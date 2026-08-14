-- 0072 — the one event that arrived without a start time
-- ============================================================
--
-- "How to Use AI to Build Your Personal Brand in 2026" (4 Sep 2026) was added on
-- **14 Aug at 10:03Z — after 0068 had filled every other event in** — carrying
-- `time_label` = "1:00 AM" and an empty `start_time_local`. The page states a
-- time; the admin form's **Starts at** field was left blank.
--
-- Measured off the organiser's page rather than trusting the label:
--
--     "startDate":"2026-09-04T01:00:00+03:00"      "timezone":"Africa/Cairo"
--
-- +03:00 is Cairo in September, and the hour matches the label exactly. This is
-- the strongest grade of evidence this project has been using — schema.org on
-- the event's own page — so 01:00 Africa/Cairo it is.
--
-- ⚠ 1 AM IS NOT A TYPO. Half the Egyptian Meetup listings in this database run
-- through the small hours: they are "Global" editions timed for a US audience
-- and displayed in Cairo time. 0069 fixed the opposite mistake (3 AM that should
-- have been 3 PM), so the instinct to "correct" this one is exactly the instinct
-- to resist — the page says 01:00 and so does the label.
--
-- ⚠⚠ THE ROW IS THE SMALL PART. The reason it existed is that nothing stops an
-- event being saved with a stated hour and no machine-readable time, and that is
-- fixed in the same commit as this migration — `app/admin/events.html` now
-- interrupts the save. Backfilling rows one at a time is not a strategy; the
-- count creeps back up every time somebody adds an event in a hurry.

update public.events
   set start_time_local = '01:00',
       time_zone        = 'Africa/Cairo'
 where slug = 'how-to-use-ai-to-build-your-personal-brand-in-2026-2026'
   and starts_at is null;

-- ⚠ `starts_at` is derived by 0066's trigger — expect 2026-09-03T22:00:00+00
-- (01:00 Cairo on the 4th is 22:00 UTC on the 3rd). Not written here.

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. It reads back as its own page does (expect 1:00 AM Cairo, 22:00Z on 3 Sep):
--
--   select to_char(starts_at at time zone time_zone, 'FMHH12:MI AM') as reads_as,
--          start_time_local, time_zone, starts_at, time_label
--     from public.events
--    where slug = 'how-to-use-ai-to-build-your-personal-brand-in-2026-2026';
--
-- 2. ⚠ THE ONE TO RUN PERIODICALLY — every upcoming event now has a start time,
--    and this is the query that catches the next one that does not. It is NOT
--    covered by tools/check-event-reminders.mjs, which only fails when NO event
--    has one; a single blank among fifty passes it cleanly:
--
--   select left(title, 44) as event, event_date, time_label
--     from public.events
--    where is_published and event_date >= current_date and starts_at is null;
--
-- 3. And the sharper version of the same question — a stated hour with no
--    machine-readable time, which is what the admin form now interrupts:
--
--   select left(title, 44) as event, event_date, time_label
--     from public.events
--    where is_published and event_date >= current_date
--      and start_time_local is null
--      and time_label ~ '[0-9]\s*[:.]\s*[0-9]';
