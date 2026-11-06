// Gemeinsame Live-Daten für alle öffentlichen Ansichten (Live, Baum, Tabelle, Halle)
import { sb, latestTournament, loadTournament, loadVisits } from './db.js';
import { roundCfg, compute } from './rules.js';

export function watchTournament(onData, onError) {
  let alive = true, timer = null, ch = null, poll = null, tid = null;
  async function load() {
    const t = await latestTournament();
    if (!alive) return;
    if (!t) { onData(null); return; }
    if (t.id !== tid) { tid = t.id; resubscribe(); }
    const d = await loadTournament(t.id);
    d.visits = await loadVisits(d.matches.map(m => m.id));
    if (alive) onData(enrich(d));
  }
  function soon() { clearTimeout(timer); timer = setTimeout(() => load().catch(onError), 300); }
  function resubscribe() {
    if (ch) sb.removeChannel(ch);
    ch = sb.channel('t-' + tid)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: 'tournament_id=eq.' + tid }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: 'tournament_id=eq.' + tid }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'visits' }, soon)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tournaments' }, soon)
      .subscribe();
  }
  load().catch(onError);
  poll = setInterval(soon, 30000);
  return () => { alive = false; clearTimeout(timer); clearInterval(poll); if (ch) sb.removeChannel(ch); };
}

// Ergänzt Spielstände und Statistiken
function enrich(d) {
  const { t, players, matches, visits } = d;
  const byMatch = {};
  for (const v of visits) (byMatch[v.match_id] = byMatch[v.match_id] || []).push(v);
  const R = Math.round(Math.log2(t.size));
  d.R = R;
  d.pname = id => (players.find(p => p.id === id) || {}).name || '';
  for (const m of matches) {
    m.cfg = roundCfg(t, m);
    m.vis = byMatch[m.id] || [];
    if (['live', 'review'].includes(m.status)) m.st = compute(m.cfg, m.bulls, m.vis);
  }
  d.stats = playerStats(d);
  return d;
}

function playerStats(d) {
  const { players, matches, R } = d;
  const S = {};
  for (const p of players) S[p.id] = { id: p.id, name: p.name, seed: p.seed, withdrawn: p.withdrawn, sp: 0, s: 0, n: 0, lf: 0, la: 0,
    pts: 0, darts: 0, t180: 0, t140: 0, hf: 0, best: 0, bestAvg: 0, out: null, place: null, reach: 0 };
  for (const m of matches) {
    const ids = [m.player_a, m.player_b];
    if (m.kind === 'ko') ids.forEach(id => { if (S[id]) S[id].reach = Math.max(S[id].reach, m.round); });
    // Aufnahmen
    const per = [{ pts: 0, darts: 0 }, { pts: 0, darts: 0 }];
    const legDarts = {};
    for (const v of m.vis) {
      const p = S[ids[v.side]]; if (!p) continue;
      const pts = v.bust ? 0 : v.score;
      p.pts += pts; p.darts += v.darts; per[v.side].pts += pts; per[v.side].darts += v.darts;
      if (v.score === 180 && !v.bust) p.t180++;
      else if (v.score >= 140 && !v.bust) p.t140++;
      const k = v.leg_no + '-' + v.side; legDarts[k] = (legDarts[k] || 0) + v.darts;
      if (v.checkout) {
        if (v.score > p.hf) p.hf = v.score;
        const ld = legDarts[k];
        if (!p.best || ld < p.best) p.best = ld;
      }
    }
    [0, 1].forEach(i => { const p = S[ids[i]]; if (p && per[i].darts >= 9) p.bestAvg = Math.max(p.bestAvg, per[i].pts / per[i].darts * 3); });
    if (m.status === 'done') {
      const A = S[m.player_a], B = S[m.player_b];
      if (A && B) {
        A.sp++; B.sp++; A.lf += m.legs_a; A.la += m.legs_b; B.lf += m.legs_b; B.la += m.legs_a;
        const W = S[m.winner], L = m.winner === m.player_a ? B : A;
        if (W) W.s++; if (L) { L.n++; if (m.kind === 'ko') L.out = m.round; }
      }
    }
    if (m.status === 'wo' && m.kind === 'ko') { const L = S[m.winner === m.player_a ? m.player_b : m.player_a]; if (L) L.out = m.round; }
  }
  // Platzierungen
  const fin = matches.find(m => m.kind === 'ko' && m.round === R - 1);
  const p3 = matches.find(m => m.kind === 'p3');
  const done = m => m && ['done', 'wo', 'bye'].includes(m.status) && m.winner;
  if (done(fin)) { S[fin.winner].place = 1; const l = fin.winner === fin.player_a ? fin.player_b : fin.player_a; if (S[l]) S[l].place = 2; }
  if (done(p3)) { S[p3.winner].place = 3; const l = p3.winner === p3.player_a ? p3.player_b : p3.player_a; if (S[l]) S[l].place = 4; }
  const list = Object.values(S);
  for (const p of list) p.avg = p.darts ? p.pts / p.darts * 3 : 0;
  list.sort((a, b) => (a.place || 99) - (b.place || 99)
    || ((b.out === null ? R : b.out) - (a.out === null ? R : a.out))
    || b.s - a.s || (b.lf - b.la) - (a.lf - a.la) || b.avg - a.avg || a.seed - b.seed);
  return list;
}
