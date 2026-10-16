-- Optional course and batch on a confession. Both are free to leave blank, and
-- "Other" stores free text that is moderated like the confession body.
-- Applied only after the moderator approves it on the live project.

alter table public.confessions
  add column if not exists course text,
  add column if not exists course_other text,
  add column if not exists batch text,
  add column if not exists batch_other text;

alter table public.confessions
  add constraint confessions_course_len check (course is null or char_length(course) <= 60),
  add constraint confessions_course_other_len check (course_other is null or char_length(course_other) <= 60),
  add constraint confessions_batch_len check (batch is null or char_length(batch) <= 60),
  add constraint confessions_batch_other_len check (batch_other is null or char_length(batch_other) <= 60);
