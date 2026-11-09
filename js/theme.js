// Design-Umschalter (Vynen rot ↔ Big Fish VyMa blau). Gilt für alle Geräte, gespeichert am Turnier.
import { sb, latestTournament, store } from './db.js';

export function setTheme(th) {
  const bf = th === 'bigfish';
  document.body.classList.toggle('theme-bigfish', bf);
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = bf ? '#06101f' : '#111113';
  store.set('vynen-theme', bf ? 'bigfish' : 'vynen');
}
export const currentTheme = () => document.body.classList.contains('theme-bigfish') ? 'bigfish' : 'vynen';

export function watchTheme() {
  setTheme(store.get('vynen-theme', 'vynen'));   // sofort, ohne Flackern
  const load = () => latestTournament().then(t => { if (t) setTheme(t.theme); }).catch(() => {});
  load();
  sb.channel('theme').on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments' }, load).subscribe();
}
