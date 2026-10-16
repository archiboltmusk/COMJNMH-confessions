-- Optional Instagram handle on a comment. Unverified: the commenter types it,
-- nothing checks it against Instagram. Stored only when the commenter fills it in.
-- Applied only after the moderator approves it on the live project.

alter table public.confession_comments
  add column if not exists instagram text
  check (instagram is null or instagram ~ '^[A-Za-z0-9._]{1,30}$');

grant select (instagram) on public.confession_comments to anon, authenticated;
