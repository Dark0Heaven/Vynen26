// Freies Spiel: Cricket und Tactics für beliebig viele Spieler, nur auf diesem Gerät (kein Login, keine Datenbank)
import { esc, store } from './db.js';
import { createCamera } from './camera.js';
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
  let cur = 0, inVisit = 0, winner = null;
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
    inVisit++;
    if (inVisit === 3) { inVisit = 0; cur = (cur + 1) % P.length; }
  }
  // Würfe der laufenden Aufnahme für die Anzeige
  if (winner === null) for (let i = game.darts.length - inVisit; i < game.darts.length; i++) visit.push(game.darts[i]);
  const dead = new Set(T.filter(t => P.every(p => p.marks[t] >= 3)));
  return { T, P, cur, inVisit, winner, visit, dead };
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
const markSym = n => n >= 3 ? '<span class="mk m3" aria-label="zu">ⓧ</span>' : n === 2 ? '<span class="mk m2" aria-label="2 Treffer">✕</span>'
  : n === 1 ? '<span class="mk m1" aria-label="1 Treffer">╱</span>' : '<span class="mk m0"></span>';

// ---------- Ansicht ----------
export function spielen(main) {
  let game = store.get(KEY, null), mult = 1, sure = '', cam = null;
  document.body.classList.add('play');

  const save = () => store.set(KEY, game);

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
    if (!isCk(game.type)) return playGeneric();
    const st = replay(game), g = GAMES[game.type];
    if (st.winner !== null) return finish(st);
    const p = st.P[st.cur];
    const rows = st.P.map((x, i) => `<tr class="${i === st.cur ? 'on' : ''}"><th scope="row"><span class="pn">${esc(x.name)}</span></th>
      ${game.variant === 'none' ? '' : `<td class="pts">${x.pts}</td>`}${st.T.map(t => `<td class="${st.dead.has(t) ? 'dead' : ''}">${markSym(x.marks[t])}</td>`).join('')}</tr>`).join('');
    main.innerHTML = `<div class="wrap play-g">
      <div class="play-top"><div><span class="muted small">${g.name} · ${VARIANTS[game.variant]}</span>
        <h2 class="play-turn">${esc(p.name)} <span class="muted">ist dran</span></h2></div>
        <div class="play-visit" aria-live="polite">${[0, 1, 2].map(k => `<span class="${st.visit[k] ? 'f' : ''}">${st.visit[k] ? dartTxt(st.visit[k]) : ''}</span>`).join('')}</div></div>
      <div class="tbl-scroll play-board"><table class="tbl ck"><thead><tr><th>Spieler</th>${game.variant === 'none' ? '' : '<th>Pkt</th>'}
        ${st.T.map(t => `<th class="${st.dead.has(t) ? 'dead' : ''}">${lbl(t)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
      <div class="play-pad">
        <div class="seg mult" role="radiogroup" aria-label="Multiplikator">${[1, 2, 3].map(m => `<button data-m="${m}" class="${mult === m ? 'on' : ''}" role="radio" aria-checked="${mult === m}">${['', 'Single', 'Double', 'Triple'][m]}</button>`).join('')}</div>
        <div class="tg ${st.T.length > 7 ? 'many' : ''}">${st.T.map(t => {
          const mine = p.marks[t] >= 3, off = (t === 25 && mult === 3);
          return `<button data-t="${t}" class="${st.dead.has(t) ? 'dead' : mine ? 'mine' : ''}" ${off ? 'disabled' : ''}>${lbl(t)}</button>`; }).join('')}
          <button data-t="0" class="miss">Fehlwurf</button></div>
        <div class="bbtns play-act"><button class="btn" data-k="undo" ${game.darts.length ? '' : 'disabled'}>↶ Rückgängig</button>
          <button class="btn" data-k="next" ${st.inVisit ? '' : 'disabled'}>Aufnahme beenden</button>
          ${navigator.mediaDevices ? `<button class="btn ${cam && cam.active ? 'on' : ''}" data-k="cam">📷 Kamera (Beta)</button>` : ''}
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
  const pad = (hl, p) => `<div class="play-pad">
        <div class="seg mult" role="radiogroup" aria-label="Multiplikator">${[1, 2, 3].map(m => `<button data-m="${m}" class="${mult === m ? 'on' : ''}" role="radio" aria-checked="${mult === m}">${['', 'Single', 'Double', 'Triple'][m]}</button>`).join('')}</div>
        <div class="tg all">${ALL.map(t => `<button data-t="${t}" class="${hl.includes(t) ? 'mine' : ''}" ${t === 25 && mult === 3 ? 'disabled' : ''}>${lbl(t)}</button>`).join('')}
          <button data-t="0" class="miss">Fehlwurf</button></div>
        <div class="bbtns play-act"><button class="btn" data-k="undo" ${game.darts.length ? '' : 'disabled'}>↶ Rückgängig</button>
          <button class="btn" data-k="next" ${p.inVisit ? '' : 'disabled'}>Aufnahme beenden</button>
          ${navigator.mediaDevices ? `<button class="btn ${cam && cam.active ? 'on' : ''}" data-k="cam">📷 Kamera (Beta)</button>` : ''}
          <button class="btn ghost ${sure === 'quit' ? 'warn' : ''}" data-k="quit">${sure === 'quit' ? 'Wirklich beenden?' : 'Spiel abbrechen'}</button></div></div>`;
  function playGeneric() {
    const def = DEFS[game.type], S = run(game);
    if (S.over) return finishGeneric(S);
    const p = S.P[S.cur];
    const rows = S.P.map(x => `<tr class="${x.i === S.cur ? 'on' : ''} ${x.out ? 'gone' : ''}"><th scope="row"><span class="pn">${esc(x.name)}</span></th>${def.row(x, S).map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    const cols = typeof def.cols === 'function' ? def.cols(S) : def.cols;
    main.innerHTML = `<div class="wrap play-g">
      <div class="play-top"><div><span class="muted small">${esc(def.name)}</span>
        <h2 class="play-turn">${esc(p.name)} <span class="muted">ist dran</span></h2></div>
        <div class="play-visit" aria-live="polite">${[0, 1, 2].map(k => `<span class="${S.visit[k] ? 'f' : ''}">${S.visit[k] ? dartTxt(S.visit[k]) : ''}</span>`).join('')}</div></div>
      <p class="play-info">${esc(def.info ? def.info(S) : '')}${S.note ? ` <span class="play-note" role="status">${esc(S.note)}</span>` : ''}</p>
      <div class="tbl-scroll play-board"><table class="tbl ck gen"><thead><tr><th>Spieler</th>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
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
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.dataset.k !== 'quit') sure = '';
    if (b.dataset.m) { mult = Number(b.dataset.m); return play(); }
    if (b.dataset.t !== undefined) {
      const t = Number(b.dataset.t);
      game.darts.push({ t, m: t ? mult : 0 }); mult = 1; save();
      if (cam && cam.active) cam.manual();
      if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
      return play();
    }
    switch (b.dataset.k) {
      case 'cam':
        if (cam && cam.active) { cam.stop(); return play(); }
        cam = createCamera({ targets: isCk(game.type) ? GAMES[game.type].targets : ALL, visitInfo: () => ({ inVisit: isCk(game.type) ? replay(game).inVisit : run(game).inVisit }),
          onDart: (t, m) => { if (!game) return; game.darts.push({ t, m: t ? m : 0 }); mult = 1; save(); play(); }, onClose: () => play() });
        cam.start(); return play();
      case 'undo': game.darts.pop(); save(); return play();
      case 'next': { const st = isCk(game.type) ? replay(game) : run(game); for (let k = st.inVisit; k < 3; k++) game.darts.push({ t: 0, m: 0 }); save(); return play(); }
      case 'quit': if (sure !== 'quit') { sure = 'quit'; return play(); } sure = ''; game = null; store.del(KEY); if (cam) cam.stop(); return setup();
      case 'rematch': {
        // Revanche: gleiche Spieler, der bisherige Startspieler rückt ans Ende
        const pl = [...game.players.slice(1), game.players[0]];
        const nums = game.nums ? [...game.nums.slice(1), game.nums[0]] : null;
        game = { ...game, players: pl, nums, darts: [], started: Date.now(), seed: (Math.random() * 1e9) | 0 }; save(); mult = 1; return play();
      }
      case 'new': game = null; store.del(KEY); if (cam) cam.stop(); return setup();
    }
  };
  if (game) play(); else setup();
  return () => { if (cam) cam.stop(); main.onclick = null; document.body.classList.remove('play'); };
}
