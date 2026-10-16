-- Anonymous comments on confessions. Written by edge functions only.
-- device_hash is a SHA-256 of a random per-browser id, used for rate limits
-- and report dedupe. It is never exposed to readers.

create table public.confession_comments (
  id uuid primary key default gen_random_uuid(),
  confession_id uuid not null references public.confessions(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  device_hash text not null,
  report_count int not null default 0,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.comment_reports (
  comment_id uuid not null references public.confession_comments(id) on delete cascade,
  device_hash text not null,
  created_at timestamptz not null default now(),
  primary key (comment_id, device_hash)
);

create index confession_comments_confession_idx on public.confession_comments (confession_id, created_at);
create index confession_comments_device_idx on public.confession_comments (device_hash, created_at);

alter table public.confession_comments enable row level security;
alter table public.comment_reports enable row level security;

-- Readers see only visible comments, and never the device hash or report count.
create policy "public read visible comments"
  on public.confession_comments for select
  to anon, authenticated
  using (hidden = false);

revoke all on public.confession_comments from anon, authenticated;
grant select (id, confession_id, body, created_at) on public.confession_comments to anon, authenticated;

-- No public access to reports at all.
revoke all on public.comment_reports from anon, authenticated;
