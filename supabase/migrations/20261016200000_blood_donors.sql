-- Blood donor list for donors.html. Donors join on purpose; searchers filter by blood group and area.
-- RLS is on with no policies, so anon/authenticated cannot read or write the table directly.
-- Everything goes through the security definer functions below, which return a donor's phone and email
-- only when that donor has chosen show_contact. Withdrawal uses a code shown once at sign-up; only its sha256 is stored.

create table if not exists public.blood_donors (
  id bigint generated always as identity primary key,
  name text not null check (char_length(btrim(name)) between 2 and 80),
  blood_group text not null check (blood_group in ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  area text not null check (char_length(btrim(area)) between 2 and 80),
  phone text check (phone is null or phone ~ '^\+?[0-9]{10,13}$'),
  email text check (email is null or (char_length(email) <= 120 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  show_contact boolean not null default false,
  consent_age_and_gap boolean not null check (consent_age_and_gap),
  withdraw_hash text not null unique,
  created_at timestamptz not null default now(),
  constraint blood_donors_has_contact check (phone is not null or email is not null)
);

alter table public.blood_donors enable row level security;
revoke all on public.blood_donors from public, anon, authenticated;

create or replace function public.blood_donor_register(
  p_name text,
  p_blood_group text,
  p_area text,
  p_phone text,
  p_email text,
  p_show_contact boolean,
  p_consent boolean
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text := gen_random_uuid()::text || gen_random_uuid()::text;
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[\s()-]', '', 'g'), '');
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
begin
  if p_consent is not true then
    raise exception 'consent_required';
  end if;

  insert into public.blood_donors
    (name, blood_group, area, phone, email, show_contact, consent_age_and_gap, withdraw_hash)
  values
    (btrim(p_name), p_blood_group, btrim(p_area), v_phone, v_email, coalesce(p_show_contact, false), true,
     encode(sha256(convert_to(v_token, 'UTF8')), 'hex'));

  return v_token;
end $$;

-- Public search. Phone and email are returned only for donors who chose to show them.
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
   where (p_blood_group is null or p_blood_group = '' or d.blood_group = p_blood_group)
     and (p_area is null or btrim(p_area) = '' or d.area ilike '%' || btrim(p_area) || '%')
   order by d.created_at desc
   limit 200;
$$;

create or replace function public.blood_donor_set_contact(p_token text, p_show boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.blood_donors
     set show_contact = coalesce(p_show, false)
   where withdraw_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
  return found;
end $$;

create or replace function public.blood_donor_withdraw(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.blood_donors
   where withdraw_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
  return found;
end $$;

revoke all on function public.blood_donor_register(text, text, text, text, text, boolean, boolean) from public;
revoke all on function public.blood_donor_search(text, text) from public;
revoke all on function public.blood_donor_set_contact(text, boolean) from public;
revoke all on function public.blood_donor_withdraw(text) from public;
grant execute on function public.blood_donor_register(text, text, text, text, text, boolean, boolean) to anon, authenticated;
grant execute on function public.blood_donor_search(text, text) to anon, authenticated;
grant execute on function public.blood_donor_set_contact(text, boolean) to anon, authenticated;
grant execute on function public.blood_donor_withdraw(text) to anon, authenticated;
