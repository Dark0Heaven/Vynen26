-- Schweizer System: 1 Punkt pro Sieg (vorher 2; Reihenfolge der Tabelle ändert sich dadurch nicht)
create or replace function public._swiss_points(p_tournament uuid)
returns table(player_id uuid, pts int)
language sql stable security definer set search_path = public as $$
  select p.id, p.start_points + (select count(*)::int from public.matches m
      where m.tournament_id = p_tournament and m.kind = 'sw' and m.winner = p.id and m.status in ('done','wo','bye'))
  from public.players p where p.tournament_id = p_tournament;
$$;
revoke execute on function public._swiss_points(uuid) from public, anon, authenticated;
