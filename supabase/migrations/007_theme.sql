-- Design-Umschalter: Vynen (rot) oder Big Fish VyMa (blau), gilt für alle Ansichten
alter table public.tournaments add column if not exists theme text not null default 'vynen' check (theme in ('vynen','bigfish'));

create or replace function public.admin_set_theme(p_tournament uuid, p_theme text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  if p_theme not in ('vynen','bigfish') then raise exception 'bad_theme'; end if;
  update public.tournaments set theme = p_theme where id = p_tournament;
end $$;
revoke execute on function public.admin_set_theme(uuid, text) from public, anon;
grant execute on function public.admin_set_theme(uuid, text) to authenticated;
