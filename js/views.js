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

// ---------- Turnierbaum ----------
export function baum(main) {
  return mount(main, d => {
    const { t, R } = d;
    const card = m => {
      const st = m.st;
      const row = i => {
        const id = i ? m.player_b : m.player_a, bye = i ? m.bye_b : m.bye_a;
        const p = d.stats.find(x => x.id === id);
        if (!id) return `<div class="row ${bye ? 'bye' : 'tbd'}"><span class="seed"></span><span class="nm">${bye ? 'Freilos' : 'offen'}</span><span class="lg"></span></div>`;
        const win = m.winner && m.winner === id && ['done', 'wo', 'bye'].includes(m.status);
        const lose = m.winner && m.winner !== id && ['done', 'wo'].includes(m.status);
        const legs = m.status === 'done' ? (i ? m.legs_b : m.legs_a) : st ? st.legs[i] : m.status === 'wo' && lose ? 'w.o.' : '';
        return `<div class="row ${win ? 'w' : ''} ${lose ? 'l' : ''}"><span class="seed">${p ? p.seed : ''}</span>
          <span class="nm">${esc(d.pname(id))}${p && p.withdrawn ? ' <small>(zurückgezogen)</small>' : ''}</span><span class="lg">${legs}</span></div>`;
      };
      const badge = ['live', 'review'].includes(m.status) ? `<span class="mbadge">● Board ${m.board}</span>` : '';
      return `<div class="match ${m.status}">${badge}${row(0)}${row(1)}</div>`;
    };
    let h = `<div class="wrap"><h1 class="tt">${esc(t.name)}</h1>${champ(d)}<div class="bracket-scroll"><div class="bracket">`;
    for (let r = 0; r < R; r++) {
      const ms = d.matches.filter(m => m.kind === 'ko' && m.round === r).sort((a, b) => a.idx - b.idx);
      const c = ms[0] ? ms[0].cfg : null;
      if (!ms.length) continue;
      h += `<section class="round"><h3>${esc(roundName(t, ms[0]))}<span>${c ? `Bo${c.bo} · ${c.start}` : ''}</span></h3><div class="col">${ms.map(card).join('')}</div>`;
      if (r === R - 1) {
        const p3 = d.matches.find(m => m.kind === 'p3');
        if (p3) h += `<h3 class="p3h">Spiel um Platz 3</h3>${card(p3)}`;
      }
      h += '</section>';
    }
    return h + '</div></div><p class="muted small">Waagerecht wischen, um alle Runden zu sehen.</p></div>';
  });
}

// ---------- Tabelle & Highlights ----------
export function tabelle(main) {
  return mount(main, d => {
    const R = d.R;
    const list = d.stats;
    const top = (key, f, n = 5) => list.filter(p => p[key]).sort((a, b) => key === 'best' ? a[key] - b[key] : b[key] - a[key]).slice(0, n)
      .map(p => ({ name: p.name, v: f(p[key]) }));
    const board = (title, items, empty) => `<section class="hl"><h3>${title}</h3>${items.length
      ? `<div class="hl-top"><span class="v">${items[0].v}</span><span class="who">${esc(items[0].name)}</span></div><ol>${items.slice(1)
        .map((x, i) => `<li><span>${i + 2}. ${esc(x.name)}</span><span class="v">${x.v}</span></li>`).join('')}</ol>`
      : `<p class="muted small">${empty}</p>`}</section>`;
    const status = p => p.place ? `<span class="st ${p.place === 1 ? 'champ-st' : ''}">${p.place}. Platz</span>`
      : p.withdrawn ? '<span class="st">Zurückgezogen</span>'
      : p.out !== null ? `<span class="st">Aus · ${esc(roundName(d.t, { kind: 'ko', round: p.out }))}</span>`
      : `<span class="st in">Im ${esc(roundName(d.t, { kind: 'ko', round: p.reach }))}</span>`;
    return `<div class="wrap"><h1 class="tt">${esc(d.t.name)}</h1>
      <h2 class="sec">Highlights</h2><div class="hls">
      ${board('High Finishes', top('hf', v => v), 'Noch kein Checkout.')}
      ${board('Bester Average (Spiel)', top('bestAvg', fmt), 'Noch kein Spiel beendet.')}
      ${board('180er', top('t180', v => v + '×'), 'Noch keine 180.')}
      ${board('Kürzestes Leg', top('best', v => v + ' Darts'), 'Noch kein Leg beendet.')}
      </div>
      <h2 class="sec">Tabelle</h2>
      <div class="tbl-scroll"><table class="tbl"><thead><tr><th>#</th><th>Spieler</th><th>Status</th><th>Sp</th><th>S</th><th>N</th><th>Legs</th><th>+/−</th><th>Ø</th><th>HF</th><th>180</th><th>140+</th></tr></thead><tbody>
      ${list.map((p, i) => { const df = p.lf - p.la; return `<tr><td class="pos">${i + 1}</td><td>${esc(p.name)}</td><td>${status(p)}</td>
        <td class="num">${p.sp}</td><td class="num">${p.s}</td><td class="num">${p.n}</td><td class="num">${p.lf}:${p.la}</td>
        <td class="num">${df > 0 ? '+' : df < 0 ? '−' : ''}${Math.abs(df)}</td><td class="num">${fmt(p.avg)}</td><td class="num">${p.hf || '–'}</td>
        <td class="num">${p.t180 || '–'}</td><td class="num">${p.t140 || '–'}</td></tr>`; }).join('')}
      </tbody></table></div>
      <p class="muted small">Ø über alle Aufnahmen im Turnier. Highlights entstehen automatisch aus dem Scorer.</p></div>`;
  });
}

// ---------- Halle (Beamer/TV) ----------
export function halle(main) {
  document.body.classList.add('hall');
  const stop = mount(main, d => {
    const boards = []; for (let b = 1; b <= d.t.boards; b++) boards.push(boardTile(d, b, true));
    const hf = d.stats.filter(p => p.hf).sort((a, b) => b.hf - a.hf).slice(0, 3);
    const t180 = d.stats.filter(p => p.t180).sort((a, b) => b.t180 - a.t180).slice(0, 3);
    const now = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    return `<div class="hall-wrap">
      <header class="hall-h"><h1>${esc(d.t.name)}</h1><span class="clock">${now}</span>
        <button class="btn sm" id="fs" type="button">Vollbild</button><a class="btn sm" href="#live">Schließen</a></header>
      ${champ(d)}
      <div class="hall-boards">${boards.join('')}</div>
      <div class="hall-row">
        <section><h2 class="sec">Als Nächstes</h2>${queue(d, 5)}</section>
        <section><h2 class="sec">Zuletzt beendet</h2>${recent(d, 5) || '<p class="muted">Noch kein Ergebnis.</p>'}</section>
        <section><h2 class="sec">Highlights</h2><ol class="list">
          ${hf.map(p => `<li><span>High Finish ${esc(p.name)}</span><b>${p.hf}</b></li>`).join('')}
          ${t180.map(p => `<li><span>180er ${esc(p.name)}</span><b>${p.t180}×</b></li>`).join('') || ''}
          ${!hf.length && !t180.length ? '<li class="muted">Noch keine Highlights.</li>' : ''}</ol></section>
      </div></div>`;
  });
  const onClick = e => {
    if (e.target.id === 'fs') { const el = document.documentElement; (el.requestFullscreen ? el.requestFullscreen() : Promise.reject()).catch(() => {}); }
  };
  main.addEventListener('click', onClick);
  const tick = setInterval(() => { const c = main.querySelector('.clock'); if (c) c.textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }, 15000);
  return () => { stop(); clearInterval(tick); main.removeEventListener('click', onClick); document.body.classList.remove('hall'); };
}
