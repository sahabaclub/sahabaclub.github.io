-- 0078 — a gallery on past Sahaba Club Hub events
-- ============================================================
--
-- Ahmed, 22 Aug 2026: a past Hub event should carry up to 5 videos and up to
-- 20 photographs. Videos live on YouTube; photographs are uploaded to the site.
--
-- ⚠ TWO ARRAYS, NOT A MEDIA TABLE. A table would buy ordering, captions and
-- per-item metadata, and none of those were asked for. Arrays match how
-- `open_to`, `interests` and `skills` already work here, they keep their own
-- order, and the caps become CHECK constraints instead of application code. If
-- captions or per-photo credits are ever wanted, that is the moment to
-- normalise — not before.
--
-- ⚠ THE CAPS ARE ENFORCED IN THE DATABASE, not just in the admin form. A limit
-- that lives only in a form is a limit until somebody uses the API, and this
-- one has a real cost behind it: twenty full-size photographs on one page is
-- already a lot to send to a phone.
--
-- ⚠ WHAT THIS MIGRATION DOES NOT DO: it does not restrict these columns to Hub
-- events. Postgres cannot express "only if this event has a sahaba-club or
-- partner organiser" as a CHECK — the organiser lives across a join table, and
-- a trigger doing it would fire on every event write to enforce a rule that is
-- really about presentation. **The Hub-only rule is applied where it is
-- visible: the admin panel only offers the gallery for a Hub event, and
-- event.html only renders one.** Filling these columns on a non-Hub event
-- stores something nobody will ever see, which is wasteful but not wrong.

alter table public.events
  add column if not exists gallery_videos text[] not null default '{}',
  add column if not exists gallery_photos text[] not null default '{}';

-- ============================================================
-- Validating every element of an array
-- ============================================================
--
-- ⚠ A CHECK CONSTRAINT CANNOT CONTAIN A SUBQUERY — Postgres 0A000, which is
-- exactly how the first draft of this migration failed. An IMMUTABLE function
-- may contain one, and a CHECK may call an IMMUTABLE function, so the test
-- lives in a named function that says what it tests.
--
-- ⚠ bool_and OVER AN EMPTY ARRAY RETURNS NULL, and a CHECK treats NULL as
-- passing. That is the behaviour wanted (an empty gallery is fine) and the
-- callers below still wrap it in coalesce(..., true) so the intent is written
-- down rather than relied upon — the same shape would silently accept
-- everything if unnest ever returned no rows for a reason nobody intended.

-- The host list is deliberate. `youtu.be` and `/shorts/` are what somebody
-- actually copies out of the YouTube app, and rejecting them would send staff
-- hunting for a "proper" URL. `/embed/` is what this site builds, so a link
-- pasted back out of our own markup still validates.
create or replace function public.all_youtube_urls(urls text[])
returns boolean
language sql
immutable
as $fn$
  select bool_and(
    u ~ '^https://(www\.)?(youtube\.com/(watch\?v=|shorts/|embed/)|youtu\.be/)[A-Za-z0-9_-]{6,}'
  )
  from unnest(coalesce(urls, '{}'::text[])) as u;
$fn$;

-- Not restricted to our own storage host: the admin panel uploads into the
-- `event-images` bucket and writes back whatever public URL it is given, and
-- hard-coding that hostname would break the day the project moves or a CDN is
-- put in front of it. https is the part that matters — these become `src` on a
-- page served over https.
create or replace function public.all_https_urls(urls text[])
returns boolean
language sql
immutable
as $fn$
  select bool_and(u ~ '^https://[^[:space:]]+$')
  from unnest(coalesce(urls, '{}'::text[])) as u;
$fn$;

alter table public.events drop constraint if exists events_gallery_videos_ok;
alter table public.events add constraint events_gallery_videos_ok check (
  coalesce(array_length(gallery_videos, 1), 0) <= 5
  and coalesce(public.all_youtube_urls(gallery_videos), true)
);

alter table public.events drop constraint if exists events_gallery_photos_ok;
alter table public.events add constraint events_gallery_photos_ok check (
  coalesce(array_length(gallery_photos, 1), 0) <= 20
  and coalesce(public.all_https_urls(gallery_photos), true)
);

comment on column public.events.gallery_videos is
  'Up to 5 YouTube URLs. Rendered only on a PAST event that belongs to the '
  'Events Hub (organiser sahaba-club or a partner). 0078.';
comment on column public.events.gallery_photos is
  'Up to 20 https image URLs, uploaded by the admin panel into the '
  'event-images bucket under gallery/<event id>/. Same Hub-only, past-only '
  'rendering rule as gallery_videos. 0078.';
