-- Snake sightings: anyone can report a sighting (joke, a person, not a snake). Three reports hide it from the list and map.
alter table public.snake_sightings add column if not exists report_count int not null default 0;

create or replace function public.snake_report_sighting(p_id bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.snake_sightings
     set report_count = report_count + 1
   where id = p_id
     and expires_at > now();
$$;

revoke all on function public.snake_report_sighting(bigint) from public;
grant execute on function public.snake_report_sighting(bigint) to anon, authenticated;
