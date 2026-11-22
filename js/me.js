// „Mein Spieler“: einem Namen folgen, Push-Benachrichtigungen, Hinweis in der offenen App, Recap am Ende
import { sb, rpc, esc, store, latestTournament } from './db.js';
import { VAPID_PUBLIC } from './config.js';
import { watchTournament } from './data.js';
import { roundName } from './rules.js';

const KEY = 'vynen-me';
export const getMe = () => store.get(KEY, '');
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const pushPossible = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64 = s => { const p = '='.repeat((4 - s.length % 4) % 4), r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, c => c.charCodeAt(0)); };
const norm = s => String(s || '').trim().toLowerCase();

// Push einschalten (fragt nach Erlaubnis). Liefert 'ok' | 'denied' | 'ios-install' | 'unsupported' | 'error'
export async function enablePush(name) {
  store.set(KEY, name.trim());
  if (!pushPossible()) return isIOS() && !standalone() ? 'ios-install' : 'unsupported';
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return 'denied';
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(VAPID_PUBLIC) });
    const j = sub.toJSON();
    await rpc('push_subscribe', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_name: name.trim() });
    store.set('vynen-push', true);
    return 'ok';
  } catch { return 'error'; }
}
export async function disableMe() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) { await rpc('push_unsubscribe', { p_endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
  } catch { /* egal */ }
  store.del(KEY); store.del('vynen-push');
}
const pushOn = () => store.get('vynen-push', false) && 'Notification' in window && Notification.permission === 'granted';
export const PUSH_MSG = {
  ok: 'Fertig! Du bekommst eine Nachricht, wenn du dran bist.',
  denied: 'Benachrichtigungen wurden nicht erlaubt. Du siehst den Hinweis dann nur, wenn die Seite offen ist.',
  'ios-install': 'Am iPhone gehen Push-Nachrichten nur aus der installierten App: Teilen → „Zum Home-Bildschirm“, dann dort nochmal antippen.',
  unsupported: 'Dieser Browser kann keine Push-Nachrichten. Du siehst den Hinweis, solange die Seite offen ist.',
  error: 'Hat nicht geklappt. Bitte später noch einmal versuchen.',
};

// ---------- Leiste „Mein Spieler“ (über der Live-Ansicht) ----------
export function meBar(el) {
  let names = [], msg = '', alive = true;
  const draw = () => {
    if (!alive) return;
    const me = getMe();
    el.hidden = false;
    el.innerHTML = me
      ? `<div class="mebar on"><span>🔔 Du folgst <b>${esc(me)}</b>${pushOn() ? ' · Push an' : ''}</span>
          <span class="bbtns">${pushOn() ? '' : '<button class="btn sm pri" data-me="push">Push einschalten</button>'}
          <a class="btn sm" href="#recap/${encodeURIComponent(me)}">Mein Recap</a><button class="btn sm ghost" data-me="off">Ändern</button></span>
          ${msg ? `<p class="small mebar-msg">${esc(msg)}</p>` : ''}</div>`
      : `<form class="mebar" id="mef" autocomplete="off"><label for="men">🔔 Benachrichtigen, wenn ich dran bin:</label>
          <div class="combo"><input id="men" placeholder="Namen eintippen …" maxlength="60" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="men-l">
            <ul class="combo-l" id="men-l" role="listbox" hidden></ul></div>
          <button class="btn sm pri" type="submit" disabled>Folgen</button>${msg ? `<p class="small mebar-msg">${esc(msg)}</p>` : ''}</form>`;
    const f = el.querySelector('#mef');
    if (f) {
      const inp = f.men, list = f.querySelector('#men-l'), btn = f.querySelector('button[type=submit]');
      const pick = n => { inp.value = n; list.hidden = true; inp.setAttribute('aria-expanded', 'false'); btn.disabled = false; };
      const exact = () => names.find(n => norm(n) === norm(inp.value));
      inp.oninput = () => {
        const q = norm(inp.value), hits = q ? names.filter(n => norm(n).includes(q)).slice(0, 8) : [];
        btn.disabled = !exact();
        list.innerHTML = hits.length ? hits.map(n => `<li role="option" data-n="${esc(n)}">${esc(n)}</li>`).join('')
          : q ? '<li class="none">Nicht in der Anmeldeliste – bitte so schreiben wie angemeldet</li>' : '';
        list.hidden = !q; inp.setAttribute('aria-expanded', String(!!q));
      };
      list.onclick = e => { const li = e.target.closest('[data-n]'); if (li) pick(li.dataset.n); };
      inp.onkeydown = e => { if (e.key === 'Enter') { const first = list.querySelector('[data-n]'); if (first && !exact()) { e.preventDefault(); pick(first.dataset.n); } } };
      f.onsubmit = async e => {
        e.preventDefault(); const n = exact(); if (!n) return;
        msg = 'Einen Moment …'; draw();
        msg = PUSH_MSG[await enablePush(n)] || ''; draw(); startWatch();
      };
    }
  };
  el.onclick = async e => {
    const b = e.target.closest('[data-me]'); if (!b) return;
    if (b.dataset.me === 'push') { msg = PUSH_MSG[await enablePush(getMe())] || ''; draw(); }
    if (b.dataset.me === 'off') { await disableMe(); msg = ''; draw(); }
  };
  // Namen aus der Anmeldeliste und dem aktuellen Turnier (ohne Doppel-Paare)
  Promise.all([
    rpc('public_reg_names', {}).catch(() => []),
    latestTournament().then(t => t ? sb.from('players').select('name,pair').eq('tournament_id', t.id) : { data: [] }).catch(() => ({ data: [] })),
  ]).then(([regs, pl]) => {
    const all = new Map();
    for (const n of [...(regs || []), ...((pl && pl.data) || []).filter(p => !p.pair).map(p => p.name)]) if (n) all.set(norm(n), n);
    names = [...all.values()].sort((a, b) => a.localeCompare(b, 'de')); draw();
  });
  draw();
  return () => { alive = false; el.hidden = true; el.innerHTML = ''; el.onclick = null; };
}

// ---------- Hinweis in der offenen App (zusätzlich zu Push) ----------
let watching = false;
export function startWatch() {
  if (watching || !getMe()) return;
  watching = true;
  const seen = new Map();
  let first = true;
  watchTournament(d => {
    const me = norm(getMe()); if (!d || !me) return;
    const mine = new Set(d.players.filter(p => norm(p.name) === me || p.name.split('&').map(norm).includes(me)).map(p => p.id));
    for (const m of d.matches) {
      if (!mine.has(m.player_a) && !mine.has(m.player_b)) continue;
      const key = `${m.status}|${m.board || ''}`, prev = seen.get(m.id);
      seen.set(m.id, key);
      if (first || prev === key) continue;
      const opp = d.pname(mine.has(m.player_a) ? m.player_b : m.player_a), rn = roundName(d.t, m);
      if (m.board && ['live', 'review'].includes(m.status) && !String(prev).includes('|' + m.board)) banner(`Jetzt: Board ${m.board} 🎯`, `${rn} gegen ${opp} – ab ans Board!`);
      else if (m.status === 'ready' && prev && prev.startsWith('pending')) banner('Gleich bist du dran 🎯', `${rn} gegen ${opp}`);
    }
    first = false;
  }, () => {});
}
function banner(title, body) {
  if (navigator.vibrate) try { navigator.vibrate([200, 100, 200]); } catch { /* egal */ }
  const el = document.createElement('div');
  el.className = 'mebanner'; el.setAttribute('role', 'alert');
  el.innerHTML = `<b>${esc(title)}</b><span>${esc(body)}</span><button class="btn sm" aria-label="Schließen">OK</button>`;
  el.querySelector('button').onclick = () => el.remove();
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 30000);
}

// ---------- Recap (#recap/<Name>) ----------
const f1 = v => v ? v.toFixed(1).replace('.', ',') : '–';
export function recap(main, nameRaw) {
  const want = norm(decodeURIComponent(nameRaw || ''));
  let last = null;
  const stop = watchTournament(d => {
    if (!d) { main.innerHTML = '<p class="pd">Noch kein Turnier.</p>'; return; }
    const p = d.stats.find(x => norm(x.name) === want);
    if (!p) { main.innerHTML = `<div class="wrap"><h1 class="tt">Recap</h1><p>Kein Spieler „${esc(decodeURIComponent(nameRaw || ''))}“ in diesem Turnier gefunden.</p><a class="btn" href="#tabelle">Zur Tabelle</a></div>`; return; }
    const R = d.R, t = d.t;
    const reach = p.place ? `${p.place}. Platz` : p.silver === 'win' ? 'Silver-Cup-Sieger'
      : t.mode === 'ko' ? (['Finale', 'Halbfinale', 'Viertelfinale', 'Achtelfinale', '16tel-Finale'][R - 1 - Math.max(p.reach, p.out ?? 0)] || `Runde ${Math.max(p.reach, p.out ?? 0) + 1}`) + (p.out === null ? '' : ' erreicht')
      : d.swiss ? `Platz ${(d.swiss.list.find(x => x.id === p.id) || {}).rank}` : '';
    const hi = p.t180 ? `${p.t180}× 180 – Maximum!` : p.hf ? `Highfinish ${p.hf}` : p.best ? `Bestes Leg: ${p.best} Darts` : p.bestAvg ? `Bestes Spiel: Ø ${f1(p.bestAvg)}` : 'Danke fürs Mitspielen!';
    const tons = (p.sc[100] || 0) + (p.sc[120] || 0) + (p.sc[140] || 0) + (p.sc[160] || 0) + (p.sc[180] || 0);
    last = { p, reach, hi, tons, title: t.name };
    const tile = (l, v) => `<div class="rc-t"><span>${l}</span><b>${v}</b></div>`;
    main.innerHTML = `<div class="wrap rc"><p class="muted small">${esc(t.name)} · Dein Abend in Zahlen</p>
      <h1 class="tt">${esc(p.name)}</h1><p class="rc-reach">${esc(reach)}${p.silver === 'in' || p.silver === 'out' ? ' · Silver Cup' : ''}</p>
      <p class="rc-hi">⭐ ${esc(hi)}</p>
      <div class="rc-grid">${tile('Average', f1(p.avg))}${tile('Spiele', `${p.s}–${p.n}`)}${tile('Legs', `${p.lf}:${p.la}`)}
        ${tile('Bestes Spiel Ø', f1(p.bestAvg))}${tile('Höchstes Finish', p.hf || '–')}${tile('Kürzestes Leg', p.best ? p.best + ' Darts' : '–')}
        ${tile('100+', tons)}${tile('140+', (p.sc[140] || 0) + (p.sc[160] || 0) + (p.sc[180] || 0))}${tile('180er', p.t180)}</div>
      <div class="bbtns"><button class="btn pri big" data-rc="img">📸 Als Bild speichern</button><a class="btn" href="#spieler/${p.id}">Alle Spiele</a></div></div>`;
  }, () => { main.innerHTML = '<p class="pd">Keine Verbindung.</p>'; });
  main.onclick = async e => { if (e.target.closest('[data-rc="img"]') && last) await saveImage(last); };
  return () => { stop(); main.onclick = null; };
}

async function saveImage({ p, reach, hi, tons, title }) {
  const W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const bf = document.body.classList.contains('theme-bigfish');
  const acc = bf ? '#1677ff' : '#e3121e', gold = bf ? '#7fd3ff' : '#f5c542';
  const bgr = g.createRadialGradient(W / 2, -100, 50, W / 2, 200, 1100); bgr.addColorStop(0, bf ? '#0b2a5c' : '#5c0d14'); bgr.addColorStop(1, bf ? '#06101f' : '#111113');
  g.fillStyle = bgr; g.fillRect(0, 0, W, H);
  await document.fonts.ready.catch(() => {});
  const logo = new Image(); logo.src = bf ? 'img/bigfish.png' : 'img/vynen26.png';
  await new Promise(r => { logo.onload = r; logo.onerror = r; });
  if (logo.naturalWidth) { const lh = 200, lw = lh * logo.naturalWidth / logo.naturalHeight; g.drawImage(logo, (W - lw) / 2, 60, lw, lh); }
  const font = (w, s, it) => `${it ? 'italic ' : ''}${w} ${s}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  g.textAlign = 'center'; g.fillStyle = '#bbb'; g.font = font(600, 34); g.fillText(title.toUpperCase() + ' · MEIN ABEND', W / 2, 320);
  g.fillStyle = '#fff'; g.font = font(800, 96, true); g.fillText(p.name.toUpperCase(), W / 2, 420, W - 80);
  g.fillStyle = gold; g.font = font(700, 52); g.fillText(reach, W / 2, 490, W - 80);
  g.fillStyle = acc; g.fillRect(W / 2 - 60, 520, 120, 6);
  const tiles = [['AVERAGE', f1(p.avg)], ['SPIELE', `${p.s}–${p.n}`], ['LEGS', `${p.lf}:${p.la}`], ['HÖCHSTES FINISH', p.hf || '–'], ['100+', tons], ['180ER', p.t180]];
  tiles.forEach(([l, v], i) => {
    const col = i % 3, row = Math.floor(i / 3), x = 60 + col * 330, y = 580 + row * 250;
    g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(x, y, 300, 220);
    g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 2; g.strokeRect(x, y, 300, 220);
    g.fillStyle = '#aaa'; g.font = font(700, 30); g.fillText(l, x + 150, y + 55);
    g.fillStyle = l === '180ER' && p.t180 ? gold : '#fff'; g.font = font(600, 104); g.fillText(String(v), x + 150, y + 170);
  });
  g.fillStyle = gold; g.font = font(700, 46, true); g.fillText('★ ' + hi, W / 2, 1150, W - 80);
  g.fillStyle = '#888'; g.font = font(600, 32); g.fillText('vynen26.de', W / 2, 1290);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], `vynen26-${p.name.replace(/[^\wäöüß-]+/gi, '_')}.png`, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Mein Abend bei Vynen 26' }); return; } catch { /* abgebrochen → Download */ } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
