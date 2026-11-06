import { sb, latestTournament, loadTournament, loadVisits, rpc, store, esc } from './db.js';
import { roundCfg, roundName, compute, OUT_LABEL } from './rules.js';
import { startScorer } from './scorer.js';

const main = document.getElementById('main');
const nav = document.getElementById('nav');
let cleanup = null;

function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  const h = location.hash.replace('#', '') || 'live';
  for (const a of nav.querySelectorAll('a')) a.setAttribute('aria-current', a.dataset.r === h ? 'page' : 'false');
  document.body.classList.toggle('scoring', h === 'schiri');
  if (h === 'schiri') return schiri();
  return live();
}
window.addEventListener('hashchange', route);

// ---------------- Live-Ansicht ----------------
async function live() {
  main.innerHTML = '<p class="muted pd">Lade Turnier …</p>';
  let t;
  try { t = await latestTournament(); } catch { main.innerHTML = '<p class="pd">Keine Verbindung. Bitte später neu laden.</p>'; return; }
  if (!t) { main.innerHTML = '<div class="empty pd"><h2>Noch kein Turnier</h2><p class="muted">Sobald die Turnierleitung ein Turnier anlegt, erscheint es hier live.</p></div>'; return; }
  let data = null, visits = [], timer = null, alive = true;

  async function load() {
    data = await loadTournament(t.id);
    const liveIds = data.matches.filter(m => ['live', 'review'].includes(m.status)).map(m => m.id);
    visits = await loadVisits(liveIds);
    if (alive) draw();
  }
  function soon() { clearTimeout(timer); timer = setTimeout(() => load().catch(() => {}), 250); }

  function draw() {
    const { t, players, matches } = data;
    const nm = id => esc((players.find(p => p.id === id) || {}).name || 'offen');
    const liveM = matches.filter(m => ['live', 'review'].includes(m.status)).sort((a, b) => a.board - b.board);
    const ready = matches.filter(m => m.status === 'ready').sort((a, b) => a.round - b.round || a.idx - b.idx);
    const done = matches.filter(m => m.status === 'done').sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 6);

    const boards = [];
    for (let b = 1; b <= t.boards; b++) {
      const m = liveM.find(x => x.board === b);
      if (!m) { boards.push(`<article class="bd free"><div class="bd-no">${b}</div><p class="muted">Frei</p></article>`); continue; }
      const cfg = roundCfg(t, m);
      const st = compute(cfg, m.bulls, visits.filter(v => v.match_id === m.id));
      const side = i => `<div class="bd-p ${st.turn === i ? 'on' : ''}"><span class="n">${nm(i ? m.player_b : m.player_a)}</span>
        <span class="l">${st.legs[i]}</span><span class="r">${st.finished ? '' : st.rem[i]}</span></div>`;
      boards.push(`<article class="bd"><div class="bd-h"><span class="bd-no">${b}</span><span class="muted">${esc(roundName(t, m))} · Bo${cfg.bo}</span>
        ${m.status === 'review' ? '<span class="tag gold">Ende</span>' : st.needBull ? '<span class="tag">Ausbullen</span>' : '<span class="tag live">Live</span>'}</div>
        ${side(0)}${side(1)}</article>`);
    }
    main.innerHTML = `<div class="wrap">
      <h1 class="tt">${esc(t.name)}</h1>
      <h2 class="sec">Boards</h2><div class="boards">${boards.join('')}</div>
      <h2 class="sec">Als Nächstes</h2>${ready.length ? `<ol class="list">${ready.slice(0, 8).map(m =>
        `<li><span>${nm(m.player_a)} <i>vs</i> ${nm(m.player_b)}</span><span class="muted">${esc(roundName(t, m))}</span></li>`).join('')}</ol>`
        : '<p class="muted">Keine wartenden Spiele.</p>'}
      ${done.length ? `<h2 class="sec">Zuletzt beendet</h2><ol class="list">${done.map(m =>
        `<li><span>${nm(m.player_a)} <b>${m.legs_a}:${m.legs_b}</b> ${nm(m.player_b)}</span><span class="muted">${esc(roundName(t, m))}</span></li>`).join('')}</ol>` : ''}
    </div>`;
  }

  await load().catch(() => { main.innerHTML = '<p class="pd">Keine Verbindung. Bitte später neu laden.</p>'; });
  const ch = sb.channel('live-' + t.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: 'tournament_id=eq.' + t.id }, soon)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'visits' }, soon)
    .subscribe();
  const poll = setInterval(soon, 30000);
  cleanup = () => { alive = false; clearInterval(poll); clearTimeout(timer); sb.removeChannel(ch); };
}

// ---------------- Schiri ----------------
function schiri() {
  const saved = store.get('vynen-pin', '');
  if (saved) { openScorer(saved, true); return; }
  let pin = '', err = '';
  const draw = () => {
    main.innerHTML = `<div class="pinbox">
      <h2>Schiri</h2><p class="muted">PIN für dieses Spiel eingeben. Du bekommst ihn von der Turnierleitung.</p>
      <div class="pin" aria-live="polite">${[0, 1, 2, 3].map(i => `<span class="${pin[i] ? 'f' : ''}">${pin[i] ? '•' : ''}</span>`).join('')}</div>
      ${err ? `<p class="err" role="alert">${esc(err)}</p>` : ''}
      <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="btn" data-k="${n}">${n}</button>`).join('')}
        <button class="btn" data-k="del" aria-label="Löschen">⌫</button><button class="btn" data-k="0">0</button>
        <button class="btn pri" data-k="ok">Start</button></div>
      <a class="btn ghost" href="#live">Abbrechen</a></div>`;
  };
  const onClick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    const k = b.dataset.k;
    if (k === 'del') pin = pin.slice(0, -1);
    else if (k !== 'ok' && pin.length < 4) pin += k;
    if (pin.length === 4 && k !== 'del') {
      main.onclick = null;
      const fail = await openScorer(pin, false);
      if (fail) { err = fail; pin = ''; draw(); main.onclick = onClick; }
      return;
    }
    err = ''; draw();
  };
  draw();
  main.onclick = onClick;
}

// Liefert bei Fehler einen Text zurück, sonst nichts
async function openScorer(pin, fromSaved) {
  main.innerHTML = '<p class="muted pd">Prüfe PIN …</p>';
  main.onclick = null;
  let r;
  try {
    r = await startScorer(main, pin, () => { store.del('vynen-pin'); location.hash = '#live'; });
  } catch {
    if (fromSaved) { main.innerHTML = '<div class="sc-msg"><h2>Keine Verbindung</h2><p>Bitte Netz prüfen und die Seite neu laden. Deine Eingaben sind gespeichert.</p></div>'; return; }
    return 'Keine Verbindung.';
  }
  if (r.error) {
    store.del('vynen-pin');
    if (fromSaved) { schiri(); return; }
    return 'PIN ungültig oder Spiel bereits beendet.';
  }
  store.set('vynen-pin', pin);
  cleanup = r.cleanup;
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
route();
