// Weitere freie Spiele (außer Cricket/Tactics): Regeln + Anzeige. Alles wird aus der Wurfliste berechnet.
import { checkout } from './rules.js';

const val = d => !d.t ? 0 : d.t === 25 ? (d.m >= 2 ? 50 : 25) : d.t * d.m;
const isDbl = d => d.t && d.m === 2;
const lbl = t => t === 25 ? 'Bull' : String(t);
const opt = (k, label, choices, def) => ({ k, label, choices, def });
// Zufall mit festem Startwert (gleiche Zahlen nach Neuladen/Rückgängig)
const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const IMPOSSIBLE_CO = new Set([159, 162, 163, 165, 166, 168, 169]);
const fmt1 = v => v.toFixed(1).replace('.', ',');
const avg = p => p.darts ? fmt1((p.scored || 0) / p.darts * 3) : '–';

// Gemeinsamer Doppel-Out-Abzug (X01, Checkout-Training, 121): liefert 'bust' | 'win' | 'ok'
function subtract(p, d, out) {
  const v = val(d), n = p.rem - v;
  const dbl = isDbl(d), master = d.t && d.m >= 2;
  if (n < 0 || (out !== 's' && n === 1) || (n === 0 && out === 'd' && !dbl) || (n === 0 && out === 'm' && !master)) return 'bust';
  p.rem = n; p.scored = (p.scored || 0) + v;
  return n === 0 ? 'win' : 'ok';
}

export const DEFS = {
  // ---------------- X01 ----------------
  x01: {
    name: 'X01 (301 / 501 / 701 / 1001)', group: 'X01', min: 1,
    opts: [opt('start', 'Start', [[301, '301'], [501, '501'], [701, '701'], [1001, '1001']], 501),
      opt('in', 'In', [['s', 'Single In'], ['d', 'Double In']], 's'),
      opt('out', 'Out', [['d', 'Double Out'], ['m', 'Master Out'], ['s', 'Single Out']], 'd')],
    rules: o => `Von ${o.start} auf genau 0 runter${o.in === 'd' ? ', Start mit einem Double' : ''}${o.out === 'd' ? ', letzter Dart ein Double' : o.out === 'm' ? ', letzter Dart Double oder Triple' : ''}. Überworfen: Aufnahme zählt nicht.`,
    player: o => ({ rem: Number(o.start), open: o.in === 's', scored: 0 }),
    visitStart: (S, p) => { p.snap = { rem: p.rem, open: p.open, scored: p.scored }; },
    dart(S, p, d) {
      if (!p.open) { if (isDbl(d)) p.open = true; else return; }
      const r = subtract(p, d, S.o.out);
      if (r === 'bust') { Object.assign(p, p.snap); p.busts = (p.busts || 0) + 1; S.end = true; S.note = 'Überworfen!'; }
      if (r === 'win') S.winner = p.i;
    },
    info(S) { const p = S.P[S.cur]; if (!p.open) return 'Zuerst ein Double treffen'; const c = p.rem <= 170 && S.o.out !== 's' ? checkout(p.rem, S.o.out === 'm' ? 'master' : 'double', 3 - S.k) : null; return c ? `Checkout: ${c.join(' · ')}` : `Rest ${p.rem}`; },
    cols: ['Rest', 'Ø', 'Darts'], row: p => [`<b class="big">${p.rem}</b>`, avg(p), p.darts],
    rank: S => [...S.P].sort((a, b) => a.rem - b.rem).map(p => ({ ...p, sub: `Rest ${p.rem} · Ø ${avg(p)} · ${p.darts} Darts` })),
  },

  // ---------------- Party ----------------
  elim: {
    name: 'Elimination / Gotcha (hochzählen + kicken)', group: 'Party', min: 2,
    opts: [opt('target', 'Ziel', [[301, '301'], [501, '501']], 501),
      opt('out', 'Ausmachen', [['s', 'Genau treffen'], ['d', 'Mit Double']], 's'),
      opt('kick', 'Kicken', [['dart', 'Nach jedem Dart'], ['visit', 'Nach der Aufnahme']], 'dart')],
    rules: o => `Alle zählen von 0 hoch, wer genau ${o.target}${o.out === 'd' ? ' mit einem Double' : ''} erreicht, gewinnt. Wer ${o.kick === 'dart' ? 'nach einem Dart' : 'nach seiner Aufnahme'} auf demselben Stand landet wie ein Gegner, kickt ihn zurück auf 0. Überworfen: Aufnahme zählt nicht.`,
    player: () => ({ score: 0, kicks: 0, kicked: 0, scored: 0 }),
    visitStart: (S, p) => { p.snap = p.score; },
    dart(S, p, d) {
      const T = Number(S.o.target), n = p.score + val(d);
      if (n > T || (S.o.out === 'd' && (n === T - 1 || (n === T && !isDbl(d))))) { p.score = p.snap; S.end = true; S.note = 'Überworfen!'; return; }
      p.score = n; p.scored += val(d);
      if (n === T) { S.winner = p.i; return; }
      if (S.o.kick === 'dart') kick(S, p);
    },
    visitEnd(S, p) { if (S.o.kick === 'visit' && !S.end) kick(S, p); },
    info: S => `Ziel ${S.o.target} · noch ${S.o.target - S.P[S.cur].score}`,
    cols: ['Stand', 'Gekickt', 'Ø'], row: p => [`<b class="big">${p.score}</b>`, p.kicks || '', avg(p)],
    rank: S => [...S.P].sort((a, b) => b.score - a.score).map(p => ({ ...p, sub: `${p.score} Punkte · ${p.kicks} gekickt · ${p.kicked}× rausgeflogen` })),
  },
  killer: {
    name: 'Killer', group: 'Party', min: 2,
    opts: [opt('lives', 'Leben', [[3, '3'], [5, '5']], 3), opt('assign', 'Zahlen', [['manual', 'Selbst werfen (schwache Hand)'], ['random', 'Zufällig auslosen']], 'manual')],
    rules: o => `${o.assign === 'manual' ? 'Jeder wirft mit der schwachen Hand einen Dart, die getroffene Zahl ist seine (doppelt: nochmal werfen). Zahlen unten bei den Spielern eintragen. ' : 'Die App lost jedem eine Zahl aus. '} Erst das eigene Double treffen, dann ist man Killer und nimmt mit dem Double eines Gegners ein Leben (${o.lives} Leben). Trifft ein Killer sein eigenes Double, verliert er selbst ein Leben. Wer übrig bleibt, gewinnt.`,
    init(S, game) {
      const r = rng(game.seed || 1), nums = Array.from({ length: 20 }, (_, i) => i + 1);
      for (let i = nums.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [nums[i], nums[j]] = [nums[j], nums[i]]; }
      S.P.forEach((p, i) => { p.num = game.nums && game.nums[i] ? Number(game.nums[i]) : nums[i % 20]; p.lives = Number(S.o.lives); p.killer = false; p.out = false; });
    },
    player: () => ({}),
    dart(S, p, d) {
      if (!isDbl(d) || d.t === 25) return;
      const hit = n => { n.lives--; if (n.lives <= 0) { n.lives = 0; n.out = true; } };
      if (d.t === p.num) { if (!p.killer) p.killer = true; else hit(p); }
      else if (p.killer) for (const v of S.P) if (v.num === d.t && !v.out) hit(v);
      const alive = S.P.filter(x => !x.out);
      if (alive.length === 1) S.winner = alive[0].i;
      if (p.out) S.end = true;
    },
    highlight: S => [S.P[S.cur].num],
    info: S => { const p = S.P[S.cur]; return p.killer ? `Killer! Doubles der Gegner treffen` : `Erst eigenes Double ${p.num} treffen`; },
    cols: ['Zahl', 'Leben', 'Status'], row: p => [`<b class="big">${p.num}</b>`, p.out ? '✝' : '♥'.repeat(p.lives), p.out ? 'raus' : p.killer ? '<span class="gold">Killer</span>' : ''],
    rank: S => [...S.P].sort((a, b) => (b.i === S.winner) - (a.i === S.winner) || b.lives - a.lives).map(p => ({ ...p, sub: `Zahl ${p.num} · ${p.lives} Leben` })),
  },
  shanghai: {
    name: 'Shanghai', group: 'Party', min: 1,
    opts: [opt('rounds', 'Runden', [[7, '1–7'], [20, '1–20']], 7)],
    rules: o => `Runde 1 zählt nur die 1, Runde 2 nur die 2 usw. bis ${o.rounds}. Single, Double und Triple der Zahl in einer Aufnahme (Shanghai) gewinnt sofort. Sonst gewinnt die höchste Punktzahl.`,
    player: () => ({ score: 0 }),
    visitStart: (S, p) => { p.vh = {}; },
    dart(S, p, d) {
      const t = S.round + 1; if (d.t !== t) return;
      p.score += t * d.m; p.vh[d.m] = 1;
      if (p.vh[1] && p.vh[2] && p.vh[3]) { S.winner = p.i; S.note = 'SHANGHAI!'; }
    },
    roundEnd: S => { if (S.round >= Number(S.o.rounds)) endByScore(S, (a, b) => b.score - a.score); },
    highlight: S => [S.round + 1], info: S => `Runde ${S.round + 1} von ${S.o.rounds} · Ziel ${S.round + 1}`,
    cols: ['Punkte'], row: p => [`<b class="big">${p.score}</b>`],
    rank: S => [...S.P].sort((a, b) => (b.i === S.winner) - (a.i === S.winner) || b.score - a.score).map(p => ({ ...p, sub: `${p.score} Punkte` })),
  },
  halveit: {
    name: 'Halve It', group: 'Party', min: 1, opts: [],
    seq: [15, 16, 'D', 17, 18, 'T', 19, 20, 25],
    rules: () => 'Start mit 40 Punkten. Jede Runde hat ein Ziel (15, 16, beliebiges Double, 17, 18, beliebiges Triple, 19, 20, Bull). Treffer zählen ihren Wert. Wer in einer Aufnahme das Ziel gar nicht trifft, wird halbiert.',
    player: () => ({ score: 40, halved: 0 }),
    visitStart: (S, p) => { p.hit = false; },
    dart(S, p, d) {
      const t = DEFS.halveit.seq[S.round];
      const ok = t === 'D' ? isDbl(d) : t === 'T' ? d.t && d.m === 3 : d.t === t;
      if (ok) { p.score += val(d); p.hit = true; }
    },
    visitEnd(S, p) { if (!p.hit) { p.score = Math.ceil(p.score / 2); p.halved++; } },
    roundEnd: S => { if (S.round >= DEFS.halveit.seq.length) endByScore(S, (a, b) => b.score - a.score); },
    highlight: S => { const t = DEFS.halveit.seq[S.round]; return typeof t === 'number' ? [t] : []; },
    info: S => { const t = DEFS.halveit.seq[S.round]; return `Runde ${S.round + 1} von 9 · Ziel: ${t === 'D' ? 'beliebiges Double' : t === 'T' ? 'beliebiges Triple' : lbl(t)}`; },
    cols: ['Punkte', 'Halbiert'], row: p => [`<b class="big">${p.score}</b>`, p.halved || ''],
    rank: S => [...S.P].sort((a, b) => b.score - a.score).map(p => ({ ...p, sub: `${p.score} Punkte · ${p.halved}× halbiert` })),
  },
  countup: {
    name: 'Count Up / High Score', group: 'Party', min: 1,
    opts: [opt('rounds', 'Runden', [[5, '5'], [8, '8'], [10, '10'], [20, '20']], 8)],
    rules: o => `${o.rounds} Aufnahmen, alle Punkte zählen. Die höchste Summe gewinnt.`,
    player: () => ({ score: 0, scored: 0 }),
    dart(S, p, d) { p.score += val(d); p.scored += val(d); },
    roundEnd: S => { if (S.round >= Number(S.o.rounds)) endByScore(S, (a, b) => b.score - a.score); },
    info: S => `Runde ${S.round + 1} von ${S.o.rounds}`,
    cols: ['Punkte', 'Ø'], row: p => [`<b class="big">${p.score}</b>`, avg(p)],
    rank: S => [...S.P].sort((a, b) => b.score - a.score).map(p => ({ ...p, sub: `${p.score} Punkte · Ø ${avg(p)}` })),
  },
  atc: {
    name: 'Around the Clock', group: 'Party', min: 1,
    opts: [opt('mode', 'Zählweise', [['one', 'Jeder Treffer 1 Feld'], ['mult', 'Double 2, Triple 3 Felder']], 'one'),
      opt('bull', 'Ende', [['1', 'Mit Bull'], ['0', 'Nach der 20']], '1')],
    seq: o => [...Array.from({ length: 20 }, (_, i) => i + 1), ...(o.bull === '1' ? [25] : [])],
    rules: o => `Der Reihe nach 1 bis 20${o.bull === '1' ? ' und Bull' : ''} treffen. ${o.mode === 'mult' ? 'Double springt 2, Triple 3 Felder weiter. ' : ''}Wer zuerst durch ist, gewinnt.`,
    player: () => ({ pos: 0, hits: 0 }),
    dart(S, p, d) {
      const seq = DEFS.atc.seq(S.o);
      if (d.t !== seq[p.pos]) return;
      p.hits++; p.pos = Math.min(seq.length, p.pos + (S.o.mode === 'mult' && d.t !== 25 ? d.m : 1));
      if (p.pos >= seq.length) S.winner = p.i;
    },
    highlight: S => [DEFS.atc.seq(S.o)[S.P[S.cur].pos]],
    info: S => `Ziel: ${lbl(DEFS.atc.seq(S.o)[S.P[S.cur].pos])}`,
    cols: ['Ziel', 'Trefferquote'], row: (p, S) => { const s = DEFS.atc.seq(S.o); return [`<b class="big">${p.pos >= s.length ? '✓' : lbl(s[p.pos])}</b>`, p.darts ? Math.round(p.hits / p.darts * 100) + ' %' : '–']; },
    rank: S => { const s = DEFS.atc.seq(S.o); return [...S.P].sort((a, b) => b.pos - a.pos || a.darts - b.darts).map(p => ({ ...p, sub: `${p.pos}/${s.length} Felder · ${p.darts} Darts` })); },
  },

  // ---------------- Training ----------------
  bobs27: {
    name: "Bob's 27 (Doubles)", group: 'Training', min: 1,
    opts: [opt('minus', 'Unter 0', [['out', 'Ausgeschieden'], ['go', 'Weiterspielen']], 'out')],
    rules: () => 'Start mit 27. Runde für Runde D1 bis D20, dann Bull. Jeder Treffer gibt den Wert des Doubles. Kein Treffer in der Aufnahme: Wert des Doubles wird abgezogen.',
    tgt: r => r >= 20 ? 25 : r + 1,
    player: () => ({ score: 27, out: false, hits: 0 }),
    visitStart: (S, p) => { p.vhit = 0; },
    dart(S, p, d) { const t = DEFS.bobs27.tgt(S.round); if (d.t === t && d.m === 2) { p.score += t === 25 ? 50 : 2 * t; p.vhit++; p.hits++; } },
    visitEnd(S, p) {
      const t = DEFS.bobs27.tgt(S.round);
      if (!p.vhit) { p.score -= t === 25 ? 50 : 2 * t; if (p.score < 0 && S.o.minus === 'out') p.out = true; }
    },
    roundEnd: S => { if (S.round >= 21 || S.P.every(p => p.out)) endByScore(S, (a, b) => b.score - a.score); },
    highlight: S => [DEFS.bobs27.tgt(S.round)],
    info: S => `Runde ${S.round + 1} von 21 · Ziel: ${S.round >= 20 ? 'Bull (Double)' : 'D' + (S.round + 1)}`,
    cols: ['Punkte', 'Treffer'], row: p => [`<b class="big">${p.score}</b>${p.out ? ' <span class="muted">raus</span>' : ''}`, p.hits],
    rank: S => [...S.P].sort((a, b) => b.score - a.score).map(p => ({ ...p, sub: `${p.score} Punkte · ${p.hits} Doubles` })),
  },
  checkout: {
    name: 'Checkout-Training', group: 'Training', min: 1,
    opts: [opt('rounds', 'Versuche', [[5, '5'], [10, '10'], [20, '20']], 10), opt('range', 'Bereich', [['easy', '2–80'], ['mid', '41–120'], ['all', '2–170']], 'all')],
    rules: () => 'Jede Runde gibt es eine zufällige Restzahl, für alle gleich. Mit 3 Darts mit Double ausmachen = 1 Punkt.',
    init(S, game) {
      const r = rng(game.seed || 7), [lo, hi] = { easy: [2, 80], mid: [41, 120], all: [2, 170] }[S.o.range];
      S.targets = []; while (S.targets.length < Number(S.o.rounds)) { const v = lo + Math.floor(r() * (hi - lo + 1)); if (!IMPOSSIBLE_CO.has(v)) S.targets.push(v); }
    },
    player: () => ({ succ: 0, scored: 0 }),
    visitStart: (S, p) => { p.rem = S.targets[S.round]; },
    dart(S, p, d) { const r = subtract(p, d, 'd'); if (r === 'bust') { S.end = true; S.note = 'Überworfen'; } if (r === 'win') { p.succ++; S.end = true; S.note = 'Gecheckt!'; } },
    roundEnd: S => { if (S.round >= Number(S.o.rounds)) endByScore(S, (a, b) => b.succ - a.succ); },
    info: S => { const p = S.P[S.cur], c = checkout(p.rem, 'double', 3 - S.k); return `Versuch ${S.round + 1} von ${S.o.rounds} · Rest ${p.rem}${c ? ' · ' + c.join(' · ') : ''}`; },
    cols: ['Gecheckt', 'Rest'], row: (p, S) => [`<b class="big">${p.succ}</b>`, p.i === S.cur ? p.rem : ''],
    rank: S => [...S.P].sort((a, b) => b.succ - a.succ).map(p => ({ ...p, sub: `${p.succ} von ${S.o.rounds} gecheckt` })),
  },
  c121: {
    name: '121-Challenge', group: 'Training', min: 1,
    opts: [opt('rounds', 'Aufnahmen', [[9, '9'], [15, '15'], [30, '30']], 15), opt('fail', 'Nicht geschafft', [['stay', 'Zahl bleibt'], ['back', 'Zurück auf 121']], 'stay')],
    rules: o => `Mit höchstens 9 Darts (3 Aufnahmen) 121 mit Double ausmachen. Geschafft: nächstes Ziel 122 usw. Nicht geschafft: ${o.fail === 'back' ? 'zurück auf 121' : 'Ziel bleibt'}. Gewinner: höchstes geschafftes Ziel.`,
    player: () => ({ target: 121, best: 0, left: 0, scored: 0 }),
    visitStart: (S, p) => { if (p.left <= 0) { p.rem = p.target; p.left = 3; } p.snap = p.rem; p.won = false; },
    dart(S, p, d) {
      const r = subtract(p, d, 'd');
      if (r === 'bust') { p.rem = p.snap; S.end = true; S.note = 'Überworfen'; }
      if (r === 'win') { p.best = Math.max(p.best, p.target); p.target++; p.left = 0; p.won = true; S.end = true; S.note = 'Geschafft!'; }
    },
    visitEnd(S, p) { if (p.won) return; p.left--; if (p.left <= 0 && S.o.fail === 'back') p.target = 121; },
    roundEnd: S => { if (S.round >= Number(S.o.rounds)) endByScore(S, (a, b) => b.best - a.best || b.target - a.target); },
    info: S => { const p = S.P[S.cur], c = checkout(p.rem, 'double', 3 - S.k); return `Ziel ${p.target} · Rest ${p.rem} · noch ${p.left} Aufnahme${p.left === 1 ? '' : 'n'}${c ? ' · ' + c.join(' · ') : ''}`; },
    cols: ['Ziel', 'Bestes'], row: p => [`<b class="big">${p.target}</b>`, p.best || '–'],
    rank: S => [...S.P].sort((a, b) => b.best - a.best).map(p => ({ ...p, sub: `Bestes Ziel ${p.best || '–'}` })),
  },
  jdc: {
    name: 'JDC Challenge', group: 'Training', min: 1, opts: [],
    seq: [10, 11, 12, 13, 14, 15, ...Array.from({ length: 20 }, (_, i) => 'D' + (i + 1)), 'DB', 15, 16, 17, 18, 19, 20],
    rules: () => 'Teil 1: Shanghai 10–15 (Treffer zählen ihren Wert, Single+Double+Triple in einer Aufnahme +100). Teil 2: Doubles 1–20 und Bull, je Treffer 50. Teil 3: Shanghai 15–20.',
    player: () => ({ score: 0 }),
    visitStart: (S, p) => { p.vh = {}; },
    dart(S, p, d) {
      const t = DEFS.jdc.seq[S.round];
      if (typeof t === 'number') { if (d.t === t) { p.score += t * d.m; p.vh[d.m] = 1; if (p.vh[1] && p.vh[2] && p.vh[3] && !p.vh.bonus) { p.score += 100; p.vh.bonus = 1; S.note = 'Shanghai +100'; } } }
      else { const n = t === 'DB' ? 25 : Number(t.slice(1)); if (d.t === n && d.m === 2) p.score += 50; }
    },
    roundEnd: S => { if (S.round >= DEFS.jdc.seq.length) endByScore(S, (a, b) => b.score - a.score); },
    highlight: S => { const t = DEFS.jdc.seq[S.round]; return [typeof t === 'number' ? t : t === 'DB' ? 25 : Number(t.slice(1))]; },
    info: S => { const t = DEFS.jdc.seq[S.round]; return `Runde ${S.round + 1} von ${DEFS.jdc.seq.length} · Ziel: ${typeof t === 'number' ? t + ' (Shanghai)' : t === 'DB' ? 'Bull (Double)' : t}`; },
    cols: ['Punkte'], row: p => [`<b class="big">${p.score}</b>`],
    rank: S => [...S.P].sort((a, b) => b.score - a.score).map(p => ({ ...p, sub: `${p.score} Punkte` })),
  },
};

function kick(S, p) {
  for (const o of S.P) if (o !== p && o.score === p.score && p.score > 0) { o.score = 0; o.kicked++; p.kicks++; S.note = `${o.name} gekickt!`; }
}
function endByScore(S, cmp) { S.over = true; const best = [...S.P].sort(cmp)[0]; S.winner = best.i; }

export const optionsOf = (type, saved = {}) => Object.fromEntries((DEFS[type].opts || []).map(o => [o.k, saved[o.k] ?? o.def]));

// Spielstand aus der Wurfliste: Spieler, Runde, wer dran ist, laufende Aufnahme, Sieger
export function run(game) {
  const def = DEFS[game.type], o = { ...optionsOf(game.type), ...(game.opts || {}) };
  const S = { o, round: 0, cur: 0, k: 0, winner: null, over: false, note: '', P: game.players.map((name, i) => ({ name, i, darts: 0, ...def.player(o) })) };
  if (def.init) def.init(S, game);
  if (def.visitStart) def.visitStart(S, S.P[0]);
  let vStart = 0;
  const endVisit = () => {
    const p = S.P[S.cur];
    if (def.visitEnd) def.visitEnd(S, p);
    S.end = false;
    if (S.winner !== null) { S.over = true; return; }
    S.k = 0;
    const alive = S.P.filter(x => !x.out);
    if (!alive.length) { S.round = 1e9; if (def.roundEnd) def.roundEnd(S); S.over = true; return; }
    let n = S.cur; do n = (n + 1) % S.P.length; while (S.P[n].out && n !== S.cur);
    if (n <= S.cur) { S.round++; if (def.roundEnd) def.roundEnd(S); if (S.over || S.winner !== null) { S.over = true; return; } }
    S.cur = n;
    if (def.visitStart) def.visitStart(S, S.P[n]);
  };
  game.darts.forEach((d, idx) => {
    if (S.over) return;
    const p = S.P[S.cur];
    S.note = ''; S.end = false; p.darts++;
    def.dart(S, p, d);
    S.k++;
    if (S.winner !== null) { S.over = true; return; }
    if (S.k === 3 || S.end) { endVisit(); vStart = idx + 1; }
  });
  S.visit = S.over ? [] : game.darts.slice(vStart);
  S.inVisit = S.over ? 0 : S.k;
  return S;
}
