// Dart-Regeln, identisch zur Server-Logik (supabase/migrations/002_functions.sql).
// Wird im Scorer für die sofortige Anzeige genutzt, der Server prüft jede Eingabe noch einmal.

export const IMPOSSIBLE = [163, 166, 169, 172, 173, 175, 176, 178, 179];
const BOGEY_DOUBLE = [169, 168, 166, 165, 163, 162, 159];

export function roundCfg(t, m) {
  const rounds = Array.isArray(t?.rounds) ? t.rounds : [];
  let c = m.kind === 'p3' ? (t.p3_cfg || rounds[rounds.length - 1]) : rounds[m.round];
  c = c || {};
  return { bo: c.bo || 3, start: c.start || 501, out: c.out || 'double', din: !!c.din };
}

export function roundName(t, m) {
  if (m.kind === 'p3') return 'Spiel um Platz 3';
  const R = Math.round(Math.log2(t.size));
  const k = R - 1 - m.round;
  return ['Finale', 'Halbfinale', 'Viertelfinale', 'Achtelfinale'][k] || `Runde ${m.round + 1}`;
}

export const OUT_LABEL = { double: 'Double Out', master: 'Master Out', straight: 'Straight Out' };

// Spielstand aus Aufnahmen berechnen (spiegelt ref_visit/_starter)
export function compute(cfg, bulls, visits) {
  const need = Math.ceil(cfg.bo / 2);
  const legs = [0, 0];
  const byLeg = {};
  for (const v of visits) (byLeg[v.leg_no] = byLeg[v.leg_no] || []).push(v);
  for (const v of visits) if (v.checkout) legs[v.side]++;
  const finished = legs[0] >= need || legs[1] >= need;
  const leg = legs[0] + legs[1] + (finished ? 0 : 1);
  const lv = byLeg[leg] || [];
  const rem = [cfg.start, cfg.start];
  const stats = [0, 1].map(() => ({ pts: 0, darts: 0, hf: 0, t180: 0, legPts: 0, legDarts: 0 }));
  for (const v of visits) {
    const s = stats[v.side];
    const p = v.bust ? 0 : v.score;
    s.pts += p; s.darts += v.darts;
    if (v.score === 180 && !v.bust) s.t180++;
    if (v.checkout && v.score > s.hf) s.hf = v.score;
  }
  for (const v of lv) {
    if (!v.bust) rem[v.side] -= v.score;
    stats[v.side].legPts += v.bust ? 0 : v.score; stats[v.side].legDarts += v.darts;
  }
  let starter = null;
  if (bulls && bulls[String(leg)] !== undefined) starter = Number(bulls[String(leg)]);
  else if (bulls && bulls['1'] !== undefined) {
    const decider = need > 1 && legs[0] === need - 1 && legs[1] === need - 1;
    starter = decider ? null : (Number(bulls['1']) + leg - 1) % 2;
  }
  const turn = starter === null || finished ? null : (starter + lv.length) % 2;
  const avg = stats.map(s => (s.darts ? (s.pts / s.darts) * 3 : 0));
  return { need, legs, leg, rem, starter, turn, finished, needBull: !finished && starter === null,
           legVisits: lv, stats, avg };
}

// Ergebnis einer Aufnahme vorhersagen
export function judge(cfg, rem, score, detail) {
  const nw = rem - score;
  if (nw < 0) return { bust: true, co: false };
  if (nw === 0) {
    let bust = false;
    if (cfg.out === 'double' && (rem > 170 || BOGEY_DOUBLE.includes(rem))) bust = true;
    if (cfg.out === 'master' && rem > 180) bust = true;
    if (!bust && detail && detail.length) {
      const last = String(detail[detail.length - 1]).toUpperCase();
      if (cfg.out === 'double' && !(last.startsWith('D') || last === 'BULL' || last === '50')) bust = true;
      if (cfg.out === 'master' && !(last.startsWith('D') || last.startsWith('T') || last === 'BULL' || last === '50')) bust = true;
    }
    return { bust, co: !bust };
  }
  if (nw === 1 && cfg.out !== 'straight') return { bust: true, co: false };
  return { bust: false, co: false };
}

// ---------- Checkout-Wege ----------
const D_PREF = [20, 16, 18, 12, 10, 8, 14, 6, 4, 2, 1, 19, 17, 15, 13, 11, 9, 7, 5, 3];
function finishers(out) {
  const f = D_PREF.map(n => ({ l: 'D' + n, v: 2 * n })).concat([{ l: 'Bull', v: 50 }]);
  if (out === 'master') for (let n = 20; n >= 1; n--) f.push({ l: 'T' + n, v: 3 * n });
  if (out === 'straight') {
    for (let n = 20; n >= 1; n--) f.push({ l: 'T' + n, v: 3 * n });
    for (let n = 20; n >= 1; n--) f.push({ l: String(n), v: n });
    f.push({ l: '25', v: 25 });
  }
  return f;
}
function setup(v) {
  if (!(v > 0)) return null;
  if (v >= 1 && v <= 20) return String(v);
  if (v === 25) return '25';
  if (v === 50) return 'Bull';
  if (v % 3 === 0 && v / 3 <= 20) return 'T' + v / 3;
  if (v % 2 === 0 && v / 2 <= 20) return 'D' + v / 2;
  return null;
}
const SETUP_ORDER = [];
for (let n = 20; n >= 1; n--) SETUP_ORDER.push({ l: 'T' + n, v: 3 * n });
SETUP_ORDER.push({ l: 'Bull', v: 50 }, { l: '25', v: 25 });
for (let n = 20; n >= 1; n--) SETUP_ORDER.push({ l: String(n), v: n });

const cache = {};
export function checkout(rem, out = 'double', darts = 3) {
  const key = out + rem + ':' + darts;
  if (key in cache) return cache[key];
  let res = null;
  if (rem >= 2 || out === 'straight') {
    const fin = finishers(out);
    for (const f of fin) if (f.v === rem) { res = [f.l]; break; }
    if (!res && darts >= 2) for (const f of fin) { const s = setup(rem - f.v); if (s) { res = [s, f.l]; break; } }
    if (!res && darts >= 3) outer: for (const a of SETUP_ORDER) for (const f of fin) {
      const s = setup(rem - f.v - a.v); if (s) { res = [a.l, s, f.l]; break outer; }
    }
  }
  return (cache[key] = res);
}
export function minDarts(rem, out) {
  for (let d = 1; d <= 3; d++) if (checkout(rem, out, d)) return d;
  return 3;
}

// Einzeldart in Punkte
export function dartValue(code) {
  if (code === 'Miss') return 0;
  if (code === 'Bull') return 50;
  if (code === '25') return 25;
  const m = /^([DT]?)(\d+)$/.exec(code);
  if (!m) return 0;
  return Number(m[2]) * (m[1] === 'T' ? 3 : m[1] === 'D' ? 2 : 1);
}
