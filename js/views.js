// Öffentliche Ansichten: Live, Turnierbaum, Tabelle & Highlights, Halle
import { esc } from './db.js';
import { roundName, OUT_LABEL } from './rules.js';
import { watchTournament } from './data.js';

const fmt = v => v ? v.toFixed(1).replace('.', ',') : '–';
const noData = '<div class="empty pd"><h2>Noch kein Turnier</h2><p class="muted">Sobald die Turnierleitung ein Turnier anlegt, erscheint es hier live.</p></div>';
const offline = '<p class="pd">Keine Verbindung. Die Seite versucht es automatisch weiter.</p>';

function mount(main, render) {
  main.innerHTML = '<p class="muted pd">Lade Turnier …</p>';
  return watchTournament(d => { main.innerHTML = d ? render(d) : noData; }, () => { if (!main.innerHTML.includes('wrap')) main.innerHTML = offline; });
}

// ---------- Board-Kachel (Live + Halle) ----------
function boardTile(d, b, big) {
  const m = d.matches.find(x => x.board === b && ['live', 'review'].includes(x.status));
  if (!m) return `<article class="bd free"><div class="bd-no">${b}</div><p class="muted">Frei</p></article>`;
  const st = m.st;
  const call = !m.vis.length && st.needBull && st.leg === 1;
  const side = i => `<div class="bd-p ${st.turn === i ? 'on' : ''}"><span class="n">${esc(d.pname(i ? m.player_b : m.player_a))}</span>
    <span class="l">${st.legs[i]}</span><span class="r">${st.finished ? '' : st.rem[i]}</span></div>`;
  const tag = m.status === 'review' ? '<span class="tag gold">Ende</span>'
    : call ? `<span class="tag gold">${big ? 'Bitte ans Board' : 'Aufruf'}</span>`
    : st.needBull ? '<span class="tag">Ausbullen</span>' : '<span class="tag live">Live</span>';
  return `<article class="bd ${call ? 'call' : ''}"><div class="bd-h"><span class="bd-no">${b}</span>
    <span class="muted">${esc(roundName(d.t, m))} · Bo${m.cfg.bo}</span>${tag}</div>${side(0)}${side(1)}</article>`;
}

function queue(d, n) {
  const ready = d.matches.filter(m => m.status === 'ready').sort((a, b) => a.round - b.round || (a.kind > b.kind ? 1 : -1) || a.idx - b.idx);
  if (!ready.length) return '<p class="muted">Keine wartenden Spiele.</p>';
  return `<ol class="list">${ready.slice(0, n).map(m =>
    `<li><span>${esc(d.pname(m.player_a))} <i>vs</i> ${esc(d.pname(m.player_b))}</span><span class="muted">${esc(roundName(d.t, m))}</span></li>`).join('')}</ol>`;
}

function recent(d, n) {
  const done = d.matches.filter(m => m.status === 'done').sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, n);
  if (!done.length) return '';
  return `<ol class="list">${done.map(m =>
    `<li><span>${esc(d.pname(m.player_a))} <b>${m.legs_a}:${m.legs_b}</b> ${esc(d.pname(m.player_b))}</span><span class="muted">${esc(roundName(d.t, m))}</span></li>`).join('')}</ol>`;
}

function champ(d) {
  const top = d.stats.filter(p => p.place && p.place <= 3).sort((a, b) => a.place - b.place);
  if (!top.length) return '';
  return `<div class="podium">${top.map(p => `<div class="pod p${p.place}"><span>${p.place}.</span><b>${esc(p.name)}</b></div>`).join('')}</div>`;
}

// ---------- Live ----------
export function live(main) {
  return mount(main, d => {
    const boards = []; for (let b = 1; b <= d.t.boards; b++) boards.push(boardTile(d, b, false));
    const r = recent(d, 6);
    return `<div class="wrap"><div class="adm-head"><h1 class="tt">${esc(d.t.name)}</h1><a class="btn sm" href="#halle">Hallen-Anzeige</a></div>${champ(d)}
      <h2 class="sec">Boards</h2><div class="boards">${boards.join('')}</div>
      <h2 class="sec">Als Nächstes</h2>${queue(d, 8)}
      ${r ? `<h2 class="sec">Zuletzt beendet</h2>${r}` : ''}</div>`;
  });
}

// ---------- Turnierbaum (mit Verbindungslinien) ----------
function bracketHtml(d) {
  const { t, R } = d;
  const W = 210, H = 76, X = 46, U = H + 14, TOP = 34;
  const cy = (r, i) => TOP + U * Math.pow(2, r) * (i + 0.5);
  const cx = r => r * (W + X);
  const card = (m, x, y) => {
    const st = m.st;
    const row = i => {
      const id = i ? m.player_b : m.player_a, bye = i ? m.bye_b : m.bye_a;
      const p = d.stats.find(z => z.id === id);
      if (!id) return `<div class="row ${bye ? 'bye' : 'tbd'}"><span class="seed"></span><span class="nm">${bye ? 'Freilos' : ''}</span><span class="lg"></span></div>`;
      const fin = ['done', 'wo', 'bye'].includes(m.status);
      const win = fin && m.winner === id, lose = fin && m.winner && m.winner !== id;
      const legs = m.status === 'done' ? (i ? m.legs_b : m.legs_a) : st ? st.legs[i] : m.status === 'wo' && lose ? 'w.o.' : '';
      return `<div class="row ${win ? 'w' : ''} ${lose ? 'l' : ''}"><span class="seed">${p ? p.seed : ''}</span>
        <span class="nm">${esc(d.pname(id))}${p && p.withdrawn ? ' <small>(zg.)</small>' : ''}</span><span class="lg">${legs}</span></div>`;
    };
    const badge = ['live', 'review'].includes(m.status) ? `<span class="mbadge">B${m.board}</span>` : '';
    return `<div class="match bk-m ${m.status}" style="left:${x}px;top:${y}px;width:${W}px;height:${H}px">${badge}${row(0)}${row(1)}</div>`;
  };
  let cards = '', heads = '', lines = '';
  for (let r = 0; r < R; r++) {
    const ms = d.matches.filter(m => m.kind === 'ko' && m.round === r);
    if (!ms.length) continue;
    const c = ms[0].cfg;
    heads += `<div class="bk-h" style="left:${cx(r)}px;width:${W}px">${esc(roundName(t, ms[0]))}<span>Bo${c.bo} · ${c.start}</span></div>`;
    for (const m of ms) {
      cards += card(m, cx(r), cy(r, m.idx) - H / 2);
      if (r < R - 1) {
        const x1 = cx(r) + W, xm = x1 + X / 2, y1 = cy(r, m.idx), y2 = cy(r + 1, m.idx >> 1);
        const on = ['done', 'wo', 'bye'].includes(m.status) && m.winner;
        lines += `<path class="${on ? 'on' : ''}" d="M${x1} ${y1}H${xm}V${y2}H${cx(r + 1)}"/>`;
      }
    }
  }
  let height = TOP + U * (t.size / 2);
  const p3 = d.matches.find(m => m.kind === 'p3');
  if (p3) {
    const y = cy(R - 1, 0) + H / 2 + 56;
    heads += `<div class="bk-h" style="left:${cx(R - 1)}px;top:${y - 26}px;width:${W}px">Spiel um Platz 3</div>`;
    cards += card(p3, cx(R - 1), y);
    height = Math.max(height, y + H + 10);
  }
  const width = R * W + (R - 1) * X;
  return `<div class="bk" style="width:${width}px;height:${height}px"><svg class="bk-l" width="${width}" height="${height}" aria-hidden="true">${lines}</svg>${heads}${cards}</div>`;
}

export function baum(main) {
  return mount(main, d => `<div class="wrap"><h1 class="tt">${esc(d.t.name)}</h1>${champ(d)}
    <div class="bracket-scroll">${bracketHtml(d)}</div><p class="muted small">Auf dem Handy waagerecht wischen.</p></div>`);
}

// ---------- Tabelle & Highlights ----------
const BUCKETS = [80, 100, 120, 140, 160, 180];
export function tabelle(main) {
  return mount(main, d => {
    const list = d.stats;
    const board = (title, items, empty) => `<section class="hl"><h3>${title}</h3>${items.length
      ? `<div class="hl-top"><span class="v">${items[0].v}</span><span class="who">${esc(items[0].name)}</span></div><ol>${items.slice(1, 5)
        .map((x, i) => `<li><span>${i + 2}. ${esc(x.name)}</span><span class="v">${x.v}</span></li>`).join('')}</ol>`
      : `<p class="muted small">${empty}</p>`}</section>`;
    const hfs = list.flatMap(p => p.hfs.map(v => ({ name: p.name, v }))).sort((a, b) => b.v - a.v);
    const by = (key, f, asc) => list.filter(p => p[key]).sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]).map(p => ({ name: p.name, v: f(p[key]) }));
    const status = p => p.place ? `<span class="st ${p.place === 1 ? 'champ-st' : ''}">${p.place}. Platz</span>`
      : p.withdrawn ? '<span class="st">Zurückgezogen</span>'
      : p.out !== null ? `<span class="st">Aus · ${esc(roundName(d.t, { kind: 'ko', round: p.out }))}</span>`
      : `<span class="st in">Im ${esc(roundName(d.t, { kind: 'ko', round: p.reach }))}</span>`;
    return `<div class="wrap"><h1 class="tt">${esc(d.t.name)}</h1>
      <h2 class="sec">Highlights</h2><div class="hls">
      ${board('High Finishes (101–170)', hfs.map(x => ({ name: x.name, v: x.v })), 'Noch kein Highfinish.')}
      ${board('Bester Average (Spiel)', by('bestAvg', fmt), 'Noch kein Spiel beendet.')}
      ${board('180er', by('t180', v => v + '×'), 'Noch keine 180.')}
      ${board('Kürzestes Leg', by('best', v => v + ' Darts', true), 'Noch kein Leg beendet.')}
      </div>
      <h2 class="sec">Tabelle</h2>
      <div class="tbl-scroll"><table class="tbl"><thead><tr><th>#</th><th>Spieler</th><th>Status</th><th>Sp</th><th>S</th><th>N</th><th>Legs</th><th>+/−</th><th>Ø</th><th>HF</th>
      ${BUCKETS.map(b => `<th>${b === 180 ? '180' : b + '+'}</th>`).join('')}</tr></thead><tbody>
      ${list.map((p, i) => { const df = p.lf - p.la; return `<tr><td class="pos">${i + 1}</td><td>${esc(p.name)}</td><td>${status(p)}</td>
        <td class="num">${p.sp}</td><td class="num">${p.s}</td><td class="num">${p.n}</td><td class="num">${p.lf}:${p.la}</td>
        <td class="num">${df > 0 ? '+' : df < 0 ? '−' : ''}${Math.abs(df)}</td><td class="num">${fmt(p.avg)}</td><td class="num">${p.hf || '–'}</td>
        ${BUCKETS.map(b => `<td class="num ${b === 180 && p.sc[b] ? 'hot' : ''}">${p.sc[b] || '–'}</td>`).join('')}</tr>`; }).join('')}
      </tbody></table></div>
      <p class="muted small">Ø über alle Aufnahmen im Turnier. HF = höchstes Finish ab 101. 80+ zählt 80–99, 100+ zählt 100–119 usw. Alles entsteht automatisch aus dem Scorer.</p></div>`;
  });
}

// ---------- Halle (Großbild für Monitor/Beamer) ----------
// Oben immer die Boards, unten wechseln alle 20 Sekunden: Infos ↔ Turnierbaum
export function halle(main) {
  document.body.classList.add('hall');
  let data = null, panel = 0;
  const draw = () => {
    if (!data) { main.innerHTML = noData; return; }
    const d = data;
    const boards = []; for (let b = 1; b <= d.t.boards; b++) boards.push(boardTile(d, b, true));
    const hfs = d.stats.flatMap(p => p.hfs.map(v => ({ name: p.name, v }))).sort((a, b) => b.v - a.v).slice(0, 3);
    const t180 = d.stats.filter(p => p.t180).sort((a, b) => b.t180 - a.t180).slice(0, 3);
    const now = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const info = `<div class="hall-row">
        <section><h2 class="sec">Als Nächstes</h2>${queue(d, 5)}</section>
        <section><h2 class="sec">Zuletzt beendet</h2>${recent(d, 5) || '<p class="muted">Noch kein Ergebnis.</p>'}</section>
        <section><h2 class="sec">Highlights</h2><ol class="list">
          ${hfs.map(x => `<li><span>High Finish · ${esc(x.name)}</span><b>${x.v}</b></li>`).join('')}
          ${t180.map(p => `<li><span>180er · ${esc(p.name)}</span><b>${p.t180}×</b></li>`).join('')}
          ${!hfs.length && !t180.length ? '<li class="muted">Noch keine Highlights.</li>' : ''}</ol></section></div>`;
    main.innerHTML = `<div class="hall-wrap">
      <header class="hall-h"><h1>${esc(d.t.name)}</h1><span class="clock">${now}</span>
        <button class="btn sm" data-fs type="button">Vollbild</button><a class="btn sm" href="#live">Schließen</a></header>
      ${champ(d)}
      <div class="hall-boards b${Math.min(d.t.boards, 8)}">${boards.join('')}</div>
      <div class="hall-panel">${panel === 0 ? info : `<h2 class="sec">Turnierbaum</h2><div class="hall-bk">${bracketHtml(d)}</div>`}</div>
      <div class="hall-dots"><span class="${panel === 0 ? 'on' : ''}"></span><span class="${panel === 1 ? 'on' : ''}"></span></div></div>`;
    fit();
  };
  const fit = () => requestAnimationFrame(() => {
    const box = main.querySelector('.hall-bk'), bk = box && box.querySelector('.bk');
    if (!bk) return;
    const sc = Math.min(1.6, box.clientWidth / bk.offsetWidth, (window.innerHeight - box.getBoundingClientRect().top - 40) / bk.offsetHeight);
    bk.style.transform = `scale(${Math.max(0.3, sc)})`; bk.style.transformOrigin = 'top left';
    box.style.height = bk.offsetHeight * Math.max(0.3, sc) + 'px';
  });
  const stop = watchTournament(d => { data = d; draw(); }, () => {});
  const rot = setInterval(() => { panel = 1 - panel; draw(); }, 20000);
  const tick = setInterval(() => { const c = main.querySelector('.clock'); if (c) c.textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }, 15000);
  const onClick = e => { if (e.target.closest('[data-fs]')) { const el = document.documentElement; if (el.requestFullscreen) el.requestFullscreen().catch(() => {}); } };
  main.addEventListener('click', onClick);
  window.addEventListener('resize', fit);
  main.innerHTML = '<p class="muted pd">Lade Turnier …</p>';
  return () => { stop(); clearInterval(rot); clearInterval(tick); main.removeEventListener('click', onClick); window.removeEventListener('resize', fit); document.body.classList.remove('hall'); };
}
