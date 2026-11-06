import { sb, latestTournament, loadTournament, loadVisits, rpc, store, esc } from './db.js';
import { roundCfg, roundName, compute, OUT_LABEL } from './rules.js';
import { startScorer } from './scorer.js';
import { startAdmin } from './admin.js';
import { live, baum, tabelle, halle } from './views.js';

const main = document.getElementById('main');
const nav = document.getElementById('nav');
let cleanup = null;

function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  const h = location.hash.replace('#', '') || 'live';
  for (const a of nav.querySelectorAll('a')) a.setAttribute('aria-current', a.dataset.r === h ? 'page' : 'false');
  document.body.classList.toggle('scoring', h === 'schiri');
  if (h === 'schiri') return schiri();
  if (h === 'admin') return admin();
  main.onclick = null;
  const view = { baum, tabelle, halle }[h] || live;
  cleanup = view(main);
}
window.addEventListener('hashchange', route);

// ---------------- Turnierleitung ----------------
async function admin() {
  main.innerHTML = '<p class="muted pd">Lade …</p>';
  main.onclick = null;
  try { cleanup = await startAdmin(main); }
  catch { main.innerHTML = '<p class="pd">Keine Verbindung. Bitte später neu laden.</p>'; }
}

// ---------------- Schiri ----------------
// Ablauf: Board wählen (wird gemerkt) → PIN eingeben → Scorer. Nach dem Spiel zurück zur PIN-Eingabe am selben Board.
async function schiri() {
  main.onclick = null;
  const saved = store.get('vynen-pin', '');
  const board = store.get('vynen-board', 0);
  if (saved && board) { openScorer(saved, board, true); return; }
  if (!board) return chooseBoard();
  pinEntry(board);
}

async function chooseBoard() {
  main.innerHTML = '<p class="muted pd">Lade Boards …</p>';
  let t = null;
  try { t = await latestTournament(); } catch { /* offline */ }
  const n = t ? t.boards : 8;
  main.innerHTML = `<div class="pinbox"><h2>Schiri</h2><p class="muted">An welchem Board stehst du?</p>
    <div class="pad">${Array.from({ length: n }, (_, i) => `<button class="btn big" data-b="${i + 1}">${i + 1}</button>`).join('')}</div>
    <a class="btn ghost" href="#live">Abbrechen</a></div>`;
  main.onclick = e => {
    const b = e.target.closest('button[data-b]'); if (!b) return;
    store.set('vynen-board', Number(b.dataset.b));
    main.onclick = null; pinEntry(Number(b.dataset.b));
  };
}

function pinEntry(board) {
  let pin = '', err = '';
  const draw = () => {
    main.innerHTML = `<div class="pinbox">
      <h2>Board ${board}</h2><p class="muted">PIN für das nächste Spiel eingeben. Du bekommst ihn von der Turnierleitung.</p>
      <div class="pin" aria-live="polite">${[0, 1, 2, 3].map(i => `<span class="${pin[i] ? 'f' : ''}">${pin[i] ? '•' : ''}</span>`).join('')}</div>
      ${err ? `<p class="err" role="alert">${esc(err)}</p>` : ''}
      <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="btn" data-k="${n}">${n}</button>`).join('')}
        <button class="btn" data-k="del" aria-label="Löschen">⌫</button><button class="btn" data-k="0">0</button>
        <button class="btn pri" data-k="ok">Start</button></div>
      <div class="row2"><button class="btn" data-k="board">Board wechseln</button><a class="btn" href="#live">Live-Ansicht</a></div></div>`;
  };
  const onClick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    const k = b.dataset.k;
    if (k === 'board') { store.del('vynen-board'); main.onclick = null; return chooseBoard(); }
    if (k === 'del') pin = pin.slice(0, -1);
    else if (k !== 'ok' && pin.length < 4) pin += k;
    if (pin.length === 4 && k !== 'del') {
      main.onclick = null;
      const fail = await openScorer(pin, board, false);
      if (fail) { err = fail; pin = ''; draw(); main.onclick = onClick; }
      return;
    }
    err = ''; draw();
  };
  draw();
  main.onclick = onClick;
}

// Liefert bei Fehler einen Text zurück, sonst nichts
async function openScorer(pin, board, fromSaved) {
  main.innerHTML = '<p class="muted pd">Prüfe PIN …</p>';
  main.onclick = null;
  let r;
  try {
    r = await startScorer(main, pin, () => { store.del('vynen-pin'); cleanup = null; pinEntry(board); }, board);
  } catch {
    if (fromSaved) { main.innerHTML = '<div class="sc-msg"><h2>Keine Verbindung</h2><p>Bitte Netz prüfen und die Seite neu laden. Deine Eingaben sind gespeichert.</p></div>'; return; }
    return 'Keine Verbindung.';
  }
  if (r.error) {
    store.del('vynen-pin');
    if (fromSaved) { pinEntry(board); return; }
    if (r.error === 'wrong_board') return `Dieser PIN gehört zu Board ${r.board}. Bitte am richtigen Board eingeben oder Board wechseln.`;
    return 'PIN ungültig oder Spiel bereits beendet.';
  }
  store.set('vynen-pin', pin);
  cleanup = r.cleanup;
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
route();
