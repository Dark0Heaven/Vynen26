// Schweizer System: Tabelle und Auslosung (rein rechnerisch, ohne Datenbankzugriff)

// Tabelle: Punkte (2 je Sieg inkl. Freilos/kampflos + Startpunkte), dann Buchholz, Leg-Differenz, Average
export function swissStandings(players, matches, visits) {
  const sw = matches.filter(m => m.kind === 'sw');
  const S = {};
  for (const p of players) S[p.id] = { id: p.id, name: p.name, seed: p.seed, withdrawn: p.withdrawn, start: p.start_points || 0,
    pts: p.start_points || 0, buch: 0, sp: 0, s: 0, n: 0, lf: 0, la: 0, opps: new Set(), hadBye: false, pp: 0, darts: 0, avg: 0 };
  for (const m of sw) {
    const A = S[m.player_a], B = S[m.player_b];
    if (m.status === 'bye') { if (A) { A.pts += 2; A.s++; A.hadBye = true; } continue; }
    if (A && B) { A.opps.add(B.id); B.opps.add(A.id); }
    if (m.status === 'done' || m.status === 'wo') {
      const W = S[m.winner];
      if (W) { W.pts += 2; W.s++; }
      const L = m.winner === m.player_a ? B : A;
      if (L) L.n++;
      if (m.status === 'done' && A && B) {
        A.sp++; B.sp++; A.lf += m.legs_a; A.la += m.legs_b; B.lf += m.legs_b; B.la += m.legs_a;
      }
    }
  }
  const swIds = new Set(sw.map(m => m.id));
  const side = {};
  for (const m of sw) side[m.id] = [m.player_a, m.player_b];
  for (const v of visits || []) {
    if (!swIds.has(v.match_id)) continue;
    const p = S[side[v.match_id][v.side]]; if (!p) continue;
    p.pp += v.bust ? 0 : v.score; p.darts += v.darts;
  }
  const list = Object.values(S);
  for (const p of list) {
    p.buch = [...p.opps].reduce((a, id) => a + (S[id] ? S[id].pts : 0), 0);
    p.avg = p.darts ? p.pp / p.darts * 3 : 0;
  }
  list.sort((a, b) => b.pts - a.pts || b.buch - a.buch || (b.lf - b.la) - (a.lf - a.la) || b.avg - a.avg || a.seed - b.seed);
  list.forEach((p, i) => { p.rank = i + 1; });
  const rounds = sw.length ? Math.max(...sw.map(m => m.round)) + 1 : 0;
  const open = sw.some(m => !['done', 'wo', 'bye'].includes(m.status));
  return { list, rounds, open };
}

// Auslosung der nächsten Runde: Punktgleiche gegeneinander, keine Wiederholung, Freilos an den
// schwächsten Spieler ohne bisheriges Freilos. Liefert {pairs:[[a,b]], bye, rematch:boolean}
export function swissPairing(standings) {
  const active = standings.list.filter(p => !p.withdrawn);
  const opp = new Map(active.map(p => [p.id, p.opps]));
  let budget = 200000;
  const solve = (ids, allowRe) => {
    if (!ids.length) return [];
    if (--budget < 0) return null;
    const [a, ...rest] = ids;
    for (let j = 0; j < rest.length; j++) {
      const b = rest[j];
      if (!allowRe && opp.get(a).has(b)) continue;
      const sub = solve(rest.filter((_, k) => k !== j), allowRe);
      if (sub) return [[a, b], ...sub];
    }
    return null;
  };
  const order = active.map(p => p.id);
  const byeOrder = active.length % 2
    ? [...active].reverse().sort((x, y) => (x.hadBye ? 1 : 0) - (y.hadBye ? 1 : 0)).map(p => p.id)
    : [null];
  for (const allowRe of [false, true]) {
    for (const bye of byeOrder) {
      budget = 200000;
      const ids = interleave((bye ? order.filter(id => id !== bye) : order), standings);
      const pairs = solve(ids, allowRe);
      if (pairs) return { pairs, bye, rematch: allowRe };
    }
  }
  return null;
}

// Innerhalb gleicher Punktzahl: obere Hälfte gegen untere Hälfte (1 gegen n/2+1 …)
function interleave(ids, standings) {
  const pts = new Map(standings.list.map(p => [p.id, p.pts]));
  const out = [];
  let i = 0;
  while (i < ids.length) {
    let j = i; while (j < ids.length && pts.get(ids[j]) === pts.get(ids[i])) j++;
    const g = ids.slice(i, j), h = Math.ceil(g.length / 2);
    for (let k = 0; k < h; k++) { out.push(g[k]); if (g[k + h]) out.push(g[k + h]); }
    i = j;
  }
  return out;
}

// Empfohlene Rundenzahl
export const suggestRounds = n => Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
