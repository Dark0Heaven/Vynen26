import { sb, latestTournament, loadTournament, loadVisits, rpc, store, esc } from './db.js';
import { roundCfg, roundName, compute, OUT_LABEL } from './rules.js';
import { startScorer } from './scorer.js';
import { startAdmin } from './admin.js';
import { live, baum, tabelle, halle } from './views.js';
import { watchTheme } from './theme.js';
import { anmelden, spieler, druck } from './extra.js';

const main = document.getElementById('main');
const nav = document.getElementById('nav');
let cleanup = null;

function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  let h = location.hash.replace('#', '');
  // Tablet-Modus: #schiri/3 legt das Tablet fest auf Board 3 und startet künftig direkt im Schiri-Bereich
  const tm = h.match(/^schiri\/(\d+)$/);
  if (tm) { store.set('vynen-board', Number(tm[1])); store.set('vynen-tablet', true); store.del('vynen-pin'); location.replace('#schiri'); return; }
  if (!h && store.get('vynen-tablet', false)) { location.replace('#schiri'); return; }
  h = h || 'live';
  for (const a of nav.querySelectorAll('a')) a.setAttribute('aria-current', a.dataset.r === h ? 'page' : 'false');
  document.body.classList.toggle('scoring', h === 'schiri');
  if (h === 'schiri') return schiri();
  if (h === 'admin') return admin();
  main.onclick = null;
  if (h === 'anmelden') { cleanup = anmelden(main); return; }
  if (h === 'druck') { cleanup = druck(main); return; }
  if (h.startsWith('spieler/')) { cleanup = spieler(main, h.slice(8)); return; }
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
  const bp = boardPin();
  if (bp && bp.board === board) return boardWait(board);
  pinEntry(board, store.get('vynen-tablet', false) ? 'board' : 'match');
}

// ---------------- Board-PIN (Tablet, 24 h) ----------------
// Gespeichert als {pin, board, exp}. Gültig bis exp, danach neu eingeben.
function boardPin() {
  const bp = store.get('vynen-bpin', null);
  if (!bp || !bp.exp || new Date(bp.exp) < new Date()) { if (bp) store.del('vynen-bpin'); return null; }
  return bp;
}
const BP_ERR = { bad_pin: 'Board-PIN ungültig.', expired: 'Board-PIN abgelaufen. Bitte neuen PIN von der Turnierleitung holen.', too_many: 'Zu viele Versuche. Bitte kurz warten.' };

async function checkBoardPin(pin, board) {
  const r = await rpc('ref_board', { p_pin: pin });
  if (!r.ok) return { error: BP_ERR[r.error] || 'Board-PIN ungültig.', fatal: true };
  if (r.board !== board) return { error: `Dieser Board-PIN gehört zu Board ${r.board}. Bitte am richtigen Board eingeben oder Board wechseln.`, fatal: true };
  store.set('vynen-bpin', { pin, board: r.board, exp: r.expires_at });
  return { matchPin: r.match_pin, exp: r.expires_at };
}

function boardWait(board, failedPin = '', firstNote = '') {
  const bp = boardPin(); if (!bp) return pinEntry(board, 'board');
  let alive = true, busy = false, note = firstNote;
  const until = new Date(bp.exp).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const draw = () => {
    main.innerHTML = `<div class="pinbox wait"><h2>Board ${board} <span class="tag live">Tablet aktiv</span></h2>
      <div class="wait-dot" aria-hidden="true"></div>
      <p class="big-t">Wartet auf das nächste Spiel …</p>
      <p class="muted">Sobald die Turnierleitung ein Spiel auf Board ${board} legt, öffnet es sich hier automatisch. Kein PIN nötig.</p>
      ${note ? `<p class="err" role="alert">${esc(note)}</p>` : ''}
      <p class="muted small">Board-PIN gültig bis ${until}</p>
      <div class="row2"><button class="btn" data-k="manual">Spiel-PIN eingeben</button><a class="btn" href="#live">Live-Ansicht</a></div>
      <button class="btn ghost" data-k="logout">Tablet abmelden</button></div>`;
  };
  const check = async () => {
    if (!alive || busy) return;
    busy = true;
    try {
      const r = await checkBoardPin(bp.pin, board);
      if (!alive) return;
      if (r.error) { stop(); store.del('vynen-bpin'); return pinEntry(board, 'board', r.error); }
      if (note) { note = ''; draw(); }
      if (r.matchPin && r.matchPin !== failedPin) {
        stop();
        const fail = await openScorer(r.matchPin, board, false);
        if (fail) boardWait(board, r.matchPin, fail); // nicht sofort erneut versuchen
        return;
      }
    } catch { if (alive && !note) { note = 'Keine Verbindung. Versuche es weiter …'; draw(); } }
    finally { busy = false; }
  };
  const iv = setInterval(check, 4000);
  const ch = sb.channel('board-' + board + '-' + Date.now())
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'matches', filter: 'board=eq.' + board }, () => setTimeout(check, 300))
    .subscribe();
  const stop = () => { alive = false; clearInterval(iv); sb.removeChannel(ch); main.onclick = null; if (cleanup === stop) cleanup = null; };
  cleanup = stop;
  main.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.k === 'manual') { stop(); pinEntry(board, 'match'); }
    if (b.dataset.k === 'logout') { stop(); store.del('vynen-bpin'); pinEntry(board, 'board'); }
  };
  draw(); check();
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

function pinEntry(board, mode = 'match', firstErr = '') {
  let pin = '', err = firstErr;
  const len = mode === 'board' ? 6 : 4;
  const draw = () => {
    main.innerHTML = `<div class="pinbox">
      <h2>Board ${board}${store.get('vynen-tablet', false) ? ' <span class="tag gold">Tablet</span>' : ''}</h2>
      <div class="seg pinmode" role="group"><button class="${mode === 'match' ? 'on' : ''}" data-k="m-match">Spiel-PIN</button><button class="${mode === 'board' ? 'on' : ''}" data-k="m-board">Board-PIN (24 h)</button></div>
      <p class="muted">${mode === 'board' ? 'Einmal den 6-stelligen Board-PIN eingeben. Das Tablet bleibt 24 Stunden angemeldet und öffnet jedes Spiel auf diesem Board automatisch.' : 'PIN für das nächste Spiel eingeben. Du bekommst ihn von der Turnierleitung.'}</p>
      <div class="pin ${len === 6 ? 'p6' : ''}" aria-live="polite">${Array.from({ length: len }, (_, i) => `<span class="${pin[i] ? 'f' : ''}">${pin[i] ? '•' : ''}</span>`).join('')}</div>
      ${err ? `<p class="err" role="alert">${esc(err)}</p>` : ''}
      <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="btn" data-k="${n}">${n}</button>`).join('')}
        <button class="btn" data-k="del" aria-label="Löschen">⌫</button><button class="btn" data-k="0">0</button>
        <button class="btn pri" data-k="ok">Start</button></div>
      <div class="row2"><button class="btn" data-k="board">Board wechseln</button><a class="btn" href="#live">Live-Ansicht</a></div></div>`;
  };
  const onClick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    const k = b.dataset.k;
    if (k === 'board') { store.del('vynen-board'); store.del('vynen-tablet'); main.onclick = null; return chooseBoard(); }
    if (k === 'm-match' || k === 'm-board') { main.onclick = null; return pinEntry(board, k.slice(2)); }
    if (k === 'del') pin = pin.slice(0, -1);
    else if (k !== 'ok' && pin.length < len) pin += k;
    if (pin.length === len && k !== 'del' && mode === 'board') {
      main.onclick = null;
      let r;
      try { r = await checkBoardPin(pin, board); } catch { r = { error: 'Keine Verbindung.' }; }
      if (r.error) { err = r.error; pin = ''; draw(); main.onclick = onClick; return; }
      return boardWait(board);
    }
    if (pin.length === len && k !== 'del') {
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
    r = await startScorer(main, pin, () => { store.del('vynen-pin'); cleanup = null; schiri(); }, board);
  } catch {
    if (fromSaved) { main.innerHTML = '<div class="sc-msg"><h2>Keine Verbindung</h2><p>Bitte Netz prüfen und die Seite neu laden. Deine Eingaben sind gespeichert.</p></div>'; return; }
    return 'Keine Verbindung.';
  }
  if (r.error) {
    store.del('vynen-pin');
    if (fromSaved) { schiri(); return; }
    if (r.error === 'wrong_board') return `Dieser PIN gehört zu Board ${r.board}. Bitte am richtigen Board eingeben oder Board wechseln.`;
    return 'PIN ungültig oder Spiel bereits beendet.';
  }
  store.set('vynen-pin', pin);
  cleanup = r.cleanup;
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
watchTheme();
route();
