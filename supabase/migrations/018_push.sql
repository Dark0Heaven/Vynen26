-- Push-Benachrichtigungen „Mein Spieler“: Abos (pro Gerät) + Trigger, der die Edge Function `notify` aufruft.
create extension if not exists pg_net;

create table if not exists public.push_subs (
  endpoint text primary key check (length(endpoint) < 1000),
  p256dh text not null check (length(p256dh) < 200),
  auth text not null check (length(auth) < 100),
  follow text not null check (length(follow) between 1 and 60),  -- Spielername (klein geschrieben)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.push_subs enable row level security; -- kein Lesezugriff, nur über Funktionen

create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare n text := lower(btrim(coalesce(p_name, '')));
begin
  if length(n) < 1 or length(n) > 60 then raise exception 'empty_name'; end if;
  if p_endpoint !~ '^https://' then raise exception 'bad_endpoint'; end if;
  if (select count(*) from public.push_subs where created_at > now() - interval '1 minute') > 60 then raise exception 'too_many'; end if;
  insert into public.push_subs(endpoint, p256dh, auth, follow) values (p_endpoint, p_p256dh, p_auth, n)
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, follow = excluded.follow, updated_at = now();
end $$;

create or replace function public.push_unsubscribe(p_endpoint text) returns void
language sql security definer set search_path = public as $$ delete from public.push_subs where endpoint = p_endpoint; $$;

revoke execute on function public.push_subscribe(text, text, text, text), public.push_unsubscribe(text) from public;
grant execute on function public.push_subscribe(text, text, text, text), public.push_unsubscribe(text) to anon, authenticated;

-- Ereignisse: ready (Gegner steht fest), live (aufs Board gelegt), result (Spiel beendet)
create or replace function public._push_matches() returns trigger
language plpgsql security definer set search_path = public as $$
declare ev text; sec text;
begin
  if new.player_a is null or new.player_b is null then return new; end if;
  if new.status = 'ready' and old.status = 'pending' then ev := 'ready';
  elsif new.board is not null and old.board is null then ev := 'live';
  elsif new.status in ('done', 'wo') and old.status not in ('done', 'wo') then ev := 'result';
  else return new; end if;
  if not exists (select 1 from public.push_subs) then return new; end if;
  select decrypted_secret into sec from vault.decrypted_secrets where name = 'push_hook';
  if sec is null then return new; end if;
  perform net.http_post(
    url := 'https://xwcmzazryuomxetkpuhj.supabase.co/functions/v1/notify',
    body := jsonb_build_object('match_id', new.id, 'event', ev),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook', sec),
    timeout_milliseconds := 5000);
  return new;
exception when others then return new; -- Push darf das Spiel nie blockieren
end $$;
drop trigger if exists push_matches on public.matches;
create trigger push_matches after update on public.matches for each row execute function public._push_matches();
