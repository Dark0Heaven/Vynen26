-- Korrekturen durch die Turnierleitung

-- Gewinner eines Spiels aus den Folgespielen wieder herausnehmen (rekursiv über Freilose/kampflose Spiele)
create or replace function public._unplace(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.matches; t public.tournaments; r int; nx public.matches;
begin
  select * into m from public.matches where id = p_match;
  if m.kind = 'p3' then return; end if;
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

-- Spiel komplett zurücksetzen (Aufnahmen löschen, Folgespiele bereinigen)
create or replace function public.admin_reset_match(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.matches;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  select * into m from public.matches where id = p_match for update;
  if m.status in ('done','bye','wo') then perform public._unplace(m.id); end if;
  delete from public.visits where match_id = m.id;
  update public.match_pins set active = false where match_id = m.id;
  update public.matches set status = 'ready', legs_a = 0, legs_b = 0, bulls = '{}'::jsonb, winner = null, board = null, updated_at = now()
   where id = m.id;
  perform public._refresh(m.id);
end $$;

-- Ergebnis von Hand eintragen (z. B. wenn ohne Scorer gespielt wurde). Vorhandene Aufnahmen bleiben für die Statistik.
create or replace function public.admin_set_result(p_match uuid, p_legs_a int, p_legs_b int) returns void
language plpgsql security definer set search_path = public as $$
declare m public.matches; need int;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  select * into m from public.matches where id = p_match for update;
  if m.player_a is null or m.player_b is null then raise exception 'not_ready'; end if;
  need := (coalesce((public._cfg(m.id) ->> 'bo')::int, 3) + 1) / 2;
  if not ((p_legs_a = need and p_legs_b between 0 and need - 1) or (p_legs_b = need and p_legs_a between 0 and need - 1)) then
    raise exception 'bad_result';
  end if;
  if m.status = 'done' then perform public._unplace(m.id); end if;
  update public.match_pins set active = false where match_id = m.id;
  update public.matches set legs_a = p_legs_a, legs_b = p_legs_b, status = 'done', board = null,
    winner = case when p_legs_a = need then m.player_a else m.player_b end, updated_at = now()
   where id = m.id;
  perform public._place(m.id);
end $$;

create or replace function public.admin_rename(p_player uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  if length(trim(p_name)) = 0 then raise exception 'empty_name'; end if;
  update public.players set name = left(trim(p_name), 40) where id = p_player;
end $$;

-- Rückzug: offene Spiele des Spielers werden kampflos (w. o.) entschieden
create or replace function public.admin_withdraw(p_player uuid) returns void
language plpgsql security definer set search_path = public as $$
declare mid uuid;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  if exists (select 1 from public.matches m where (m.player_a = p_player or m.player_b = p_player)
             and m.status in ('live','review') and exists (select 1 from public.visits v where v.match_id = m.id)) then
    raise exception 'match_running';
  end if;
  update public.players set withdrawn = true where id = p_player;
  for mid in select id from public.matches where (player_a = p_player or player_b = p_player) and status in ('pending','ready','live') loop
    update public.match_pins set active = false where match_id = mid;
    update public.matches set status = 'pending', board = null, bulls = '{}'::jsonb where id = mid;
    perform public._refresh(mid);
  end loop;
end $$;

-- Nachmelden: Spieler in ein Freilos der ersten Runde setzen
create or replace function public.admin_add_player(p_tournament uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare m public.matches; pid uuid; s int;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  select * into m from public.matches where tournament_id = p_tournament and kind = 'ko' and round = 0
     and status = 'bye' and (bye_a <> bye_b) order by idx limit 1 for update;
  if m.id is null then raise exception 'no_free_slot'; end if;
  perform public._unplace(m.id);
  select coalesce(max(seed), 0) + 1 into s from public.players where tournament_id = p_tournament;
  insert into public.players(tournament_id, seed, name) values (p_tournament, s, left(trim(p_name), 40)) returning id into pid;
  if m.bye_a then
    update public.matches set player_a = pid, bye_a = false, status = 'pending', winner = null, updated_at = now() where id = m.id;
  else
    update public.matches set player_b = pid, bye_b = false, status = 'pending', winner = null, updated_at = now() where id = m.id;
  end if;
  perform public._refresh(m.id);
  return pid;
end $$;

revoke execute on function public._unplace(uuid) from public, anon, authenticated;
revoke execute on function public.admin_reset_match(uuid), public.admin_set_result(uuid, int, int), public.admin_rename(uuid, text),
  public.admin_withdraw(uuid), public.admin_add_player(uuid, text) from public, anon;
grant execute on function public.admin_reset_match(uuid), public.admin_set_result(uuid, int, int), public.admin_rename(uuid, text),
  public.admin_withdraw(uuid), public.admin_add_player(uuid, text) to authenticated;
