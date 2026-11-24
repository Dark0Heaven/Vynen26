// Autodarts-Anbindung: Autodarts (Board Manager / Autodarts Desktop) erkennt die Würfe,
// diese App zählt das Spiel. Lokale Schnittstelle auf Port 3180:
//   GET  /api/state   (alter Aufbau: throws[].segment{number,multiplier,name}; neu: segmentNumber/multiplier flach)
//   WS   /api/events  (Änderungen in Echtzeit)
// Gleiche Schnittstelle wie camera.js: start, stop, sync, manual, clear, active, views, ready.
import { store } from './db.js';

const KEY = 'vynen-ad-host';
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Zustand vereinheitlichen (beide Formate, auch in {data:…} verpackt)
export function normState(st) {
  if (!st || typeof st !== 'object') return null;
  if (!Array.isArray(st.throws) && st.data && typeof st.data === 'object') st = st.data;
  const throws = Array.isArray(st.throws) ? st.throws.map(t => {
    const seg = t.segment || {};
    let n = Number(seg.number ?? t.segmentNumber ?? 0), m = Number(seg.multiplier ?? t.multiplier ?? 0);
    const name = String(seg.name ?? t.segmentName ?? '');
    if (n === 50 || /^bull$/i.test(name) || /^d?bull$/i.test(name) && !n) { n = 25; m = 2; }
    if (/^(25|sbull|outer)/i.test(name) && n === 25 && !m) m = 1;
    if (!n || !m || /miss|outside/i.test(name + (seg.bed || t.bed || ''))) { n = 0; m = 0; }
    return { n, m, name };
  }) : null;
  return { status: String(st.status || st.event || ''), throws, connected: st.connected, running: st.running };
}

export function createAutodarts(opts) {
  let host = store.get(KEY, 'http://localhost:3180'), mode = 'off', msg = '', status = '', lastTxt = '';
  let ws = null, poll = null, seen = -1, block = false, lastVisit = 0, okAt = 0, wsOk = false;
  const panel = document.createElement('div');
  panel.className = 'cam-panel'; panel.hidden = true;
  document.body.appendChild(panel);

  const norm = h => { h = h.trim().replace(/\/+$/, ''); if (!/^https?:\/\//.test(h)) h = 'http://' + h; if (!/:\d+$/.test(h)) h += ':3180'; return h; };
  const isLocal = h => /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(h);

  function start() { mode = 'setup'; render(); }
  function connect() {
    stopConn(); mode = 'connecting'; msg = ''; seen = -1; block = false; render();
    // WebSocket (ohne CORS); bei Fehlern trotzdem per Abfrage weiter
    try {
      ws = new WebSocket(host.replace(/^http/, 'ws') + '/api/events');
      ws.onmessage = e => { wsOk = true; let d = null; try { d = JSON.parse(e.data); } catch { return; } handle(d); fetchState(); };
      ws.onerror = () => { wsOk = false; };
      ws.onclose = () => { wsOk = false; };
    } catch { ws = null; }
    fetchState(); poll = setInterval(fetchState, 800);
  }
  async function fetchState() {
    try {
      const o = { cache: 'no-store' };
      if (!isLocal(host)) o.targetAddressSpace = 'local'; // Chrome: Zugriff aufs Heimnetz (fragt einmal nach Erlaubnis)
      const r = await fetch(host + '/api/state', o);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      handle(await r.json());
    } catch (e) {
      if (wsOk) return; // Events kommen über den WebSocket
      if (Date.now() - okAt > 4000) {
        msg = location.protocol === 'https:' && !isLocal(host)
          ? 'Keine Verbindung. Chrome blockiert evtl. den Zugriff aufs Heimnetz: Schloss-Symbol → Website-Einstellungen → „Unsicherer Inhalt“ und „Geräte im lokalen Netzwerk“ erlauben. Oder die App am Autodarts-PC mit localhost öffnen.'
          : 'Keine Verbindung zu Autodarts. Läuft Autodarts / der Board Manager? Adresse prüfen.';
        if (mode !== 'setup') { mode = 'error'; render(); }
      }
    }
  }
  function handle(raw) {
    const st = normState(raw); if (!st) return;
    okAt = Date.now();
    if (mode === 'connecting' || mode === 'error') { mode = 'on'; msg = ''; store.set(KEY, host); opts.onReady && opts.onReady(); }
    if (st.status) status = st.status;
    if (st.throws) {
      const n = st.throws.length;
      if (seen < 0) seen = n; // beim Verbinden: schon steckende Darts nicht übernehmen
      if (n < seen) { seen = 0; } // Takeout / Reset
      if (n === 0) block = false;
      for (let i = seen; i < n; i++) {
        const t = st.throws[i];
        lastTxt = t.n ? (t.n === 25 ? (t.m >= 2 ? 'Bull' : '25') : ['', 'S', 'D', 'T'][t.m] + t.n) : 'Fehlwurf';
        if (block) continue; // Aufnahme in der App schon zu Ende (z. B. überworfen) – bis zum Ziehen ignorieren
        const hit = t.n && opts.targets.includes(t.n);
        opts.onDart(hit ? t.n : 0, hit ? t.m : 0);
      }
      seen = n;
    }
    render();
  }
  function stopConn() { clearInterval(poll); poll = null; if (ws) { ws.onclose = ws.onerror = ws.onmessage = null; try { ws.close(); } catch {} } ws = null; wsOk = false; }
  function stop() { stopConn(); mode = 'off'; panel.hidden = true; panel.innerHTML = ''; }
  function sync() {
    if (mode !== 'on') return;
    const { inVisit } = opts.visitInfo();
    if (inVisit === 0 && lastVisit > 0 && seen > 0) block = true; // Rest dieser Autodarts-Aufnahme nicht dem nächsten Spieler geben
    lastVisit = inVisit; render();
  }

  function render() {
    if (mode === 'off') { panel.hidden = true; return; }
    panel.hidden = false;
    if (mode === 'setup') {
      panel.className = 'cam-panel';
      panel.innerHTML = `<div class="cam-choose"><b>Autodarts verbinden</b>
        <span class="muted small">Autodarts erkennt die Würfe, die App zählt. Am Autodarts-PC: <b>localhost:3180</b>. Auf Tablet/Handy: IP des PCs, z. B. 192.168.178.37:3180.</span>
        <input data-ad="host" value="${esc(host)}" aria-label="Adresse des Board Managers" autocomplete="off">
        <div class="bbtns"><button class="btn pri" data-a="go">Verbinden</button><button class="btn" data-a="local">Am Autodarts-PC (localhost)</button><button class="btn ghost" data-a="close">Abbrechen</button></div></div>`;
      return;
    }
    const st = mode === 'on' ? (block ? 'pull' : /takeout/i.test(status) ? 'pull' : 'ok') : 'warn';
    panel.className = 'cam-panel slim';
    panel.innerHTML = `<div class="cam-bar"><span class="cam-dot ${st}" aria-hidden="true"></span>
      <div class="cam-info"><span class="muted small">Autodarts · ${esc(host.replace(/^https?:\/\//, ''))}${status ? ' · ' + esc(status) : ''}</span>
        <b>${mode === 'connecting' ? 'Verbinde …' : mode === 'error' ? esc(msg) : block ? 'Darts ziehen …' : lastTxt ? `Erkannt: ${esc(lastTxt)}` : 'Verbunden – werfen!'}</b></div>
      <div class="cam-btns">${mode === 'error' ? '<button class="btn sm" data-a="retry">Neu verbinden</button>' : ''}<button class="btn sm" data-a="setup">Adresse</button><button class="btn sm" data-a="close">Aus</button></div></div>`;
  }
  panel.addEventListener('click', e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'go') { const v = panel.querySelector('[data-ad=host]').value; if (!v.trim()) return; host = norm(v); connect(); }
    if (a === 'local') { host = 'http://localhost:3180'; connect(); }
    if (a === 'retry') connect();
    if (a === 'setup') { stopConn(); mode = 'setup'; render(); }
    if (a === 'close') { stop(); opts.onClose && opts.onClose(); }
  });

  return { start, stop, sync, manual() {}, clear() { lastTxt = ''; }, get active() { return mode !== 'off'; }, views: [],
    // Livebilder der Autodarts-Kameras: MJPEG-Stream (Board Manager 2) bzw. Einzelbilder (ältere Versionen)
    get streams() { return mode === 'on' ? [0, 1, 2].map(i => ({ stream: `${host}/api/streams/cams/${i}`, snap: `${host}/api/img/cams/${i}` })) : []; }, get ready() { return mode === 'on'; } };
}
