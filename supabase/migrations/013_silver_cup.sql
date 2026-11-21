-- Silver Cup (Zusatz zum KO-Modus): die Verlierer der 1. Hauptrunde spielen einen eigenen KO-Baum (kind 'sc').
-- Hauptrunde-1-Spiel i -> Silver-Runde-0-Spiel i/2, Seite i%2. Freilos in der Hauptrunde = Freilos im Silver Cup.
alter table public.tournaments add column if not exists silver jsonb; -- {"rounds":[cfg, ...]}
alter table public.matches drop constraint if exists matches_kind_check;
alter table public.matches add constraint matches_kind_check check (kind in ('ko','p3','sw','lg','sc'));

create or replace function public._cfg(p_match uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    case when m.kind = 'sw' then t.swiss -> 'cfg'
         when m.kind = 'p3' then coalesce(t.p3_cfg, t.rounds -> (jsonb_array_length(t.rounds) - 1))
         when m.kind = 'sc' then t.silver -> 'rounds' -> m.round
         else t.rounds -> m.round end,
    '{}'::jsonb)
  from public.matches m join public.tournaments t on t.id = m.tournament_id
  where m.id = p_match;
$$;

-- Verlierer eines Hauptrunde-1-Spiels in den Silver Cup setzen (null = Freilos)
create or replace function public._silver_feed(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.matches; loser uuid; nxt uuid;
begin
  select * into m from public.matches where id = p_match;
  if m.kind <> 'ko' or m.round <> 0 or m.status not in ('done','wo','bye') then return; end if;
  if not exists (select 1 from public.matches where tournament_id = m.tournament_id and kind = 'sc') then return; end if;
  loser := case when m.status = 'bye' then null
                when m.winner = m.player_a then m.player_b
                when m.winner = m.player_b then m.player_a end;
  if m.idx % 2 = 0 then
    update public.matches set player_a = loser, bye_a = (loser is null), updated_at = now()
     where tournament_id = m.tournament_id and kind = 'sc' and round = 0 and idx = m.idx / 2 returning id into nxt;
  else
    update public.matches set player_b = loser, bye_b = (loser is null), updated_at = now()
     where tournament_id = m.tournament_id and kind = 'sc' and round = 0 and idx = m.idx / 2 returning id into nxt;
  end if;
  if nxt is not null then perform public._refresh(nxt); end if;
end $$;

create or replace function public._place(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.matches; t public.tournaments; r int; nxt uuid; loser uuid;
begin
  select * into m from public.matches where id = p_match;
  select * into t from public.tournaments where id = m.tournament_id;
  -- Silver Cup: im eigenen Baum weiterrücken (ohne Spiel um Platz 3)
  if m.kind = 'sc' then
    r := public._rounds(t.size / 2);
    if m.round < r - 1 then
      if m.idx % 2 = 0 then
        update public.matches set player_a = m.winner, bye_a = (m.winner is null), updated_at = now()
         where tournament_id = m.tournament_id and kind = 'sc' and round = m.round + 1 and idx = m.idx / 2 returning id into nxt;
      else
        update public.matches set player_b = m.winner, bye_b = (m.winner is null), updated_at = now()
         where tournament_id = m.tournament_id and kind = 'sc' and round = m.round + 1 and idx = m.idx / 2 returning id into nxt;
      end if;
      perform public._refresh(nxt);
    end if;
    return;
  end if;
  if m.kind <> 'ko' then return; end if;
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
  if m.round = 0 then perform public._silver_feed(m.id); end if;
end $$;

create or replace function public._unplace(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.matches; t public.tournaments; r int; nx public.matches;
begin
  select * into m from public.matches where id = p_match;
  select * into t from public.tournaments where id = m.tournament_id;
  if m.kind = 'sc' then
    r := public._rounds(t.size / 2);
    if m.round < r - 1 then
      select * into nx from public.matches where tournament_id = m.tournament_id and kind = 'sc' and round = m.round + 1 and idx = m.idx / 2;
      if nx.status in ('live','review','done') then raise exception 'next_started'; end if;
      if nx.status in ('bye','wo') then perform public._unplace(nx.id); end if;
      if m.idx % 2 = 0 then
        update public.matches set player_a = null, bye_a = false, status = 'pending', winner = null, updated_at = now() where id = nx.id;
      else
        update public.matches set player_b = null, bye_b = false, status = 'pending', winner = null, updated_at = now() where id = nx.id;
      end if;
    end if;
    return;
  end if;
  if m.kind <> 'ko' then return; end if;
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
  -- Silver Cup: Verlierer wieder herausnehmen
  if m.round = 0 then
    select * into nx from public.matches where tournament_id = m.tournament_id and kind = 'sc' and round = 0 and idx = m.idx / 2;
    if nx.id is not null then
      if nx.status in ('live','review','done') then raise exception 'next_started'; end if;
      if nx.status in ('bye','wo') then perform public._unplace(nx.id); end if;
      if m.idx % 2 = 0 then
        update public.matches set player_a = null, bye_a = false, status = 'pending', winner = null, updated_at = now() where id = nx.id;
      else
        update public.matches set player_b = null, bye_b = false, status = 'pending', winner = null, updated_at = now() where id = nx.id;
      end if;
    end if;
  end if;
end $$;

-- Silver Cup für ein gerade angelegtes KO-Turnier einschalten
create or replace function public.admin_enable_silver(p_tournament uuid, p_rounds jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare t public.tournaments; ss int; rs int; rr int; i int; mid uuid;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  select * into t from public.tournaments where id = p_tournament;
  if t.mode <> 'ko' then raise exception 'not_ko'; end if;
  if t.size < 8 then raise exception 'silver_min_8'; end if;
  if exists (select 1 from public.matches where tournament_id = t.id and kind = 'sc') then raise exception 'silver_exists'; end if;
  ss := t.size / 2; rs := public._rounds(ss);
  update public.tournaments set silver = jsonb_build_object('rounds', coalesce(p_rounds, '[]'::jsonb)) where id = t.id;
  for rr in 0..rs - 1 loop
    for i in 0..(ss >> (rr + 1)) - 1 loop
      insert into public.matches(tournament_id, kind, round, idx) values (t.id, 'sc', rr, i);
    end loop;
  end loop;
  for mid in select id from public.matches where tournament_id = t.id and kind = 'ko' and round = 0 and status in ('done','wo','bye') order by idx loop
    perform public._silver_feed(mid);
  end loop;
end $$;

revoke execute on function public._silver_feed(uuid) from public, anon, authenticated;
revoke execute on function public.admin_enable_silver(uuid, jsonb) from public, anon;
grant execute on function public.admin_enable_silver(uuid, jsonb) to authenticated;
