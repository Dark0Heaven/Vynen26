-- Vynen Dart: Spiellogik (läuft serverseitig, damit niemand Ergebnisse am Client vorbei manipulieren kann)

-- Runden-Konfiguration eines Spiels
create or replace function public._cfg(p_match uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    case when m.kind = 'p3'
      then coalesce(t.p3_cfg, t.rounds -> (jsonb_array_length(t.rounds) - 1))
      else t.rounds -> m.round end,
    '{}'::jsonb)
  from public.matches m join public.tournaments t on t.id = m.tournament_id
  where m.id = p_match;
$$;

create or replace function public._rounds(p_size int) returns int
language sql immutable as $$ select round(log(2, p_size))::int $$;

-- Gewinner (bzw. Freilos) ins nächste Spiel und Verlierer ins Spiel um Platz 3 tragen
create or replace function public._place(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.matches; t public.tournaments; r int; nxt uuid; loser uuid;
begin
  select * into m from public.matches where id = p_match;
  if m.kind = 'p3' then return; end if;
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

-- Status eines wartenden Spiels neu bestimmen (Freilos, kampflos, spielbereit)
create or replace function public._refresh(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.matches; wa boolean; wb boolean; w uuid; st text;
begin
  select * into m from public.matches where id = p_match;
  if m.id is null or m.status not in ('pending','ready') then return; end if;
  if not ((m.player_a is not null or m.bye_a) and (m.player_b is not null or m.bye_b)) then
    update public.matches set status = 'pending', updated_at = now() where id = m.id;
    return;
  end if;
  if m.bye_a and m.bye_b then st := 'bye'; w := null;
  elsif m.bye_a then st := 'bye'; w := m.player_b;
  elsif m.bye_b then st := 'bye'; w := m.player_a;
  else
    select withdrawn into wa from public.players where id = m.player_a;
    select withdrawn into wb from public.players where id = m.player_b;
    if wa and wb then st := 'wo'; w := null;
    elsif wa then st := 'wo'; w := m.player_b;
    elsif wb then st := 'wo'; w := m.player_a;
    else
      update public.matches set status = 'ready', updated_at = now() where id = m.id;
      return;
    end if;
  end if;
  update public.matches set status = st, winner = w, updated_at = now() where id = m.id;
  perform public._place(m.id);
end $$;

-- Wer beginnt ein Leg? null = es muss (erneut) ausgebullt werden
create or replace function public._starter(p_match uuid, p_leg int) returns int
language plpgsql stable security definer set search_path = public as $$
declare
  m public.matches; need int;
begin
  select * into m from public.matches where id = p_match;
  if m.bulls ? p_leg::text then return (m.bulls ->> p_leg::text)::int; end if;
  if not (m.bulls ? '1') then return null; end if;
  need := (coalesce((public._cfg(m.id) ->> 'bo')::int, 3) + 1) / 2;
  if need > 1 and m.legs_a = need - 1 and m.legs_b = need - 1 and p_leg = m.legs_a + m.legs_b + 1 then
    return null; -- Decider: neu ausbullen
  end if;
  return ((m.bulls ->> '1')::int + p_leg - 1) % 2;
end $$;

-- PIN prüfen (mit Bremse gegen Raten). Wirft nie, damit Fehlversuche gespeichert bleiben.
create or replace function public._pin_match(p_pin text) returns uuid
language plpgsql security definer set search_path = public as $$
declare mid uuid;
begin
  if (select count(*) from public.pin_attempts where not ok and at > now() - interval '1 minute') > 30 then
    return null;
  end if;
  select match_id into mid from public.match_pins where pin = p_pin and active;
  if mid is null then
    insert into public.pin_attempts(ok) values (false);
    delete from public.pin_attempts where at < now() - interval '1 hour';
  end if;
  return mid;
end $$;

create or replace function public._state(p_match uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('ok', true, 'match_id', m.id, 'status', m.status,
    'legs_a', m.legs_a, 'legs_b', m.legs_b, 'bulls', m.bulls, 'board', m.board)
  from public.matches m where m.id = p_match;
$$;

-- ===== Schiri =====

create or replace function public.ref_login(p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare mid uuid;
begin
  mid := public._pin_match(p_pin);
  if mid is null then return jsonb_build_object('ok', false, 'error', 'bad_pin'); end if;
  return public._state(mid);
end $$;

create or replace function public.ref_bull(p_pin text, p_leg int, p_side int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare mid uuid; m public.matches; cur int;
begin
  mid := public._pin_match(p_pin);
  if mid is null then return jsonb_build_object('ok', false, 'error', 'bad_pin'); end if;
  if p_side not in (0,1) then return jsonb_build_object('ok', false, 'error', 'bad_side'); end if;
  select * into m from public.matches where id = mid for update;
  if m.status <> 'live' then return jsonb_build_object('ok', false, 'error', 'not_live'); end if;
  cur := m.legs_a + m.legs_b + 1;
  if p_leg <> cur then return jsonb_build_object('ok', false, 'error', 'stale'); end if;
  if exists (select 1 from public.visits where match_id = mid and leg_no = cur) then
    return jsonb_build_object('ok', false, 'error', 'leg_started');
  end if;
  if public._starter(mid, cur) is not null and not (m.bulls ? cur::text) then
    return jsonb_build_object('ok', false, 'error', 'no_bull_needed');
  end if;
  update public.matches set bulls = bulls || jsonb_build_object(cur::text, p_side), updated_at = now() where id = mid;
  return public._state(mid);
end $$;

create or replace function public.ref_visit(p_pin text, p_client uuid, p_leg int, p_side int,
  p_score int, p_darts int default 3, p_detail jsonb default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  mid uuid; m public.matches; cfg jsonb; bo int; need int; startp int; outr text;
  cur int; st int; nv int; rem int; nw int; is_bust boolean := false; co boolean := false;
  last text; drt int := coalesce(p_darts, 3);
begin
  mid := public._pin_match(p_pin);
  if mid is null then return jsonb_build_object('ok', false, 'error', 'bad_pin'); end if;
  if exists (select 1 from public.visits where client_id = p_client) then
    return public._state(mid) || jsonb_build_object('dup', true);
  end if;
  select * into m from public.matches where id = mid for update;
  if m.status <> 'live' then return jsonb_build_object('ok', false, 'error', 'not_live'); end if;
  cfg := public._cfg(mid);
  bo := coalesce((cfg ->> 'bo')::int, 3);
  need := (bo + 1) / 2;
  startp := coalesce((cfg ->> 'start')::int, 501);
  outr := coalesce(cfg ->> 'out', 'double');
  cur := m.legs_a + m.legs_b + 1;
  if p_leg <> cur then return jsonb_build_object('ok', false, 'error', 'stale'); end if;
  st := public._starter(mid, cur);
  if st is null then return jsonb_build_object('ok', false, 'error', 'need_bull'); end if;
  select count(*) into nv from public.visits where match_id = mid and leg_no = cur;
  if p_side <> (st + nv) % 2 then return jsonb_build_object('ok', false, 'error', 'wrong_side'); end if;
  if p_score < 0 or p_score > 180 or p_score in (163,166,169,172,173,175,176,178,179) then
    return jsonb_build_object('ok', false, 'error', 'bad_score');
  end if;
  select startp - coalesce(sum(score) filter (where not bust), 0) into rem
    from public.visits where match_id = mid and leg_no = cur and side = p_side;
  nw := rem - p_score;
  if nw < 0 then is_bust := true;
  elsif nw = 0 then
    if outr = 'double' and (rem > 170 or rem in (169,168,166,165,163,162,159)) then is_bust := true;
    elsif outr = 'master' and rem > 180 then is_bust := true;
    end if;
    if not is_bust and p_detail is not null and jsonb_typeof(p_detail) = 'array' and jsonb_array_length(p_detail) > 0 then
      last := upper(p_detail ->> (jsonb_array_length(p_detail) - 1));
      if outr = 'double' and not (last like 'D%' or last in ('BULL','50')) then is_bust := true; end if;
      if outr = 'master' and not (last like 'D%' or last like 'T%' or last in ('BULL','50')) then is_bust := true; end if;
    end if;
    co := not is_bust;
  elsif nw = 1 and outr in ('double','master') then is_bust := true;
  end if;
  if not co then drt := 3; end if;
  insert into public.visits(match_id, client_id, leg_no, side, score, darts, detail, bust, checkout, remaining)
  values (mid, p_client, cur, p_side, p_score, greatest(1, least(3, drt)), p_detail, is_bust, co,
          case when is_bust then rem else nw end);
  if co then
    if p_side = 0 then m.legs_a := m.legs_a + 1; else m.legs_b := m.legs_b + 1; end if;
    update public.matches set legs_a = m.legs_a, legs_b = m.legs_b,
      status = case when greatest(m.legs_a, m.legs_b) >= need then 'review' else 'live' end,
      winner = case when m.legs_a >= need then m.player_a when m.legs_b >= need then m.player_b end,
      updated_at = now()
    where id = mid;
  else
    update public.matches set updated_at = now() where id = mid;
  end if;
  return public._state(mid) || jsonb_build_object('bust', is_bust, 'checkout', co);
end $$;

create or replace function public.ref_undo(p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare mid uuid; m public.matches; v public.visits; cur int;
begin
  mid := public._pin_match(p_pin);
  if mid is null then return jsonb_build_object('ok', false, 'error', 'bad_pin'); end if;
  select * into m from public.matches where id = mid for update;
  if m.status not in ('live','review') then return jsonb_build_object('ok', false, 'error', 'not_live'); end if;
  cur := m.legs_a + m.legs_b + 1;
  -- 1) Decider-Bull des aktuellen Legs zurücknehmen, solange noch nicht geworfen wurde
  if m.status = 'live' and cur > 1 and m.bulls ? cur::text
     and not exists (select 1 from public.visits where match_id = mid and leg_no = cur) then
    update public.matches set bulls = bulls - cur::text, updated_at = now() where id = mid;
    return public._state(mid) || jsonb_build_object('undone', 'bull');
  end if;
  select * into v from public.visits where match_id = mid order by id desc limit 1;
  -- 2) Noch keine Aufnahme: Ausbullen zurücknehmen
  if v.id is null then
    if m.bulls ? '1' then
      update public.matches set bulls = '{}'::jsonb, updated_at = now() where id = mid;
      return public._state(mid) || jsonb_build_object('undone', 'bull');
    end if;
    return jsonb_build_object('ok', false, 'error', 'nothing');
  end if;
  -- 3) Letzte Aufnahme löschen (auch über ein Leg-Ende hinweg)
  delete from public.visits where id = v.id;
  if v.checkout then
    update public.matches set
      legs_a = legs_a - (case when v.side = 0 then 1 else 0 end),
      legs_b = legs_b - (case when v.side = 1 then 1 else 0 end),
      status = 'live', winner = null,
      bulls = (select coalesce(jsonb_object_agg(k, val), '{}'::jsonb)
                 from jsonb_each(m.bulls) as e(k, val) where k::int <= v.leg_no),
      updated_at = now()
    where id = mid;
  else
    update public.matches set updated_at = now() where id = mid;
  end if;
  return public._state(mid) || jsonb_build_object('undone', 'visit');
end $$;

create or replace function public.ref_confirm(p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare mid uuid; m public.matches;
begin
  mid := public._pin_match(p_pin);
  if mid is null then return jsonb_build_object('ok', false, 'error', 'bad_pin'); end if;
  select * into m from public.matches where id = mid for update;
  if m.status <> 'review' then return jsonb_build_object('ok', false, 'error', 'not_finished'); end if;
  update public.matches set status = 'done', board = null, updated_at = now() where id = mid;
  update public.match_pins set active = false where match_id = mid;
  perform public._place(mid);
  return jsonb_build_object('ok', true, 'status', 'done');
end $$;

-- ===== Turnierleitung =====

create or replace function public.admin_create_tournament(p_name text, p_date date, p_boards int,
  p_third boolean, p_rounds jsonb, p_p3 jsonb, p_players text[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  n int; sz int := 2; r int; tid uuid; pids uuid[] := '{}'; pid uuid;
  so int[] := array[1]; tmp int[]; s int; m2 int; i int; rr int; sa int; sb int; mid uuid;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  n := coalesce(array_length(p_players, 1), 0);
  if n < 2 then raise exception 'min_2_players'; end if;
  if n > 128 then raise exception 'max_128_players'; end if;
  while sz < n loop sz := sz * 2; end loop;
  r := public._rounds(sz);
  insert into public.tournaments(name, event_date, boards, third_place, size, rounds, p3_cfg)
  values (left(trim(p_name), 80), p_date, p_boards, coalesce(p_third, true) and r >= 2, sz,
          coalesce(p_rounds, '[]'::jsonb), p_p3)
  returning id into tid;
  for i in 1..n loop
    insert into public.players(tournament_id, seed, name) values (tid, i, left(trim(p_players[i]), 40))
    returning id into pid;
    pids := pids || pid;
  end loop;
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
        values (tid, 0, i, case when sa <= n then pids[sa] end, case when sb <= n then pids[sb] end, sa > n, sb > n);
      else
        insert into public.matches(tournament_id, round, idx) values (tid, rr, i);
      end if;
    end loop;
  end loop;
  if coalesce(p_third, true) and r >= 2 then
    insert into public.matches(tournament_id, kind, round, idx) values (tid, 'p3', r - 1, 0);
  end if;
  for mid in select id from public.matches where tournament_id = tid and round = 0 and kind = 'ko' order by idx loop
    perform public._refresh(mid);
  end loop;
  return tid;
end $$;

-- Spiel auf ein Board legen; liefert den neuen PIN
create or replace function public.admin_assign_board(p_match uuid, p_board int) returns text
language plpgsql security definer set search_path = public as $$
declare m public.matches; t public.tournaments; v_pin text;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  select * into m from public.matches where id = p_match for update;
  select * into t from public.tournaments where id = m.tournament_id;
  if m.status <> 'ready' then raise exception 'not_ready'; end if;
  if p_board < 1 or p_board > t.boards then raise exception 'bad_board'; end if;
  if exists (select 1 from public.matches where tournament_id = m.tournament_id and board = p_board
             and status in ('live','review')) then raise exception 'board_busy'; end if;
  loop
    v_pin := lpad(floor(random() * 10000)::int::text, 4, '0');
    exit when not exists (select 1 from public.match_pins where pin = v_pin and active);
  end loop;
  insert into public.match_pins(match_id, pin, active) values (m.id, v_pin, true)
  on conflict (match_id) do update set pin = excluded.pin, active = true, created_at = now();
  update public.matches set board = p_board, status = 'live', updated_at = now() where id = m.id;
  return v_pin;
end $$;

-- Board wieder freigeben, solange noch nicht geworfen wurde
create or replace function public.admin_unassign(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  if exists (select 1 from public.visits where match_id = p_match) then raise exception 'already_started'; end if;
  update public.matches set board = null, status = 'ready', bulls = '{}'::jsonb, updated_at = now()
   where id = p_match and status = 'live';
  update public.match_pins set active = false where match_id = p_match;
end $$;

-- Rechte: interne Funktionen nur serverseitig
revoke execute on function public._cfg(uuid), public._rounds(int), public._place(uuid), public._refresh(uuid),
  public._starter(uuid, int), public._pin_match(text), public._state(uuid) from public, anon, authenticated;
grant execute on function public.ref_login(text), public.ref_bull(text, int, int),
  public.ref_visit(text, uuid, int, int, int, int, jsonb), public.ref_undo(text), public.ref_confirm(text)
  to anon, authenticated;
revoke execute on function public.admin_create_tournament(text, date, int, boolean, jsonb, jsonb, text[]),
  public.admin_assign_board(uuid, int), public.admin_unassign(uuid) from public, anon;
grant execute on function public.admin_create_tournament(text, date, int, boolean, jsonb, jsonb, text[]),
  public.admin_assign_board(uuid, int), public.admin_unassign(uuid) to authenticated;
