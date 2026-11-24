-- Online-Spiele im Bereich „Spielen“: Raum mit Code, Spielstand als JSON, Versionszähler gegen gleichzeitiges Schreiben.
-- Kein direkter Tabellenzugriff; nur über die Funktionen (Code = Zugang). Räume verfallen nach 3 Tagen.
create table if not exists public.play_rooms (
  code text primary key,
  game jsonb not null,
  ver int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.play_rooms enable row level security;

create or replace function public.play_room_create(p_game jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare c text; i int;
begin
  if octet_length(p_game::text) > 300000 then raise exception 'zu groß'; end if;
  delete from play_rooms where updated_at < now() - interval '3 days';
  loop
    c := '';
    for i in 1..6 loop c := c || substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1); end loop;
    begin insert into play_rooms(code, game) values (c, p_game); return c;
    exception when unique_violation then end;
  end loop;
end $$;

create or replace function public.play_room_get(p_code text) returns table(game jsonb, ver int)
language sql stable security definer set search_path = public as $$
  select game, ver from play_rooms where code = upper(trim(p_code));
$$;

-- Schreibt nur, wenn niemand dazwischen geschrieben hat; gibt die neue Version zurück (sonst null)
create or replace function public.play_room_push(p_code text, p_ver int, p_game jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  if octet_length(p_game::text) > 300000 then raise exception 'zu groß'; end if;
  update play_rooms set game = p_game, ver = ver + 1, updated_at = now()
    where code = upper(trim(p_code)) and ver = p_ver returning ver into v;
  return v;
end $$;

revoke all on table public.play_rooms from anon, authenticated;
revoke execute on function public.play_room_create(jsonb), public.play_room_get(text), public.play_room_push(text, int, jsonb) from public;
grant execute on function public.play_room_create(jsonb), public.play_room_get(text), public.play_room_push(text, int, jsonb) to anon, authenticated;
