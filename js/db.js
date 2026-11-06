import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, storageKey: 'vynen-auth' },
  realtime: { params: { eventsPerSecond: 10 } },
});

export async function latestTournament() {
  const { data, error } = await sb.from('tournaments').select('*').order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  return data[0] || null;
}

export async function loadTournament(tid) {
  const [t, p, m] = await Promise.all([
    sb.from('tournaments').select('*').eq('id', tid).single(),
    sb.from('players').select('*').eq('tournament_id', tid).order('seed'),
    sb.from('matches').select('*').eq('tournament_id', tid).order('round').order('idx'),
  ]);
  for (const r of [t, p, m]) if (r.error) throw r.error;
  return { t: t.data, players: p.data, matches: m.data };
}

export async function loadVisits(matchIds) {
  if (!matchIds.length) return [];
  const { data, error } = await sb.from('visits').select('*').in('match_id', matchIds).order('id');
  if (error) throw error;
  return data;
}

export async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* voll oder gesperrt */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* egal */ } },
};

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
