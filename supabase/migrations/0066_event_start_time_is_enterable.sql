-- 0066 — staff can finally set an event's start time
-- ============================================================
--
-- 0045 added `events.starts_at` and the reminder sweeps have fired on it ever
-- since. **Nothing has ever written it.** Not `app/admin/events.html`, not the
-- `import-event` AI importer. Measured 13 Aug 2026: 39 upcoming published
-- events, 0 with a start time — so 0065's two-hour reminder is correct code
-- that can never fire.
--
-- This is the other half: a way to put a value in.
--
-- ============================================================
-- ⚠ WHY NOT JUST A `datetime-local` BOX ON THE FORM
-- ============================================================
--
-- Because `starts_at` is a timestamptz — an INSTANT — and "7:00 PM" is not one
-- until you say where. The upcoming list spans the UAE and Egypt, two zones
-- that differ by two hours. A form that posted a browser-local instant would
-- stamp events with whatever zone the staff member's laptop happened to be in,
-- which is a bug that only shows up when somebody travels, and shows up as
-- members being told the wrong hour.
--
-- So staff enter what they actually know — a LOCAL clock time and the place it
-- refers to — and the database computes the instant. Three columns, one of
-- which is derived and must never be typed into:
--
--   event_date        date       (already existed)
--   start_time_local  time       what the poster says: 19:00
--   time_zone         text       IANA name: 'Asia/Dubai'
--   starts_at         timestamptz  DERIVED. Trigger only.
--
-- ⚠ `time_label` STAYS AND IS STILL THE DISPLAY STRING. It is free text shown
-- exactly as typed ("8:00 AM onwards", "6:00 PM – 8:00 PM") and 39 events rely
-- on it. This does not replace it and must not: a range and an onwards are
-- things a start instant cannot express, and the events list shows the label.
-- The new fields are for machines, the label is for people.

-- ============================================================
-- 1. The two enterable columns
-- ============================================================

alter table public.events
  add column if not exists start_time_local time,
  -- Defaulting to the club's own zone rather than leaving it null: the
  -- overwhelming majority of these events are UAE, and a default that is right
  -- most of the time and visible on the form beats a required field that gets
  -- filled with whatever dismisses the error.
  add column if not exists time_zone text not null default 'Asia/Dubai';

comment on column public.events.start_time_local is
  'The local clock time on the poster, e.g. 19:00. Combined with event_date '
  'and time_zone by the trigger below to produce starts_at. Null means the '
  'start time is unknown and no reminder can fire.';

comment on column public.events.time_zone is
  'IANA zone the start_time_local is expressed in, e.g. Asia/Dubai, '
  'Africa/Cairo. Validated by the trigger — an unknown name is rejected '
  'rather than silently treated as UTC.';

comment on column public.events.starts_at is
  'DERIVED — set only by events_set_starts_at(). Do not write it directly; '
  'any value assigned is overwritten. Set start_time_local and time_zone '
  'instead. Null whenever start_time_local is null.';

-- ============================================================
-- 2. One place that computes the instant
-- ============================================================
--
-- ⚠ A TRIGGER RATHER THAN THE CLIENT DOING THE ARITHMETIC. Two callers already
-- write events — the admin form and `import-event` — and a third (a CSV import,
-- a backfill script) is the obvious next one. Time-zone arithmetic done in
-- three places is time-zone arithmetic that disagrees in three places, and the
-- disagreement is invisible until a member arrives two hours late.
--
-- ⚠ It is also what makes `starts_at` impossible to get wrong by hand: the
-- column is derived, so a well-meaning UPDATE that sets it directly is
-- overwritten rather than quietly believed.

create or replace function public.events_set_starts_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- An unknown zone name must not fall through to UTC. Postgres would raise on
  -- the conversion below anyway, but the message names the column and the bad
  -- value, which is the difference between a fixable error on the form and
  -- "invalid input syntax" in a console nobody is reading.
  if new.time_zone is null or new.time_zone = '' then
    new.time_zone := 'Asia/Dubai';
  elsif not exists (select 1 from pg_timezone_names where name = new.time_zone) then
    raise exception 'events.time_zone: % is not a known IANA time zone', new.time_zone
      using hint = 'Use a name such as Asia/Dubai or Africa/Cairo.';
  end if;

  if new.event_date is null or new.start_time_local is null then
    -- ⚠ Cleared, not left alone. Removing the time must remove the instant, or
    -- an event whose time was deleted keeps reminding people at the old hour.
    new.starts_at := null;
  else
    new.starts_at := (new.event_date + new.start_time_local) at time zone new.time_zone;
  end if;

  return new;
end;
$$;

drop trigger if exists events_set_starts_at_trg on public.events;
create trigger events_set_starts_at_trg
  before insert or update of event_date, start_time_local, time_zone, starts_at
  on public.events
  for each row
  execute function public.events_set_starts_at();

-- ⚠ Nothing is backfilled here, deliberately. `time_label` is free text and the
-- events are not all in one country, so parsing it would guess an hour and a
-- zone at the same time. Staff fill these in on the form; 0065's header and
-- SETUP.md §8 both say so.

-- ============================================================
-- 3. No new grants, and that is checked rather than assumed
-- ============================================================
--
-- `events` grants are TABLE-level (0012 revokes writes from anon and nothing
-- has ever granted per-column), so both new columns inherit exactly what the
-- table already allows: anon reads, staff write through the existing RLS
-- policies. Nothing to add.
--
-- ⚠ This is the one place a column addition CAN leak: had the original grants
-- been column-scoped, new columns would be unreadable rather than over-shared —
-- the opposite failure, and equally silent. Verification 3 measures it instead
-- of trusting this paragraph.

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. The derivation works, in both zones, and is not UTC:
--
--   begin;
--   insert into public.events (title, slug, event_date, start_time_local, time_zone, is_published)
--   values ('tz probe dubai','tz-probe-dubai','2026-08-20','19:00','Asia/Dubai', false),
--          ('tz probe cairo','tz-probe-cairo','2026-08-20','19:00','Africa/Cairo', false);
--   select slug, start_time_local, time_zone, starts_at,
--          starts_at at time zone 'UTC' as utc_instant
--     from public.events where slug like 'tz-probe-%';
--   -- Expect Dubai 15:00Z and Cairo 16:00Z (or 17:00Z under DST) — DIFFERENT
--   -- instants for the same wall clock. If they are equal, the zone is being
--   -- ignored and every reminder outside the UAE will be wrong.
--   rollback;
--
-- 2. `starts_at` cannot be written by hand (expect it to come back derived,
--    NOT the year 2000):
--
--   begin;
--   insert into public.events (title, slug, event_date, start_time_local, time_zone, starts_at, is_published)
--   values ('override probe','override-probe','2026-08-20','19:00','Asia/Dubai','2000-01-01T00:00:00Z', false);
--   select starts_at from public.events where slug = 'override-probe';
--   rollback;
--
-- 3. ⚠ The new columns are readable by anon exactly like the rest of the row,
--    and still not writable. Run the project's own checker, which asks the live
--    database as anon rather than reading policy text:
--
--   node tools/check-anon-access.mjs
--
-- 4. Clearing the time clears the instant (expect null):
--
--   begin;
--   insert into public.events (title, slug, event_date, start_time_local, is_published)
--   values ('clear probe','clear-probe','2026-08-20','19:00', false);
--   update public.events set start_time_local = null where slug = 'clear-probe';
--   select starts_at from public.events where slug = 'clear-probe';
--   rollback;
--
-- 5. How many upcoming events still have no start time — the number 0065's
--    reminder depends on, and the one to watch fall as staff fill the form in:
--
--   select count(*) filter (where starts_at is not null) as ready,
--          count(*) filter (where starts_at is null)     as still_missing
--     from public.events where is_published and event_date >= current_date;
