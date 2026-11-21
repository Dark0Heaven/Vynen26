-- Änderungsprotokoll für die Turnierleitung: wer hat wann was geändert (nur Leitung lesbar, live per Realtime)
create table if not exists public.audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  tx bigint not null default txid_current(),
  user_id uuid,
  who text,            -- E-Mail der Leitung, „Schiri Board 2“ oder „Online-Anmeldung“
  action text not null,
  tournament_id uuid
);
create index if not exists audit_log_at on public.audit_log (at desc);
alter table public.audit_log enable row level security;
drop policy if exists "admin liest" on public.audit_log;
create policy "admin liest" on public.audit_log for select using (public.is_admin());
alter publication supabase_realtime add table public.audit_log;

alter table public.admin_prefs add column if not exists seen_at timestamptz;

create or replace function public._audit(p_action text, p_tournament uuid, p_who text default null) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); em text;
begin
  if uid is not null then select email into em from auth.users where id = uid; end if;
  insert into public.audit_log(user_id, who, action, tournament_id) values (uid, coalesce(p_who, em, 'unbekannt'), left(p_action, 300), p_tournament);
end $$;

create or replace function public._pn(p uuid) returns text language sql stable security definer set search_path = public as $$
  select coalesce((select name from public.players where id = p), '?');
$$;

-- Spiele: Board, Ergebnis, Zurücksetzen, Spieler eintragen (Liga). Weiterrücken im Baum wird nicht protokolliert.
create or replace function public._audit_matches() returns trigger
language plpgsql security definer set search_path = public as $$
declare vs text := public._pn(new.player_a) || ' vs ' || public._pn(new.player_b); uid uuid := auth.uid();
begin
  if new.status = old.status and new.board is not distinct from old.board and new.legs_a = old.legs_a and new.legs_b = old.legs_b
     and new.player_a is not distinct from old.player_a and new.player_b is not distinct from old.player_b then return new; end if;
  if uid is null then
    -- Schiri (ohne Login): nur das bestätigte Ergebnis
    if new.status = 'done' and old.status <> 'done' then
      perform public._audit('Ergebnis bestätigt: ' || public._pn(new.player_a) || ' ' || new.legs_a || ':' || new.legs_b || ' ' || public._pn(new.player_b),
        new.tournament_id, 'Schiri Board ' || coalesce(old.board::text, '?'));
    end if;
    return new;
  end if;
  if new.board is not null and old.board is null then perform public._audit(vs || ' auf Board ' || new.board || ' gelegt', new.tournament_id);
  elsif new.board is null and old.board is not null and new.status in ('ready','pending') and old.status in ('live','review') and new.legs_a = 0 and new.legs_b = 0 and old.legs_a + old.legs_b = 0
    then perform public._audit('Board ' || old.board || ' freigegeben (' || vs || ')', new.tournament_id);
  elsif new.status = 'done' and (old.status <> 'done' or new.legs_a <> old.legs_a or new.legs_b <> old.legs_b) then
    perform public._audit('Ergebnis gesetzt: ' || public._pn(new.player_a) || ' ' || new.legs_a || ':' || new.legs_b || ' ' || public._pn(new.player_b), new.tournament_id);
  elsif new.status = 'wo' and old.status <> 'wo' and old.status in ('ready','pending','live','review') and old.player_a is not null and old.player_b is not null then
    perform public._audit('Kampflos gewertet: ' || vs, new.tournament_id);
  elsif old.status in ('live','review','done','wo') and new.status in ('ready','pending') then
    perform public._audit('Spiel zurückgesetzt: ' || vs, new.tournament_id);
  elsif new.kind = 'lg' and (new.player_a is distinct from old.player_a or new.player_b is distinct from old.player_b) then
    perform public._audit('Liga Spiel ' || (new.idx + 1) || ' eingetragen: ' || vs, new.tournament_id);
  end if;
  return new;
end $$;
drop trigger if exists audit_matches on public.matches;
create trigger audit_matches after update on public.matches for each row execute function public._audit_matches();

create or replace function public._audit_players() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    -- Beim Anlegen eines Turniers nicht jeden Spieler einzeln melden
    if exists (select 1 from public.audit_log where tx = txid_current() and action like 'Turnier angelegt%') then return new; end if;
    if new.team is not null then return new; end if; -- Liga-Namen kommen über „Spiel eingetragen“
    perform public._audit('Spieler nachgemeldet: ' || new.name, new.tournament_id);
  elsif tg_op = 'UPDATE' then
    if new.name <> old.name then perform public._audit('Umbenannt: ' || old.name || ' → ' || new.name, new.tournament_id); end if;
    if new.withdrawn and not old.withdrawn then perform public._audit('Zurückgezogen: ' || new.name, new.tournament_id); end if;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists audit_players on public.players;
create trigger audit_players after insert or update on public.players for each row execute function public._audit_players();

create or replace function public._audit_tournaments() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then perform public._audit('Turnier angelegt: ' || new.name || ' (' || new.mode || ')', new.id);
  elsif tg_op = 'DELETE' then perform public._audit('Turnier gelöscht: ' || old.name, null);
  else
    if new.theme is distinct from old.theme then perform public._audit('Design auf ' || case when new.theme = 'bigfish' then 'Big Fish VyMa' else 'Vynen 26' end || ' umgestellt', new.id); end if;
    if new.is_test and not old.is_test and old.created_at < now() - interval '1 minute' then perform public._audit('Als Testturnier markiert: ' || new.name, new.id); end if;
    if new.silver is not null and old.silver is null then perform public._audit('Silver Cup eingeschaltet', new.id); end if;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists audit_tournaments on public.tournaments;
create trigger audit_tournaments after insert or update or delete on public.tournaments for each row execute function public._audit_tournaments();

create or replace function public._audit_regs() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public._audit(case when new.source = 'online' then 'Neue Online-Anmeldung: ' else 'Vor Ort angemeldet: ' end || new.name, null,
      case when auth.uid() is null then 'Online-Anmeldung' end);
  elsif tg_op = 'DELETE' then perform public._audit('Anmeldung entfernt: ' || old.name, null);
  elsif new.paid <> old.paid then perform public._audit(new.name || case when new.paid then ' hat bezahlt' else ': bezahlt zurückgenommen' end, null);
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists audit_regs on public.registrations;
create trigger audit_regs after insert or update or delete on public.registrations for each row execute function public._audit_regs();

create or replace function public._audit_misc() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'reg_settings' then
    perform public._audit('Anmeldung ' || case when new.open then 'geöffnet' else 'geschlossen' end || coalesce(' · Schluss ' || to_char(new.deadline, 'DD.MM.YYYY'), ''), null);
  elsif tg_table_name = 'board_pins' then
    if tg_op = 'INSERT' or new.pin <> old.pin then perform public._audit('Neuer Board-PIN für Board ' || new.board, null); end if;
  elsif tg_table_name = 'admins' then
    perform public._audit('Neuer Leitungs-Account: ' || coalesce((select email from auth.users where id = new.user_id), '?'), null);
  end if;
  return new;
end $$;
drop trigger if exists audit_regset on public.reg_settings;
create trigger audit_regset after update on public.reg_settings for each row execute function public._audit_misc();
drop trigger if exists audit_bpins on public.board_pins;
create trigger audit_bpins after insert or update on public.board_pins for each row execute function public._audit_misc();
drop trigger if exists audit_admins on public.admins;
create trigger audit_admins after insert on public.admins for each row execute function public._audit_misc();

-- „Gelesen bis“ pro Leitungs-Account
create or replace function public.admin_seen() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  insert into public.admin_prefs (user_id, seen_at) values (auth.uid(), now())
  on conflict (user_id) do update set seen_at = now();
end $$;

revoke execute on function public._audit(text, uuid, text), public._pn(uuid) from public, anon, authenticated;
revoke execute on function public.admin_seen() from public, anon;
grant execute on function public.admin_seen() to authenticated;
