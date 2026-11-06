-- Einmal-Code, mit dem sich das erste Konto zur Turnierleitung macht
create table public.admin_setup (code text primary key, created_at timestamptz not null default now());
alter table public.admin_setup enable row level security;

create or replace function public.claim_admin(p_code text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_logged_in'; end if;
  if public.is_admin() then return true; end if;
  if not exists (select 1 from public.admin_setup where code = p_code) then
    insert into public.pin_attempts(ok) values (false);
    return false;
  end if;
  insert into public.admins(user_id) values (auth.uid()) on conflict do nothing;
  delete from public.admin_setup where code = p_code;
  return true;
end $$;
revoke execute on function public.claim_admin(text) from public, anon;
grant execute on function public.claim_admin(text) to authenticated;

create or replace function public.am_admin() returns boolean
language sql stable security definer set search_path = public as $$ select public.is_admin() $$;
grant execute on function public.am_admin() to authenticated;

-- Code wird zufällig erzeugt und nur der Turnierleitung mitgeteilt
insert into public.admin_setup(code) values (upper(substr(md5(gen_random_uuid()::text), 1, 8)));
