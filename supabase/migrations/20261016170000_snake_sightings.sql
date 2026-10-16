-- Snake sightings for the Kalyani snake page (snakes.html). Anonymous: no uid is stored.
-- Public for 48 h via expires_at; the prune trigger drops rows that expired over a day ago.

create table if not exists public.snake_sightings (
  id bigint generated always as identity primary key,
  photo text not null check (photo like 'data:image/jpeg;base64,%' and length(photo) <= 900000),
  lat double precision not null check (lat between 22.90 and 23.05),
  lng double precision not null check (lng between 88.36 and 88.51),
  accuracy_m integer not null check (accuracy_m between 0 and 100),
  note text check (note is null or char_length(note) <= 140),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '48 hours'
);

create index if not exists snake_sightings_expires_idx on public.snake_sightings (expires_at desc);

alter table public.snake_sightings enable row level security;

drop policy if exists snake_sightings_read on public.snake_sightings;
create policy snake_sightings_read on public.snake_sightings
  for select to anon, authenticated using (expires_at > now());

drop policy if exists snake_sightings_insert on public.snake_sightings;
create policy snake_sightings_insert on public.snake_sightings
  for insert to anon, authenticated with check (true);

revoke all on public.snake_sightings from anon, authenticated;
grant select, insert on public.snake_sightings to anon, authenticated;
grant usage on sequence public.snake_sightings_id_seq to anon, authenticated;

-- Drop sightings that expired more than a day ago, on each insert, so photos do not pile up.
create or replace function public.snake_sightings_prune() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.snake_sightings where expires_at < now() - interval '1 day';
  return null;
end $$;

drop trigger if exists snake_sightings_prune_trg on public.snake_sightings;
create trigger snake_sightings_prune_trg after insert on public.snake_sightings
  for each statement execute function public.snake_sightings_prune();
