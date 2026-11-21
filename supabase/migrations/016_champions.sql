-- Ehemalige Sieger (für alle lesbar, Pflege durch die Leitung über admin_champion_save / admin_champion_delete)
create table if not exists public.champions (
  id uuid primary key default gen_random_uuid(),
  year int not null check (year between 1990 and 2100),
  name text not null check (length(name) between 1 and 60),
  second text, third text, silver text, note text,
  created_at timestamptz not null default now()
);
-- vollständige Fassung inkl. Funktionen: siehe Supabase-Migration 016_champions
