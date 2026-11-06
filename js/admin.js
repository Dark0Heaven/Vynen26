// Turnierleitung: Login, Turnier anlegen, Spiele auf Boards legen und PINs vergeben.
import { sb, rpc, latestTournament, loadTournament, loadVisits, esc } from './db.js';
import { swissStandings, swissPairing, suggestRounds } from './swiss.js';
import { roundCfg, roundName, OUT_LABEL } from './rules.js';

const ERR = {
  not_admin: 'Dieses Konto ist nicht als Turnierleitung freigeschaltet.',
  not_ready: 'Das Spiel ist nicht spielbereit.',
  board_busy: 'Auf diesem Board läuft bereits ein Spiel.',
  bad_board: 'Dieses Board gibt es nicht.',
  already_started: 'Auf diesem Spiel wurde schon geworfen. Freigeben geht nicht mehr.',
  next_started: 'Das Folgespiel läuft schon oder ist beendet. Erst dieses zurücksetzen.',
  bad_result: 'Ungültiges Ergebnis: Ein Spieler braucht genau die nötigen Legs, der andere weniger.',
  match_running: 'Der Spieler steht gerade in einem laufenden Spiel. Erst das Ergebnis eintragen oder das Spiel zurücksetzen.',
  no_free_slot: 'Kein Freilos mehr frei, in das nachgemeldet werden kann (oder das Folgespiel läuft schon).',
  empty_name: 'Bitte einen Namen eingeben.',
  round_open: 'Es laufen noch Spiele dieser Runde.',
  rematch: 'Diese Paarung gab es schon.',
  stale_round: 'Die Runde wurde inzwischen schon ausgelost. Seite neu geladen.',
  all_rounds_done: 'Alle Runden sind gespielt.',
  bad_pairs: 'Die Auslosung passt nicht zu den aktiven Spielern. Bitte neu auslosen.',
  rounds_open: 'Erst alle Schweizer Runden fertig spielen.',
  final_started: 'Das KO-Finale läuft schon. Nachmelden ist nicht mehr möglich.',
  bad_rounds: 'Rundenzahl zwischen 1 und 20 wählen.',
  min_2_players: 'Mindestens zwei Spieler eintragen.',
  max_128_players: 'Maximal 128 Spieler.',
};
const errText = e => ERR[(e && (e.message || '').trim())] || (e && e.message) || 'Unbekannter Fehler.';

export async function startAdmin(main) {
  let alive = true, ch = null, tab = 'boards', msg = '', pins = {}, data = null, timer = null, preview = null;

  const { data: { session } } = await sb.auth.getSession();
  if (!session) return loginView();
  const isAdmin = await rpc('am_admin', {}).catch(() => false);
  if (!isAdmin) return claimView();
  await loadAll();
  draw();
  ch = sb.channel('admin')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, () => soon())
    .subscribe();
  return () => { alive = false; clearTimeout(timer); if (ch) sb.removeChannel(ch); };

  // ---------- Login ----------
  function loginView(note = '') {
    main.innerHTML = `<div class="adm-box"><h2>Turnierleitung</h2>
      <form id="lf" class="form">
        <label for="em">E-Mail</label><input id="em" type="email" autocomplete="username" required>
        <label for="pw">Passwort</label><input id="pw" type="password" autocomplete="current-password" minlength="8" required>
        ${note ? `<p class="note" role="alert">${esc(note)}</p>` : ''}
        <button class="btn pri" type="submit">Anmelden</button>
        <button class="btn" type="button" id="su">Konto anlegen</button>
      </form><p class="muted small">Konto anlegen nur beim ersten Mal. Danach mit dem Einrichtungscode freischalten.</p></div>`;
    const f = main.querySelector('#lf');
    f.onsubmit = async e => {
      e.preventDefault();
      const { error } = await sb.auth.signInWithPassword({ email: f.em.value.trim(), password: f.pw.value });
      if (error) return loginView(error.message.includes('Email not confirmed') ? 'Bitte zuerst den Link in der Bestätigungs-Mail öffnen.' : 'Anmeldung fehlgeschlagen. E-Mail oder Passwort falsch.');
      reload();
    };
    main.querySelector('#su').onclick = async () => {
      if (!f.reportValidity()) return;
      const { data: d, error } = await sb.auth.signUp({ email: f.em.value.trim(), password: f.pw.value,
        options: { emailRedirectTo: location.origin + location.pathname + '#admin' } });
      if (error) return loginView('Konto konnte nicht angelegt werden: ' + error.message);
      if (!d.session) return loginView('Konto angelegt. Bitte den Link in der Bestätigungs-Mail öffnen und dich dann anmelden.');
      reload();
    };
    return () => {};
  }

  function claimView(note = '') {
    main.innerHTML = `<div class="adm-box"><h2>Freischalten</h2>
      <p class="muted">Gib den Einrichtungscode ein, um dieses Konto zur Turnierleitung zu machen. Er gilt nur einmal.</p>
      <form id="cf" class="form"><label for="code">Einrichtungscode</label><input id="code" autocomplete="off" required>
      ${note ? `<p class="note" role="alert">${esc(note)}</p>` : ''}
      <button class="btn pri" type="submit">Freischalten</button><button class="btn" type="button" id="lo">Abmelden</button></form></div>`;
    const f = main.querySelector('#cf');
    f.onsubmit = async e => {
      e.preventDefault();
      const ok = await rpc('claim_admin', { p_code: f.code.value.trim().toUpperCase() }).catch(() => false);
      if (!ok) return claimView('Code ungültig.');
      reload();
    };
    main.querySelector('#lo').onclick = async () => { await sb.auth.signOut(); reload(); };
    return () => {};
  }

  function reload() { window.dispatchEvent(new HashChangeEvent('hashchange')); }

  // ---------- Daten ----------
  async function loadAll() {
    const t = await latestTournament();
    if (!t) { data = null; tab = 'new'; return; }
    data = await loadTournament(t.id);
    if (t.mode === 'swiss') {
      data.visits = await loadVisits(data.matches.filter(m => m.kind === 'sw').map(m => m.id));
      data.sw = swissStandings(data.players, data.matches, data.visits);
    }
    const ids = data.matches.filter(m => ['live', 'review'].includes(m.status)).map(m => m.id);
    pins = {};
    if (ids.length) {
      const { data: p } = await sb.from('match_pins').select('match_id,pin,active').in('match_id', ids);
      for (const x of p || []) if (x.active) pins[x.match_id] = x.pin;
    }
  }
  function soon() { clearTimeout(timer); timer = setTimeout(async () => { if (!alive) return; await loadAll(); if (tab === 'boards') draw(); }, 300); }

  // ---------- Ansicht ----------
  function draw() {
    const tabs = `<div class="seg adm-tabs" role="group">
      <button class="${tab === 'boards' ? 'on' : ''}" data-tab="boards" ${data ? '' : 'disabled'}>Boards</button>
      <button class="${tab === 'fix' ? 'on' : ''}" data-tab="fix" ${data ? '' : 'disabled'}>Korrekturen</button>
      <button class="${tab === 'new' ? 'on' : ''}" data-tab="new">Neues Turnier</button></div>`;
    main.innerHTML = `<div class="wrap adm"><div class="adm-head"><h1 class="tt">Turnierleitung</h1><div class="bbtns"><a class="btn sm" href="#halle">Hallen-Anzeige</a><button class="btn sm" id="lo">Abmelden</button></div></div>
      ${tabs}${msg ? `<p class="note" role="alert">${esc(msg)}</p>` : ''}<div id="body"></div></div>`;
    main.querySelector('#lo').onclick = async () => { await sb.auth.signOut(); reload(); };
    main.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; msg = ''; draw(); });
    const body = main.querySelector('#body');
    if (tab === 'new') newForm(body); else if (tab === 'fix') fixes(body); else boards(body);
  }

  function boards(body) {
    const { t, players, matches } = data;
    const nm = id => esc((players.find(p => p.id === id) || {}).name || 'offen');
    const ready = matches.filter(m => m.status === 'ready').sort((a, b) => a.round - b.round || (a.kind > b.kind ? 1 : -1) || a.idx - b.idx);
    const busy = new Set(matches.filter(m => ['live', 'review'].includes(m.status)).map(m => m.board));
    const free = []; for (let b = 1; b <= t.boards; b++) if (!busy.has(b)) free.push(b);
    let h = `<h2 class="sec">${esc(t.name)} · Boards</h2><div class="boards">`;
    for (let b = 1; b <= t.boards; b++) {
      const m = matches.find(x => x.board === b && ['live', 'review'].includes(x.status));
      if (!m) { h += `<article class="bd free"><div class="bd-no">${b}</div><p class="muted">Frei</p></article>`; continue; }
      h += `<article class="bd"><div class="bd-h"><span class="bd-no">${b}</span><span class="muted">${esc(roundName(t, m))}</span>
        ${m.status === 'review' ? '<span class="tag gold">Prüfen</span>' : '<span class="tag live">Live</span>'}</div>
        <div class="bd-p"><span class="n">${nm(m.player_a)}</span><span class="l">${m.legs_a}</span><span></span></div>
        <div class="bd-p"><span class="n">${nm(m.player_b)}</span><span class="l">${m.legs_b}</span><span></span></div>
        <div class="pinline"><span class="muted">PIN</span><b>${esc(pins[m.id] || '––––')}</b>
        <button class="btn sm" data-un="${m.id}">Freigeben</button></div></article>`;
    }
    h += `</div>`;
    if (t.mode === 'swiss') h += swissPanel();
    h += `<h2 class="sec">Spielbereit</h2>`;
    if (!ready.length) h += '<p class="muted">Kein Spiel wartet gerade.</p>';
    else h += `<ol class="list adm-q">${ready.map(m => {
      const cfg = roundCfg(t, m);
      return `<li><div><b>${nm(m.player_a)}</b> <i>vs</i> <b>${nm(m.player_b)}</b><div class="muted small">${esc(roundName(t, m))} · Best of ${cfg.bo} Legs · ${cfg.start} ${OUT_LABEL[cfg.out]}</div></div>
        <div class="bbtns">${free.length ? free.map(b => `<button class="btn sm pri" data-as="${m.id}" data-b="${b}">Board ${b}</button>`).join('') : '<span class="muted small">alle Boards belegt</span>'}</div></li>`;
    }).join('')}</ol>`;
    body.innerHTML = h;
    body.onclick = async e => {
      const b = e.target.closest('button'); if (!b) return;
      try {
        if (b.dataset.as) {
          b.disabled = true;
          const pin = await rpc('admin_assign_board', { p_match: b.dataset.as, p_board: Number(b.dataset.b) });
          msg = `Board ${b.dataset.b} gestartet · PIN ${pin}`;
        }
        if (b.dataset.un) { await rpc('admin_unassign', { p_match: b.dataset.un }); msg = 'Board freigegeben.'; }
        if (b.dataset.sw === 'preview') { preview = swissPairing(data.sw); if (!preview) msg = 'Keine gültige Auslosung möglich.'; draw(); return; }
        if (b.dataset.sw === 'cancel') { preview = null; draw(); return; }
        if (b.dataset.sw === 'go' && preview) {
          await rpc('admin_swiss_pair', { p_tournament: t.id, p_round: data.sw.rounds + 1, p_pairs: preview.pairs,
            p_bye: preview.bye, p_allow_rematch: preview.rematch });
          msg = `Runde ${data.sw.rounds + 1} ausgelost.`; preview = null;
        }
        if (b.dataset.sw === 'final') {
          const top = data.sw.list.filter(p => !p.withdrawn).map(p => p.id);
          await rpc('admin_swiss_final', { p_tournament: t.id, p_players: top.slice(0, t.size) });
          msg = `KO-Finale der Top ${t.size} gestartet.`;
        }
        await loadAll(); draw();
      } catch (err) { preview = null; msg = errText(err); await loadAll().catch(() => {}); draw(); }
    };
    const af = body.querySelector('#swadd');
    if (af) af.onsubmit = async e => {
      e.preventDefault();
      try { await rpc('admin_swiss_add', { p_tournament: t.id, p_name: af.querySelector('input').value });
        msg = 'Spieler nachgemeldet. Er wird ab der nächsten Auslosung berücksichtigt.'; preview = null; await loadAll(); draw(); }
      catch (err) { msg = errText(err); draw(); }
    };
  }

  // ---------- Schweizer System ----------
  function swissPanel() {
    const { t, matches } = data, sw = data.sw, total = t.swiss.rounds;
    const nm = id => esc((data.players.find(p => p.id === id) || {}).name || '');
    const hasFinal = matches.some(m => m.kind === 'ko');
    const done = sw.rounds >= total && !sw.open;
    const endTxt = { table: 'Tabellen-Erster gewinnt', top4: 'KO-Finale Top 4', top8: 'KO-Finale Top 8' }[t.swiss.end];
    let h = `<h2 class="sec">Schweizer System</h2><div class="card swp"><div class="swp-h">
      <div><b>Runde ${sw.rounds} von ${total}</b><div class="muted small">${endTxt} · Nachzügler starten mit ${t.swiss.late === 'last' ? 'den Punkten des Letzten' : '0 Punkten'}</div></div>`;
    if (preview) {
      h += `</div><p class="small">Vorschau Runde ${sw.rounds + 1}${preview.rematch ? ' · <b class="warn-t">Ohne Wiederholung nicht lösbar, enthält eine schon gespielte Paarung</b>' : ''}:</p>
        <ol class="list">${preview.pairs.map(([a, b]) => `<li><span>${nm(a)} <i>vs</i> ${nm(b)}</span></li>`).join('')}
        ${preview.bye ? `<li><span>${nm(preview.bye)}</span><span class="muted">Freilos (2 Punkte)</span></li>` : ''}</ol>
        <div class="bbtns"><button class="btn pri" data-sw="go">Auslosung bestätigen</button><button class="btn" data-sw="cancel">Abbrechen</button></div>`;
    } else if (sw.open) {
      h += `<span class="muted small">Runde läuft – Auslosung nach dem letzten Spiel</span></div>`;
    } else if (!done) {
      h += `<button class="btn pri" data-sw="preview">Runde ${sw.rounds + 1} auslosen</button></div>`;
    } else if (t.swiss.end !== 'table' && !hasFinal) {
      h += `<button class="btn pri" data-sw="final">KO-Finale Top ${t.size} starten</button></div>`;
    } else {
      h += `<span class="tag gold">${hasFinal ? 'KO-Finale läuft' : 'Beendet'}</span></div>`;
    }
    if (!hasFinal) h += `<form id="swadd" class="bbtns addrow"><input placeholder="Name für Nachmeldung" maxlength="40" aria-label="Name für Nachmeldung" required>
      <button class="btn sm" type="submit">Nachmelden (ab nächster Runde)</button></form>`;
    return h + '</div>';
  }

  // ---------- Korrekturen ----------
  function fixes(body) {
    const { t, players, matches } = data;
    const nm = id => esc((players.find(p => p.id === id) || {}).name || 'offen');
    const shown = matches.filter(m => m.player_a && m.player_b && m.status !== 'pending')
      .sort((a, b) => a.round - b.round || (a.kind > b.kind ? 1 : -1) || a.idx - b.idx);
    const label = { ready: 'Spielbereit', live: 'Läuft', review: 'Wartet auf Bestätigung', done: 'Beendet', wo: 'Kampflos', bye: 'Freilos' };
    body.innerHTML = `
      <h2 class="sec">Spiele</h2>
      <p class="muted small">Ergebnis von Hand setzen (z. B. wenn ohne Scorer gespielt wurde) oder ein Spiel komplett zurücksetzen. Zurücksetzen löscht die Aufnahmen dieses Spiels.</p>
      <ol class="list fixlist">${shown.map(m => {
        const need = Math.ceil(roundCfg(t, m).bo / 2);
        const opts = n => Array.from({ length: need + 1 }, (_, i) => `<option ${i === n ? 'selected' : ''}>${i}</option>`).join('');
        return `<li><div><b>${nm(m.player_a)}</b> <i>vs</i> <b>${nm(m.player_b)}</b>
          <div class="muted small">${esc(roundName(t, m))} · ${label[m.status] || m.status}${m.status === 'done' ? ` · ${m.legs_a}:${m.legs_b}` : ''} · First to ${need}</div></div>
          <div class="bbtns"><select data-la="${m.id}" aria-label="Legs ${nm(m.player_a)}">${opts(m.legs_a)}</select><span>:</span>
          <select data-lb="${m.id}" aria-label="Legs ${nm(m.player_b)}">${opts(m.legs_b)}</select>
          <button class="btn sm pri" data-set="${m.id}">Setzen</button>
          ${m.status !== 'ready' ? `<button class="btn sm" data-reset="${m.id}">Zurücksetzen</button>` : ''}</div></li>`;
      }).join('') || '<li class="muted">Noch keine Spiele mit zwei Spielern.</li>'}</ol>
      <h2 class="sec">Spieler</h2>
      <form id="addf" class="bbtns addrow"><input id="addn" placeholder="Name für Nachmeldung" maxlength="40" aria-label="Name für Nachmeldung" required>
        <button class="btn sm pri" type="submit">${t.mode === 'swiss' ? 'Nachmelden (ab nächster Runde)' : 'Nachmelden (in ein Freilos)'}</button></form>
      <ol class="list fixlist">${players.map(p => `<li><div><span class="muted">${p.seed}.</span>
        <input class="inl" data-name="${p.id}" value="${esc(p.name)}" maxlength="40" aria-label="Name von Spieler ${p.seed}">
        ${p.withdrawn ? '<span class="st">Zurückgezogen</span>' : ''}</div>
        <div class="bbtns"><button class="btn sm" data-ren="${p.id}">Umbenennen</button>
        ${p.withdrawn ? '' : `<button class="btn sm" data-wd="${p.id}">Zurückziehen</button>`}</div></li>`).join('')}</ol>`;
    let confirmKey = '';
    body.onclick = async e => {
      const b = e.target.closest('button'); if (!b) return;
      const d = b.dataset;
      const ask = (key, text) => { if (confirmKey === key) { confirmKey = ''; return true; } confirmKey = key; b.textContent = text; b.classList.add('warn'); return false; };
      try {
        if (d.set) {
          const la = Number(body.querySelector(`[data-la="${d.set}"]`).value), lb = Number(body.querySelector(`[data-lb="${d.set}"]`).value);
          await rpc('admin_set_result', { p_match: d.set, p_legs_a: la, p_legs_b: lb }); msg = `Ergebnis ${la}:${lb} gesetzt.`;
        } else if (d.reset) {
          if (!ask('r' + d.reset, 'Wirklich zurücksetzen?')) return;
          await rpc('admin_reset_match', { p_match: d.reset }); msg = 'Spiel zurückgesetzt.';
        } else if (d.ren) {
          const v = body.querySelector(`[data-name="${d.ren}"]`).value;
          await rpc('admin_rename', { p_player: d.ren, p_name: v }); msg = 'Name geändert.';
        } else if (d.wd) {
          if (!ask('w' + d.wd, 'Wirklich zurückziehen?')) return;
          await rpc('admin_withdraw', { p_player: d.wd }); msg = 'Spieler zurückgezogen. Offene Spiele gehen kampflos an den Gegner.';
        } else return;
        await loadAll(); draw();
      } catch (err) { msg = errText(err); draw(); }
    };
    body.querySelector('#addf').onsubmit = async e => {
      e.preventDefault();
      try { await rpc(t.mode === 'swiss' ? 'admin_swiss_add' : 'admin_add_player', { p_tournament: t.id, p_name: body.querySelector('#addn').value });
        msg = 'Spieler nachgemeldet.'; await loadAll(); draw(); }
      catch (err) { msg = errText(err); draw(); }
    };
  }

  function newForm(body) {
    const rn = (R, r) => ['Finale', 'Halbfinale', 'Viertelfinale', 'Achtelfinale'][R - 1 - r] || `Runde ${r + 1}`;
    const cfgRow = (key, label, d) => `<tr><th>${label}</th>
      <td><select data-c="${key}.bo" aria-label="${label} Best of">${[1, 3, 5, 7, 9, 11].map(n => `<option ${n === d.bo ? 'selected' : ''}>${n}</option>`).join('')}</select></td>
      <td><select data-c="${key}.start" aria-label="${label} Startpunkte">${[301, 501, 701].map(n => `<option ${n === d.start ? 'selected' : ''}>${n}</option>`).join('')}</select></td>
      <td><select data-c="${key}.out" aria-label="${label} Out">${Object.entries(OUT_LABEL).map(([k, l]) => `<option value="${k}" ${k === d.out ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><input type="checkbox" data-c="${key}.din" aria-label="${label} Double In"></td></tr>`;
    body.innerHTML = `<form id="nf" class="form wide">
      ${data ? '<p class="note">Ein neues Turnier ersetzt in der Live-Ansicht das aktuelle. Das alte bleibt in der Datenbank erhalten.</p>' : ''}
      <div class="flabel">Turniermodus</div>
      <div class="seg modesel" role="radiogroup" aria-label="Turniermodus">
        <button type="button" class="on" data-mode="ko" role="radio" aria-checked="true">KO-Baum</button>
        <button type="button" data-mode="swiss" role="radio" aria-checked="false">Schweizer System</button></div>
      <div id="swopt" class="grid2" hidden>
        <div><label for="swr">Runden</label><select id="swr">${Array.from({ length: 12 }, (_, i) => `<option>${i + 1}</option>`).join('')}</select></div>
        <div><label for="swe">Ende</label><select id="swe"><option value="table">Tabellen-Erster gewinnt</option>
          <option value="top4">KO-Finale Top 4</option><option value="top8" selected>KO-Finale Top 8</option></select></div>
        <div><label for="swl">Nachzügler starten mit</label><select id="swl"><option value="zero">0 Punkten</option>
          <option value="last">Punkten des Letzten</option></select></div>
      </div>
      <div class="grid2">
        <div><label for="tn">Turniername</label><input id="tn" required maxlength="80" value="Neujahrsdart-Turnier Vynen 26"></div>
        <div><label for="td">Datum</label><input id="td" type="date" value="2027-01-23"></div>
        <div><label for="tb">Boards</label><select id="tb">${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option ${n === 4 ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div><label for="ts">Setzliste</label><select id="ts"><option value="list">Reihenfolge wie eingegeben</option><option value="rand">Zufällig auslosen</option></select></div>
      </div>
      <label for="tp">Spieler, einer pro Zeile</label><textarea id="tp" rows="10" placeholder="Max&#10;Anna&#10;Tim"></textarea>
      <label class="chk" id="t3l"><input type="checkbox" id="t3" checked> Spiel um Platz 3</label>
      <div id="rc"></div>
      <button class="btn pri" type="submit">Turnier erstellen</button></form>`;
    const f = body.querySelector('#nf');
    const rc = body.querySelector('#rc');
    const names = () => [...new Set(f.tp.value.split('\n').map(s => s.trim()).filter(Boolean))];
    let lastKey = '', mode = 'ko', roundsTouched = false;
    const swopt = body.querySelector('#swopt');
    body.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
      mode = b.dataset.mode;
      body.querySelectorAll('[data-mode]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
      swopt.hidden = mode !== 'swiss';
      drawCfg();
    });
    f.swr.onchange = () => { roundsTouched = true; };
    f.swe.onchange = () => drawCfg();
    const drawCfg = () => {
      const n = names().length;
      if (mode === 'swiss') return drawSwissCfg(n);
      body.querySelector('#t3l').hidden = false;
      if (n < 2) { lastKey = ''; rc.innerHTML = '<p class="muted small">Sobald mindestens zwei Spieler eingetragen sind, erscheinen hier die Einstellungen pro Runde.</p>'; return; }
      let sz = 2; while (sz < n) sz *= 2; const R = Math.log2(sz);
      const info = `${n} Spieler · ${R} Runden${sz > n ? ` · ${sz - n} Freilos${sz - n > 1 ? 'e' : ''} in Runde 1` : ''}`;
      const key = R + '|' + f.t3.checked;
      if (key === lastKey) { rc.querySelector('.info').textContent = info; return; } // Einstellungen nicht zurücksetzen
      lastKey = key;
      let rows = '';
      for (let r = 0; r < R; r++) rows += cfgRow('r' + r, rn(R, r), { bo: r === R - 1 ? 5 : 3, start: 501, out: 'double' });
      if (f.t3.checked && R >= 2) rows += cfgRow('p3', 'Platz 3', { bo: 3, start: 501, out: 'double' });
      rc.innerHTML = `<p class="muted small info">${info}</p>
        <div class="tblwrap"><table class="cfg"><thead><tr><th>Runde</th><th>Best of</th><th>Start</th><th>Out</th><th>Double In</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    };
    const drawSwissCfg = n => {
      if (!roundsTouched && n >= 2) f.swr.value = String(Math.min(12, suggestRounds(n)));
      const fin = { table: 0, top4: 2, top8: 3 }[f.swe.value];
      body.querySelector('#t3l').hidden = fin < 2;
      const info = n < 2 ? 'Mindestens zwei Spieler eintragen.'
        : `${n} Spieler · ${f.swr.value} Runden${n % 2 ? ' · pro Runde ein Freilos' : ''}${fin ? ` · danach KO-Finale Top ${fin === 2 ? 4 : 8}` : ''}`;
      const key = 'sw|' + fin + '|' + f.t3.checked;
      if (key === lastKey) { rc.querySelector('.info').textContent = info; return; }
      lastKey = key;
      let rows = cfgRow('sw', 'Schweizer Runden', { bo: 3, start: 501, out: 'double' });
      for (let r = 0; r < fin; r++) rows += cfgRow('r' + r, 'KO · ' + rn(fin, r), { bo: r === fin - 1 ? 5 : 3, start: 501, out: 'double' });
      if (fin >= 2 && f.t3.checked) rows += cfgRow('p3', 'Platz 3', { bo: 3, start: 501, out: 'double' });
      rc.innerHTML = `<p class="muted small info">${info}</p>
        <div class="tblwrap"><table class="cfg"><thead><tr><th>Runde</th><th>Best of</th><th>Start</th><th>Out</th><th>Double In</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    };
    f.tp.oninput = drawCfg; f.t3.onchange = drawCfg; drawCfg();
    f.onsubmit = async e => {
      e.preventDefault();
      let list = names();
      if (list.length < 2) { msg = ERR.min_2_players; return draw(); }
      if (f.ts.value === 'rand') for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
      const get = (k) => {
        const o = {};
        for (const el of rc.querySelectorAll(`[data-c^="${k}."]`)) {
          const p = el.dataset.c.split('.')[1];
          o[p] = el.type === 'checkbox' ? el.checked : p === 'out' ? el.value : Number(el.value);
        }
        return o;
      };
      if (mode === 'swiss') {
        const fin = { table: 0, top4: 2, top8: 3 }[f.swe.value];
        const rounds = []; for (let r = 0; r < fin; r++) rounds.push(get('r' + r));
        try {
          await rpc('admin_create_swiss', { p_name: f.tn.value.trim(), p_date: f.td.value || null, p_boards: Number(f.tb.value),
            p_swiss: { rounds: Number(f.swr.value), end: f.swe.value, late: f.swl.value, cfg: get('sw') },
            p_rounds: rounds, p_third: fin >= 2 && f.t3.checked, p_p3: fin >= 2 && f.t3.checked ? get('p3') : null, p_players: list });
          msg = 'Schweizer Turnier erstellt. Unter „Boards“ Runde 1 auslosen.'; tab = 'boards'; await loadAll(); draw();
        } catch (err) { msg = errText(err); draw(); }
        return;
      }
      let sz = 2; while (sz < list.length) sz *= 2; const R = Math.log2(sz);
      const rounds = []; for (let r = 0; r < R; r++) rounds.push(get('r' + r));
      try {
        await rpc('admin_create_tournament', { p_name: f.tn.value.trim(), p_date: f.td.value || null, p_boards: Number(f.tb.value),
          p_third: f.t3.checked, p_rounds: rounds, p_p3: f.t3.checked && R >= 2 ? get('p3') : null, p_players: list });
        msg = 'Turnier erstellt.'; tab = 'boards'; await loadAll(); draw();
      } catch (err) { msg = errText(err); draw(); }
    };
  }
}
