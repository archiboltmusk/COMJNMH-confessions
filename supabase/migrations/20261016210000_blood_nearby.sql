-- Nearby donor search for donors.html. Donors may share an approximate location (rounded to 0.01 degree, about 1 km).
-- Searchers send their own location for one query; it is not stored. Contact details still show only when the donor opts in.
-- Rate limit and reports use a sha256 of the caller's forwarded address, never the raw address.
-- Migration is NOT applied to live until approved.

alter table public.blood_donors add column if not exists lat_approx double precision check (lat_approx between -90 and 90);
alter table public.blood_donors add column if not exists lng_approx double precision check (lng_approx between -180 and 180);
alter table public.blood_donors add column if not exists hidden boolean not null default false;

alter table public.blood_donors drop constraint if exists blood_donors_loc_pair;
alter table public.blood_donors add constraint blood_donors_loc_pair check ((lat_approx is null) = (lng_approx is null));

create table if not exists public.blood_search_hits (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  kind text not null check (kind in ('search', 'report')),
  at timestamptz not null default now()
);
create index if not exists blood_search_hits_ip_idx on public.blood_search_hits (ip_hash, kind, at desc);
alter table public.blood_search_hits enable row level security;
revoke all on public.blood_search_hits from public, anon, authenticated;

create table if not exists public.blood_donor_reports (
  id bigint generated always as identity primary key,
  donor_id bigint not null references public.blood_donors (id) on delete cascade,
  reason text not null check (char_length(btrim(reason)) between 3 and 200),
  created_at timestamptz not null default now()
);
alter table public.blood_donor_reports enable row level security;
revoke all on public.blood_donor_reports from public, anon, authenticated;

-- Hashed caller address for rate limits. Missing header => one shared bucket.
create or replace function public.blood_client_hash()
returns text
language sql
stable
set search_path = public
as $$
  select encode(sha256(convert_to(coalesce(
    nullif(split_part(coalesce(nullif(current_setting('request.headers', true), '')::json->>'x-forwarded-for', ''), ',', 1), ''),
    'unknown'), 'UTF8')), 'hex');
$$;

-- Donor sets or clears an approximate location with their code.
create or replace function public.blood_donor_set_location(p_token text, p_lat double precision, p_lng double precision)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.blood_donors
     set lat_approx = case when p_lat is null or p_lng is null then null else round(p_lat::numeric, 2)::double precision end,
         lng_approx = case when p_lat is null or p_lng is null then null else round(p_lng::numeric, 2)::double precision end
   where withdraw_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
  return found;
end $$;

-- Nearby search. Sorted by distance. Searcher location is used for this query only.
create or replace function public.blood_donor_nearby(
  p_lat double precision,
  p_lng double precision,
  p_blood_group text default null,
  p_radius_km double precision default 25
)
returns table (id bigint, name text, blood_group text, area text, distance_km double precision,
               phone text, email text, show_contact boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ip text := public.blood_client_hash();
  v_n int;
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'bad_location';
  end if;

  delete from public.blood_search_hits where at < now() - interval '1 day';
  select count(*) into v_n from public.blood_search_hits
   where ip_hash = v_ip and kind = 'search' and at > now() - interval '1 hour';
  if v_n >= 30 then
    raise exception 'rate_limited';
  end if;
  insert into public.blood_search_hits (ip_hash, kind) values (v_ip, 'search');

  return query
  select d.id,
         d.name,
         d.blood_group,
         d.area,
         round(dist.km::numeric, 1)::double precision,
         case when d.show_contact then d.phone end,
         case when d.show_contact then d.email end,
         d.show_contact
    from public.blood_donors d
    cross join lateral (
      select 6371 * 2 * asin(sqrt(
        power(sin(radians(d.lat_approx - p_lat) / 2), 2) +
        cos(radians(p_lat)) * cos(radians(d.lat_approx)) * power(sin(radians(d.lng_approx - p_lng) / 2), 2)
      )) as km
    ) dist
   where d.lat_approx is not null
     and not d.hidden
     and (p_blood_group is null or p_blood_group = '' or d.blood_group = p_blood_group)
     and dist.km <= least(greatest(coalesce(p_radius_km, 25), 1), 50)
   order by dist.km, d.created_at desc
   limit 100;
end $$;

-- Hidden listings leave the area search too.
create or replace function public.blood_donor_search(p_blood_group text default null, p_area text default null)
returns table (name text, blood_group text, area text, phone text, email text, show_contact boolean)
language sql
stable
security definer
set search_path = public
as $$
  select d.name,
         d.blood_group,
         d.area,
         case when d.show_contact then d.phone end,
         case when d.show_contact then d.email end,
         d.show_contact
    from public.blood_donors d
   where not d.hidden
     and (p_blood_group is null or p_blood_group = '' or d.blood_group = p_blood_group)
     and (p_area is null or btrim(p_area) = '' or d.area ilike '%' || btrim(p_area) || '%')
   order by d.created_at desc
   limit 200;
$$;

-- A reader reports a listing. Three distinct reports hide it from search.
create or replace function public.blood_donor_report(p_donor_id bigint, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ip text := public.blood_client_hash();
  v_n int;
begin
  delete from public.blood_search_hits where at < now() - interval '1 day';
  select count(*) into v_n from public.blood_search_hits
   where ip_hash = v_ip and kind = 'report' and at > now() - interval '1 hour';
  if v_n >= 10 then
    raise exception 'rate_limited';
  end if;
  insert into public.blood_search_hits (ip_hash, kind) values (v_ip, 'report');

  if not exists (select 1 from public.blood_donors where id = p_donor_id) then
    return false;
  end if;

  insert into public.blood_donor_reports (donor_id, reason)
  values (p_donor_id, btrim(p_reason));

  update public.blood_donors d
     set hidden = true
   where d.id = p_donor_id
     and (select count(*) from public.blood_donor_reports r where r.donor_id = p_donor_id) >= 3;
  return true;
end $$;

revoke all on function public.blood_client_hash() from public;
revoke all on function public.blood_donor_set_location(text, double precision, double precision) from public;
revoke all on function public.blood_donor_nearby(double precision, double precision, text, double precision) from public;
revoke all on function public.blood_donor_report(bigint, text) from public;
grant execute on function public.blood_donor_set_location(text, double precision, double precision) to anon, authenticated;
grant execute on function public.blood_donor_nearby(double precision, double precision, text, double precision) to anon, authenticated;
grant execute on function public.blood_donor_report(bigint, text) to anon, authenticated;
