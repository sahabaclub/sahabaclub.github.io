-- 0068 — a 10:00 default start time, in the event's own country's zone
-- ============================================================
--
-- Ahmed, 14 Aug: "any event with no time put the time 10:00 AM based on the
-- event country, if it is in Egypt so it will be Cairo time if Dubai it will be
-- UAE time and same for any country."
--
-- Fourteen upcoming published events had no start time, so nobody attending them
-- could get the two-hour reminder (0065). Their pages never state one and no
-- amount of parsing will invent it.
--
-- ============================================================
-- ⚠ THIS WRITES A GUESS, AND THE GUESS IS VISIBLE TO MEMBERS
-- ============================================================
--
-- Every other start time in this database was READ off the organiser's page.
-- These twelve are not: 10:00 is a policy, not a fact. An event that actually
-- begins at 18:00 will now email its attendees at 08:00 — eight hours early
-- rather than not at all.
--
-- That trade was made deliberately and explicitly by Ahmed, and it is recorded
-- here rather than buried, because the reminder does not say "approximately"
-- and the member has no way to tell a defaulted time from a measured one.
--
-- ⚠ THE HONEST FIX IS UPSTREAM: put the real time on the event. Anything set
-- here is superseded the moment somebody edits the event in Admin → Events,
-- because this migration only ever touches rows where `starts_at IS NULL`.
--
-- ⚠ PAST EVENTS ARE DELIBERATELY UNTOUCHED — 34 of them. No reminder can fire
-- for an event that has happened, so writing an invented start time onto the
-- archive would falsify the record and buy nothing.

-- ============================================================
-- 1. First, the two that DID state a time — they are not defaults
-- ============================================================
--
-- Both were in the "no start time" set only because their `time_label` was
-- never machine-parsed, not because the page is silent. Defaulting them to
-- 10:00 would have put the reminder in flat contradiction with the event's own
-- page, which is the failure this whole feature has been avoiding all week.
--
-- ⚠ RUN BEFORE §2. §2 matches on `starts_at is null`, so these must be filled
-- first or they get 10:00 like everything else.

update public.events
   set start_time_local = '18:30',   -- label: "6:30 PM – 9:00 PM"
       time_zone        = 'Asia/Dubai'
 where slug = 'next-gulf-2026'
   and starts_at is null;

update public.events
   set start_time_local = '09:00',   -- label: "9:00 AM Feb 1 - 6:00 PM Feb 3 (GST)"
       time_zone        = 'Asia/Dubai'
 where slug = '3rd-international-conference-on-artificial-intelligence-and-data-science-2027'
   and starts_at is null;

-- ============================================================
-- 2. The default: 10:00, in the country's own zone
-- ============================================================
--
-- ⚠ The map is wider than the four countries currently present (UAE 9, Saudi
-- Arabia 3, Egypt 1, and one with no country at all). The extra rows cost
-- nothing and mean this is still correct if it is ever re-run against a
-- database that has grown — which is the point of a migration.
--
-- ⚠ THE FALLBACK IS THE CLUB'S OWN ZONE, NOT UTC. An unrecognised or absent
-- country lands on Asia/Dubai: the club is UAE-based and most of its events
-- are, so it is the least-wrong default. UTC would be wrong for every single
-- event in this database.
--
-- ⚠ `starts_at` is NOT written here. It is derived by 0066's trigger from
-- event_date + start_time_local + time_zone, which is what keeps one piece of
-- time-zone arithmetic in one place.

update public.events
   set start_time_local = '10:00',
       time_zone = case lower(trim(coalesce(country, '')))
         when 'uae'                  then 'Asia/Dubai'
         when 'united arab emirates' then 'Asia/Dubai'
         when 'dubai'                then 'Asia/Dubai'
         when 'abu dhabi'            then 'Asia/Dubai'
         when 'saudi arabia'         then 'Asia/Riyadh'
         when 'ksa'                  then 'Asia/Riyadh'
         when 'egypt'                then 'Africa/Cairo'
         when 'qatar'                then 'Asia/Qatar'
         when 'kuwait'               then 'Asia/Kuwait'
         when 'bahrain'              then 'Asia/Bahrain'
         when 'oman'                 then 'Asia/Muscat'
         when 'jordan'               then 'Asia/Amman'
         when 'lebanon'              then 'Asia/Beirut'
         when 'iraq'                 then 'Asia/Baghdad'
         when 'morocco'              then 'Africa/Casablanca'
         when 'tunisia'              then 'Africa/Tunis'
         when 'algeria'              then 'Africa/Algiers'
         when 'libya'                then 'Africa/Tripoli'
         when 'sudan'                then 'Africa/Khartoum'
         when 'turkey'               then 'Europe/Istanbul'
         when 'india'                then 'Asia/Kolkata'
         when 'pakistan'             then 'Asia/Karachi'
         when 'uk'                   then 'Europe/London'
         when 'united kingdom'       then 'Europe/London'
         -- ⚠ NO 'usa' ROW ON PURPOSE. The United States spans six zones and a
         -- country name cannot choose between them; such an event falls to the
         -- club's zone below and needs a human. Guessing Eastern would be
         -- three hours wrong for a third of the country.
         else 'Asia/Dubai'
       end
 where is_published
   and event_date >= current_date
   and starts_at is null;

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. Nothing upcoming is left without a start time (expect 0):
--
--   select count(*) from public.events
--    where is_published and event_date >= current_date and starts_at is null;
--
-- 2. ⚠ THE ONE THAT CATCHES A BAD MAP — every defaulted event reads back as
--    10:00 in a plausible zone, and the two exceptions keep their real times
--    (expect NEXT Gulf 6:30 PM and the conference 9:00 AM):
--
--   select to_char(starts_at at time zone time_zone, 'FMHH12:MI AM') as reads_as,
--          time_zone, country, left(title, 40) as event
--     from public.events
--    where is_published and event_date >= current_date
--    order by starts_at;
--
-- 3. No past event was touched (expect the same 34 as before):
--
--   select count(*) from public.events
--    where is_published and event_date < current_date and starts_at is null;
--
-- 4. ⚠ WHICH REMINDERS THIS ACTUALLY CREATES. A defaulted time on an event
--    somebody has marked themselves going to is a real email at a made-up hour
--    — this is the list worth reading before believing the job is done:
--
--   select to_char(e.starts_at at time zone e.time_zone, 'FMHH12:MI AM') as reads_as,
--          e.time_label, left(e.title, 40) as event, count(*) as going
--     from public.events e
--     join public.event_registrations reg
--       on reg.event_id = e.id and reg.status = 'registered'
--    where e.is_published and e.starts_at > now()
--    group by e.title, e.starts_at, e.time_zone, e.time_label
--    order by min(e.starts_at);
