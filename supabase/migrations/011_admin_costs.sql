-- Kosten (Essen & Getränke) pro Leitungs-Account, nur für den eigenen Account lesbar
create table if not exists public.admin_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  costs numeric check (costs is null or costs >= 0),
  updated_at timestamptz not null default now()
);
alter table public.admin_prefs enable row level security;
drop policy if exists "eigene lesen" on public.admin_prefs;
create policy "eigene lesen" on public.admin_prefs for select using (user_id = auth.uid() and public.is_admin());

create or replace function public.admin_set_costs(p_costs numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  insert into public.admin_prefs (user_id, costs) values (auth.uid(), p_costs)
  on conflict (user_id) do update set costs = excluded.costs, updated_at = now();
end $$;
revoke execute on function public.admin_set_costs(numeric) from public, anon;
grant execute on function public.admin_set_costs(numeric) to authenticated;
