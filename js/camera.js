// Kamera-Zählung (Beta) für Cricket/Tactics.
// Prinzip: Board einmessen (4 Punkte → Homographie), Bild vor/nach jedem Wurf vergleichen,
// Spitze des neuen Darts schätzen, Feld berechnen, als Vorschlag anzeigen (Auto-Übernahme nach Countdown).
import { store, sb, uuid } from './db.js';

const KEY = 'vynen-cam-cal';
const SEG = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
// Einmesspunkte: Außenkante Double-Ring mittig auf 20, 6, 3, 11 (Board-Koordinaten in mm, y nach oben)
const CAL = [{ n: 20, x: 0, y: 170 }, { n: 6, x: 170, y: 0 }, { n: 3, x: 0, y: -170 }, { n: 11, x: -170, y: 0 }];
const PW = 480; // Verarbeitungsbreite

// ---------- Mathe ----------
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gauß-Elimination
  for (let c = 0; c < 8; c++) {
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < 8; r++) if (r !== c) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]).concat(1);
}
export const apply = (H, x, y) => { const w = H[6] * x + H[7] * y + 1; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; };

// Board-Koordinate (mm) → Feld {s: Zahl (25 = Bull), m: 1–3, label}
export function segmentAt(x, y) {
  const r = Math.hypot(x, y);
  if (r > 170) return { s: 0, m: 0, label: 'Daneben' };
  if (r <= 6.35) return { s: 25, m: 2, label: 'Bull' };
  if (r <= 15.9) return { s: 25, m: 1, label: '25' };
  const a = ((90 - Math.atan2(y, x) * 180 / Math.PI) % 360 + 360) % 360;
  const s = SEG[Math.floor((a + 9) / 18) % 20];
  const m = r >= 99 && r <= 107 ? 3 : r >= 162 ? 2 : 1;
  return { s, m, label: ['', 'S', 'D', 'T'][m] + s };
}

// Spitze eines Blobs (Liste von [x,y]): Hauptachse, schmaleres Ende = Spitze
export function tipOf(pts) {
  const n = pts.length; let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; } mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { const dx = x - mx, dy = y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ax = Math.cos(ang), ay = Math.sin(ang);
  const proj = pts.map(([x, y]) => [(x - mx) * ax + (y - my) * ay, -(x - mx) * ay + (y - my) * ax, x, y]);
  let lo = Infinity, hi = -Infinity; for (const p of proj) { lo = Math.min(lo, p[0]); hi = Math.max(hi, p[0]); }
  const len = hi - lo;
  if (len < 3) return [mx, my];
  const spread = (from, to) => { const s = proj.filter(p => p[0] >= from && p[0] <= to).map(p => p[1]); if (!s.length) return 0; const m = s.reduce((a, b) => a + b, 0) / s.length; return Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / s.length); };
  const tipHi = spread(hi - 0.25 * len, hi) < spread(lo, lo + 0.25 * len);
  const edge = proj.filter(p => tipHi ? p[0] >= hi - 0.06 * len : p[0] <= lo + 0.06 * len);
  return [edge.reduce((a, p) => a + p[2], 0) / edge.length, edge.reduce((a, p) => a + p[3], 0) / edge.length];
}

// Pixel des neuen Darts: größte zusammenhängende Fläche plus nahe Teilstücke
// (Barrel, Schaft und Flight hängen im Differenzbild oft nicht zusammen)
function dartPixels(mask, w, h) {
  const seen = new Uint8Array(w * h), blobs = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    const st = [i], blob = []; seen[i] = 1;
    while (st.length) {
      const j = st.pop(), x = j % w, y = (j / w) | 0; blob.push([x, y]);
      for (const k of [j - 1, j + 1, j - w, j + w, j - w - 1, j - w + 1, j + w - 1, j + w + 1]) {
        if (k < 0 || k >= w * h || seen[k] || !mask[k]) continue;
        if (Math.abs((k % w) - x) > 1) continue;
        seen[k] = 1; st.push(k);
      }
    }
    if (blob.length >= 3) blobs.push(blob);
  }
  if (!blobs.length) return [];
  blobs.sort((a, b) => b.length - a.length);
  const near = (a, b, r) => { for (let i = 0; i < a.length; i += 2) for (let j = 0; j < b.length; j += 2) if (Math.abs(a[i][0] - b[j][0]) + Math.abs(a[i][1] - b[j][1]) <= r) return true; return false; };
  let out = blobs[0];
  const lim = Math.max(12, Math.round(w / 16)); // ~ Länge eines weißen Schafts vor weißem Feld
  for (const b of blobs.slice(1, 12)) if (near(out, b, lim)) out = out.concat(b);
  return out;
}

// ---------- Kamera-Komponente ----------
// opts: { targets:[...], onDart(t,m), visitInfo(): {inVisit}, multi: bool }
// multi = mehrere USB-Kameras am PC (z. B. die drei von Autodarts, wenn Autodarts geschlossen ist).
// Jede Kamera wird einzeln eingemessen; die Spitze wird pro Kamera aufs Board umgerechnet und
// die Positionen werden zusammengeführt (Mehrheit: Punkt, der am besten zu den anderen passt).
const MKEY = 'vynen-cam-multi';
export function fuse(pts, tol = 12) {
  if (pts.length === 1) return pts[0];
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let best = pts[0], bs = Infinity;
  for (const p of pts) { const s = pts.reduce((a, q) => a + d(p, q), 0); if (s < bs) { bs = s; best = p; } }
  const cl = pts.filter(p => d(p, best) <= tol);
  return [cl.reduce((a, p) => a + p[0], 0) / cl.length, cl.reduce((a, p) => a + p[1], 0) / cl.length];
}
export function createCamera(opts) {
  const multi = !!opts.multi;
  let views = [], V = null; // V = Kamera, die gerade eingemessen/angezeigt wird
  let timer = null, mode = 'off', proposal = null, countdown = 0, cdTimer = null, auto = store.get('vynen-cam-auto', true);
  let announced = false, lastVisit = 0, last = '', lastDet = null, bm = false, thr = store.get('vynen-cam-thr', 30), msg = '', devices = [], pick = store.get(MKEY, []);
  // Trainingsfotos: alle Darts der laufenden Aufnahme mit Spitze (normiert) und Feld (nur mit einer Kamera)
  let collect = !multi && store.get('vynen-cam-collect', false), visitTips = [], tipAsk = null, sent = store.get('vynen-cam-sent', 0);
  const panel = document.createElement('div');
  panel.className = 'cam-panel'; panel.hidden = true;
  document.body.appendChild(panel);

  const calKey = v => multi ? `${KEY}-${v.id}` : KEY;
  const setCal = (v, c) => {
    v.cal = c; store.set(calKey(v), c);
    v.H = homography(c.map(p => [p.x, p.y]), CAL.map(p => [p.x, p.y]));
    v.Hinv = homography(CAL.map(p => [p.x, p.y]), c.map(p => [p.x, p.y]));
    buildMask(v);
  };
  function buildMask(v) {
    if (!v.H) return;
    v.mask = new Uint8Array(v.pw * v.ph); v.boardPix = 0;
    for (let y = 0; y < v.ph; y++) for (let x = 0; x < v.pw; x++) {
      const [bx, by] = apply(v.H, x / v.pw, y / v.ph);
      if (Math.hypot(bx, by) < 225) { v.mask[y * v.pw + x] = 1; v.boardPix++; }
    }
  }
  // Farbbild (RGB) in Verarbeitungsgröße; Farbe statt Grau, damit z. B. ein grauer Barrel auf grünem Feld sichtbar bleibt
  function grab(v) {
    v.ctx.drawImage(v.video, 0, 0, v.pw, v.ph);
    const d = v.ctx.getImageData(0, 0, v.pw, v.ph).data, g = new Uint8Array(v.pw * v.ph * 3);
    for (let i = 0, j = 0, k = 0; i < v.pw * v.ph; i++, j += 4, k += 3) { g[k] = d[j]; g[k + 1] = d[j + 1]; g[k + 2] = d[j + 2]; }
    return g;
  }
  const diffCount = (v, a, b, thr, out) => {
    let n = 0;
    for (let i = 0, k = 0; i < v.pw * v.ph; i++, k += 3) {
      const on = v.mask[i] && Math.max(Math.abs(a[k] - b[k]), Math.abs(a[k + 1] - b[k + 1]), Math.abs(a[k + 2] - b[k + 2])) > thr;
      if (out) out[i] = on ? 1 : 0; if (on) n++;
    }
    return n;
  };

  async function openView(constraints, id, label) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
    const video = document.createElement('video'); video.playsInline = true; video.muted = true; video.srcObject = stream;
    await video.play().catch(() => {});
    await new Promise(r => video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true }));
    const v = { id, label, stream, video, pw: PW, ph: Math.round(PW * video.videoHeight / video.videoWidth), cal: null, H: null, Hinv: null, mask: null, boardPix: 0, ref: null, prev: null, empty: null, stable: 0, cur: null };
    v.cvs = document.createElement('canvas'); v.cvs.width = v.pw; v.cvs.height = v.ph; v.ctx = v.cvs.getContext('2d', { willReadFrequently: true });
    const c = store.get(calKey(v), null); if (c) setCal(v, c);
    return v;
  }
  async function start() {
    if (multi) return startMulti();
    try {
      const v = await openView({ facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, 'main', '');
      views = [v]; V = v;
    } catch (e) { msg = 'Kein Kamerazugriff. Bitte in den Browser-Einstellungen erlauben.'; mode = 'error'; render(); return; }
    const hz = store.get('vynen-cam-zoom', null);
    if (hz) V.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: hz }] }).catch(() => {});
    begin();
  }
  // Mehrere Kameras: erst Zugriff erlauben (sonst fehlen die Namen), dann auswählen
  async function startMulti() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      s.getTracks().forEach(t => t.stop());
      devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    } catch (e) { msg = 'Kein Kamerazugriff. Bitte erlauben – und Autodarts vorher schließen, sonst sind die Kameras belegt.'; mode = 'error'; render(); return; }
    pick = pick.filter(id => devices.some(d => d.deviceId === id));
    if (!pick.length) pick = devices.slice(0, 3).map(d => d.deviceId);
    mode = 'choose'; render();
  }
  async function openPicked() {
    msg = ''; views = [];
    const sel = devices.filter(d => pick.includes(d.deviceId));
    for (const [k, d] of sel.entries()) {
      try { views.push(await openView({ deviceId: { exact: d.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, d.deviceId, d.label || `Kamera ${k + 1}`)); }
      catch (e) { msg = `${d.label || `Kamera ${k + 1}`} lässt sich nicht öffnen (belegt? Autodarts schließen).`; }
    }
    if (!views.length) { mode = 'error'; render(); return; }
    begin();
  }
  function begin() {
    const todo = views.find(v => !v.cal);
    if (todo) { V = todo; calPts = []; mode = 'calib'; }
    else { V = views[0]; mode = 'watch'; resetRef(true); }
    render();
    timer = setInterval(tick, 220);
  }
  function stop() {
    clearInterval(timer); clearInterval(cdTimer); timer = null;
    for (const v of views) v.stream.getTracks().forEach(t => t.stop());
    views = []; V = null; mode = 'off'; proposal = null; panel.hidden = true; panel.innerHTML = '';
  }
  function resetRef(isEmpty) { for (const v of views) { if (!v.H) continue; v.ref = grab(v); v.prev = v.ref; if (isEmpty) v.empty = v.ref; v.stable = 0; } }

  // Robuster als vorher: Rauschen (LED-Ring, Belichtung) pro Kamera mitlernen, Lichtwechsel abfangen,
  // „Darts ziehen“ auch erkennen, wenn sich das Bild leicht verändert hat (Takeout = Bewegung, danach Ruhe).
  function tick() {
    if (mode !== 'watch' && mode !== 'pull') return;
    if (!announced) { announced = true; opts.onReady && opts.onReady(); }
    const live = views.filter(v => v.H && v.ref);
    for (const v of live) {
      const cur = grab(v);
      const motion = v.prev ? diffCount(v, cur, v.prev, 22) : 0; v.prev = cur; v.cur = cur;
      const lim = Math.max(6, v.boardPix * 0.002, (v.noise || 0) * 2.5);
      v.stable = motion < lim ? v.stable + 1 : 0;
      if (motion < lim) v.noise = (v.noise || 0) * 0.9 + motion * 0.1; // Grundrauschen
      v.moving = motion > lim * 3;
      if (v.moving) v.sawMove = true;
    }
    if (bm) updBm();
    if (mode === 'pull') {
      // Nach der Aufnahme: Board leer und ruhig – oder nach dem Ziehen (Bewegung) 2 s Ruhe
      const ok = live.every(v => v.stable >= 3 && (v.empty ? diffCount(v, v.cur, v.empty, thr) : 0) < v.boardPix * 0.004)
        || (live.some(v => v.sawMove) && live.every(v => v.stable >= 9));
      if (ok && !tipAsk) { for (const v of live) { v.ref = v.cur; v.empty = v.cur; v.sawMove = false; } mode = 'watch'; msg = ''; visitTips = []; render(); }
      return;
    }
    // Mehrheit der Kameras muss ruhig sein (eine flackernde Kamera blockiert nicht mehr alles)
    const calm = live.filter(v => v.stable >= 2);
    if (proposal || !calm.length || calm.length < Math.ceil(live.length / 2) || live.some(v => v.moving)) return;
    const cands = []; let busy = 0;
    for (const v of calm) {
      const mask = new Uint8Array(v.pw * v.ph);
      const n = diffCount(v, v.cur, v.ref, thr, mask);
      v.seen = '';
      if (n < 12) continue;
      if (n > v.boardPix * 0.12) {
        // großflächig anders, aber ruhig = Licht/Belichtung hat sich geändert → neue Referenz
        if (v.stable >= 6) { v.ref = v.cur; continue; }
        busy++; continue;
      }
      const blob = dartPixels(mask, v.pw, v.ph);
      if (blob.length < 10) { v.ref = v.cur; continue; }
      const [tx, ty] = tipOf(blob), b = apply(v.H, tx / v.pw, ty / v.ph);
      v.seen = segmentAt(b[0], b[1]).label; v.tip = [tx / v.pw, ty / v.ph];
      cands.push({ v, tip: v.tip, b });
    }
    if (!cands.length) { if (busy) { msg = 'Zu viel Bewegung vor dem Board …'; render(); } return; }
    const [bx, by] = fuse(cands.map(c => c.b));
    const f = segmentAt(bx, by);
    const hit = f.s && opts.targets.includes(f.s);
    const main = cands.find(c => c.v === views[0]) || cands[0];
    proposal = { t: hit ? f.s : 0, m: hit ? f.m : 0, s: f.s, sm: f.m, label: f.label, game: hit ? f.label : `${f.label} → Fehlwurf`, tip: main.tip, b: [bx, by],
      frames: live.map(v => [v, v.cur]), seen: cands.length, of: live.length };
    lastDet = { label: f.label, per: views.map(v => v.seen || '–') };
    msg = '';
    if (navigator.vibrate) try { navigator.vibrate(30); } catch {}
    if (auto) { last = proposal.game; accept(); return; } // sofort übernehmen; korrigieren über die Scheibe / Aufnahme
    render();
  }
  function accept() {
    clearInterval(cdTimer); if (!proposal) return;
    const p = proposal; proposal = null; for (const [v, fr] of p.frames) v.ref = fr;
    if (p.s && !multi) { visitTips.push({ k: opts.visitInfo().inVisit, x: +p.tip[0].toFixed(4), y: +p.tip[1].toFixed(4), s: p.s, m: p.sm, src: 'auto' }); if (collect) upload(); }
    opts.onDart(p.t, p.m, p.b);
  }
  const refAll = () => { for (const v of views) if (v.H) v.ref = grab(v); };
  // Foto + Beschriftung hochladen (ohne Login; Fehler werden still ignoriert)
  async function upload() {
    const v = views[0];
    if (!v || !v.cal || multi) return;
    try {
      const W = Math.min(800, v.video.videoWidth), Hh = Math.round(W * v.video.videoHeight / v.video.videoWidth);
      const c = document.createElement('canvas'); c.width = W; c.height = Hh; c.getContext('2d').drawImage(v.video, 0, 0, W, Hh);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
      if (!blob || blob.size > 400000) return;
      const path = `v1/${new Date().toISOString().slice(0, 10)}/${uuid()}.jpg`;
      const up = await sb.storage.from('training').upload(path, blob, { contentType: 'image/jpeg' });
      if (up.error) return;
      await sb.from('training_samples').insert({ path, w: W, h: Hh, cal: v.cal.map(p => [+p.x.toFixed(4), +p.y.toFixed(4)]),
        darts: visitTips.slice(-3).map(({ k, ...d }) => d), device: navigator.userAgent.slice(0, 190) });
      sent++; store.set('vynen-cam-sent', sent); render();
    } catch { /* Sammeln ist optional */ }
  }
  // Vom Spiel: Dart wurde von Hand eingetragen. Beim Sammeln nach der Spitze fragen.
  function manual() {
    if (!collect || !views.length || mode !== 'watch') return;
    tipAsk = true; render();
  }
  function reject() { clearInterval(cdTimer); if (proposal) refAll(); proposal = null; msg = 'Bitte den Dart unten antippen.'; render(); }

  // Vom Spiel aufgerufen, nach jeder Änderung (Antippen, Rückgängig, Kamera)
  function sync() {
    if (!views.length || mode === 'calib' || mode === 'off' || mode === 'choose') return;
    const { inVisit } = opts.visitInfo();
    if (mode === 'watch' && inVisit > 0) visitTips = visitTips.filter(t => t.k < inVisit); // Rückgängig
    if (inVisit === 0) last = '';
    if (inVisit === 0 && lastVisit > 0) { mode = 'pull'; msg = 'Darts ziehen – danach geht es automatisch weiter.'; proposal = null; clearInterval(cdTimer); }
    else if (mode === 'watch') { refAll(); for (const v of views) v.stable = 0; } // manuell getippt/korrigiert: aktuelles Bild als neue Referenz
    lastVisit = inVisit; render();
  }

  // ---------- Darstellung ----------
  let calPts = [], calAll = false;
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function renderChoose() {
    panel.className = 'cam-panel';
    panel.innerHTML = `<div class="cam-choose"><b>Kameras wählen</b>
      <span class="muted small">Autodarts vorher schließen, sonst sind die Kameras belegt. Jede Kamera wird einmal eingemessen.</span>
      ${devices.length ? devices.map((d, k) => `<label class="inl-l"><input type="checkbox" data-dev value="${esc(d.deviceId)}" ${pick.includes(d.deviceId) ? 'checked' : ''}> ${esc(d.label || `Kamera ${k + 1}`)}</label>`).join('') : '<span>Keine Kamera gefunden.</span>'}
      <div class="bbtns"><button class="btn pri" data-c="go">Starten</button><button class="btn ghost" data-c="close">Abbrechen</button></div></div>`;
  }
  function render() {
    if (mode === 'off') { panel.hidden = true; return; }
    panel.hidden = false;
    if (mode === 'error') { panel.innerHTML = `<div class="cam-bar"><span>${msg}</span><button class="btn sm" data-c="close">Schließen</button></div>`; return; }
    if (mode === 'choose') return renderChoose();
    if (mode === 'calib') { announced = false; return renderCalib(); }
    if (tipAsk) return renderTipAsk();
    if (bm) return renderBm();
    const pr = proposal, inV = opts.visitInfo().inVisit;
    const st = pr ? 'hit' : mode === 'pull' ? 'pull' : msg ? 'warn' : 'ok';
    panel.className = 'cam-panel slim';
    panel.innerHTML = `<div class="cam-bar">
      <span class="cam-dot ${st}" aria-hidden="true"></span>
      <div class="cam-info">${pr ? `<span class="muted small">Erkannt${multi ? ` · ${pr.seen}/${pr.of} Kameras` : ''}</span><b class="cam-hit">${pr.game}</b>`
        : mode === 'pull' ? `<span class="muted small">Takeout</span><b>${msg}</b>`
        : `<span class="muted small">${multi ? `${views.length} Kameras` : 'Kamera'} · ${['1.', '2.', '3.'][inV] || ''} Dart</span><b>${msg || (last && inV ? `Erkannt: ${last}` : 'Bereit – werfen!')}</b>`}</div>
      <div class="cam-btns">${pr ? `<button class="btn pri" data-c="ok">✓</button><button class="btn" data-c="no">✕</button>`
        : `<button class="btn sm" data-c="free" title="Board ist leer – Erkennung neu starten">Reset</button>
           <button class="btn sm ${auto ? 'on' : ''}" data-c="auto" aria-pressed="${auto}">Auto ${auto ? 'an' : 'aus'}</button>
           <button class="btn sm" data-c="bm">⚙ Board Manager</button><button class="btn sm" data-c="close">Aus</button>`}</div></div>`;
  }
  // Board Manager: alle Kameras live mit Ringen, Status und was jede Kamera zuletzt gesehen hat
  function renderBm() {
    panel.className = 'cam-panel full bm';
    panel.innerHTML = `<div class="bm-wrap"><div class="bm-head"><b>Board Manager</b><span class="muted small" data-bm="state"></span>
        <button class="btn sm" data-c="bmclose">Schließen</button></div>
      <div class="bm-grid">${views.map((v, k) => `<div class="bm-cam"><div class="bm-vid" data-v="${k}"></div>
        <div class="bm-cap"><b>${esc(v.label || `Kamera ${k + 1}`)}</b><span data-bm="s${k}"></span>
          <button class="btn sm" data-c="calone" data-k="${k}">Einmessen</button></div></div>`).join('')}</div>
      <div class="bm-foot">
        <span data-bm="det" class="bm-det"></span>
        <label class="inl-l">Empfindlichkeit <select data-c2="thr">${[[20, 'hoch'], [30, 'normal'], [45, 'niedrig']].map(([v, l]) => `<option value="${v}" ${thr === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <button class="btn sm" data-c="free">Reset (Board leer)</button>
        <button class="btn sm" data-c="calib">Alle einmessen</button>
        ${multi ? '<button class="btn sm" data-c="rechoose">Kameras wählen</button>' : `<button class="btn sm ${collect ? 'on' : ''}" data-c="collect" aria-pressed="${collect}" title="Fotos fürs KI-Training sammeln">📸 ${collect ? sent : 'Sammeln'}</button>`}
      </div>
      <p class="muted small bm-tip">Grün = ruhig, Gelb = Bewegung. Zählt eine Kamera oft falsch: neu einmessen oder Empfindlichkeit ändern. Bei „Darts ziehen“ hängt: Reset.</p></div>`;
    panel.querySelectorAll('.bm-vid').forEach(el => {
      const v = views[+el.dataset.v];
      v.video.className = 'cam-video'; el.appendChild(v.video); v.video.play().catch(() => {});
      const oc = document.createElement('canvas'); oc.className = 'cam-ov'; el.appendChild(oc); v.oc = oc;
      requestAnimationFrame(() => drawOverlay(oc, v.seen && v.tip, v));
    });
    panel.querySelector('[data-c2=thr]').onchange = e => { thr = Number(e.target.value); store.set('vynen-cam-thr', thr); };
    updBm();
  }
  function updBm() {
    const q = k => panel.querySelector(`[data-bm="${k}"]`); if (!q('state')) return;
    q('state').textContent = mode === 'pull' ? 'Takeout – Darts ziehen' : 'Bereit';
    views.forEach((v, k) => { const el = q('s' + k); if (!el) return;
      el.className = 'bm-st ' + (!v.H ? 'off' : v.stable >= 2 ? 'ok' : 'mv');
      el.textContent = !v.H ? 'nicht eingemessen' : `${v.stable >= 2 ? 'ruhig' : 'Bewegung'}${v.seen ? ` · sieht ${v.seen}` : ''}`; });
    q('det').textContent = lastDet ? `Letzter Dart: ${lastDet.label} (${lastDet.per.map((x, k) => `K${k + 1}: ${x}`).join(', ')})` : '';
  }
  function drawOverlay(oc, tip, v = V) {
    const w = oc.width = oc.clientWidth * 2 || 240, h = oc.height = oc.clientHeight * 2 || 135, c = oc.getContext('2d');
    const Hinv = v && v.Hinv;
    if (!Hinv) return;
    c.strokeStyle = 'rgba(0,255,140,.8)'; c.lineWidth = 2;
    for (const r of [170, 162, 107, 99, 15.9]) {
      c.beginPath();
      for (let a = 0; a <= 360; a += 6) { const [x, y] = apply(Hinv, r * Math.cos(a * Math.PI / 180), r * Math.sin(a * Math.PI / 180)); a ? c.lineTo(x * w, y * h) : c.moveTo(x * w, y * h); }
      c.stroke();
    }
    if (tip) { c.fillStyle = '#ff2d55'; c.beginPath(); c.arc(tip[0] * w, tip[1] * h, 6, 0, 7); c.fill(); }
  }
  // Einmessen mit Zoom: Pinch/Ziehen oder +/−, Tippen setzt den Punkt (Transform wird über getBoundingClientRect berücksichtigt)
  let view = { z: 1, tx: 0, ty: 0 };
  function renderCalib() {
    panel.className = 'cam-panel full';
    const next = CAL[calPts.length], stream = V.stream, video = V.video;
    const caps = stream && stream.getVideoTracks()[0].getCapabilities ? stream.getVideoTracks()[0].getCapabilities() : {};
    const hz = caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null;
    const curZ = hz ? (stream.getVideoTracks()[0].getSettings().zoom || hz.min) : 1;
    panel.innerHTML = `<div class="cam-cal"><div class="cam-stage"><div class="cam-zoom"></div>
        <div class="cam-zbtn"><button class="btn sm" data-z="in" aria-label="Vergrößern">＋</button><button class="btn sm" data-z="out" aria-label="Verkleinern">−</button><button class="btn sm" data-z="reset" aria-label="Ganzes Bild">⤢</button></div></div>
      <div class="cam-cal-bar">${multi ? `<span class="muted small">📷 ${esc(V.label)} · Kamera ${views.indexOf(V) + 1} von ${views.length}</span>` : ''}${next ? `<b>Tippe auf den äußeren Rand des Double-Rings, mittig auf der <span class="gold">${next.n}</span></b>
        <span class="muted small">Punkt ${calPts.length + 1} von 4 · Mit zwei Fingern oder ＋ vergrößern, mit einem Finger verschieben</span>`
        : `<b>Passen die grünen Ringe aufs Board?</b>`}
        ${hz && !multi ? `<label class="inl-l cam-hz">Kamera-Zoom <input type="range" min="${hz.min}" max="${hz.max}" step="${hz.step || 0.1}" value="${curZ}" data-hz></label>` : ''}
        <div class="bbtns">${next ? '' : '<button class="btn pri" data-c="calok">Passt</button>'}${calPts.length && next ? '<button class="btn" data-c="calback">Letzten Punkt zurück</button>' : ''}<button class="btn" data-c="recal">Neu</button>${multi && views.length > 1 ? '<button class="btn" data-c="skipcam">Kamera weglassen</button>' : ''}<button class="btn ghost" data-c="close">Abbrechen</button></div></div></div>`;
    const stage = panel.querySelector('.cam-stage'), zl = panel.querySelector('.cam-zoom');
    video.className = 'cam-video'; zl.appendChild(video); video.play().catch(() => {});
    const oc = document.createElement('canvas'); oc.className = 'cam-ov'; zl.appendChild(oc);
    const applyView = () => {
      const W = stage.clientWidth, Hh = stage.clientHeight;
      view.z = Math.min(8, Math.max(1, view.z));
      view.tx = Math.min(0, Math.max(W - W * view.z, view.tx)); view.ty = Math.min(0, Math.max(Hh - Hh * view.z, view.ty));
      zl.style.transform = `translate(${view.tx}px,${view.ty}px) scale(${view.z})`;
    };
    const zoomAt = (f, cx, cy) => { const z0 = view.z, z1 = Math.min(8, Math.max(1, z0 * f)); view.tx = cx - (cx - view.tx) * z1 / z0; view.ty = cy - (cy - view.ty) * z1 / z0; view.z = z1; applyView(); };
    const hzIn = panel.querySelector('[data-hz]');
    if (hzIn && !multi) hzIn.oninput = () => {
      stream.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: Number(hzIn.value) }] }).catch(() => {});
      store.set('vynen-cam-zoom', Number(hzIn.value));
      if (calPts.length) { calPts = []; renderCalib(); } // anderer Bildausschnitt: Punkte neu setzen
    };
    panel.querySelectorAll('[data-z]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      const W = stage.clientWidth / 2, Hh = stage.clientHeight / 2;
      if (b.dataset.z === 'in') zoomAt(1.6, W, Hh); else if (b.dataset.z === 'out') zoomAt(1 / 1.6, W, Hh); else { view = { z: 1, tx: 0, ty: 0 }; applyView(); }
    });
    // Gesten: ein Finger verschiebt (ab 6 px), zwei Finger zoomen, kurzes Tippen setzt einen Punkt
    const ptrs = new Map(); let moved = false, pinch = null;
    stage.onpointerdown = e => { if (e.target.closest('button')) return; stage.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY }); moved = ptrs.size > 1;
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) }; } };
    stage.onpointermove = e => {
      const p = ptrs.get(e.pointerId); if (!p) return;
      const rc = stage.getBoundingClientRect();
      if (ptrs.size === 2 && pinch) {
        p.x = e.clientX; p.y = e.clientY; const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        zoomAt(d / pinch.d, (a.x + b.x) / 2 - rc.left, (a.y + b.y) / 2 - rc.top); pinch.d = d; return;
      }
      if (!moved && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < 6) return;
      moved = true; view.tx += e.clientX - p.x; view.ty += e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; applyView();
    };
    stage.onpointerup = stage.onpointercancel = e => {
      const p = ptrs.get(e.pointerId); ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
      if (!p || moved || e.type === 'pointercancel' || calPts.length >= 4) { if (!ptrs.size) moved = false; return; }
      const r = oc.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      calPts.push({ x, y });
      if (calPts.length === 4) setCal(V, calPts);
      renderCalib();
    };
    stage.onwheel = e => { e.preventDefault(); const rc = stage.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - rc.left, e.clientY - rc.top); };
    requestAnimationFrame(() => {
      const box = videoBox(stage);
      Object.assign(oc.style, { left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' });
      applyView();
      const w = oc.width = box.w * 3, h = oc.height = box.h * 3, c = oc.getContext('2d');
      const rad = Math.max(3, 12 / view.z);
      c.strokeStyle = '#ffcc00'; c.lineWidth = Math.max(1.5, 3 / view.z);
      calPts.forEach(p => { // Fadenkreuz statt Punkt, damit die Stelle sichtbar bleibt
        c.beginPath(); c.arc(p.x * w, p.y * h, rad, 0, 7); c.moveTo(p.x * w - rad * 2, p.y * h); c.lineTo(p.x * w + rad * 2, p.y * h);
        c.moveTo(p.x * w, p.y * h - rad * 2); c.lineTo(p.x * w, p.y * h + rad * 2); c.stroke(); });
      if (calPts.length === 4) drawOverlay(oc);
    });
  }
  // Spitze eines von Hand eingetragenen Darts antippen (für die Trainingsdaten)
  function renderTipAsk() {
    panel.className = 'cam-panel full';
    panel.innerHTML = `<div class="cam-cal"><div class="cam-stage"></div>
      <div class="cam-cal-bar"><b>📸 Tippe auf die <span class="gold">Spitze</span> des letzten Darts</b>
        <span class="muted small">Damit lernt die Erkennung dazu. Daneben geworfen oder nicht zu sehen: Überspringen.</span>
        <div class="bbtns"><button class="btn" data-c="tipskip">Überspringen</button></div></div></div>`;
    const stage = panel.querySelector('.cam-stage'), video = V.video;
    video.className = 'cam-video'; stage.appendChild(video); video.play().catch(() => {});
    const oc = document.createElement('canvas'); oc.className = 'cam-ov'; stage.appendChild(oc);
    requestAnimationFrame(() => {
      const box = videoBox(stage);
      Object.assign(oc.style, { left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' });
      oc.width = box.w; oc.height = box.h; drawOverlay(oc);
      oc.onclick = e => {
        const r = oc.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        const [bx, by] = apply(V.H, x, y), f = segmentAt(bx, by);
        visitTips.push({ k: Math.max(0, (opts.visitInfo().inVisit || 3) - 1), x: +x.toFixed(4), y: +y.toFixed(4), s: f.s, m: f.m, src: 'tap' });
        tipAsk = null; upload(); refAll(); render();
      };
    });
  }
  // Wo liegt das Videobild innerhalb des Containers (object-fit: contain)
  function videoBox(el) {
    const video = V.video, W = el.clientWidth, Hh = el.clientHeight, r = video.videoWidth / video.videoHeight;
    let w = W, h = W / r; if (h > Hh) { h = Hh; w = Hh * r; }
    return { x: (W - w) / 2, y: (Hh - h) / 2, w, h };
  }

  panel.addEventListener('click', e => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    const c = b.dataset.c;
    if (c === 'close') { stop(); opts.onClose && opts.onClose(); }
    if (c === 'ok') accept();
    if (c === 'no') reject();
    if (c === 'free') { resetRef(true); for (const v of views) v.sawMove = false; mode = 'watch'; msg = ''; visitTips = []; render(); }
    if (c === 'calib') { calAll = true; V = views[0]; calPts = []; view = { z: 1, tx: 0, ty: 0 }; mode = 'calib'; render(); }
    if (c === 'recal') { calPts = []; view = { z: 1, tx: 0, ty: 0 }; mode = 'calib'; render(); }
    if (c === 'calback') { calPts.pop(); render(); }
    if (c === 'calok') {
      // Mehrere Kameras: nach „Einmessen“ alle der Reihe nach, sonst nur die noch fehlenden
      const nxt = multi && (calAll ? views[views.indexOf(V) + 1] : views.find(v => !v.cal));
      if (nxt) { V = nxt; calPts = []; view = { z: 1, tx: 0, ty: 0 }; render(); return; }
      calAll = false; V = views[0]; mode = 'watch'; resetRef(true); msg = ''; render();
    }
    if (c === 'skipcam') { // Kamera weglassen
      const k = views.indexOf(V); V.stream.getTracks().forEach(t => t.stop()); views.splice(k, 1);
      if (!views.length) { stop(); opts.onClose && opts.onClose(); return; }
      const nxt = calAll ? views[k] : views.find(v => !v.cal);
      if (nxt) { V = nxt; calPts = []; render(); return; }
      calAll = false; V = views[0]; mode = 'watch'; resetRef(true); render();
    }
    if (c === 'go') { pick = [...panel.querySelectorAll('[data-dev]:checked')].map(i => i.value); if (!pick.length) return; store.set(MKEY, pick); mode = 'off'; openPicked(); }
    if (c === 'auto') { auto = !auto; store.set('vynen-cam-auto', auto); render(); }
    if (c === 'collect') { collect = !collect; store.set('vynen-cam-collect', collect); msg = collect ? 'Sammeln an: Board-Fotos gehen an die Leitung (Personen bitte nicht ins Bild).' : ''; render(); }
    if (c === 'tipskip') { tipAsk = null; render(); }
    if (c === 'bm') { bm = true; render(); }
    if (c === 'bmclose') { bm = false; render(); }
    if (c === 'calone') { calAll = false; V = views[+b.dataset.k]; calPts = []; view = { z: 1, tx: 0, ty: 0 }; mode = 'calib'; render(); }
    if (c === 'rechoose') { bm = false; clearInterval(timer); for (const v of views) v.stream.getTracks().forEach(t => t.stop()); views = []; startMulti(); }
  });

  return { start, stop, sync, manual, clear() { last = ''; }, get active() { return mode !== 'off'; },
    // Für die Live-Ansicht im Spiel: Kameras mit Stream und Umrechnung
    get views() { return views.filter(v => v.H).map(v => ({ stream: v.stream, label: v.label, H: v.H, Hinv: v.Hinv })); }, get ready() { return mode === 'watch' || mode === 'pull'; } };
}
