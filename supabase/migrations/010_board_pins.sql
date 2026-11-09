-- Board-PIN für Tablets: einmal eingeben, 24 Stunden gültig ab der ersten Benutzung.
-- Das Tablet holt sich damit automatisch den Spiel-PIN des Spiels, das gerade auf seinem Board läuft.
create table if not exists public.board_pins (
  board int primary key check (board between 1 and 16),
  pin text not null unique,
  created_at timestamptz not null default now(),
  first_used timestamptz,
  expires_at timestamptz
);
alter table public.board_pins enable row level security;
drop policy if exists "admin liest" on public.board_pins;
create policy "admin liest" on public.board_pins for select using (public.is_admin());

-- Neuen Board-PIN erzeugen (ersetzt den alten, alte Tablets müssen neu eingeben)
create or replace function public.admin_board_pin(p_board int) returns text
language plpgsql security definer set search_path = public as $$
declare v text;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  if p_board < 1 or p_board > 16 then raise exception 'bad_board'; end if;
  loop
    v := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from public.board_pins where pin = v);
  end loop;
  insert into public.board_pins (board, pin) values (p_board, v)
  on conflict (board) do update set pin = excluded.pin, created_at = now(), first_used = null, expires_at = null;
  return v;
end $$;

-- Tablet: Board-PIN prüfen (erste Benutzung startet die 24 h), laufendes Spiel auf dem Board liefern
create or replace function public.ref_board(p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare bp public.board_pins; mp text; mid uuid;
begin
  if (select count(*) from public.pin_attempts where not ok and at > now() - interval '1 minute') > 30 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  select * into bp from public.board_pins where pin = p_pin for update;
  if bp.board is null then
    insert into public.pin_attempts(ok) values (false);
    return jsonb_build_object('ok', false, 'error', 'bad_pin');
  end if;
  if bp.expires_at is null then
    update public.board_pins set first_used = now(), expires_at = now() + interval '24 hours' where board = bp.board
    returning * into bp;
  end if;
  if bp.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'expired'); end if;
  select m.id, p.pin into mid, mp from public.matches m join public.match_pins p on p.match_id = m.id and p.active
    join public.tournaments t on t.id = m.tournament_id
    where m.board = bp.board and m.status in ('live', 'review')
    order by t.created_at desc limit 1;
  return jsonb_build_object('ok', true, 'board', bp.board, 'expires_at', bp.expires_at, 'match_pin', mp);
end $$;

revoke execute on function public.ref_board(text) from public;
grant execute on function public.ref_board(text) to anon, authenticated;
revoke execute on function public.admin_board_pin(int) from public, anon;
grant execute on function public.admin_board_pin(int) to authenticated;
