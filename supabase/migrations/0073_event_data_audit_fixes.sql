-- 0073 — the fixes from the 19 Aug event audit
-- ============================================================
-- An audit of all 133 published events (70 upcoming) found the data in good
-- shape on everything that used to be broken: zero missing start times, images,
-- register links, venues or prices. What remained was concentrated in three
-- places, and this migration closes two of them.
--
-- ⚠ WHAT THIS DELIBERATELY DOES NOT DO: it deletes nothing. Duplicates are
-- UNPUBLISHED, not removed. `event_registrations`, `event_favourites` and
-- `event_views` all reference `events (id) ON DELETE CASCADE`, so a DELETE here
-- would silently take a member's registration with it. Measured before writing
-- this: both Dubai AI Festival copies carry a live registration and a view.

-- ============================================================
-- 1. Five events whose stored zone contradicts their country
-- ============================================================
-- These are the ones that matter most, because they are the input to the
-- two-hour reminder. `starts_at` is derived from (event_date, start_time_local,
-- time_zone) by the trigger in 0066, so a wrong zone is not cosmetic: it moves
-- the instant the reminder fires, and nothing on the page shows the zone, so it
-- is invisible to a human reading the event.
--
-- Riyadh is UTC+3 and Dubai is UTC+4, so a Saudi event stored as Asia/Dubai
-- reminds an hour LATE. Cairo against Dubai is two hours; against bare UTC the
-- Databricks session was three hours out in the other direction.
--
-- ⚠ start_time_local is NOT touched. The local wall-clock time is what the
-- source page stated and what time_label prints; only the zone it is read in
-- was wrong.

update public.events set time_zone = 'Africa/Cairo'
 where slug = 'gtm-at-the-speed-of-code-2026' and country = 'Egypt';

update public.events set time_zone = 'Africa/Cairo'
 where slug like 'databricks-build-a-practical-data-foundation%' and country = 'Egypt';

update public.events set time_zone = 'Asia/Riyadh'
 where country = 'Saudi Arabia' and time_zone = 'Asia/Dubai';

-- ============================================================
-- 2. Three duplicate listings, unpublished (not deleted)
-- ============================================================
-- Each pair shares a date, a start time, a venue AND a register link — the same
-- event imported twice under slightly different titles. The copy kept is the one
-- with the better slug; where the discarded copy had the fuller venue string,
-- that string is copied onto the keeper first so nothing is lost.

-- 19 Aug — Connected Banking Summit. ⚠ THIS ONE IS TRIPLED, NOT DOUBLED.
-- The row titled "DIGEST" is not a placeholder for some other event: it carries
-- the same date, the same 08:00 start, the same Fairmont Nile City venue and the
-- same register link as the other two. It is the same Cairo summit imported a
-- third time with a broken title, and all three went out in the 19 Aug brief.
--
-- Found only because the duplicate check keys on (date + register_link) rather
-- than on the title — "27th Connected Banking Summit", "Connected Banking
-- Summit 2026" and "DIGEST" share no words at all.
--
-- Keep the "27th …" title: it is the most informative of the three.
update public.events set is_published = false
 where slug in ('connected-banking-summit-north-africa-egypt-2026-2026',
                'digest-2026');

-- 17 Nov — World AI Technology Expo. Neither copy has member data.
-- Keep the "… Dubai" row: it carries the fuller venue.
update public.events set is_published = false
 where slug = 'world-ai-technology-expo-2026';

-- 26 Oct — Dubai AI Festival. ⚠ BOTH COPIES CARRY A REGISTRATION AND A VIEW.
-- Keep the clean slug, give it the fuller venue from the copy being retired,
-- and move the retired copy's registrations across so the member who signed up
-- on the wrong one still sees it under "I'm going".
update public.events
   set location = 'Dubai World Trade Centre (DWTC), Dubai'
 where slug = 'dubai-ai-festival-2026';

-- ⚠ ON CONFLICT DO NOTHING is load-bearing. If the SAME member registered on
-- both copies, moving the row would violate the unique pair and abort the whole
-- migration. Skipping is correct in that case: they already hold a registration
-- on the keeper, so nothing is lost by leaving the duplicate behind.
update public.event_registrations r
   set event_id = (select id from public.events where slug = 'dubai-ai-festival-2026')
 where r.event_id = (select id from public.events where slug = 'dubai-ai-festival-2026-2026')
   and not exists (
     select 1 from public.event_registrations x
      where x.user_id = r.user_id
        and x.event_id = (select id from public.events where slug = 'dubai-ai-festival-2026')
   );

update public.events set is_published = false
 where slug = 'dubai-ai-festival-2026-2026';

-- ============================================================
-- 3. A past event still holding a featured slot
-- ============================================================
update public.events set is_featured = false
 where slug like 'heygen-ambassador-spotlight%' and event_date < current_date;

-- ============================================================
-- 4. Three rows where `country` holds something that is not a country
-- ============================================================
-- Two say 'Online', which is the mode, not a place. One says 'Africa/Cairo',
-- which is a timezone. The 18 other online events have country NULL, which is
-- the correct representation, so these are brought into line with that.
update public.events set country = null
 where country = 'Online';

update public.events set country = 'Egypt'
 where country = 'Africa/Cairo';

-- ============================================================
-- ⚠ LEFT ALONE ON PURPOSE — two judgement calls that are Ahmed's
-- ============================================================
--
-- 1. 28 Oct, Riyadh: "15th Middle East Enterprise AI & Analytics Summit" and
--    "Middle East Banking AI & Analytics Summit" share a date, a start time, a
--    venue and a register link — but Enterprise and Banking are a real semantic
--    difference, and these venues do host co-located tracks. Neither copy has
--    member data, so nothing is at risk either way. Somebody has to look.
--
-- 2. 14 Sep, UNESCO Global Forum: time_label says "10:00 AM - 6:00 PM" and
--    start_time_local says 11:00. The member reads the label; the reminder
--    counts from the column. One is wrong and the source page decides which —
--    guessing would just move the error somewhere less visible.
--
-- ============================================================
-- VERIFY — run these after applying. "Success. No rows returned" from the
-- statements above proves nothing on its own.
-- ============================================================
--
--   -- zones now agree with their country (expect 0 rows):
--   select slug, country, time_zone from public.events
--    where event_date >= current_date and is_published
--      and ((country = 'Saudi Arabia' and time_zone <> 'Asia/Riyadh')
--        or (country = 'Egypt' and time_zone <> 'Africa/Cairo')
--        or (country = 'United Arab Emirates' and time_zone <> 'Asia/Dubai'));
--
--   -- the three retired duplicates are hidden (expect 3 rows, all false):
--   select slug, is_published from public.events
--    where slug in ('connected-banking-summit-north-africa-egypt-2026-2026',
--                   'world-ai-technology-expo-2026','dubai-ai-festival-2026-2026');
--
--   -- ⚠ THE ONE THAT MATTERS: no member lost a registration (expect 0):
--   select count(*) from public.event_registrations r
--     join public.events e on e.id = r.event_id
--    where e.is_published = false and e.event_date >= current_date;
--
--   -- nothing is featured in the past (expect 0 rows):
--   select slug from public.events
--    where is_featured and event_date < current_date;
