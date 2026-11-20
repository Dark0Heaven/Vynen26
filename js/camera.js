// Kamera-Zählung (Beta) für Cricket/Tactics.
// Prinzip: Board einmessen (4 Punkte → Homographie), Bild vor/nach jedem Wurf vergleichen,
// Spitze des neuen Darts schätzen, Feld berechnen, als Vorschlag anzeigen (Auto-Übernahme nach Countdown).
import { store } from './db.js';

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
// opts: { targets:[...], onDart(t,m), visitInfo(): {inVisit} }
export function createCamera(opts) {
  let stream = null, video = null, timer = null, cal = store.get(KEY, null), H = null, Hinv = null;
  let pw = PW, ph = 240, cvs = null, ctx = null, ref = null, prev = null, empty = null, boardMask = null, boardPix = 0;
  let mode = 'off', stable = 0, proposal = null, countdown = 0, cdTimer = null, auto = store.get('vynen-cam-auto', true);
  let lastVisit = 0, msg = '';
  const panel = document.createElement('div');
  panel.className = 'cam-panel'; panel.hidden = true;
  document.body.appendChild(panel);

  const setCal = c => {
    cal = c; store.set(KEY, c);
    H = homography(c.map(p => [p.x, p.y]), CAL.map(p => [p.x, p.y]));
    Hinv = homography(CAL.map(p => [p.x, p.y]), c.map(p => [p.x, p.y]));
    buildMask();
  };
  function buildMask() {
    if (!H) return;
    boardMask = new Uint8Array(pw * ph); boardPix = 0;
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const [bx, by] = apply(H, x / pw, y / ph);
      if (Math.hypot(bx, by) < 225) { boardMask[y * pw + x] = 1; boardPix++; }
    }
  }
  // Farbbild (RGB) in Verarbeitungsgröße; Farbe statt Grau, damit z. B. ein grauer Barrel auf grünem Feld sichtbar bleibt
  function grab() {
    ctx.drawImage(video, 0, 0, pw, ph);
    const d = ctx.getImageData(0, 0, pw, ph).data, g = new Uint8Array(pw * ph * 3);
    for (let i = 0, j = 0, k = 0; i < pw * ph; i++, j += 4, k += 3) { g[k] = d[j]; g[k + 1] = d[j + 1]; g[k + 2] = d[j + 2]; }
    return g;
  }
  const diffCount = (a, b, thr, out) => {
    let n = 0;
    for (let i = 0, k = 0; i < pw * ph; i++, k += 3) {
      const on = boardMask[i] && Math.max(Math.abs(a[k] - b[k]), Math.abs(a[k + 1] - b[k + 1]), Math.abs(a[k + 2] - b[k + 2])) > thr;
      if (out) out[i] = on ? 1 : 0; if (on) n++;
    }
    return n;
  };

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) { msg = 'Kein Kamerazugriff. Bitte in den Browser-Einstellungen erlauben.'; mode = 'error'; render(); return; }
    const hz = store.get('vynen-cam-zoom', null);
    if (hz) stream.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: hz }] }).catch(() => {});
    video = document.createElement('video'); video.playsInline = true; video.muted = true; video.srcObject = stream;
    await video.play().catch(() => {});
    await new Promise(r => video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true }));
    ph = Math.round(PW * video.videoHeight / video.videoWidth); pw = PW;
    cvs = document.createElement('canvas'); cvs.width = pw; cvs.height = ph; ctx = cvs.getContext('2d', { willReadFrequently: true });
    if (cal) { setCal(cal); mode = 'watch'; resetRef(true); } else mode = 'calib';
    render();
    timer = setInterval(tick, 220);
  }
  function stop() {
    clearInterval(timer); clearInterval(cdTimer); timer = null;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; mode = 'off'; proposal = null; panel.hidden = true; panel.innerHTML = '';
  }
  function resetRef(isEmpty) { if (!video) return; ref = grab(); prev = ref; if (isEmpty) empty = ref; stable = 0; }

  function tick() {
    if (mode !== 'watch' && mode !== 'pull') return;
    const cur = grab();
    const motion = prev ? diffCount(cur, prev, 22) : 0; prev = cur;
    stable = motion < Math.max(6, boardPix * 0.002) ? stable + 1 : 0;
    if (mode === 'pull') {
      // Nach der Aufnahme: warten, bis das Board wieder leer und ruhig ist
      const vsEmpty = empty ? diffCount(cur, empty, 30) : 0;
      if (stable >= 3 && vsEmpty < boardPix * 0.004) { ref = cur; empty = cur; mode = 'watch'; msg = ''; render(); }
      return;
    }
    if (proposal || stable < 2) return;
    const mask = new Uint8Array(pw * ph);
    const n = diffCount(cur, ref, 30, mask);
    if (n < 12) return;
    if (n > boardPix * 0.12) { msg = 'Zu viel Bewegung vor dem Board …'; render(); return; }
    const blob = dartPixels(mask, pw, ph);
    if (blob.length < 10) { ref = cur; return; }
    const [tx, ty] = tipOf(blob);
    const [bx, by] = apply(H, tx / pw, ty / ph);
    const f = segmentAt(bx, by);
    const hit = f.s && opts.targets.includes(f.s);
    proposal = { t: hit ? f.s : 0, m: hit ? f.m : 0, label: f.label, game: hit ? f.label : `${f.label} → Fehlwurf`, tip: [tx / pw, ty / ph], frame: cur };
    msg = '';
    if (auto) { countdown = 3; clearInterval(cdTimer); cdTimer = setInterval(() => { countdown--; if (countdown <= 0) accept(); else render(); }, 1000); }
    if (navigator.vibrate) try { navigator.vibrate(30); } catch {}
    render();
  }
  function accept() {
    clearInterval(cdTimer); if (!proposal) return;
    const p = proposal; proposal = null; ref = p.frame;
    opts.onDart(p.t, p.m);
  }
  function reject() { clearInterval(cdTimer); if (proposal) ref = grab(); proposal = null; msg = 'Bitte den Dart unten antippen.'; render(); }

  // Vom Spiel aufgerufen, nach jeder Änderung (Antippen, Rückgängig, Kamera)
  function sync() {
    if (!video || mode === 'calib' || mode === 'off') return;
    const { inVisit } = opts.visitInfo();
    if (inVisit === 0 && lastVisit > 0) { mode = 'pull'; msg = 'Darts ziehen – danach geht es automatisch weiter.'; proposal = null; clearInterval(cdTimer); }
    else if (mode === 'watch') ref = grab(); // manuell getippt: aktuelles Bild als neue Referenz
    lastVisit = inVisit; render();
  }

  // ---------- Darstellung ----------
  let calPts = [];
  function render() {
    if (mode === 'off') { panel.hidden = true; return; }
    panel.hidden = false;
    if (mode === 'error') { panel.innerHTML = `<div class="cam-bar"><span>${msg}</span><button class="btn sm" data-c="close">Schließen</button></div>`; return; }
    if (mode === 'calib') return renderCalib();
    const pr = proposal;
    panel.className = 'cam-panel';
    panel.innerHTML = `<div class="cam-bar">
      <div class="cam-mini"></div>
      <div class="cam-info">${pr ? `<span class="muted small">Erkannt</span><b class="cam-hit">${pr.game}</b>`
        : mode === 'pull' ? `<span class="muted small">Kamera</span><b>${msg}</b>`
        : `<span class="muted small">Kamera (Beta) · ${['1.', '2.', '3.'][opts.visitInfo().inVisit] || ''} Dart</span><b>${msg || 'Bereit – werfen!'}</b>`}</div>
      <div class="cam-btns">${pr ? `<button class="btn pri" data-c="ok">✓ ${auto ? countdown : ''}</button><button class="btn" data-c="no">✕</button>`
        : `<button class="btn sm" data-c="free">Board frei</button><button class="btn sm" data-c="calib">Einmessen</button>
           <button class="btn sm ${auto ? 'on' : ''}" data-c="auto" aria-pressed="${auto}">Auto ${auto ? 'an' : 'aus'}</button><button class="btn sm" data-c="close">Aus</button>`}</div></div>`;
    const mini = panel.querySelector('.cam-mini');
    video.className = 'cam-video'; mini.appendChild(video); video.play().catch(() => {});
    const oc = document.createElement('canvas'); oc.className = 'cam-ov'; mini.appendChild(oc);
    drawOverlay(oc, pr && pr.tip);
  }
  function drawOverlay(oc, tip) {
    const w = oc.width = oc.clientWidth * 2 || 240, h = oc.height = oc.clientHeight * 2 || 135, c = oc.getContext('2d');
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
    const next = CAL[calPts.length];
    const caps = stream && stream.getVideoTracks()[0].getCapabilities ? stream.getVideoTracks()[0].getCapabilities() : {};
    const hz = caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null;
    const curZ = hz ? (stream.getVideoTracks()[0].getSettings().zoom || hz.min) : 1;
    panel.innerHTML = `<div class="cam-cal"><div class="cam-stage"><div class="cam-zoom"></div>
        <div class="cam-zbtn"><button class="btn sm" data-z="in" aria-label="Vergrößern">＋</button><button class="btn sm" data-z="out" aria-label="Verkleinern">−</button><button class="btn sm" data-z="reset" aria-label="Ganzes Bild">⤢</button></div></div>
      <div class="cam-cal-bar">${next ? `<b>Tippe auf den äußeren Rand des Double-Rings, mittig auf der <span class="gold">${next.n}</span></b>
        <span class="muted small">Punkt ${calPts.length + 1} von 4 · Mit zwei Fingern oder ＋ vergrößern, mit einem Finger verschieben</span>`
        : `<b>Passen die grünen Ringe aufs Board?</b>`}
        ${hz ? `<label class="inl-l cam-hz">Kamera-Zoom <input type="range" min="${hz.min}" max="${hz.max}" step="${hz.step || 0.1}" value="${curZ}" data-hz></label>` : ''}
        <div class="bbtns">${next ? '' : '<button class="btn pri" data-c="calok">Passt</button>'}${calPts.length && next ? '<button class="btn" data-c="calback">Letzten Punkt zurück</button>' : ''}<button class="btn" data-c="recal">Neu</button><button class="btn ghost" data-c="close">Abbrechen</button></div></div></div>`;
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
    if (hzIn) hzIn.oninput = () => {
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
      if (calPts.length === 4) setCal(calPts);
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
  // Wo liegt das Videobild innerhalb des Containers (object-fit: contain)
  function videoBox(el) {
    const W = el.clientWidth, Hh = el.clientHeight, r = video.videoWidth / video.videoHeight;
    let w = W, h = W / r; if (h > Hh) { h = Hh; w = Hh * r; }
    return { x: (W - w) / 2, y: (Hh - h) / 2, w, h };
  }

  panel.addEventListener('click', e => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    const c = b.dataset.c;
    if (c === 'close') { stop(); opts.onClose && opts.onClose(); }
    if (c === 'ok') accept();
    if (c === 'no') reject();
    if (c === 'free') { resetRef(true); mode = 'watch'; msg = ''; render(); }
    if (c === 'calib' || c === 'recal') { calPts = []; view = { z: 1, tx: 0, ty: 0 }; mode = 'calib'; render(); }
    if (c === 'calback') { calPts.pop(); render(); }
    if (c === 'calok') { mode = 'watch'; resetRef(true); msg = ''; render(); }
    if (c === 'auto') { auto = !auto; store.set('vynen-cam-auto', auto); render(); }
  });

  return { start, stop, sync, get active() { return mode !== 'off'; } };
}
