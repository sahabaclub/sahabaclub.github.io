-- 0050 — give the Organizer filter something to filter on
-- ============================================================
--
-- The Organizer filter shipped on the events page and returns nothing for
-- every bucket, because only the 17 archived events have organizers linked
-- and all of those are in the past. The upcoming list — the one the filter is
-- attached to — has none at all.
--
-- ⚠ THIS LINKS ONLY WHAT CAN BE KNOWN FROM THE REGISTRATION LINK ITSELF.
--
-- Of the 24 upcoming events, 13 are listed on luma.com, meetup.com or
-- allevents.in. Those are TICKETING platforms: anyone can list anything on
-- them, and the real organizer's name exists only on the listing page. They
-- are deliberately left unlinked. Inventing "Luma" as an organizer would be
-- worse than an empty answer, and guessing a community's name from an event
-- title would put words in somebody else's mouth.
--
-- What IS knowable: an event hosted on its own domain is run by that brand.
-- gitex.com is GITEX. dubaiaifestival.com is the Dubai AI Festival. That is
-- not an inference, it is what the domain means.
--
-- The matching is declarative — a host-to-organizer table joined against
-- `register_link` — rather than a generated list of event ids. It reads as the
-- rule it implements, it is re-runnable, and it will pick up new events on
-- those same domains without anybody regenerating anything.

-- ============================================================
-- 1. The organizers these events actually belong to
-- ============================================================
--
-- Categories, and why:
--   * The independent commercial conferences are 'Others'. None of the six
--     buckets describes them and a seventh would break the filter Ahmed
--     specified — 0048's CHECK constraint refuses one anyway.
--   * AI Tinkerers Dubai is 'Community': it is a chapter meetup, run on its
--     own domain rather than through meetup.com, which is the only reason its
--     name is knowable here at all.
--   * is_partner is FALSE for all of these. A partner is somebody the club
--     works with, not everyone whose event is listed. GITEX does not know
--     Sahaba Club exists. Marking them partners would put their logos in the
--     "Our partners" section on the hub page, which would be a false claim
--     about a relationship.

insert into public.organizers (name, slug, category, is_partner, sort_order, website) values
  ('Ai Everything',                 'ai-everything',              'Others',    false, 50, 'https://aieverythingabudhabi.com'),
  ('Dubai AI Festival',             'dubai-ai-festival',          'Others',    false, 51, 'https://dubaiaifestival.com'),
  ('Global AI Show',                'global-ai-show',             'Others',    false, 52, 'https://globalaishow.com'),
  ('World AI Technology Expo',      'world-ai-technology-expo',   'Others',    false, 53, 'https://worldaiexpo.io'),
  ('Digital Transformation Summit', 'digital-transformation-summit', 'Others', false, 54, 'https://digitransformationsummit.com'),
  ('The Arabian AI & Agentic Summit','arabian-ai-agentic-summit', 'Others',    false, 55, 'https://thearabianchatbot.com'),
  ('AI Tinkerers Dubai',            'ai-tinkerers-dubai',         'Community', false, 56, 'https://dubai.aitinkerers.org')
on conflict (slug) do update set
  category = excluded.category,
  website  = coalesce(public.organizers.website, excluded.website);

-- ============================================================
-- 2. Link them, by what the registration link says
-- ============================================================
--
-- ⚠ `on conflict do nothing` matters: this is re-runnable, and an event that
-- already has this organizer must not error or duplicate.
--
-- ⚠ Only hosts where the DOMAIN IDENTIFIES THE ORGANIZER appear here. Adding
-- luma.com or meetup.com to this table would be the bug this migration exists
-- to avoid.

with mapping (host, org_slug) as (values
  ('aieverythingabudhabi.com',      'ai-everything'),
  ('dubaiaifestival.com',           'dubai-ai-festival'),
  ('globalaishow.com',              'global-ai-show'),
  ('worldaiexpo.io',                'world-ai-technology-expo'),
  ('digitransformationsummit.com',  'digital-transformation-summit'),
  ('thearabianchatbot.com',         'arabian-ai-agentic-summit'),
  ('dubai.aitinkerers.org',         'ai-tinkerers-dubai'),
  ('gitex.com',                     'gitex'),
  ('expertslive.ae',                'expertslive'),
  ('msevents.microsoft.com',        'microsoft'),
  ('events.teams.microsoft.com',    'microsoft')
)
insert into public.event_organizers (event_id, organizer_id, is_lead)
select e.id, o.id, true
  from public.events e
  join mapping m
    on e.register_link ilike 'https://' || m.host || '/%'
    or e.register_link ilike 'https://www.' || m.host || '/%'
    or e.register_link ilike 'https://' || m.host
    or e.register_link ilike 'https://www.' || m.host
  join public.organizers o on o.slug = m.org_slug
on conflict do nothing;

-- The AWS Summit is the one event whose organizer is named in its TITLE while
-- its link points at a ticketing site (eventbrowse.com). Matched on the title
-- rather than the host, and narrowly — an ILIKE on '%aws%' would also catch a
-- community meetup that happens to mention AWS.
insert into public.event_organizers (event_id, organizer_id, is_lead)
select e.id, o.id, true
  from public.events e, public.organizers o
 where o.slug = 'aws'
   and e.title ilike 'AWS Summit%'
on conflict do nothing;

-- Anything the `brand` column already asserted. It is set on 10 events, all
-- 'microsoft', and predates the organizers table — this is where that older
-- answer gets carried into the new model rather than being quietly dropped.
insert into public.event_organizers (event_id, organizer_id, is_lead)
select e.id, o.id, true
  from public.events e, public.organizers o
 where o.slug = 'microsoft'
   and e.brand = 'microsoft'
on conflict do nothing;

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. How much of the UPCOMING list the filter can now answer for. The
--    unlinked remainder is the luma/meetup/allevents set, and is expected:
--
--   select
--     count(*) filter (where exists (select 1 from public.event_organizers eo where eo.event_id = e.id)) as linked,
--     count(*) filter (where not exists (select 1 from public.event_organizers eo where eo.event_id = e.id)) as unlinked,
--     count(*) as upcoming
--   from public.events e
--   where e.is_published and e.event_date >= current_date;
--
-- 2. What each filter bucket will now return on the upcoming list. Every one
--    of the six should be a number you can explain:
--
--   select o.category, count(distinct e.id) as upcoming_events
--     from public.events e
--     join public.event_organizers eo on eo.event_id = e.id
--     join public.organizers o on o.id = eo.organizer_id
--    where e.is_published and e.event_date >= current_date
--    group by o.category order by 2 desc;
--
-- 3. ⚠ Nobody was made a partner by this migration. The "Our partners"
--    section on events-hub.html must not have grown — GITEX and the
--    conferences are listed, not partnered (expect the same 7 as before):
--
--   select name, category from public.organizers where is_partner order by sort_order;
--
-- 4. Which upcoming events still have no organizer, and why — this is the
--    to-do list for whoever opens the listings and reads the real names:
--
--   select e.title, e.register_link
--     from public.events e
--    where e.is_published and e.event_date >= current_date
--      and not exists (select 1 from public.event_organizers eo where eo.event_id = e.id)
--    order by e.event_date;
--
-- 5. No event gained a duplicate organizer link (expect zero rows):
--
--   select event_id, organizer_id, count(*) from public.event_organizers
--    group by 1, 2 having count(*) > 1;
