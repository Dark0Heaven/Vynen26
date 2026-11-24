// Freies Spiel: Cricket und Tactics für beliebig viele Spieler, nur auf diesem Gerät (kein Login, keine Datenbank)
import { esc, store } from './db.js';
import { createCamera, apply as hApply, segmentAt } from './camera.js';
import { createAutodarts } from './autodarts.js';
const PC = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches; // Maus = PC/Laptop
import { DEFS, run, optionsOf } from './games.js';

const GAMES = {
  cricket: { name: 'Cricket', targets: [20, 19, 18, 17, 16, 15, 25] },
  tactics: { name: 'Tactics', targets: [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 25] },
};
const VARIANTS = { std: 'Standard (Punkte)', cut: 'Cut-Throat', none: 'Ohne Punkte' };
const KEY = 'vynen-play', KEY_SETUP = 'vynen-play-setup';
const lbl = t => t === 25 ? 'Bull' : String(t);
const ALL = [...Array.from({ length: 20 }, (_, i) => i + 1), 25];
const isCk = type => type in GAMES;
const gameName = type => isCk(type) ? GAMES[type].name : DEFS[type].name;
const minPlayers = type => isCk(type) ? 2 : DEFS[type].min;
// Spielauswahl als Pulldown, gruppiert
function gameSelect(cur) {
  const groups = { Cricket: Object.entries(GAMES).map(([k, g]) => [k, g.name + (k === 'cricket' ? ' (15–20, Bull)' : ' (10–20, Bull)')]) };
  for (const [k, d] of Object.entries(DEFS)) (groups[d.group] = groups[d.group] || []).push([k, d.name]);
  return `<select id="gt" aria-label="Spiel">${Object.entries(groups).map(([g, list]) => `<optgroup label="${g}">${list.map(([k, n]) =>
    `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>`).join('')}</select>`;
}

// ---------- Spiellogik: Stand komplett aus der Wurfliste berechnen (macht Rückgängig trivial) ----------
export function replay(game) {
  const T = GAMES[game.type].targets;
  const P = game.players.map(name => ({ name, marks: Object.fromEntries(T.map(t => [t, 0])), pts: 0, darts: 0, hits: 0 }));
  let cur = 0, inVisit = 0, winner = null, last = null, idx = 0; const lastBy = {};
  const visit = [];
  for (const d of game.darts) {
    if (winner !== null) break;
    const p = P[cur];
    p.darts++;
    if (d.t) {
      const m = d.t === 25 ? Math.min(d.m, 2) : d.m;
      p.hits += m;
      const close = Math.min(m, 3 - p.marks[d.t]), extra = m - close;
      p.marks[d.t] += close;
      if (extra > 0 && game.variant !== 'none') {
        const others = P.filter((_, i) => i !== cur);
        if (game.variant === 'std') { if (others.some(o => o.marks[d.t] < 3)) p.pts += extra * d.t; }
        else for (const o of others) if (o.marks[d.t] < 3) o.pts += extra * d.t;
      }
    }
    if (isWinner(game, P, cur)) { winner = cur; break; }
    inVisit++; idx++;
    if (inVisit === 3) { last = { p: cur, s: idx - 3, e: idx }; lastBy[cur] = last; inVisit = 0; cur = (cur + 1) % P.length; }
  }
  // Würfe der laufenden Aufnahme für die Anzeige
  if (winner === null) for (let i = game.darts.length - inVisit; i < game.darts.length; i++) visit.push(game.darts[i]);
  const dead = new Set(T.filter(t => P.every(p => p.marks[t] >= 3)));
  return { T, P, cur, inVisit, winner, visit, dead, last, lastBy };
}

function isWinner(game, P, i) {
  const p = P[i], T = GAMES[game.type].targets;
  if (!T.every(t => p.marks[t] >= 3)) return false;
  const others = P.filter((_, k) => k !== i);
  if (game.variant === 'std') return others.every(o => p.pts >= o.pts);
  if (game.variant === 'cut') return others.every(o => p.pts <= o.pts);
  return true;
}

function ranking(game, st) {
  const closed = p => st.T.filter(t => p.marks[t] >= 3).length;
  return st.P.map((p, i) => ({ ...p, i })).sort((a, b) => (b.i === st.winner) - (a.i === st.winner) || closed(b) - closed(a)
    || (game.variant === 'cut' ? a.pts - b.pts : b.pts - a.pts));
}

const dartTxt = d => !d.t ? '–' : d.t === 25 ? (d.m >= 2 ? 'Bull' : '25') : ['', 'S', 'D', 'T'][d.m] + d.t;
// ---------- Scheibe (bei Kamera) und Aufnahmen ----------
const SEG = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
const pt = (r, deg) => [r * Math.sin(deg * Math.PI / 180), -r * Math.cos(deg * Math.PI / 180)];
function wedge(r0, r1, a0, a1) {
  const [x0, y0] = pt(r1, a0), [x1, y1] = pt(r1, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r1} ${r1} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}A${r0} ${r0} 0 0 0 ${x3.toFixed(1)} ${y3.toFixed(1)}Z`;
}
let BOARD = '';
function boardBase() {
  if (BOARD) return BOARD;
  let g = '<circle r="200" fill="#151518"/>';
  SEG.forEach((n, i) => {
    const a0 = i * 18 - 9, a1 = i * 18 + 9, dark = i % 2 === 0;
    g += `<path d="${wedge(107, 162, a0, a1)}" fill="${dark ? '#1b1b1b' : '#e9dfc4'}"/><path d="${wedge(15.9, 99, a0, a1)}" fill="${dark ? '#1b1b1b' : '#e9dfc4'}"/>`
      + `<path d="${wedge(162, 170, a0, a1)}" fill="${dark ? '#d1202f' : '#1f8a4c'}"/><path d="${wedge(99, 107, a0, a1)}" fill="${dark ? '#d1202f' : '#1f8a4c'}"/>`;
    const [x, y] = pt(185, i * 18);
    g += `<text x="${x.toFixed(1)}" y="${(y + 6).toFixed(1)}" text-anchor="middle" font-size="17" fill="#fff" font-family="inherit">${n}</text>`;
  });
  g += '<circle r="15.9" fill="#1f8a4c"/><circle r="6.35" fill="#d1202f"/>';
  return (BOARD = g);
}
// Position eines Darts: von der Kamera (x/y in mm) oder Feldmitte
function dartPos(d) {
  if (d.x !== undefined) return [d.x, -d.y];
  if (!d.t) return null;
  if (d.t === 25) return d.m >= 2 ? [0, 0] : [0, -11];
  return pt(d.m === 3 ? 103 : d.m === 2 ? 166 : 135, SEG.indexOf(d.t) * 18);
}
function boardSvg(list, fix) {
  const dots = list.map(([i, d], k) => { const p = dartPos(d); if (!p) return '';
    return `<g class="bd-dart ${i === fix ? 'sel' : ''}"><circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="9"/><text x="${p[0].toFixed(1)}" y="${(p[1] + 4.5).toFixed(1)}" text-anchor="middle" font-size="12">${k + 1}</text></g>`; }).join('');
  return `<svg class="bd-svg" viewBox="-200 -200 400 400" role="img" aria-label="Dartscheibe – antippen trägt das Feld ein">${boardBase()}${dots}</svg>`;
}
// Feld aus Klick auf die Scheibe
function fieldAt(svg, e) {
  const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * 400 - 200, y = (e.clientY - r.top) / r.height * 400 - 200;
  const rr = Math.hypot(x, y);
  if (rr > 170) return { t: 0, m: 0, x, y: -y };
  if (rr <= 6.35) return { t: 25, m: 2, x, y: -y };
  if (rr <= 15.9) return { t: 25, m: 1, x, y: -y };
  const a = ((Math.atan2(x, -y) * 180 / Math.PI) % 360 + 360) % 360;
  return { t: SEG[Math.floor((a + 9) / 18) % 20], m: rr >= 99 && rr <= 107 ? 3 : rr >= 162 ? 2 : 1, x, y: -y };
}
const vsum = ds => ds.reduce((a, d) => a + (d.t || 0) * (d.m || 0), 0);

const markSym = n => n >= 3 ? '<span class="mk m3" aria-label="zu">ⓧ</span>' : n === 2 ? '<span class="mk m2" aria-label="2 Treffer">✕</span>'
  : n === 1 ? '<span class="mk m1" aria-label="1 Treffer">╱</span>' : '<span class="mk m0"></span>';

// ---------- Ansicht ----------
export function spielen(main) {
  let game = store.get(KEY, null), mult = 1, sure = '', cam = null, camOn = false, fix = null;
  document.body.classList.add('play');

  const save = () => store.set(KEY, game);
  // Letzte Aufnahme (antippbar zum Korrigieren), Korrektur-Hinweis und bei Kamera die Scheibe
  function extras(S, cards) {
    const L = S.last, ck = isCk(game.type);
    const lastHtml = L ? `<div class="play-last"><span class="muted small">Letzte Aufnahme · ${esc(S.P[L.p].name)}</span>
      ${game.darts.slice(L.s, L.e).map((d, k) => `<button class="${fix === L.s + k ? 'sel' : ''}" data-fix="${L.s + k}" aria-label="Dart korrigieren">${dartTxt(d)}</button>`).join('')}
      ${ck ? '' : `<b>${vsum(game.darts.slice(L.s, L.e))}</b>`}</div>` : '';
    const fixHtml = fix !== null ? `<p class="play-fix" role="status">✎ Dart ${dartTxt(game.darts[fix])} korrigieren: richtiges Feld ${camOn ? 'auf der Scheibe' : 'unten'} antippen. <button class="btn sm" data-k="fixno">Abbrechen</button></p>` : '';
    const board = '';
    return lastHtml + fixHtml + board;
  }
  // ---------- Kamera-Ansicht (an Autodarts/Scolia angelehnt): Spieler oben, Live-Bild in der Mitte, Aufnahme rechts ----------
  let liveK = store.get('vynen-live-k', 0), liveV = null;
  const liveVids = new Map();
  function adView(o) {
    const S = o.S, from = S.inVisit ? game.darts.length - S.inVisit : S.last ? S.last.s : game.darts.length, to = S.inVisit ? game.darts.length : S.last ? S.last.e : from;
    const cur = S.inVisit ? game.darts.slice(from, to) : [];
    const lastTxt = L => L ? game.darts.slice(L.s, L.e).map(dartTxt).join(' ') + (o.ck ? '' : ` = ${vsum(game.darts.slice(L.s, L.e))}`) : '';
    const vs = cam && cam.views || [];
    const tabs = [...vs.map((v, k) => `<button class="${liveK === k ? 'on' : ''}" data-live="${k}">📷 ${vs.length > 1 ? k + 1 : 'Live'}</button>`), `<button class="${liveK === 'b' || !vs.length ? 'on' : ''}" data-live="b">🎯 Scheibe</button>`].join('');
    const slots = [0, 1, 2].map(k => { const i = from + k, d = game.darts[i];
      return d && i < to ? `<button class="ad-slot f ${fix === i ? 'sel' : ''}" data-fix="${i}" aria-label="Dart ${k + 1} korrigieren">${dartTxt(d)}</button>` : '<span class="ad-slot"></span>'; }).join('');
    return `<div class="wrap play-g ad">
      <div class="ad-players">${o.cards.map((c, i) => `<div class="ad-pc ${c.on ? 'on' : ''} ${c.gone ? 'gone' : ''}">
        <div class="ad-pn">${esc(c.name)}</div><div class="ad-big">${c.main}</div>
        <div class="ad-ps">${c.sub}</div>${S.lastBy && S.lastBy[i] ? `<div class="ad-pl"><small>Letzte</small> ${lastTxt(S.lastBy[i])}</div>` : ''}</div>`).join('')}</div>
      <div class="ad-main">
        <div class="ad-center"><div class="ad-tabs">${tabs}</div><div class="ad-live" data-livehost></div></div>
        <div class="ad-side">
          <div class="muted small">${esc(o.title)}</div>
          <div class="ad-turn">${esc(S.P[S.cur].name)}</div>
          <div class="ad-slots" aria-live="polite">${slots}</div>
          <div class="ad-sum">${S.inVisit ? (o.ck ? '' : vsum(cur)) : S.last ? `<small>Letzte Aufnahme</small> ${lastTxt(S.last)}` : ''}</div>
          ${o.info ? `<p class="play-info">${o.info}</p>` : ''}
          ${fix !== null ? `<p class="play-fix" role="status">✎ ${dartTxt(game.darts[fix])} korrigieren: richtiges Feld im Bild oder auf der Scheibe antippen. <button class="btn sm" data-k="fixno">Abbrechen</button></p>` : '<p class="muted small">Falsch erkannt? Dart oben antippen, dann das richtige Feld.</p>'}
          <div class="bbtns ad-act"><button class="btn" data-t="0">Fehlwurf</button><button class="btn" data-k="undo" ${game.darts.length ? '' : 'disabled'}>↶ Rückgängig</button>
            <button class="btn" data-k="next" ${S.inVisit ? '' : 'disabled'}>Aufnahme beenden</button>
            <button class="btn on" data-k="cam">Erkennung aus</button>
            <button class="btn ghost ${sure === 'quit' ? 'warn' : ''}" data-k="quit">${sure === 'quit' ? 'Wirklich beenden?' : 'Spiel abbrechen'}</button></div>
        </div></div></div>`;
  }
  // Live-Bild (eigenes <video> auf denselben Stream) mit Ringen und Darts; Tippen = Feld eintragen
  function mountLive() {
    const host = main.querySelector('[data-livehost]'); if (!host) return;
    const S = isCk(game.type) ? replay(game) : run(game);
    const from = S.inVisit ? game.darts.length - S.inVisit : S.last ? S.last.s : game.darts.length, to = S.inVisit ? game.darts.length : S.last ? S.last.e : from;
    const list = game.darts.slice(from, to).map((d, k) => [from + k, d]);
    const vs = cam && cam.views || [];
    if (liveK === 'b' || !vs.length) { liveV = null; host.innerHTML = `<div class="play-bd">${boardSvg(list, fix)}</div>`; return; }
    const v = vs[Math.min(liveK, vs.length - 1)]; liveV = v;
    let el = liveVids.get(v.stream);
    if (!el) { el = document.createElement('video'); el.muted = true; el.playsInline = true; el.autoplay = true; el.srcObject = v.stream; liveVids.set(v.stream, el); }
    el.className = 'ad-vid'; host.appendChild(el); el.play().catch(() => {});
    const oc = document.createElement('canvas'); oc.className = 'ad-ov'; host.appendChild(oc);
    const draw = () => {
      if (!el.videoWidth) return void setTimeout(draw, 150);
      const W = host.clientWidth, Hh = host.clientHeight, r = el.videoWidth / el.videoHeight;
      let w = W, h = W / r; if (h > Hh) { h = Hh; w = Hh * r; }
      Object.assign(oc.style, { left: (W - w) / 2 + 'px', top: (Hh - h) / 2 + 'px', width: w + 'px', height: h + 'px' });
      const cw = oc.width = Math.round(w * 2), ch = oc.height = Math.round(h * 2), c = oc.getContext('2d');
      c.strokeStyle = 'rgba(0,255,140,.55)'; c.lineWidth = 2;
      for (const rr of [170, 162, 107, 99, 15.9, 6.35]) { c.beginPath();
        for (let a = 0; a <= 360; a += 5) { const [x, y] = hApply(v.Hinv, rr * Math.cos(a * Math.PI / 180), rr * Math.sin(a * Math.PI / 180)); a ? c.lineTo(x * cw, y * ch) : c.moveTo(x * cw, y * ch); } c.stroke(); }
      list.forEach(([i, d], k) => { const p = dartPos(d); if (!p) return; const [x, y] = hApply(v.Hinv, p[0], -p[1]);
        c.fillStyle = i === fix ? '#00e0ff' : '#ffcc00'; c.strokeStyle = '#000'; c.lineWidth = 3; c.beginPath(); c.arc(x * cw, y * ch, 22, 0, 7); c.fill(); c.stroke();
        c.fillStyle = '#000'; c.font = 'bold 24px sans-serif'; c.textAlign = 'center'; c.fillText(String(k + 1), x * cw, y * ch + 8); });
    };
    requestAnimationFrame(draw);
  }
  // Dart eintragen oder (im Korrekturmodus) ersetzen
  function enter(d, viaCam) {
    if (fix !== null && game.darts[fix]) { game.darts[fix] = d; fix = null; save(); if (cam && cam.active) cam.clear(); return play(); }
    game.darts.push(d); mult = 1; save();
    if (!viaCam && cam && cam.active) cam.manual();
    if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
    return play();
  }

  function setup() {
    const s = store.get(KEY_SETUP, { type: 'cricket', variant: 'std', players: [] });
    if (!isCk(s.type) && !DEFS[s.type]) s.type = 'cricket';
    s.opts = s.opts || {};
    const opts = () => optionsOf(s.type, s.opts[s.type]);
    s.knums = s.knums || {};
    const manualNums = () => s.type === 'killer' && opts().assign === 'manual';
    // Killer mit selbst geworfenen Zahlen: alle brauchen eine Zahl, keine doppelt
    const numsOk = () => { if (!manualNums()) return true; const v = players.map(n => Number(s.knums[n]) || 0); return v.every(x => x) && new Set(v).size === v.length; };
    let players = [...s.players];
    const draw = () => {
      main.innerHTML = `<div class="wrap play-setup"><h1 class="tt">Spielen</h1>
        <p class="muted">Cricket, X01, Party- und Trainingsspiele an einem Board. Läuft nur auf diesem Gerät, ohne Anmeldung.</p>
        <label class="flabel" for="gt">Spiel</label>${gameSelect(s.type)}
        ${isCk(s.type) ? `<label class="flabel" for="gv">Variante</label><select id="gv">${Object.entries(VARIANTS).map(([k, v]) => `<option value="${k}" ${s.variant === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <p class="muted small">${s.variant === 'std' ? 'Treffer auf eigene offene Zahlen geben Punkte, solange ein Gegner sie noch nicht zu hat. Sieger: alles zu und mindestens gleich viele Punkte.'
          : s.variant === 'cut' ? 'Treffer auf eigene offene Zahlen schreiben jedem Gegner Punkte auf, der sie noch nicht zu hat. Sieger: alles zu und die wenigsten Punkte.'
          : 'Es zählt nur das Schließen. Wer zuerst alle Zahlen zu hat, gewinnt.'}</p>`
        : `<div class="play-opts">${DEFS[s.type].opts.map(o => `<div><label class="flabel" for="go-${o.k}">${o.label}</label><select id="go-${o.k}" data-opt="${o.k}">${o.choices.map(([v, l]) =>
            `<option value="${v}" ${String(opts()[o.k]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`).join('')}</div>
          <p class="muted small">${DEFS[s.type].rules(opts())}</p>`}
        <div class="flabel">Spieler (${players.length})</div>
        <form id="pa" class="bbtns addrow"><input id="pn" maxlength="24" placeholder="Name" aria-label="Spielername" autocomplete="off">
          <button class="btn pri" type="submit">Hinzufügen</button></form>
        <ol class="list play-pl">${players.map((n, i) => `<li><span><span class="muted">${i + 1}.</span> ${esc(n)}</span>
          ${manualNums() ? `<select class="knum" data-knum="${esc(n)}" aria-label="Zahl von ${esc(n)}"><option value="">Zahl</option>${Array.from({ length: 20 }, (_, k) => k + 1).map(v =>
            `<option value="${v}" ${Number(s.knums[n]) === v ? 'selected' : ''}>${v}</option>`).join('')}</select>` : ''}
          <span class="bbtns"><button class="btn sm" data-up="${i}" aria-label="${esc(n)} nach oben" ${i ? '' : 'disabled'}>↑</button>
          <button class="btn sm" data-rm="${i}" aria-label="${esc(n)} entfernen">✕</button></span></li>`).join('') || `<li class="muted">Noch keine Spieler. ${minPlayers(s.type) > 1 ? 'Mindestens zwei eintragen.' : 'Mindestens einen eintragen.'}</li>`}</ol>
        <div class="bbtns"><button class="btn" data-k="shuffle" ${players.length > 1 ? '' : 'disabled'}>Reihenfolge auslosen</button>
          <button class="btn pri big" data-k="start" ${players.length >= minPlayers(s.type) && numsOk() ? '' : 'disabled'}>Spiel starten</button></div>
        ${manualNums() && !numsOk() && players.length ? '<p class="muted small">Jeder Spieler braucht eine eigene Zahl. Doppelte Zahl: nochmal werfen.</p>' : ''}</div>`;
      const f = main.querySelector('#pa');
      main.querySelector('#gt').onchange = e => { s.type = e.target.value; persist(); draw(); };
      const gv = main.querySelector('#gv'); if (gv) gv.onchange = e => { s.variant = e.target.value; persist(); draw(); };
      main.querySelectorAll('[data-knum]').forEach(el => el.onchange = () => { s.knums[el.dataset.knum] = el.value; persist(); draw(); });
      main.querySelectorAll('[data-opt]').forEach(el => el.onchange = () => { s.opts[s.type] = { ...opts(), [el.dataset.opt]: el.value }; persist(); draw(); });
      f.onsubmit = e => { e.preventDefault(); const n = f.pn.value.trim(); if (n) { players.push(n); persist(); draw(); main.querySelector('#pn').focus(); } };
    };
    const persist = () => { s.players = players; store.set(KEY_SETUP, s); };
    main.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.type) { s.type = b.dataset.type; persist(); draw(); }
      else if (b.dataset.var) { s.variant = b.dataset.var; persist(); draw(); }
      else if (b.dataset.rm !== undefined) { players.splice(Number(b.dataset.rm), 1); persist(); draw(); }
      else if (b.dataset.up !== undefined) { const i = Number(b.dataset.up); [players[i - 1], players[i]] = [players[i], players[i - 1]]; persist(); draw(); }
      else if (b.dataset.k === 'shuffle') { for (let i = players.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [players[i], players[j]] = [players[j], players[i]]; } persist(); draw(); }
      else if (b.dataset.k === 'start') { game = { type: s.type, variant: s.variant, opts: isCk(s.type) ? null : opts(), nums: manualNums() ? players.map(n => Number(s.knums[n])) : null, players: [...players], darts: [], started: Date.now(), seed: (Math.random() * 1e9) | 0 }; save(); mult = 1; play(); }
    };
    draw();
  }

  function play() {
    main.onclick = onPlay;
    if (fix !== null && !game.darts[fix]) fix = null;
    if (!isCk(game.type)) return playGeneric();
    const st = replay(game), g = GAMES[game.type];
    if (st.winner !== null) return finish(st);
    const p = st.P[st.cur];
    if (camOn) {
      main.innerHTML = adView({ S: st, ck: true, title: `${g.name} · ${VARIANTS[game.variant]}`, info: '', cards: st.P.map((x, i) => ({ name: x.name, on: i === st.cur,
        main: game.variant === 'none' ? `${st.T.filter(t => x.marks[t] >= 3).length}/${st.T.length}` : x.pts,
        sub: st.T.map(t => `<span class="${st.dead.has(t) ? 'dead' : ''}"><small>${lbl(t)}</small>${markSym(x.marks[t])}</span>`).join('') })) });
      mountLive(); if (cam && cam.active) cam.sync(); return;
    }
    const rows = st.P.map((x, i) => `<tr class="${i === st.cur ? 'on' : ''}"><th scope="row"><span class="pn">${esc(x.name)}</span></th>
      ${game.variant === 'none' ? '' : `<td class="pts">${x.pts}</td>`}${st.T.map(t => `<td class="${st.dead.has(t) ? 'dead' : ''}">${markSym(x.marks[t])}</td>`).join('')}</tr>`).join('');
    main.innerHTML = `<div class="wrap play-g">
      <div class="play-top"><div><span class="muted small">${g.name} · ${VARIANTS[game.variant]}</span>
        <h2 class="play-turn">${esc(p.name)} <span class="muted">ist dran</span></h2></div>
        <div class="play-visit" aria-live="polite">${[0, 1, 2].map(k => st.visit[k] ? `<button class="f ${fix === game.darts.length - st.inVisit + k ? 'sel' : ''}" data-fix="${game.darts.length - st.inVisit + k}" aria-label="Dart ${k + 1} korrigieren">${dartTxt(st.visit[k])}</button>` : '<span></span>').join('')}</div></div>
      ${extras(st, st.P.map((x, i) => ({ name: x.name, on: i === st.cur, main: game.variant === 'none' ? '' : x.pts,
        sub: st.T.map(t => `<span class="${st.dead.has(t) ? 'dead' : ''}"><small>${lbl(t)}</small>${markSym(x.marks[t])}</span>`).join('') })))}
      ${camOn ? '' : `<div class="tbl-scroll play-board"><table class="tbl ck"><thead><tr><th>Spieler</th>${game.variant === 'none' ? '' : '<th>Pkt</th>'}
        ${st.T.map(t => `<th class="${st.dead.has(t) ? 'dead' : ''}">${lbl(t)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`}
      <div class="play-pad">${camOn ? '' : `
        <div class="seg mult" role="radiogroup" aria-label="Multiplikator">${[1, 2, 3].map(m => `<button data-m="${m}" class="${mult === m ? 'on' : ''}" role="radio" aria-checked="${mult === m}">${['', 'Single', 'Double', 'Triple'][m]}</button>`).join('')}</div>
        <div class="tg ${st.T.length > 7 ? 'many' : ''}">${st.T.map(t => {
          const mine = p.marks[t] >= 3, off = (t === 25 && mult === 3);
          return `<button data-t="${t}" class="${st.dead.has(t) ? 'dead' : mine ? 'mine' : ''}" ${off ? 'disabled' : ''}>${lbl(t)}</button>`; }).join('')}
          <button data-t="0" class="miss">Fehlwurf</button></div>`}
        <div class="bbtns play-act">${camOn ? '<button class="btn" data-t="0">Fehlwurf</button>' : ''}<button class="btn" data-k="undo" ${game.darts.length ? '' : 'disabled'}>↶ Rückgängig</button>
          <button class="btn" data-k="next" ${st.inVisit ? '' : 'disabled'}>Aufnahme beenden</button>
          ${navigator.mediaDevices ? `<button class="btn ${camOn ? 'on' : ''}" data-k="cam">📷 Kamera (Beta)</button>` : ''}
          ${navigator.mediaDevices && PC && !camOn ? `<button class="btn" data-k="cam3" title="Mehrere USB-Kameras am PC (z. B. Autodarts-Kameras)">🎥 3 Kameras</button>` : ''}
          ${!camOn ? `<button class="btn" data-k="adk" title="Autodarts erkennt die Würfe, die App zählt">🎯 Autodarts</button>` : ''}
          <button class="btn ghost ${sure === 'quit' ? 'warn' : ''}" data-k="quit">${sure === 'quit' ? 'Wirklich beenden?' : 'Spiel abbrechen'}</button></div>
      </div></div>`;
    if (cam && cam.active) cam.sync();
  }

  function finish(st) {
    main.onclick = onPlay;
    const r = ranking(game, st), g = GAMES[game.type];
    const closed = p => st.T.filter(t => p.marks[t] >= 3).length;
    main.innerHTML = `<div class="wrap play-end"><span class="muted small">${g.name} · ${VARIANTS[game.variant]}</span>
      <h1 class="tt">🏆 ${esc(st.P[st.winner].name)} gewinnt</h1>
      <ol class="list play-rank">${r.map((p, k) => `<li class="${k === 0 ? 'w' : ''}"><span><b>${k + 1}.</b> ${esc(p.name)}</span>
        <span class="muted">${closed(p)}/${st.T.length} zu${game.variant === 'none' ? '' : ` · ${p.pts} Pkt`} · ${p.darts} Darts · ${p.darts ? (p.hits / p.darts * 3).toFixed(2).replace('.', ',') : '0'} MPR</span></li>`).join('')}</ol>
      <p class="muted small">MPR = Treffer (Marks) pro Aufnahme.</p>
      <div class="bbtns"><button class="btn" data-k="undo">↶ Letzten Dart zurück</button>
        <button class="btn pri big" data-k="rematch">Revanche</button><button class="btn" data-k="new">Neues Spiel</button></div></div>`;
  }

  // ---------- Alle anderen Spiele (games.js) ----------
  const pad = (hl, p) => `<div class="play-pad">${camOn ? '' : `
        <div class="seg mult" role="radiogroup" aria-label="Multiplikator">${[1, 2, 3].map(m => `<button data-m="${m}" class="${mult === m ? 'on' : ''}" role="radio" aria-checked="${mult === m}">${['', 'Single', 'Double', 'Triple'][m]}</button>`).join('')}</div>
        <div class="tg all">${ALL.map(t => `<button data-t="${t}" class="${hl.includes(t) ? 'mine' : ''}" ${t === 25 && mult === 3 ? 'disabled' : ''}>${lbl(t)}</button>`).join('')}
          <button data-t="0" class="miss">Fehlwurf</button></div>`}
        <div class="bbtns play-act">${camOn ? '<button class="btn" data-t="0">Fehlwurf</button>' : ''}<button class="btn" data-k="undo" ${game.darts.length ? '' : 'disabled'}>↶ Rückgängig</button>
          <button class="btn" data-k="next" ${p.inVisit ? '' : 'disabled'}>Aufnahme beenden</button>
          ${navigator.mediaDevices ? `<button class="btn ${camOn ? 'on' : ''}" data-k="cam">📷 Kamera (Beta)</button>` : ''}
          ${navigator.mediaDevices && PC && !camOn ? `<button class="btn" data-k="cam3" title="Mehrere USB-Kameras am PC (z. B. Autodarts-Kameras)">🎥 3 Kameras</button>` : ''}
          ${!camOn ? `<button class="btn" data-k="adk" title="Autodarts erkennt die Würfe, die App zählt">🎯 Autodarts</button>` : ''}
          <button class="btn ghost ${sure === 'quit' ? 'warn' : ''}" data-k="quit">${sure === 'quit' ? 'Wirklich beenden?' : 'Spiel abbrechen'}</button></div></div>`;
  function playGeneric() {
    const def = DEFS[game.type], S = run(game);
    if (S.over) return finishGeneric(S);
    const p = S.P[S.cur];
    const rows = S.P.map(x => `<tr class="${x.i === S.cur ? 'on' : ''} ${x.out ? 'gone' : ''}"><th scope="row"><span class="pn">${esc(x.name)}</span></th>${def.row(x, S).map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    const cols = typeof def.cols === 'function' ? def.cols(S) : def.cols;
    if (camOn) {
      main.innerHTML = adView({ S, ck: false, title: def.name, info: esc(def.info ? def.info(S) : '') + (S.note ? ` <span class="play-note" role="status">${esc(S.note)}</span>` : ''),
        cards: S.P.map(x => { const c = def.row(x, S); let mi = c.findIndex(v => /class="big"/.test(String(v))); if (mi < 0) mi = 0;
          return { name: x.name, on: x.i === S.cur, gone: x.out, main: c[mi], sub: cols.map((h, k) => k === mi ? '' : `<span><small>${h}</small> ${c[k]}</span>`).join('') }; }) });
      mountLive(); if (cam && cam.active) cam.sync(); return;
    }
    main.innerHTML = `<div class="wrap play-g">
      <div class="play-top"><div><span class="muted small">${esc(def.name)}</span>
        <h2 class="play-turn">${esc(p.name)} <span class="muted">ist dran</span></h2></div>
        <div class="play-visit" aria-live="polite">${[0, 1, 2].map(k => S.visit[k] ? `<button class="f ${fix === game.darts.length - S.inVisit + k ? 'sel' : ''}" data-fix="${game.darts.length - S.inVisit + k}" aria-label="Dart ${k + 1} korrigieren">${dartTxt(S.visit[k])}</button>` : '<span></span>').join('')}</div></div>
      <p class="play-info">${esc(def.info ? def.info(S) : '')}${S.note ? ` <span class="play-note" role="status">${esc(S.note)}</span>` : ''}</p>
      ${extras(S, S.P.map(x => { const c = def.row(x, S); return { name: x.name, on: x.i === S.cur, gone: x.out, main: c[0],
        sub: cols.slice(1).map((h, k) => `<span><small>${h}</small>${c[k + 1]}</span>`).join('') }; }))}
      ${camOn ? '' : `<div class="tbl-scroll play-board"><table class="tbl ck gen"><thead><tr><th>Spieler</th>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`}
      ${pad(def.highlight ? def.highlight(S) : [], S)}</div>`;
    if (cam && cam.active) cam.sync();
  }
  function finishGeneric(S) {
    const def = DEFS[game.type], r = def.rank(S);
    const w = S.winner !== null ? S.P[S.winner] : r[0];
    main.innerHTML = `<div class="wrap play-end"><span class="muted small">${esc(def.name)}</span>
      <h1 class="tt">🏆 ${esc(w.name)} gewinnt</h1>${S.note ? `<p class="play-note">${esc(S.note)}</p>` : ''}
      <ol class="list play-rank">${r.map((p, k) => `<li class="${p.i === w.i ? 'w' : ''}"><span><b>${k + 1}.</b> ${esc(p.name)}</span><span class="muted">${esc(p.sub)}</span></li>`).join('')}</ol>
      <div class="bbtns"><button class="btn" data-k="undo">↶ Letzten Dart zurück</button>
        <button class="btn pri big" data-k="rematch">Revanche</button><button class="btn" data-k="new">Neues Spiel</button></div></div>`;
  }

  const onPlay = e => {
    if (!game) return;
    const tab = e.target.closest('[data-live]');
    if (tab) { liveK = tab.dataset.live === 'b' ? 'b' : Number(tab.dataset.live); store.set('vynen-live-k', liveK); return play(); }
    const ov = e.target.closest('.ad-ov');
    if (ov && liveV) {
      const r = ov.getBoundingClientRect(), [bx, by] = hApply(liveV.H, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height), f = segmentAt(bx, by);
      const T = isCk(game.type) ? GAMES[game.type].targets : ALL, t = f.s && T.includes(f.s) ? f.s : 0;
      return enter({ t, m: t ? f.m : 0, x: Math.round(bx), y: Math.round(by) });
    }
    const svg = e.target.closest('.bd-svg');
    if (svg) {
      const f = fieldAt(svg, e), T = isCk(game.type) ? GAMES[game.type].targets : ALL;
      const d = { t: f.t && T.includes(f.t) ? f.t : 0, m: 0, x: Math.round(f.x), y: Math.round(f.y) }; d.m = d.t ? f.m : 0;
      return enter(d);
    }
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.dataset.k !== 'quit') sure = '';
    if (b.dataset.m) { mult = Number(b.dataset.m); return play(); }
    if (b.dataset.t !== undefined) {
      const t = Number(b.dataset.t);
      const m = t ? mult : 0; mult = 1;
      return enter({ t, m });
    }
    if (b.dataset.fix !== undefined) { const i = Number(b.dataset.fix); fix = fix === i ? null : i; return play(); }
    switch (b.dataset.k) {
      case 'cam': case 'cam3': case 'adk':
        if (camOn) { if (cam) cam.stop(); camOn = false; return play(); }
        camOn = true;
        cam = (b.dataset.k === 'adk' ? createAutodarts : createCamera)({ multi: b.dataset.k === 'cam3', targets: isCk(game.type) ? GAMES[game.type].targets : ALL, visitInfo: () => ({ inVisit: isCk(game.type) ? replay(game).inVisit : run(game).inVisit }),
          onDart: (t, m, b) => { if (!game) return; const d = { t, m: t ? m : 0 }; if (b) { d.x = Math.round(b[0] * 10) / 10; d.y = Math.round(b[1] * 10) / 10; } enter(d, true); },
          onClose: () => { camOn = false; play(); }, onReady: () => { if (game) play(); } });
        cam.start(); return play();
      case 'undo': game.darts.pop(); fix = null; save(); return play();
      case 'fixno': fix = null; return play();
      case 'next': { const st = isCk(game.type) ? replay(game) : run(game); for (let k = st.inVisit; k < 3; k++) game.darts.push({ t: 0, m: 0 }); save(); return play(); }
      case 'quit': if (sure !== 'quit') { sure = 'quit'; return play(); } sure = ''; game = null; fix = null; store.del(KEY); if (cam) cam.stop(); camOn = false; return setup();
      case 'rematch': {
        // Revanche: gleiche Spieler, der bisherige Startspieler rückt ans Ende
        const pl = [...game.players.slice(1), game.players[0]];
        const nums = game.nums ? [...game.nums.slice(1), game.nums[0]] : null;
        game = { ...game, players: pl, nums, darts: [], started: Date.now(), seed: (Math.random() * 1e9) | 0 }; save(); mult = 1; return play();
      }
      case 'new': game = null; fix = null; store.del(KEY); if (cam) cam.stop(); camOn = false; return setup();
    }
  };
  if (game) play(); else setup();
  return () => { if (cam) cam.stop(); main.onclick = null; document.body.classList.remove('play'); };
}
