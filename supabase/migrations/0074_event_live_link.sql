-- 0074 — where to go when it starts
-- ============================================================
-- Until now the "Going" state on an event page was a dead end. Once a member
-- said they were going, `event.html` swapped the Register button for
-- `<span class="ev-status is-going">Going</span>` — a SPAN, with no href and
-- nothing to click. That was deliberate at the time (it stopped the page asking
-- somebody to register for something they had already confirmed) but it left
-- the one screen they return to on the day with no way to actually get in.
--
-- `live_link` is that destination, and it means one thing for both formats:
-- WHERE TO GO WHEN IT STARTS. For an online event that is the meeting URL; for
-- an in-person one it is the map or venue page.
--
-- ⚠ WHY NOT REUSE `maps_link`, WHICH ALREADY EXISTS. Measured before writing
-- this: it is set on 3 of 37 upcoming in-person events and 0 of 30 online ones.
-- Reviving a 92%-empty column would mean backfilling it anyway AND keeping two
-- fields that answer the same question differently depending on the mode.
-- `maps_link` is left alone; it is not read by this feature.

alter table public.events
  add column if not exists live_link text;

-- ⚠ THIS BECOMES AN href ON A PAGE WE SERVE, so the scheme is constrained in the
-- DATABASE and not only in the admin form. A `javascript:` URL in an href is the
-- one failure mode here that is worth a constraint rather than a code review:
-- the form can be bypassed, the column cannot.
--
-- https only, deliberately. All 67 upcoming events already carry an https
-- register_link, so nothing legitimate is excluded, and http would downgrade a
-- member from a page we serve over TLS.
alter table public.events
  drop constraint if exists events_live_link_https;

alter table public.events
  add constraint events_live_link_https
  check (live_link is null or live_link ~ '^https://[^[:space:]]+$');

comment on column public.events.live_link is
  'Where a member goes when the event starts: the meeting URL if online, the map or venue page if in person. Rendered as the href behind the "Going" state on event.html and events.html. NULL is normal and expected — the button then falls back to register_link, which every published event has. https only, enforced by events_live_link_https, because this value becomes an href on a page we serve.';

-- ============================================================
-- VERIFY — "Success. No rows returned" proves nothing on its own.
-- ============================================================
--
--   -- the column exists and is nullable (expect one row, is_nullable = YES):
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public' and table_name='events' and column_name='live_link';
--
--   -- the constraint is present (expect one row):
--   select conname from pg_constraint where conname = 'events_live_link_https';
--
--   -- ⚠ THE ONE THAT MATTERS. The constraint must actually reject a hostile
--   -- value, not merely exist. This must ERROR, and if it succeeds the check is
--   -- not doing its job:
--   --
--   --   update public.events set live_link = 'javascript:alert(1)'
--   --    where slug = (select slug from public.events limit 1);
--   --
--   -- Roll it back either way. A constraint nobody has seen refuse anything is
--   -- a constraint nobody should trust.
