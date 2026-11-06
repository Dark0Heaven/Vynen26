-- Schweizer System (Zusatz). KO-Turniere bleiben unverändert.

alter table public.tournaments add column if not exists mode text not null default 'ko' check (mode in ('ko','swiss'));
-- {"rounds":5,"end":"table|top4|top8","late":"zero|last","cfg":{"bo":3,"start":501,"out":"double","din":false}}
alter table public.tournaments add column if not exists swiss jsonb;
alter table public.players add column if not exists start_points int not null default 0;

alter table public.matches drop constraint if exists matches_kind_check;
alter table public.matches add constraint matches_kind_check check (kind in ('ko','p3','sw'));

-- Runden-Konfiguration: Schweizer Runden nutzen swiss.cfg, alles andere wie bisher
create or replace function public._cfg(p_match uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    case when m.kind = 'sw' then t.swiss -> 'cfg'
         when m.kind = 'p3' then coalesce(t.p3_cfg, t.rounds -> (jsonb_array_length(t.rounds) - 1))
         else t.rounds -> m.round end,
    '{}'::jsonb)
  from public.matches m join public.tournaments t on t.id = m.tournament_id
  where m.id = p_match;
$$;

-- Schweizer Spiele rücken nicht im Baum weiter
create or replace function public._place(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.matches; t public.tournaments; r int; nxt uuid; loser uuid;
begin
  select * into m from public.matches where id = p_match;
  if m.kind <> 'ko' then return; end if;
  select * into t from public.tournaments where id = m.tournament_id;
  r := public._rounds(t.size);
  if m.round < r - 1 then
    if m.idx % 2 = 0 then
      update public.matches set player_a = m.winner, bye_a = (m.winner is null), updated_at = now()
       where tournament_id = m.tournament_id and kind = 'ko' and round = m.round + 1 and idx = m.idx / 2
       returning id into nxt;
    else
      update public.matches set player_b = m.winner, bye_b = (m.winner is null), updated_at = now()
       where tournament_id = m.tournament_id and kind = 'ko' and round = m.round + 1 and idx = m.idx / 2
       returning id into nxt;
    end if;
    perform public._refresh(nxt);
  end if;
  if m.round = r - 2 and t.third_place then
    loser := case when m.winner = m.player_a then m.player_b
                  when m.winner = m.player_b then m.player_a end;
    if m.idx % 2 = 0 then
      update public.matches set player_a = loser, bye_a = (loser is null), updated_at = now()
       where tournament_id = m.tournament_id and kind = 'p3' returning id into nxt;
    else
      update public.matches set player_b = loser, bye_b = (loser is null), updated_at = now()
       where tournament_id = m.tournament_id and kind = 'p3' returning id into nxt;
    end if;
    if nxt is not null then perform public._refresh(nxt); end if;
  end if;
end $$;

create or replace function public._unplace(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.matches; t public.tournaments; r int; nx public.matches;
begin
  select * into m from public.matches where id = p_match;
  if m.kind <> 'ko' then return; end if;
  select * into t from public.tournaments where id = m.tournament_id;
  r := public._rounds(t.size);
  if m.round < r - 1 then
    select * into nx from public.matches where tournament_id = m.tournament_id and kind = 'ko' and round = m.round + 1 and idx = m.idx / 2;
    if nx.status in ('live','review','done') then raise exception 'next_started'; end if;
    if nx.status in ('bye','wo') then perform public._unplace(nx.id); end if;
    if m.idx % 2 = 0 then
      update public.matches set player_a = null, bye_a = false, status = 'pending', winner = null, updated_at = now() where id = nx.id;
    else
      update public.matches set player_b = null, bye_b = false, status = 'pending', winner = null, updated_at = now() where id = nx.id;
    end if;
  end if;
  if m.round = r - 2 and t.third_place then
    select * into nx from public.matches where tournament_id = m.tournament_id and kind = 'p3';
    if nx.id is not null then
      if nx.status in ('live','review','done') then raise exception 'next_started'; end if;
      if m.idx % 2 = 0 then
        update public.matches set player_a = null, bye_a = false, status = 'pending', winner = null, updated_at = now() where id = nx.id;
      else
        update public.matches set player_b = null, bye_b = false, status = 'pending', winner = null, updated_at = now() where id = nx.id;
      end if;
    end if;
  end if;
end $$;

-- Punkte im Schweizer System: Startpunkte + 2 je Sieg (auch Freilos und kampflos)
create or replace function public._swiss_points(p_tournament uuid)
returns table(player_id uuid, pts int)
language sql stable security definer set search_path = public as $$
  select p.id, p.start_points + 2 * (select count(*)::int from public.matches m
      where m.tournament_id = p_tournament and m.kind = 'sw' and m.winner = p.id and m.status in ('done','wo','bye'))
  from public.players p where p.tournament_id = p_tournament;
$$;

create or replace function public.admin_create_swiss(p_name text, p_date date, p_boards int, p_swiss jsonb,
  p_rounds jsonb, p_third boolean, p_p3 jsonb, p_players text[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare n int; tid uuid; i int; fin int;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  n := coalesce(array_length(p_players, 1), 0);
  if n < 2 then raise exception 'min_2_players'; end if;
  if n > 128 then raise exception 'max_128_players'; end if;
  if coalesce((p_swiss ->> 'rounds')::int, 0) not between 1 and 20 then raise exception 'bad_rounds'; end if;
  fin := case p_swiss ->> 'end' when 'top4' then 4 when 'top8' then 8 else 2 end;
  insert into public.tournaments(name, event_date, boards, third_place, size, rounds, p3_cfg, mode, swiss)
  values (left(trim(p_name), 80), p_date, p_boards, coalesce(p_third, false) and fin >= 4, fin,
          coalesce(p_rounds, '[]'::jsonb), p_p3, 'swiss', p_swiss)
  returning id into tid;
  for i in 1..n loop
    insert into public.players(tournament_id, seed, name) values (tid, i, left(trim(p_players[i]), 40));
  end loop;
  return tid;
end $$;

-- Nächste Runde anlegen. Paarungen berechnet die Leitung (Punktgleiche gegeneinander), hier wird alles geprüft.
-- p_pairs: [["<uuid>","<uuid>"], ...], p_bye: Spieler mit Freilos oder null
create or replace function public.admin_swiss_pair(p_tournament uuid, p_round int, p_pairs jsonb, p_bye uuid,
  p_allow_rematch boolean default false) returns int
language plpgsql security definer set search_path = public as $$
declare
  t public.tournaments; cur int; active uuid[]; seen uuid[] := '{}'; pr jsonb; a uuid; b uuid; i int := 0;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  select * into t from public.tournaments where id = p_tournament for update;
  if t.mode <> 'swiss' then raise exception 'not_swiss'; end if;
  select coalesce(max(round) + 1, 0) into cur from public.matches where tournament_id = t.id and kind = 'sw';
  if p_round <> cur + 1 then raise exception 'stale_round'; end if;
  if p_round > (t.swiss ->> 'rounds')::int then raise exception 'all_rounds_done'; end if;
  if exists (select 1 from public.matches where tournament_id = t.id and kind = 'sw' and status not in ('done','wo','bye')) then
    raise exception 'round_open';
  end if;
  select array_agg(id) into active from public.players where tournament_id = t.id and not withdrawn;
  for pr in select * from jsonb_array_elements(p_pairs) loop
    a := (pr ->> 0)::uuid; b := (pr ->> 1)::uuid;
    if a = b or a = any(seen) or b = any(seen) then raise exception 'bad_pairs'; end if;
    if not (a = any(active) and b = any(active)) then raise exception 'bad_pairs'; end if;
    if not p_allow_rematch and exists (select 1 from public.matches where tournament_id = t.id and kind = 'sw'
        and ((player_a = a and player_b = b) or (player_a = b and player_b = a))) then
      raise exception 'rematch';
    end if;
    seen := seen || a || b;
  end loop;
  if p_bye is not null then
    if p_bye = any(seen) or not (p_bye = any(active)) then raise exception 'bad_pairs'; end if;
    seen := seen || p_bye;
  end if;
  if coalesce(array_length(seen, 1), 0) <> coalesce(array_length(active, 1), 0) then raise exception 'bad_pairs'; end if;
  for pr in select * from jsonb_array_elements(p_pairs) loop
    insert into public.matches(tournament_id, kind, round, idx, player_a, player_b, status)
    values (t.id, 'sw', p_round - 1, i, (pr ->> 0)::uuid, (pr ->> 1)::uuid, 'ready');
    i := i + 1;
  end loop;
  if p_bye is not null then
    insert into public.matches(tournament_id, kind, round, idx, player_a, bye_b, status, winner)
    values (t.id, 'sw', p_round - 1, i, p_bye, true, 'bye', p_bye);
  end if;
  return p_round;
end $$;

-- Nachmelden im Schweizer System: Einstieg ab der nächsten Auslosung
create or replace function public.admin_swiss_add(p_tournament uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare t public.tournaments; s int; sp int := 0; pid uuid;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  select * into t from public.tournaments where id = p_tournament;
  if t.mode <> 'swiss' then raise exception 'not_swiss'; end if;
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'empty_name'; end if;
  if exists (select 1 from public.matches where tournament_id = t.id and kind = 'ko') then raise exception 'final_started'; end if;
  if t.swiss ->> 'late' = 'last' then
    select coalesce(min(x.pts), 0) into sp from public._swiss_points(t.id) x
      join public.players p on p.id = x.player_id where not p.withdrawn;
  end if;
  select coalesce(max(seed), 0) + 1 into s from public.players where tournament_id = t.id;
  insert into public.players(tournament_id, seed, name, start_points) values (t.id, s, left(trim(p_name), 40), sp)
  returning id into pid;
  return pid;
end $$;

-- KO-Finale aus der Schweizer Tabelle (Spieler in Tabellenreihenfolge übergeben)
create or replace function public.admin_swiss_final(p_tournament uuid, p_players uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare
  t public.tournaments; n int; sz int; r int; so int[] := array[1]; tmp int[]; s int; m2 int; i int; rr int; sa int; sb int; mid uuid;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  select * into t from public.tournaments where id = p_tournament for update;
  if t.mode <> 'swiss' or t.size < 4 then raise exception 'not_swiss'; end if;
  if exists (select 1 from public.matches where tournament_id = t.id and kind in ('ko','p3')) then raise exception 'final_started'; end if;
  if (select coalesce(max(round) + 1, 0) from public.matches where tournament_id = t.id and kind = 'sw') < (t.swiss ->> 'rounds')::int
     or exists (select 1 from public.matches where tournament_id = t.id and kind = 'sw' and status not in ('done','wo','bye')) then
    raise exception 'rounds_open';
  end if;
  sz := t.size;
  n := least(coalesce(array_length(p_players, 1), 0), sz);
  if n < 2 then raise exception 'min_2_players'; end if;
  r := public._rounds(sz);
  while array_length(so, 1) < sz loop
    m2 := array_length(so, 1) * 2; tmp := '{}';
    foreach s in array so loop tmp := tmp || s || (m2 + 1 - s); end loop;
    so := tmp;
  end loop;
  for rr in 0..r-1 loop
    for i in 0..(sz >> (rr + 1)) - 1 loop
      if rr = 0 then
        sa := so[2*i + 1]; sb := so[2*i + 2];
        insert into public.matches(tournament_id, round, idx, player_a, player_b, bye_a, bye_b)
        values (t.id, 0, i, case when sa <= n then p_players[sa] end, case when sb <= n then p_players[sb] end, sa > n, sb > n);
      else
        insert into public.matches(tournament_id, round, idx) values (t.id, rr, i);
      end if;
    end loop;
  end loop;
  if t.third_place and r >= 2 then
    insert into public.matches(tournament_id, kind, round, idx) values (t.id, 'p3', r - 1, 0);
  end if;
  for mid in select id from public.matches where tournament_id = t.id and round = 0 and kind = 'ko' order by idx loop
    perform public._refresh(mid);
  end loop;
end $$;

revoke execute on function public._swiss_points(uuid) from public, anon, authenticated;
revoke execute on function public.admin_create_swiss(text, date, int, jsonb, jsonb, boolean, jsonb, text[]),
  public.admin_swiss_pair(uuid, int, jsonb, uuid, boolean), public.admin_swiss_add(uuid, text),
  public.admin_swiss_final(uuid, uuid[]) from public, anon;
grant execute on function public.admin_create_swiss(text, date, int, jsonb, jsonb, boolean, jsonb, text[]),
  public.admin_swiss_pair(uuid, int, jsonb, uuid, boolean), public.admin_swiss_add(uuid, text),
  public.admin_swiss_final(uuid, uuid[]) to authenticated;
