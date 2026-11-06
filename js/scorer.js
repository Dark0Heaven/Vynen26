// Schiri-Scorer: Ausbullen, Aufnahme- oder Einzeldart-Eingabe, Rückgängig, Abschluss.
// Jede Eingabe wird sofort lokal angezeigt und über eine Warteschlange (offline-fest) an den Server geschickt.
import { sb, rpc, uuid, store, esc, loadTournament, loadVisits } from './db.js';
import { roundCfg, roundName, compute, judge, checkout, minDarts, dartValue, IMPOSSIBLE, OUT_LABEL } from './rules.js';

const ERR = {
  stale: 'Der Spielstand hatte sich geändert.',
  wrong_side: 'Falscher Spieler am Wurf.',
  need_bull: 'Erst ausbullen.',
  not_live: 'Das Spiel ist nicht mehr aktiv.',
  leg_started: 'Das Leg läuft bereits.',
  no_bull_needed: 'Ausbullen ist hier nicht nötig.',
  nothing: 'Nichts zum Rückgängigmachen.',
  bad_score: 'Ungültige Punktzahl.',
  not_finished: 'Das Spiel ist noch nicht beendet.',
};

export async function startScorer(root, pin, onExit) {
  const S = {
    pin, matchId: null, t: null, m: null, names: ['', ''], cfg: null,
    visits: [], bulls: {}, queue: [], busy: false, online: true,
    mode: store.get('vynen-mode', 'visit'), input: '', darts: [], mult: 'S',
    ask: null, toast: '', toastT: null, screen: 'score', ch: null, retry: null,
  };

  // ---------- Laden ----------
  const login = await rpc('ref_login', { p_pin: pin });
  if (!login.ok) return { error: login.error };
  S.matchId = login.match_id;
  S.queue = store.get('vynen-q-' + S.matchId, []);
  await resync(true);
  subscribe();
  render();
  flush();

  async function resync(first) {
    const { data: m, error } = await sb.from('matches').select('*').eq('id', S.matchId).single();
    if (error) throw error;
    const { t, players } = first || !S.t ? await loadTournament(m.tournament_id) : { t: S.t, players: S.players };
    S.t = t; S.players = players; S.m = m;
    const nm = id => (players.find(p => p.id === id) || {}).name || '?';
    S.names = [nm(m.player_a), nm(m.player_b)];
    S.cfg = roundCfg(t, m);
    const server = await loadVisits([S.matchId]);
    // Noch nicht übertragene Eingaben oben drauf legen
    S.visits = server;
    S.bulls = { ...(m.bulls || {}) };
    for (const op of S.queue) applyLocal(op);
    if (m.status === 'done') S.screen = 'done';
  }

  function subscribe() {
    S.ch = sb.channel('ref-' + S.matchId)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'matches', filter: 'id=eq.' + S.matchId },
        () => { if (!S.queue.length && !S.busy) resync().then(render).catch(() => {}); })
      .subscribe();
  }

  // ---------- Warteschlange ----------
  function saveQueue() { store.set('vynen-q-' + S.matchId, S.queue); }

  function applyLocal(op) {
    if (op.kind === 'bull') S.bulls[String(op.args.p_leg)] = op.args.p_side;
    if (op.kind === 'visit') {
      const a = op.args;
      S.visits.push({ client_id: a.p_client, leg_no: a.p_leg, side: a.p_side, score: a.p_score, darts: a.p_darts,
        detail: a.p_detail, bust: op.local.bust, checkout: op.local.co, pending: true });
    }
    if (op.kind === 'undo') undoLocal();
  }

  function undoLocal() {
    const st = state();
    const lv = S.visits.filter(v => v.leg_no === st.leg);
    if (!st.finished && st.leg > 1 && S.bulls[String(st.leg)] !== undefined && !lv.length) {
      delete S.bulls[String(st.leg)]; return;
    }
    const last = S.visits[S.visits.length - 1];
    if (!last) { S.bulls = {}; return; }
    S.visits.pop();
    if (last.checkout) for (const k of Object.keys(S.bulls)) if (Number(k) > last.leg_no) delete S.bulls[k];
  }

  function push(kind, args, local) {
    const op = { id: uuid(), kind, args: { p_pin: S.pin, ...args }, local };
    S.queue.push(op); saveQueue(); applyLocal(op); render(); flush();
  }

  async function flush() {
    if (S.busy) return;
    S.busy = true;
    try {
      while (S.queue.length) {
        const op = S.queue[0];
        const fn = { bull: 'ref_bull', visit: 'ref_visit', undo: 'ref_undo', confirm: 'ref_confirm' }[op.kind];
        let res;
        try {
          res = await rpc(fn, { ...op.args, p_pin: S.pin });
        } catch (e) {
          S.online = false; render();
          clearTimeout(S.retry); S.retry = setTimeout(() => flush(), 3000);
          return;
        }
        S.online = true;
        S.queue.shift(); saveQueue();
        if (res && res.ok === false) {
          if (res.error === 'bad_pin') { S.screen = 'expired'; render(); return; }
          toast((ERR[res.error] || 'Eingabe abgelehnt.') + ' Stand wurde neu geladen.');
          S.queue = []; saveQueue();
          await resync(); render();
          continue;
        }
        if (op.kind === 'confirm') { S.screen = 'done'; render(); return; }
      }
      // Alles übertragen: mit dem Server abgleichen
      await resync(); render();
    } finally { S.busy = false; }
  }

  // ---------- Berechnung ----------
  function state() { return compute(S.cfg, S.bulls, S.visits); }

  function toast(msg) {
    S.toast = msg; clearTimeout(S.toastT);
    S.toastT = setTimeout(() => { S.toast = ''; render(); }, 2600);
  }

  // ---------- Eingaben ----------
  function submitVisit(score, darts, detail) {
    const st = state();
    if (st.turn === null) return;
    if (score > 180 || IMPOSSIBLE.includes(score)) { toast('Kein gültiger Wurf: ' + score); return; }
    const rem = st.rem[st.turn];
    const j = judge(S.cfg, rem, score, detail);
    const local = { bust: j.bust, co: j.co };
    push('visit', { p_client: uuid(), p_leg: st.leg, p_side: st.turn, p_score: score,
      p_darts: j.co ? darts : 3, p_detail: detail || null }, local);
    S.input = ''; S.darts = []; S.mult = 'S';
    if (j.bust) toast('Überworfen – 0 Punkte');
  }

  function okVisit() {
    const st = state();
    const score = Number(S.input || 0);
    const rem = st.rem[st.turn];
    const j = judge(S.cfg, rem, score);
    if (j.co && !(score > 180 || IMPOSSIBLE.includes(score))) {
      const md = minDarts(rem, S.cfg.out);
      if (md < 3) { S.ask = { score, md }; render(); return; }
    }
    submitVisit(score, 3, null);
  }

  function addDart(code) {
    const st = state();
    if (st.turn === null || S.darts.length >= 3) return;
    S.darts.push(code); S.mult = 'S';
    const sum = S.darts.reduce((a, c) => a + dartValue(c), 0);
    const rem = st.rem[st.turn];
    const j = judge(S.cfg, rem, sum, S.darts);
    const left = rem - sum;
    if (j.co || j.bust || S.darts.length === 3 || (left === 0)) {
      const d = S.darts.length;
      setTimeout(() => submitVisit(sum, d, S.darts.slice()), 150);
    }
    render();
  }

  function undo() {
    if (S.mode === 'dart' && S.darts.length) { S.darts.pop(); render(); return; }
    if (S.mode === 'visit' && S.input) { S.input = ''; render(); return; }
    const last = S.queue[S.queue.length - 1];
    if (last && last.kind === 'visit' && (S.queue.length > 1 || !S.busy)) {
      // Noch nicht übertragen: einfach verwerfen
      S.queue.pop(); saveQueue();
      const i = S.visits.findIndex(v => v.client_id === last.args.p_client);
      if (i >= 0) S.visits.splice(i, 1);
      render(); return;
    }
    const st = state();
    if (!S.visits.length && S.bulls['1'] === undefined) { toast('Nichts zum Rückgängigmachen.'); return; }
    if (st.finished || S.visits.length || Object.keys(S.bulls).length) push('undo', {}, null);
  }

  // ---------- Darstellung ----------
  function render() {
    if (S.screen === 'expired') {
      root.innerHTML = `<div class="sc-msg"><h2>Zugang beendet</h2><p>Der PIN für dieses Spiel ist nicht mehr gültig. Frag die Turnierleitung nach einem neuen PIN.</p>
        <button class="btn pri" data-x="exit">Schließen</button></div>`;
      return bind();
    }
    if (S.screen === 'done') {
      root.innerHTML = `<div class="sc-msg"><h2>Ergebnis gespeichert</h2><p>${esc(S.names[0])} ${S.m.legs_a} : ${S.m.legs_b} ${esc(S.names[1])}</p>
        <p class="muted">Board ${esc(S.m.board ?? '')} ist wieder frei. Danke!</p>
        <button class="btn pri" data-x="exit">Schließen</button></div>`;
      return bind();
    }
    const st = state();
    const c = S.cfg;
    const head = `<div class="sc-head">
      <div class="sc-meta"><b>${S.m.board ? 'Board ' + S.m.board : ''}</b> · ${esc(roundName(S.t, S.m))} · Leg ${st.leg} · Best of ${c.bo} · ${c.start} ${OUT_LABEL[c.out] || ''}${c.din ? ' · Double In' : ''}</div>
      <div class="sc-sync ${S.online ? (S.queue.length ? 'busy' : 'ok') : 'off'}" role="status">${
        !S.online ? `Offline · ${S.queue.length} wartet` : S.queue.length ? 'Überträgt …' : 'Live'}</div>
    </div>`;

    if (st.finished) {
      const w = st.legs[0] > st.legs[1] ? 0 : 1;
      const row = (label, f) => `<tr><th>${label}</th><td>${f(0)}</td><td>${f(1)}</td></tr>`;
      root.innerHTML = head + `<div class="sc-review">
        <h2>Spiel beendet</h2>
        <p class="winner">${esc(S.names[w])} gewinnt ${Math.max(...st.legs)}:${Math.min(...st.legs)}</p>
        <table class="sc-stats"><thead><tr><th></th><th>${esc(S.names[0])}</th><th>${esc(S.names[1])}</th></tr></thead><tbody>
        ${row('Legs', i => st.legs[i])}
        ${row('Average', i => st.avg[i].toFixed(1).replace('.', ','))}
        ${row('Highfinish', i => st.stats[i].hf || '–')}
        ${row('180er', i => st.stats[i].t180 || '–')}
        ${row('Darts', i => st.stats[i].darts)}
        </tbody></table>
        <p class="muted">Bitte prüfen. Nach dem Bestätigen ist das Spiel abgeschlossen und der PIN gesperrt.</p>
        <div class="row2"><button class="btn" data-x="undo">↶ Rückgängig</button>
        <button class="btn pri" data-x="confirm">Ergebnis bestätigen</button></div>
      </div>${toastHtml()}`;
      return bind();
    }

    if (st.needBull) {
      const decider = st.leg > 1;
      root.innerHTML = head + `<div class="sc-bull">
        <h2>${decider ? 'Decider – erneut ausbullen' : 'Ausbullen'}</h2>
        <p class="muted">Wer hat das Ausbullen gewonnen und beginnt${decider ? ' den Decider' : ''}?</p>
        <div class="row2"><button class="btn big" data-bull="0">${esc(S.names[0])}</button>
        <button class="btn big" data-bull="1">${esc(S.names[1])}</button></div>
        ${S.visits.length || Object.keys(S.bulls).length ? '<button class="btn" data-x="undo">↶ Rückgängig</button>' : ''}
      </div>${toastHtml()}`;
      return bind();
    }

    const card = i => {
      const active = st.turn === i;
      const last = [...st.legVisits].reverse().find(v => v.side === i);
      return `<section class="pc ${active ? 'on' : ''}" aria-current="${active}">
        <div class="pc-top"><span class="pc-name">${st.starter === i ? '<i class="dot" title="Anwurf"></i>' : ''}${esc(S.names[i])}</span><span class="pc-legs">${st.legs[i]}</span></div>
        <div class="pc-rem">${st.rem[i]}</div>
        <div class="pc-sub"><span>Ø ${st.avg[i].toFixed(1).replace('.', ',')}</span><span>${st.stats[i].legDarts} Darts</span><span>${last ? (last.bust ? 'Bust' : 'Letzte ' + last.score) : '&nbsp;'}</span></div>
      </section>`;
    };

    const rem = st.rem[st.turn];
    let hint = '';
    if (S.mode === 'dart') {
      const sum = S.darts.reduce((a, c2) => a + dartValue(c2), 0);
      const r = checkout(rem - sum, c.out, 3 - S.darts.length);
      if (r && rem - sum <= 180) hint = r.join(' · ');
    } else {
      const r = rem <= 180 ? checkout(rem, c.out, 3) : null;
      if (r) hint = r.join(' · ');
    }

    const pad = S.mode === 'visit' ? visitPad() : dartPad(rem);
    root.innerHTML = head + `<div class="pcs">${card(0)}${card(1)}</div>
      <div class="sc-hint">${hint ? `Checkout: <b>${hint}</b>` : '&nbsp;'}</div>
      <div class="sc-tools">
        <div class="seg" role="group" aria-label="Eingabeart">
          <button class="${S.mode === 'visit' ? 'on' : ''}" data-mode="visit" aria-pressed="${S.mode === 'visit'}">Aufnahme</button>
          <button class="${S.mode === 'dart' ? 'on' : ''}" data-mode="dart" aria-pressed="${S.mode === 'dart'}">Einzeldart</button>
        </div>
        <button class="btn" data-x="undo">↶ Rückgängig</button>
      </div>
      ${pad}${S.ask ? askHtml() : ''}${toastHtml()}`;
    bind();
  }

  function visitPad() {
    const q = [26, 41, 45, 60, 81, 85, 100, 140, 180];
    return `<div class="sc-input" aria-live="polite">${S.input || '<span class="muted">0</span>'}</div>
      <div class="quick">${q.map(n => `<button class="btn" data-q="${n}">${n}</button>`).join('')}</div>
      <div class="pad">${[7, 8, 9, 4, 5, 6, 1, 2, 3].map(n => `<button class="btn" data-k="${n}">${n}</button>`).join('')}
        <button class="btn" data-k="del" aria-label="Löschen">⌫</button><button class="btn" data-k="0">0</button>
        <button class="btn pri" data-k="ok">OK</button></div>
      <div class="row2"><button class="btn" data-q="0">No Score</button><button class="btn" data-x="rest">Rest gecheckt</button></div>`;
  }

  function dartPad(rem) {
    const sum = S.darts.reduce((a, c) => a + dartValue(c), 0);
    const slots = [0, 1, 2].map(i => `<span class="slot ${S.darts[i] ? 'f' : ''}">${S.darts[i] ? esc(S.darts[i]) : '–'}</span>`).join('');
    const nums = [];
    for (let n = 1; n <= 20; n++) nums.push(`<button class="btn" data-d="${n}">${n}</button>`);
    return `<div class="sc-input"><div class="slots">${slots}</div><span class="sum">${sum} · Rest ${rem - sum}</span></div>
      <div class="seg mult" role="group" aria-label="Feld">
        ${[['S', 'Single'], ['D', 'Double'], ['T', 'Triple']].map(([k, l]) =>
          `<button class="${S.mult === k ? 'on' : ''}" data-mult="${k}" aria-pressed="${S.mult === k}">${l}</button>`).join('')}
      </div>
      <div class="grid20">${nums.join('')}</div>
      <div class="row4"><button class="btn" data-dd="25">25</button><button class="btn" data-dd="Bull">Bull</button>
        <button class="btn" data-dd="Miss">Miss</button><button class="btn" data-x="undo" aria-label="Letzten Dart löschen">⌫</button></div>`;
  }

  function askHtml() {
    const b = [1, 2, 3].filter(d => d >= S.ask.md).map(d => `<button class="btn big" data-ask="${d}">${d}. Dart</button>`).join('');
    return `<div class="ov"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="askT">
      <h2 id="askT">Checkout ${S.ask.score}</h2><p class="muted">Mit welchem Dart wurde gecheckt?</p>
      <div class="row3">${b}</div><button class="btn" data-ask="cancel">Abbrechen</button></div></div>`;
  }

  function toastHtml() { return S.toast ? `<div class="toast" role="alert">${esc(S.toast)}</div>` : ''; }

  function bind() {
    root.onclick = ev => {
      const b = ev.target.closest('button'); if (!b) return;
      const d = b.dataset;
      if (d.x === 'exit') { cleanup(); onExit(); return; }
      if (d.x === 'undo') return undo();
      if (d.x === 'confirm') { push('confirm', {}, null); return; }
      if (d.x === 'rest') { const st = state(); S.input = String(st.rem[st.turn]); okVisit(); return; }
      if (d.bull !== undefined) { const st = state(); push('bull', { p_leg: st.leg, p_side: Number(d.bull) }, null); return; }
      if (d.mode) { S.mode = d.mode; store.set('vynen-mode', S.mode); S.input = ''; S.darts = []; render(); return; }
      if (d.q !== undefined) { S.input = d.q; okVisit(); return; }
      if (d.k !== undefined) {
        if (d.k === 'del') S.input = S.input.slice(0, -1);
        else if (d.k === 'ok') return okVisit();
        else if (S.input.length < 3) S.input = (S.input + d.k).replace(/^0+(?=\d)/, '');
        render(); return;
      }
      if (d.mult) { S.mult = S.mult === d.mult ? 'S' : d.mult; render(); return; }
      if (d.d) { const n = d.d; addDart(S.mult === 'S' ? n : S.mult + n); return; }
      if (d.dd) { addDart(d.dd); return; }
      if (d.ask) {
        const a = S.ask; S.ask = null;
        if (d.ask === 'cancel') { render(); return; }
        submitVisit(a.score, Number(d.ask), null); return;
      }
    };
  }

  function onKey(e) {
    if (S.mode !== 'visit' || S.screen !== 'score' || S.ask) return;
    if (/^\d$/.test(e.key)) { if (S.input.length < 3) S.input = (S.input + e.key).replace(/^0+(?=\d)/, ''); render(); }
    else if (e.key === 'Backspace') { S.input = S.input.slice(0, -1); render(); }
    else if (e.key === 'Enter') okVisit();
  }
  document.addEventListener('keydown', onKey);

  function cleanup() {
    document.removeEventListener('keydown', onKey);
    clearTimeout(S.retry);
    if (S.ch) sb.removeChannel(S.ch);
    root.onclick = null;
  }
  window.addEventListener('online', () => flush());
  return { ok: true, cleanup };
}
