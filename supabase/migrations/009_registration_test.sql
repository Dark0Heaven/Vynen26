-- Anmeldung (online + vor Ort), Bezahlt-Haken, Testturnier
alter table public.tournaments add column if not exists is_test boolean not null default false;

create table if not exists public.registrations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 40),
  phone text check (phone is null or length(phone) <= 30),
  source text not null default 'online' check (source in ('online','vorort')),
  paid boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.registrations enable row level security;
drop policy if exists "admin liest" on public.registrations;
create policy "admin liest" on public.registrations for select using (public.is_admin());
create unique index if not exists registrations_name_uq on public.registrations (lower(name));

create table if not exists public.reg_settings (
  id int primary key default 1 check (id = 1),
  open boolean not null default true,
  deadline date default '2027-01-20',
  fee numeric not null default 10
);
insert into public.reg_settings (id) values (1) on conflict do nothing;
alter table public.reg_settings enable row level security;
drop policy if exists "alle lesen" on public.reg_settings;
create policy "alle lesen" on public.reg_settings for select using (true);

-- Öffentlich: Status + Anzahl (keine Namen, keine Nummern)
create or replace function public.public_reg_info() returns jsonb
language sql security definer set search_path = public stable as $$
  select jsonb_build_object('open', s.open and (s.deadline is null or (now() at time zone 'Europe/Berlin')::date <= s.deadline),
    'deadline', s.deadline, 'fee', s.fee, 'count', (select count(*) from public.registrations))
  from public.reg_settings s where s.id = 1;
$$;

create or replace function public.public_register(p_name text, p_phone text) returns int
language plpgsql security definer set search_path = public as $$
declare s public.reg_settings; n text := btrim(coalesce(p_name, '')); ph text := btrim(coalesce(p_phone, ''));
begin
  select * into s from public.reg_settings where id = 1;
  if not s.open or (s.deadline is not null and (now() at time zone 'Europe/Berlin')::date > s.deadline) then raise exception 'reg_closed'; end if;
  if length(n) < 2 or length(n) > 40 then raise exception 'empty_name'; end if;
  if length(regexp_replace(ph, '[^0-9]', '', 'g')) < 6 or length(ph) > 30 then raise exception 'bad_phone'; end if;
  if (select count(*) from public.registrations where created_at > now() - interval '1 minute') >= 20 then raise exception 'too_many'; end if;
  if exists (select 1 from public.registrations where lower(name) = lower(n)) then raise exception 'duplicate'; end if;
  insert into public.registrations (name, phone, source) values (n, ph, 'online');
  return (select count(*) from public.registrations);
end $$;

create or replace function public.admin_reg_add(p_name text, p_phone text) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); rid uuid;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  if length(n) < 1 or length(n) > 40 then raise exception 'empty_name'; end if;
  if exists (select 1 from public.registrations where lower(name) = lower(n)) then raise exception 'duplicate'; end if;
  insert into public.registrations (name, phone, source) values (n, nullif(btrim(coalesce(p_phone, '')), ''), 'vorort') returning id into rid;
  return rid;
end $$;

create or replace function public.admin_reg_paid(p_id uuid, p_paid boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  update public.registrations set paid = p_paid where id = p_id;
end $$;

create or replace function public.admin_reg_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  delete from public.registrations where id = p_id;
end $$;

create or replace function public.admin_reg_settings(p_open boolean, p_deadline date) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  update public.reg_settings set open = p_open, deadline = p_deadline where id = 1;
end $$;

create or replace function public.admin_set_test(p_tournament uuid, p_test boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  update public.tournaments set is_test = p_test where id = p_tournament;
end $$;

-- Löscht nur Turniere, die als Test markiert sind (mit allen Spielen, Aufnahmen, PINs)
create or replace function public.admin_delete_test(p_tournament uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  if not exists (select 1 from public.tournaments where id = p_tournament and is_test) then raise exception 'not_test'; end if;
  delete from public.tournaments where id = p_tournament;
end $$;

revoke execute on function public.public_reg_info() from public;
revoke execute on function public.public_register(text, text) from public;
grant execute on function public.public_reg_info() to anon, authenticated;
grant execute on function public.public_register(text, text) to anon, authenticated;
do $$ declare f text; begin
  foreach f in array array['admin_reg_add(text,text)','admin_reg_paid(uuid,boolean)','admin_reg_delete(uuid)',
    'admin_reg_settings(boolean,date)','admin_set_test(uuid,boolean)','admin_delete_test(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
