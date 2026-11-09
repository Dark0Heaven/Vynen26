// Zusätze: Anmeldung, Spielerprofil, Notfall-Paket (Druck + Ergebnis-Datei)
import { rpc, esc } from './db.js';
import { roundName } from './rules.js';
import { watchTournament } from './data.js';
import { bracketHtml, BUCKETS } from './views.js';

const fmt = v => v ? v.toFixed(1).replace('.', ',') : '–';
const dateDe = s => s ? new Date(s + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
const REG_ERR = {
  reg_closed: 'Die Anmeldung ist geschlossen. Du kannst dich am Turniertag vor Ort nachmelden.',
  empty_name: 'Bitte deinen Namen eingeben (mindestens 2 Zeichen).',
  bad_phone: 'Bitte eine gültige Handynummer eingeben.',
  duplicate: 'Dieser Name ist schon angemeldet. Bei gleichem Namen bitte z. B. den Nachnamen ergänzen.',
  too_many: 'Gerade melden sich viele an. Bitte in einer Minute noch einmal versuchen.',
};

// ---------- Anmeldung (#anmelden) ----------
export function anmelden(main) {
  let alive = true;
  const draw = (info, msg = '', ok = false) => {
    if (!alive) return;
    if (!info) { main.innerHTML = '<p class="pd">Keine Verbindung. Bitte später neu laden.</p>'; return; }
    const head = `<h2>Anmeldung</h2><p class="muted">Neujahrsdart-Turnier Vynen 26 · Sa 23.01.2027 · Vereinsheim Vynen<br>
      Startgeld ${info.fee} € bar vor Ort${info.deadline ? ` · Anmeldeschluss ${dateDe(info.deadline)}` : ''}</p>`;
    if (ok) { main.innerHTML = `<div class="adm-box">${head}<p class="note ok-note" role="status">${esc(msg)}</p>
      <a class="btn" href="#live">Zur Live-Ansicht</a></div>`; return; }
    if (!info.open) { main.innerHTML = `<div class="adm-box">${head}<p class="note">Die Online-Anmeldung ist geschlossen. Nachmelden geht am Turniertag vor Ort.</p></div>`; return; }
    main.innerHTML = `<div class="adm-box">${head}
      <form id="rf" class="form"><label for="rn">Name</label><input id="rn" maxlength="40" autocomplete="name" required>
      <label for="rp">Handynummer</label><input id="rp" type="tel" maxlength="30" autocomplete="tel" required>
      ${msg ? `<p class="note" role="alert">${esc(msg)}</p>` : ''}
      <button class="btn pri" type="submit">Verbindlich anmelden</button></form>
      <p class="muted small">${info.count} angemeldet. Die Nummer sieht nur die Turnierleitung, für Rückfragen zum Turnier. Sie wird nach dem Turnier gelöscht.</p></div>`;
    const f = main.querySelector('#rf');
    f.onsubmit = async e => {
      e.preventDefault();
      const b = f.querySelector('button'); b.disabled = true;
      try {
        const n = await rpc('public_register', { p_name: f.rn.value, p_phone: f.rp.value });
        draw(info, `Danke, ${f.rn.value.trim()}! Du bist angemeldet (Nr. ${n}). Bitte ${info.fee} € bar am Turniertag mitbringen.`, true);
      } catch (err) {
        const k = (err && err.message || '').trim();
        const keep = [f.rn.value, f.rp.value];
        draw(info, REG_ERR[k] || 'Anmeldung fehlgeschlagen. Bitte später noch einmal versuchen.');
        const g = main.querySelector('#rf'); if (g) { g.rn.value = keep[0]; g.rp.value = keep[1]; }
      }
    };
  };
  main.innerHTML = '<p class="muted pd">Lade …</p>';
  rpc('public_reg_info', {}).then(i => draw(i)).catch(() => draw(null));
  return () => { alive = false; };
}

// ---------- Spielerprofil (#spieler/<id>) ----------
export function spieler(main, id) {
  return watchTournament(d => {
    if (!d) { main.innerHTML = '<p class="pd">Noch kein Turnier.</p>'; return; }
    const p = d.stats.find(x => x.id === id);
    if (!p) { main.innerHTML = '<div class="wrap"><p class="pd">Spieler nicht gefunden.</p><a class="btn" href="#tabelle">Zur Tabelle</a></div>'; return; }
    const sw = d.swiss && d.swiss.list.find(x => x.id === id);
    const games = d.matches.filter(m => m.player_a === id || m.player_b === id)
      .sort((a, b) => (a.kind === 'sw' ? 0 : 1) - (b.kind === 'sw' ? 0 : 1) || a.round - b.round || (a.kind > b.kind ? 1 : -1));
    const rows = games.map(m => {
      const me = m.player_a === id ? 0 : 1, opp = me ? m.player_a : m.player_b;
      let pts = 0, darts = 0;
      for (const v of m.vis) if (v.side === me) { pts += v.bust ? 0 : v.score; darts += v.darts; }
      const res = m.status === 'bye' || (!opp && ['done', 'wo'].includes(m.status)) ? 'Freilos'
        : m.status === 'done' ? `${me ? m.legs_b : m.legs_a}:${me ? m.legs_a : m.legs_b}`
        : m.status === 'wo' ? (m.winner === id ? 'kampflos gew.' : 'kampflos verl.')
        : ['live', 'review'].includes(m.status) ? `läuft · Board ${m.board}` : 'offen';
      const win = ['done', 'wo', 'bye'].includes(m.status) && m.winner ? (m.winner === id ? 'w' : 'l') : '';
      return `<li class="pf-g ${win}"><span><span class="muted small">${esc(roundName(d.t, m))}</span><br>${opp ? `vs <a href="#spieler/${opp}">${esc(d.pname(opp))}</a>` : 'Freilos'}</span>
        <span class="pf-r"><b>${res}</b><span class="muted small">${darts ? 'Ø ' + fmt(pts / darts * 3) : ''}</span></span></li>`;
    }).join('');
    const tile = (l, v) => `<div class="pf-t"><span>${l}</span><b>${v}</b></div>`;
    const status = p.place ? `${p.place}. Platz` : p.withdrawn ? 'Zurückgezogen' : sw ? `Platz ${sw.rank} · ${sw.pts} Pkt` : p.out !== null && p.out !== undefined ? 'Ausgeschieden' : 'Im Turnier';
    main.innerHTML = `<div class="wrap pf"><a class="btn ghost" href="#tabelle">← Tabelle</a>
      <h1 class="tt">${esc(p.name)}</h1><p class="muted">${esc(status)}</p>
      <div class="pf-grid">${tile('Average', fmt(p.avg))}${tile('Bester Ø (Spiel)', fmt(p.bestAvg))}${tile('Spiele', `${p.s}–${p.n}`)}
        ${tile('Legs', `${p.lf}:${p.la}`)}${tile('Höchstes Finish', p.hf || '–')}${tile('Kürzestes Leg', p.best ? p.best + ' Darts' : '–')}
        ${sw ? tile('Buchholz', sw.buch) : ''}</div>
      <h2 class="sec">Aufnahmen</h2><div class="pf-sc">${BUCKETS.map(b => `<div><span>${b === 180 ? '180' : b + '+'}</span><b class="${b === 180 && p.sc[b] ? 'hot' : ''}">${p.sc[b] || 0}</b></div>`).join('')}</div>
      ${p.hfs.length ? `<h2 class="sec">High Finishes</h2><p class="pf-hf">${p.hfs.sort((a, b) => b - a).map(v => `<span>${v}</span>`).join('')}</p>` : ''}
      <h2 class="sec">Spiele</h2><ol class="list">${rows || '<li class="muted">Noch keine Spiele.</li>'}</ol></div>`;
  }, () => { main.innerHTML = '<p class="pd">Keine Verbindung.</p>'; });
}

// ---------- Notfall-Paket (#druck) ----------
export function druck(main) {
  document.body.classList.add('print-view');
  let last = null;
  const stop = watchTournament(d => {
    last = d;
    if (!d) { main.innerHTML = '<p class="pd">Noch kein Turnier.</p>'; return; }
    const ms = [...d.matches].filter(m => m.status !== 'pending' || m.player_a || m.player_b)
      .sort((a, b) => (a.kind === 'sw' ? 0 : 1) - (b.kind === 'sw' ? 0 : 1) || a.round - b.round || (a.kind > b.kind ? 1 : -1) || a.idx - b.idx);
    const line = m => {
      const fin = ['done', 'wo', 'bye'].includes(m.status);
      const res = m.status === 'done' ? `${m.legs_a} : ${m.legs_b}` : m.status === 'wo' ? 'w. o.' : m.status === 'bye' ? 'Freilos' : '___ : ___';
      return `<tr class="${fin ? 'fin' : ''}"><td>${esc(roundName(d.t, m))}</td><td>${esc(d.pname(m.player_a)) || (m.bye_a ? 'Freilos' : '')}</td>
        <td class="c">${res}</td><td>${esc(d.pname(m.player_b)) || (m.bye_b ? 'Freilos' : '')}</td><td class="c">${m.board && ['live', 'review'].includes(m.status) ? m.board : ''}</td></tr>`;
    };
    const ko = d.matches.some(m => m.kind === 'ko');
    const now = new Date().toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
    main.innerHTML = `<div class="wrap prt">
      <div class="prt-bar no-print"><a class="btn sm" href="#admin">← Leitung</a><button class="btn sm pri" data-p>Drucken / als PDF speichern</button>
        <button class="btn sm" data-csv>Ergebnisse als Datei</button></div>
      <p class="note no-print">Nach der Auslosung einmal drucken und zur Turnierleitung legen. Fällt das Internet länger aus, auf Papier weiterspielen und die Ergebnisse danach unter „Korrekturen“ nachtragen.</p>
      <h1 class="tt">${esc(d.t.name)}</h1><p class="muted">Stand ${now} · ${d.players.length} Spieler</p>
      ${ko ? `<section class="prt-page"><h2 class="sec">${d.t.mode === 'swiss' ? 'KO-Finale' : 'Turnierbaum'}</h2><div class="prt-bk">${bracketHtml(d)}</div></section>` : ''}
      ${d.swiss ? `<section class="prt-page"><h2 class="sec">Tabelle Schweizer System · Runde ${d.swiss.rounds} von ${d.t.swiss.rounds}</h2>
        <table class="prt-t"><thead><tr><th>#</th><th>Spieler</th><th>Pkt</th><th>BHZ</th><th>Legs</th></tr></thead><tbody>
        ${d.swiss.list.map(p => `<tr><td>${p.rank}</td><td>${esc(p.name)}</td><td class="c">${p.pts}</td><td class="c">${p.buch}</td><td class="c">${p.lf}:${p.la}</td></tr>`).join('')}</tbody></table></section>` : ''}
      <section class="prt-page"><h2 class="sec">Alle Spiele</h2><table class="prt-t"><thead><tr><th>Runde</th><th>Spieler A</th><th class="c">Legs</th><th>Spieler B</th><th class="c">Board</th></tr></thead>
        <tbody>${ms.map(line).join('')}</tbody></table></section>
      <section class="prt-page"><h2 class="sec">Spieler</h2><ol class="prt-pl">${d.players.map(p => `<li>${esc(p.name)}${p.withdrawn ? ' (zg.)' : ''}</li>`).join('')}</ol></section></div>`;
    requestAnimationFrame(() => {
      const box = main.querySelector('.prt-bk'), bk = box && box.querySelector('.bk');
      if (bk) { const s = Math.min(1, 1000 / bk.offsetWidth); bk.style.zoom = s; }
    });
  }, () => { if (!last) main.innerHTML = '<p class="pd">Keine Verbindung.</p>'; });
  const onClick = e => {
    if (e.target.closest('[data-p]')) window.print();
    if (e.target.closest('[data-csv]') && last) download(last);
  };
  main.addEventListener('click', onClick);
  return () => { stop(); main.removeEventListener('click', onClick); document.body.classList.remove('print-view'); };
}

function download(d) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Runde', 'Spieler A', 'Legs A', 'Legs B', 'Spieler B', 'Status', 'Sieger', 'Ø A', 'Ø B']];
  const label = { pending: 'offen', ready: 'spielbereit', live: 'läuft', review: 'prüfen', done: 'beendet', wo: 'kampflos', bye: 'Freilos' };
  for (const m of d.matches) {
    const av = [0, 1].map(s => { let p = 0, n = 0; for (const v of m.vis) if (v.side === s) { p += v.bust ? 0 : v.score; n += v.darts; } return n ? (p / n * 3).toFixed(2).replace('.', ',') : ''; });
    rows.push([roundName(d.t, m), d.pname(m.player_a), m.legs_a, m.legs_b, d.pname(m.player_b), label[m.status] || m.status, d.pname(m.winner), av[0], av[1]]);
  }
  rows.push([]);
  rows.push(['Spieler', 'Platz', 'Siege', 'Niederlagen', 'Legs', 'Average', 'Höchstes Finish', '180er']);
  for (const p of d.stats) rows.push([p.name, p.place || '', p.s, p.n, `${p.lf}:${p.la}`, p.avg ? p.avg.toFixed(2).replace('.', ',') : '', p.hf || '', p.t180]);
  const csv = '﻿' + rows.map(r => r.map(q).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `vynen-ergebnisse-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
