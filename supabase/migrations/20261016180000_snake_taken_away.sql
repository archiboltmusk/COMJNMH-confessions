-- Snake sightings: a sighting can be marked as taken away. Anon may only mark an unexpired, not-yet-taken row.
alter table public.snake_sightings add column if not exists taken_away_at timestamptz;

create or replace function public.snake_mark_taken(p_id bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.snake_sightings
     set taken_away_at = now()
   where id = p_id
     and taken_away_at is null
     and expires_at > now();
$$;

revoke all on function public.snake_mark_taken(bigint) from public;
grant execute on function public.snake_mark_taken(bigint) to anon, authenticated;
