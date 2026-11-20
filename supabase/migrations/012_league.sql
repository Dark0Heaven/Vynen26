-- Liga-Modus (Zusatz): Mannschaftsduell zweier Teams, 6 Einzel – 3 Doppel – 6 Einzel.
-- Spieler werden pro Spiel eingetragen. Konfiguration je Block über tournaments.rounds[block] (wie KO-Runden).
alter table public.tournaments drop constraint if exists tournaments_mode_check;
alter table public.tournaments add constraint tournaments_mode_check check (mode in ('ko','swiss','league'));
-- {"teams":["Team A","Team B"],"blocks":[{"t":"s","n":6},{"t":"d","n":3},{"t":"s","n":6}]}
alter table public.tournaments add column if not exists league jsonb;
alter table public.players add column if not exists team smallint check (team in (1, 2));
alter table public.players add column if not exists pair boolean not null default false;

alter table public.matches drop constraint if exists matches_kind_check;
alter table public.matches add constraint matches_kind_check check (kind in ('ko','p3','sw','lg'));

create or replace function public.admin_create_league(p_name text, p_date date, p_boards int, p_teams text[], p_rounds jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare tid uuid; blocks jsonb := '[{"t":"s","n":6},{"t":"d","n":3},{"t":"s","n":6}]'::jsonb; b int; k int; g int := 0;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  if coalesce(array_length(p_teams, 1), 0) <> 2 or length(trim(p_teams[1])) = 0 or length(trim(p_teams[2])) = 0 then
    raise exception 'need_2_teams';
  end if;
  insert into public.tournaments(name, event_date, boards, third_place, size, rounds, mode, league)
  values (left(trim(p_name), 80), p_date, p_boards, false, 2, coalesce(p_rounds, '[]'::jsonb), 'league',
          jsonb_build_object('teams', jsonb_build_array(left(trim(p_teams[1]), 40), left(trim(p_teams[2]), 40)), 'blocks', blocks))
  returning id into tid;
  for b in 0..jsonb_array_length(blocks) - 1 loop
    for k in 1..(blocks -> b ->> 'n')::int loop
      insert into public.matches(tournament_id, kind, round, idx) values (tid, 'lg', b, g);
      g := g + 1;
    end loop;
  end loop;
  return tid;
end $$;

-- Spieler für ein Ligaspiel eintragen (Doppel z. B. "Max & Tim"). Leere Namen = Spiel wieder offen.
create or replace function public.admin_league_set(p_match uuid, p_a text, p_b text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.matches; t public.tournaments; isd boolean; na text := trim(coalesce(p_a, '')); nb text := trim(coalesce(p_b, ''));
  pa uuid; pb uuid; s int;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  select * into m from public.matches where id = p_match for update;
  if m.kind <> 'lg' then raise exception 'not_league'; end if;
  if m.status not in ('pending', 'ready') then raise exception 'already_started'; end if;
  select * into t from public.tournaments where id = m.tournament_id;
  isd := (t.league -> 'blocks' -> m.round ->> 't') = 'd';
  if length(na) > 40 or length(nb) > 40 then raise exception 'name_too_long'; end if;
  if length(na) > 0 then
    select id into pa from public.players where tournament_id = t.id and team = 1 and lower(name) = lower(na) limit 1;
    if pa is null then
      select coalesce(max(seed), 0) + 1 into s from public.players where tournament_id = t.id;
      insert into public.players(tournament_id, seed, name, team, pair) values (t.id, s, na, 1, isd) returning id into pa;
    end if;
  end if;
  if length(nb) > 0 then
    select id into pb from public.players where tournament_id = t.id and team = 2 and lower(name) = lower(nb) limit 1;
    if pb is null then
      select coalesce(max(seed), 0) + 1 into s from public.players where tournament_id = t.id;
      insert into public.players(tournament_id, seed, name, team, pair) values (t.id, s, nb, 2, isd) returning id into pb;
    end if;
  end if;
  update public.matches set player_a = pa, player_b = pb,
    status = case when pa is not null and pb is not null then 'ready' else 'pending' end, updated_at = now()
   where id = m.id;
  -- Namen, die nirgends mehr eingetragen sind, wieder entfernen
  delete from public.players p where p.tournament_id = t.id and p.team is not null
    and not exists (select 1 from public.matches x where x.player_a = p.id or x.player_b = p.id or x.winner = p.id);
end $$;

revoke execute on function public.admin_create_league(text, date, int, text[], jsonb), public.admin_league_set(uuid, text, text) from public, anon;
grant execute on function public.admin_create_league(text, date, int, text[], jsonb), public.admin_league_set(uuid, text, text) to authenticated;
