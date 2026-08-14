-- 0070 — real start times, for the four whose pages actually state one
-- ============================================================
--
-- 0068 gave fourteen events a 10:00 default, and its own header called that
-- what it is: a policy, not a fact. Ahmed, 14 Aug: fill in the real times.
--
-- Two of the fourteen never needed it — LEAP 2026 ("10:00 AM - 8:00 PM") and
-- The Arabian AI & Agentic Summit ("10:00 - 16:00") were read off their pages
-- and genuinely start at 10:00. That left twelve guesses.
--
-- Each page was fetched and read. **Four state a start time. Eight do not.**
-- Only the four are changed here, and each one names its evidence — because a
-- start time nobody can point at a source for is the 10:00 default wearing a
-- better disguise.
--
-- ⚠ THE EIGHT WITH NO EVIDENCE ARE LEFT ON 10:00, DELIBERATELY: Ai Everything
-- Abu Dhabi, AINext Awards Dubai, Microsoft Ignite, GITEX GLOBAL, the 12th
-- International Conference on AI, ARC 2027, Global AI Show Riyadh 2027, and
-- Ai Everything MEA Egypt. Their pages publish dates and no hours. Guessing a
-- plausible conference start would remove the one signal that these are
-- unverified — they would look exactly like the four below.
--
-- ⚠ **GITEX GLOBAL HAS SOMEBODY GOING AND IS STILL A GUESS.** Its schema.org
-- block carries `"startDate":"2026-12-7"` — a DATE with no time — and the only
-- hour on the page ("Tuesday - 14 Oct, 9 - 9.30 AM") belongs to a previous
-- edition, five days off our own date. It is the one row here worth a human
-- asking the organiser.

-- ============================================================
-- 1. Global AI Summit (GAIN) 2026 — schema.org on the event page
-- ============================================================
-- "startDate":"2026-09-15T09:00:00:00+03:00"  (sic — the site emits a
-- malformed offset with an extra ":00", but the hour and the +03:00 are
-- unambiguous, and +03:00 is Riyadh, which is already this row's zone).

update public.events
   set start_time_local = '09:00'
 where slug = 'global-ai-summit-gain-2026-2026'
   and start_time_local = time '10:00';

-- ============================================================
-- 2. Black Hat MEA 2026 — schema.org on the event page
-- ============================================================
-- "startDate":"2026-12-01T09:00:00:00+03:00"  — same source, same shape.

update public.events
   set start_time_local = '09:00'
 where slug = 'black-hat-mea-2026-2026'
   and start_time_local = time '10:00';

-- ============================================================
-- 3 + 4. Dubai AI Festival — the published agenda
-- ============================================================
--
-- The landing page states no time; the agenda page does. 58 session times were
-- parsed from it and sorted: the day runs **09:30 to 17:20**, so 09:30 is the
-- first thing that happens.
--
-- ⚠ THIS IS THE FIRST SESSION, NOT NECESSARILY THE DOOR TIME. Registration at a
-- show like this usually opens earlier, so a member reminded two hours before
-- 09:30 is reminded in good time either way. It is evidence rather than a
-- guess, which is the standard this file is holding to — but it is worth
-- knowing which kind of evidence it is.
--
-- ⚠ TWO ROWS, ONE FESTIVAL. `dubai-ai-festival-2026-2026` and
-- `dubai-ai-festival-2026` are duplicates of the same 26–27 Oct event, and one
-- of them has a member marked as going. They are both corrected rather than one
-- — a member holding the other row would otherwise be reminded an hour early.
-- ⚠ The duplication itself is not fixed here; merging two published events is a
-- separate decision with a slug and a registration hanging off it.

update public.events
   set start_time_local = '09:30'
 where slug in ('dubai-ai-festival-2026-2026', 'dubai-ai-festival-2026')
   and start_time_local = time '10:00';

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. The four moved and read back as their sources say (expect 9:00 AM Riyadh
--    twice and 9:30 AM Dubai twice):
--
--   select left(title, 40) as event,
--          to_char(starts_at at time zone time_zone, 'FMHH12:MI AM') as reads_as,
--          time_zone, event_date
--     from public.events
--    where slug in ('global-ai-summit-gain-2026-2026','black-hat-mea-2026-2026',
--                   'dubai-ai-festival-2026-2026','dubai-ai-festival-2026')
--    order by event_date;
--
-- 2. ⚠ WHAT IS STILL A GUESS. Eight rows, and this is the list to work through
--    with an organiser rather than a fetch:
--
--   select left(e.title, 44) as event, e.event_date, e.country,
--          count(reg.*) filter (where reg.status = 'registered') as going
--     from public.events e
--     left join public.event_registrations reg on reg.event_id = e.id
--    where e.is_published and e.event_date >= current_date
--      and e.start_time_local = time '10:00'
--    group by e.title, e.event_date, e.country
--    order by going desc, e.event_date;
--
--    ⚠ LEAP 2026 and The Arabian AI & Agentic Summit will appear in that list
--    and are NOT guesses — their pages really do say 10:00. Do not "fix" them.
--
-- 3. Nothing else moved (expect 49 of 49 upcoming events still to have a start
--    time, exactly as 0068 left it):
--
--   select count(*) filter (where starts_at is not null) as ready,
--          count(*) filter (where starts_at is null)     as still_missing
--     from public.events where is_published and event_date >= current_date;
