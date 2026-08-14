-- 0071 — GITEX GLOBAL starts at 11:00, on Ahmed's word
-- ============================================================
--
-- 0070 left GITEX on the 10:00 policy default and flagged it as the one row
-- where a guess reached a real person: a member is marked going, and the site
-- publishes no start time. Its schema.org carries `"startDate":"2026-12-7"` —
-- a date with no hour — and the only time on the page belongs to a previous
-- edition, five days off our own date.
--
-- Ahmed, 14 Aug: **11:00 AM**. Asked and answered, which is exactly what 0070
-- said this row needed.
--
-- ⚠ THE SOURCE IS AHMED, NOT THE PAGE, and that is worth recording rather than
-- blurring. 0070 ranked its evidence — schema.org above a published agenda —
-- because a later reader has to be able to tell how much to trust each row. A
-- person who runs the club's events programme knowing the show's opening hours
-- is a *better* source than either; it simply is not one anybody can re-derive
-- by fetching the page, so a future sweep looking for unsourced times must not
-- treat this as one of them.
--
-- ⚠ Not a whole-conference claim. GITEX runs 7–11 Dec; this is the start of the
-- day our row is dated, which is the only day the reminder fires for.

update public.events
   set start_time_local = '11:00'
 where slug = 'gitex-global-2026'
   and start_time_local = time '10:00';

-- ⚠ `starts_at` is derived by 0066's trigger — expect 2026-12-07T07:00:00+00
-- (11:00 Dubai, UTC+4). Not written here.

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. It reads back as 11:00 AM Dubai, and its attendee is reminded at 09:00:
--
--   select to_char(starts_at at time zone time_zone, 'FMHH12:MI AM') as reads_as,
--          starts_at, starts_at - interval '2 hours' as reminder_fires_about,
--          time_zone
--     from public.events where slug = 'gitex-global-2026';
--
-- 2. Seven events remain on the policy default, none of them with anybody
--    going (GITEX was the last one that had):
--
--   select left(e.title, 44) as event, e.event_date,
--          count(reg.*) filter (where reg.status = 'registered') as going
--     from public.events e
--     left join public.event_registrations reg on reg.event_id = e.id
--    where e.is_published and e.event_date >= current_date
--      and e.start_time_local = time '10:00'
--    group by e.title, e.event_date
--    order by going desc, e.event_date;
--
--    ⚠ LEAP 2026 and The Arabian AI & Agentic Summit appear there and are NOT
--    defaults — their own pages say 10:00. Do not "fix" them.
