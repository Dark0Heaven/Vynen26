// Zusätze: Anmeldung, Spielerprofil, Notfall-Paket (Druck + Ergebnis-Datei)
import { rpc, esc, sb } from './db.js';
import { roundName, roundCfg, OUT_LABEL } from './rules.js';
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

// ---------- App auf den Homebildschirm ----------
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
window.addEventListener('appinstalled', () => { installEvt = null; });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function installGuide() {
  if (isStandalone()) return '';
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const iosOther = ios && /CriOS|FxiOS|EdgiOS|GSA/.test(ua);
  const steps = ios
    ? (iosOther ? '<li>Diese Seite in <b>Safari</b> öffnen (nur dort geht es auf dem iPhone).</li>' : '')
      + '<li>Unten auf <b>Teilen</b> tippen <span class="ico" aria-hidden="true">⬆︎</span> (Viereck mit Pfeil).</li><li>Nach unten scrollen und <b>Zum Home-Bildschirm</b> wählen.</li><li>Oben rechts auf <b>Hinzufügen</b> tippen.</li>'
    : '<li>Oben rechts auf <b>⋮</b> tippen.</li><li><b>App installieren</b> oder <b>Zum Startbildschirm hinzufügen</b> wählen.</li><li>Mit <b>Installieren</b> bestätigen.</li>';
  return `<div class="card inst"><h3>Hol dir die App aufs Handy</h3>
    <p class="muted">Dann hast du am Turniertag Spielstand, Turnierbaum und deine Statistik mit einem Tipp.</p>
    <button class="btn pri" data-install ${installEvt ? '' : 'hidden'}>App installieren</button>
    <ol class="inst-steps" ${installEvt ? 'hidden' : ''}>${steps}</ol></div>`;
}
function wireInstall(root) {
  const b = root.querySelector('[data-install]'); if (!b) return;
  b.onclick = async () => {
    if (!installEvt) return;
    installEvt.prompt();
    const r = await installEvt.userChoice.catch(() => null);
    installEvt = null;
    if (r && r.outcome === 'accepted') b.closest('.inst').innerHTML = '<h3>Fertig!</h3><p class="muted">Die App liegt jetzt auf deinem Startbildschirm.</p>';
    else { b.hidden = true; root.querySelector('.inst-steps').hidden = false; }
  };
}

// ---------- Anmeldung (#anmelden) ----------
export function anmelden(main) {
  let alive = true;
  const draw = (info, msg = '', ok = false) => {
    if (!alive) return;
    if (!info) { main.innerHTML = '<p class="pd">Keine Verbindung. Bitte später neu laden.</p>'; return; }
    const head = `<h2>Anmeldung</h2><p class="muted">Neujahrsdart-Turnier Vynen 26 · Sa 27.02.2027 · 17:00 Uhr · Platzhaus Vynen<br>
      Startgeld ${info.fee} € inkl. Freigetränke und Currywurst, bar vor Ort${info.deadline ? ` · Anmeldeschluss ${dateDe(info.deadline)}` : ''}</p>`;
    if (ok) { main.innerHTML = `<div class="adm-box">${head}<p class="note ok-note" role="status">${esc(msg)}</p>
      ${installGuide()}<a class="btn" href="#live">Zur Live-Ansicht</a></div>`; wireInstall(main); return; }
    if (!info.open) { main.innerHTML = `<div class="adm-box">${head}<p class="note">Die Online-Anmeldung ist geschlossen. Nachmelden geht am Turniertag vor Ort.</p>${installGuide()}</div>`; wireInstall(main); return; }
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
    const ord = { sw: 0, lg: 0, ko: 1, p3: 1, sc: 2 };
    const ms = [...d.matches].filter(m => m.status !== 'pending' || m.player_a || m.player_b)
      .sort((a, b) => (ord[a.kind] - ord[b.kind]) || a.round - b.round || (a.kind > b.kind ? 1 : -1) || a.idx - b.idx);
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
      ${d.matches.some(m => m.kind === 'sc') ? `<section class="prt-page"><h2 class="sec">Silver Cup</h2><div class="prt-bk">${bracketHtml(d, 'sc')}</div></section>` : ''}
      ${d.swiss ? `<section class="prt-page"><h2 class="sec">Tabelle Schweizer System · Runde ${d.swiss.rounds} von ${d.t.swiss.rounds}</h2>
        <table class="prt-t"><thead><tr><th>#</th><th>Spieler</th><th>Pkt</th><th>BHZ</th><th>Legs</th></tr></thead><tbody>
        ${d.swiss.list.map(p => `<tr><td>${p.rank}</td><td>${esc(p.name)}</td><td class="c">${p.pts}</td><td class="c">${p.buch}</td><td class="c">${p.lf}:${p.la}</td></tr>`).join('')}</tbody></table></section>` : ''}
      <section class="prt-page"><h2 class="sec">Alle Spiele</h2><table class="prt-t"><thead><tr><th>Runde</th><th>Spieler A</th><th class="c">Legs</th><th>Spieler B</th><th class="c">Board</th></tr></thead>
        <tbody>${ms.map(line).join('')}</tbody></table></section>
      <section class="prt-page"><h2 class="sec">Spieler</h2><ol class="prt-pl">${d.players.map(p => `<li>${esc(p.name)}${p.withdrawn ? ' (zg.)' : ''}</li>`).join('')}</ol></section></div>`;
    requestAnimationFrame(() => {
      for (const bk of main.querySelectorAll('.prt-bk .bk')) { const s = Math.min(1, 1000 / bk.offsetWidth); bk.style.zoom = s; }
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

// ---------- Regeln für Spieler (#regeln) ----------
// Formate kommen aus dem aktuellen Turnier; ohne Turnier gilt der Plan der Turnierleitung.
const PLAN = { main: [['16tel-Finale', 3], ['Achtelfinale', 3], ['Viertelfinale', 5], ['Halbfinale', 7], ['Finale', 9]], p3: 7,
  silver: [['Achtelfinale', 3], ['Viertelfinale', 3], ['Halbfinale', 5], ['Finale', 5]] };
export function regeln(main) {
  const fmtRow = (name, c) => `<tr><th>${esc(name)}</th><td>Best of ${c.bo}</td><td>${c.start}</td><td>${esc(OUT_LABEL[c.out] || c.out)}${c.din ? ' · Double In' : ''}</td></tr>`;
  const table = rows => `<div class="tblwrap"><table class="tbl rg-t"><thead><tr><th>Runde</th><th>Legs</th><th>Start</th><th>Out</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const formats = d => {
    const t = d && d.t;
    if (!t || t.mode !== 'ko') {
      const c = bo => ({ bo, start: 501, out: 'double' });
      return `<p class="muted small">Geplante Formate (werden am Turniertag bestätigt):</p>
        ${table(PLAN.main.map(([n, b]) => fmtRow(n, c(b))).join('') + fmtRow('Spiel um Platz 3', c(PLAN.p3)))}
        <h3 class="rg-h3">Silver Cup</h3>${table(PLAN.silver.map(([n, b]) => fmtRow(n, c(b))).join(''))}`;
    }
    const R = Math.round(Math.log2(t.size)), main = [];
    for (let r = 0; r < R; r++) main.push(fmtRow(roundName(t, { kind: 'ko', round: r }), roundCfg(t, { kind: 'ko', round: r })));
    if (t.third_place) main.push(fmtRow('Spiel um Platz 3', roundCfg(t, { kind: 'p3' })));
    let h = table(main.join(''));
    if (t.silver) {
      const sR = Math.round(Math.log2(t.size / 2)), rows = [];
      for (let r = 0; r < sR; r++) rows.push(fmtRow(roundName(t, { kind: 'sc', round: r }).replace('Silver Cup · ', ''), roundCfg(t, { kind: 'sc', round: r })));
      h += `<h3 class="rg-h3">Silver Cup</h3>${table(rows.join(''))}`;
    }
    return h;
  };
  const sec = (title, items) => `<section class="card rg-sec"><h2 class="sec">${title}</h2><ul class="rg-l">${items.map(i => `<li>${i}</li>`).join('')}</ul></section>`;
  const draw = d => {
    const silver = !d || d.t.mode !== 'ko' || d.t.silver;
    main.innerHTML = `<div class="wrap rg"><h1 class="tt">Regeln</h1>
      <p class="muted">Neujahrsdart-Turnier Vynen 26 · Sa 27.02.2027 · 17:00 Uhr · Platzhaus Vynen</p>
      ${sec('Ablauf', [
        'Bitte bis <b>17:00 Uhr</b> da sein und das <b>Startgeld von 20 €</b> bar bezahlen. Darin sind <b>Freigetränke und Currywurst</b> enthalten. Danach wird ausgelost.',
        'Gespielt wird im <b>KO-System</b>: Wer verliert, scheidet aus dem Hauptturnier aus.',
        silver ? 'Wer in der <b>1. Runde</b> verliert, spielt im <b>Silver Cup</b> weiter, einem eigenen KO-Baum. So hat jeder mindestens zwei Spiele.' : '',
        'Die beiden Verlierer der Halbfinale spielen das <b>Spiel um Platz 3</b>.',
        'Wann und an welchem Board du spielst, siehst du live auf <b>vynen26.de</b> und auf dem Bildschirm in der Halle. Wirst du aufgerufen, geh bitte direkt zum Board.',
      ].filter(Boolean))}
      <section class="card rg-sec"><h2 class="sec">Spielmodus</h2>
        <p>Alle Spiele: <b>501, Double Out</b>. Ein Leg gewinnt, wer genau auf 0 kommt und dabei mit einem <b>Double</b> (oder dem Bull) ausmacht.</p>
        ${formats(d)}
        <p class="muted small">„Best of 3“ heißt: Wer zuerst 2 Legs gewinnt, gewinnt das Spiel. Best of 5 = 3 Legs, Best of 7 = 4, Best of 9 = 5.</p></section>
      ${sec('Am Board', [
        'Vor dem Spiel wird <b>ausgebullt</b>: Jeder wirft einen Dart aufs Bull, wer näher dran ist, beginnt das erste Leg.',
        'Danach wechselt der <b>Anwurf</b> mit jedem Leg. Kommt es zum <b>Entscheidungs-Leg</b>, wird noch einmal ausgebullt.',
        'Eine <b>Aufnahme</b> sind 3 Darts. Es zählen nur Darts, die nach der Aufnahme <b>im Board stecken</b>. Abpraller und herausgefallene Darts zählen 0.',
        '<b>Überworfen</b> (unter 0, genau 1 Rest oder 0 ohne Double): Die ganze Aufnahme zählt nicht, der Rest bleibt wie vorher.',
        'Geworfen wird hinter der <b>Wurflinie</b> (2,37 m vom Board). Der Fuß darf die Linie nicht übertreten.',
        'Darts erst ziehen, wenn der <b>Schiri</b> die Punkte eingetragen hat.',
      ])}
      ${sec('Schiri und Wertung', [
        'An jedem Board tippt ein Schiri die Punkte ins Tablet. Der Spielstand ist sofort live für alle sichtbar.',
        'Siehst du einen Fehler, sag es <b>sofort</b>, noch bevor die Darts gezogen sind. Der Schiri kann jede Eingabe rückgängig machen.',
        'Am Ende des Spiels prüft der Schiri das Ergebnis und bestätigt es. Danach geht es nur noch über die Turnierleitung zu ändern.',
        'Bei Streitfragen entscheidet die <b>Turnierleitung</b>.',
      ])}
      ${sec('Fairplay', [
        'Kein Ablenken des Gegners beim Werfen: Abstand halten, leise sein, nicht in die Wurfbahn laufen.',
        'Handys bitte stumm, und keine Getränke im Wurfbereich abstellen.',
        'Wer sein Spiel nicht antreten kann oder aufgibt, meldet sich bei der Turnierleitung. Das Spiel wird dann kampflos gewertet.',
      ])}
      ${sec('Preise', [
        '<b>Preisgeld für Platz 1 bis 3</b> und ein <b>Pokal</b> für den Sieger.',
        'Das Preisgeld ergibt sich aus den Startgeldern abzüglich Getränke und Currywurst und wird am Turniertag bekanntgegeben.',
        '🌭 Currywurst und Getränke sind im Startgeld enthalten.',
      ])}
      <p class="muted small">Änderungen durch die Turnierleitung vorbehalten.</p></div>`;
  };
  draw(null);
  return watchTournament(d => draw(d && d.t ? d : null), () => {});
}

// ---------- Ehemalige Sieger (#sieger) ----------
export function sieger(main) {
  let alive = true, list = [], isAdmin = false, edit = null, msg = '';
  const load = async () => {
    const r = await sb.from('champions').select('*').order('year', { ascending: false });
    list = r.data || [];
    const { data: { session } } = await sb.auth.getSession();
    isAdmin = session ? await rpc('am_admin', {}).catch(() => false) : false;
  };
  const form = c => `<form class="card sg-form" id="sgf"><h3>${c.id ? 'Eintrag ändern' : 'Neuen Sieger eintragen'}</h3>
    <div class="sg-grid"><label>Jahr<input name="year" type="number" min="1990" max="2100" required value="${c.year || new Date().getFullYear()}"></label>
      <label>Sieger<input name="name" required maxlength="60" value="${esc(c.name || '')}"></label>
      <label>2. Platz<input name="second" maxlength="60" value="${esc(c.second || '')}"></label>
      <label>3. Platz<input name="third" maxlength="60" value="${esc(c.third || '')}"></label>
      <label>Silver Cup<input name="silver" maxlength="60" value="${esc(c.silver || '')}"></label>
      <label class="wide">Notiz<input name="note" maxlength="200" placeholder="z. B. Finale 5:3, Highfinish 170" value="${esc(c.note || '')}"></label></div>
    <div class="bbtns"><button class="btn pri" type="submit">Speichern</button><button class="btn" type="button" data-k="cancel">Abbrechen</button>
      ${c.id ? '<button class="btn warn" type="button" data-k="del">Löschen</button>' : ''}</div></form>`;
  const draw = () => {
    if (!alive) return;
    main.innerHTML = `<div class="wrap sg"><h1 class="tt">Ehemalige Sieger</h1>
      <p class="muted">Neujahrsdart-Turnier Vynen · Hall of Fame</p>
      ${msg ? `<p class="note" role="status">${esc(msg)}</p>` : ''}
      ${isAdmin && !edit ? '<button class="btn sm" data-k="new">+ Sieger eintragen</button>' : ''}
      ${edit ? form(edit) : ''}
      <ol class="sg-list">${list.map((c, i) => `<li class="sg-c ${i === 0 ? 'first' : ''}">
        <div class="sg-y">${c.year}</div>
        <div class="sg-n"><span class="sg-cup" aria-hidden="true">🏆</span><b>${esc(c.name)}</b>
          ${c.second || c.third || c.silver ? `<div class="sg-more">${c.second ? `<span>2. ${esc(c.second)}</span>` : ''}${c.third ? `<span>3. ${esc(c.third)}</span>` : ''}${c.silver ? `<span class="sv">Silver Cup: ${esc(c.silver)}</span>` : ''}</div>` : ''}
          ${c.note ? `<p class="muted small">${esc(c.note)}</p>` : ''}</div>
        ${isAdmin ? `<button class="btn sm ghost" data-ed="${c.id}">Ändern</button>` : ''}</li>`).join('') || '<li class="muted">Noch keine Einträge.</li>'}</ol>
      <p class="muted small">Wer gewinnt 2027 und kommt hier dazu? 🎯</p></div>`;
    const f = main.querySelector('#sgf');
    if (f) f.onsubmit = async e => {
      e.preventDefault();
      try {
        await rpc('admin_champion_save', { p_id: edit.id || null, p_year: Number(f.year.value), p_name: f.name.value, p_second: f.second.value, p_third: f.third.value, p_silver: f.silver.value, p_note: f.note.value });
        edit = null; msg = 'Gespeichert.'; await load();
      } catch (err) { msg = 'Speichern fehlgeschlagen.'; }
      draw();
    };
  };
  main.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.k === 'new') { edit = {}; msg = ''; draw(); }
    if (b.dataset.ed) { edit = list.find(c => c.id === b.dataset.ed) || null; msg = ''; draw(); }
    if (b.dataset.k === 'cancel') { edit = null; draw(); }
    if (b.dataset.k === 'del') {
      if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Wirklich löschen?'; return; }
      await rpc('admin_champion_delete', { p_id: edit.id }).catch(() => {}); edit = null; msg = 'Eintrag gelöscht.'; await load(); draw();
    }
  };
  main.innerHTML = '<p class="muted pd">Lade …</p>';
  load().then(draw).catch(() => { main.innerHTML = '<p class="pd">Keine Verbindung.</p>'; });
  return () => { alive = false; main.onclick = null; };
}
