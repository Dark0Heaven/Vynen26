-- Nur die Namen der Anmeldungen (ohne Nummern) für die Auswahl „Mein Spieler“
create or replace function public.public_reg_names() returns setof text
language sql stable security definer set search_path = public as $$
  select name from public.registrations order by lower(name);
$$;
revoke execute on function public.public_reg_names() from public;
grant execute on function public.public_reg_names() to anon, authenticated;
