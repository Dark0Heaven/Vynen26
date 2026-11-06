-- Vynen Dart: Grundschema
create extension if not exists pgcrypto;

create table public.admins (
  user_id uuid primary key references auth.users on delete cascade
);

create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  event_date date,
  boards int not null default 4 check (boards between 1 and 8),
  third_place boolean not null default true,
  size int not null check (size between 2 and 128),
  -- pro Runde: {"bo":3,"start":501,"out":"double","din":false}
  rounds jsonb not null default '[]'::jsonb,
  p3_cfg jsonb,
  status text not null default 'running' check (status in ('running','finished')),
  created_at timestamptz not null default now()
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments on delete cascade,
  seed int not null,
  name text not null check (length(name) between 1 and 40),
  withdrawn boolean not null default false,
  unique (tournament_id, seed)
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments on delete cascade,
  kind text not null default 'ko' check (kind in ('ko','p3')),
  round int not null,
  idx int not null,
  player_a uuid references public.players on delete set null,
  player_b uuid references public.players on delete set null,
  bye_a boolean not null default false,
  bye_b boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending','ready','live','review','done','bye','wo')),
  board int,
  bulls jsonb not null default '{}'::jsonb,   -- {"1":0,"5":1}: Leg -> Seite, die beginnt
  legs_a int not null default 0,
  legs_b int not null default 0,
  winner uuid references public.players on delete set null,
  updated_at timestamptz not null default now(),
  unique (tournament_id, kind, round, idx)
);
create index on public.matches (tournament_id);

-- PINs sind für Zuschauer unsichtbar (kein Select-Policy für anon)
create table public.match_pins (
  match_id uuid primary key references public.matches on delete cascade,
  pin text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index match_pins_active_pin on public.match_pins (pin) where active;

create table public.visits (
  id bigint generated always as identity primary key,
  match_id uuid not null references public.matches on delete cascade,
  client_id uuid not null unique,
  leg_no int not null,
  side smallint not null check (side in (0,1)),
  score int not null check (score between 0 and 180),
  darts int not null default 3 check (darts between 1 and 3),
  detail jsonb,
  bust boolean not null default false,
  checkout boolean not null default false,
  remaining int not null,
  created_at timestamptz not null default now()
);
create index on public.visits (match_id, id);

-- Schutz gegen PIN-Raten
create table public.pin_attempts (
  id bigint generated always as identity primary key,
  ok boolean not null,
  at timestamptz not null default now()
);

-- Zugriffsregeln
alter table public.admins enable row level security;
alter table public.tournaments enable row level security;
alter table public.players enable row level security;
alter table public.matches enable row level security;
alter table public.match_pins enable row level security;
alter table public.visits enable row level security;
alter table public.pin_attempts enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

create policy "admin sieht sich selbst" on public.admins for select using (user_id = auth.uid());

create policy "alle lesen" on public.tournaments for select using (true);
create policy "alle lesen" on public.players for select using (true);
create policy "alle lesen" on public.matches for select using (true);
create policy "alle lesen" on public.visits for select using (true);

create policy "admin schreibt" on public.tournaments for all using (public.is_admin()) with check (public.is_admin());
create policy "admin schreibt" on public.players for all using (public.is_admin()) with check (public.is_admin());
create policy "admin schreibt" on public.matches for all using (public.is_admin()) with check (public.is_admin());
create policy "admin schreibt" on public.visits for all using (public.is_admin()) with check (public.is_admin());
create policy "admin liest pins" on public.match_pins for select using (public.is_admin());

-- Live-Updates
alter publication supabase_realtime add table public.matches, public.visits, public.players, public.tournaments;
