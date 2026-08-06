-- 0048 — AI Events Universe: organizers, slugs, featuring, and a duplicate guard
-- ============================================================
--
-- Schema for the rebuilt events section. The pages come later; this is the
-- data they need, plus two clean-ups of what is already there.
--
-- ============================================================
-- ⚠ WHY ORGANIZER IS A TABLE AND NOT A COLUMN
-- ============================================================
--
-- The first design was a single `organizer` column holding one of six fixed
-- values. Ahmed's own back catalogue killed it: one row's organizer is
-- literally **"Microsoft & Sahaba Club"**, and three more are co-organized in
-- substance ("Sahaba Club @ GosTech - IEEE BU"; a Google DevFest session whose
-- description says "Sahaba Club's Participation ... we have joined"). A single
-- column forces a choice between two true answers, and whichever you pick, the
-- other partner disappears from their own event.
--
-- So an event has MANY organizers. Two consequences fall straight out, and
-- both were requirements:
--
--   * **"Is this our event?"** becomes "is Sahaba Club among its organizers" —
--     Ahmed's exact rule, expressible as a join rather than as a guess.
--   * **The partners section** is just `organizers where is_partner`. It is the
--     same list, seen from the other side; a separate `partners` table would
--     have meant maintaining the same logo twice.
--
-- ⚠ `name` and `category` are DIFFERENT THINGS and must not be merged.
-- `name` is who actually ran it — "AI Salone", "Azure Egypt Community",
-- "ExpertsLive", "IEEE". That is what a member should read on the event page.
-- `category` is one of the six buckets the FILTER offers. Many organizers
-- share a category: every community group is `Community`, but they are not
-- interchangeable and must not be displayed as one another.

-- ============================================================
-- 1. Who runs events
-- ============================================================

create table if not exists public.organizers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) between 1 and 120),
  slug text not null unique,

  -- The filter bucket. Exactly the six values Ahmed specified — a seventh
  -- would silently break the filter, so the constraint refuses one.
  category text not null check (category in (
    'Sahaba Club', 'Microsoft', 'AWS', 'Google', 'Community', 'Others'
  )),

  logo_url text,
  website text check (website is null or website ~ '^https?://'),
  description text check (description is null or length(description) <= 1000),

  -- Shown in the partners section on the Events Hub. Not every organizer is a
  -- partner: GITEX runs its own show and is no relationship of ours.
  is_partner boolean not null default false,
  sort_order int not null default 100,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger organizers_set_updated_at before update on public.organizers
  for each row execute procedure public.set_updated_at();

create index if not exists organizers_category_idx on public.organizers (category);
create index if not exists organizers_partner_idx on public.organizers (is_partner) where is_partner;

alter table public.organizers enable row level security;

-- Public: the events page and the partners section are both open to visitors.
drop policy if exists "organizers: public read" on public.organizers;
create policy "organizers: public read" on public.organizers for select using (true);

drop policy if exists "organizers: staff write" on public.organizers;
create policy "organizers: staff write" on public.organizers
  for all using (public.is_staff()) with check (public.is_staff());

revoke all on public.organizers from anon, authenticated;
grant select on public.organizers to anon, authenticated;

-- ---- The join ------------------------------------------------------------

create table if not exists public.event_organizers (
  event_id uuid not null references public.events (id) on delete cascade,
  organizer_id uuid not null references public.organizers (id) on delete cascade,
  -- Whose event it is FIRST, when several ran it together. Drives which logo
  -- leads on a card. Exactly one lead per event is not enforced — co-hosted
  -- events genuinely have none, and a constraint would make the honest case
  -- unrepresentable.
  is_lead boolean not null default false,
  primary key (event_id, organizer_id)
);

create index if not exists event_organizers_organizer_idx
  on public.event_organizers (organizer_id);

alter table public.event_organizers enable row level security;

drop policy if exists "event organizers: public read" on public.event_organizers;
create policy "event organizers: public read" on public.event_organizers for select using (true);

drop policy if exists "event organizers: staff write" on public.event_organizers;
create policy "event organizers: staff write" on public.event_organizers
  for all using (public.is_staff()) with check (public.is_staff());

revoke all on public.event_organizers from anon, authenticated;
grant select on public.event_organizers to anon, authenticated;

-- ============================================================
-- 2. What an event now carries
-- ============================================================

alter table public.events
  -- The shareable URL: /event.html?e=<slug>. ⚠ A slug is a PROMISE. Once a
  -- link has been sent to somebody, changing it breaks the link they hold, and
  -- nothing in this system can tell you who that was. Generated once from the
  -- title, then left alone.
  add column if not exists slug text,

  -- 16 of Ahmed's 17 archived events have a YouTube recording. On-Demand was
  -- dropped as a TAB, but the recordings themselves are the club's back
  -- catalogue and a past event should offer "watch the recording".
  add column if not exists recording_url text check (recording_url is null or recording_url ~ '^https?://'),

  add column if not exists presenter text check (presenter is null or length(presenter) <= 200),
  add column if not exists duration_minutes int check (duration_minutes is null or duration_minutes between 1 and 10080),

  -- ---- Featuring, for the Mega Events banner ----
  --
  -- ⚠ The banner is NOT a generated image, and must not become one. It is
  -- composed in HTML/CSS today from a logo plus text (see featured-events.js
  -- and .featured-card), which is why it stays sharp on every screen, reflows
  -- on a phone, and reads correctly to a screen reader. "Generate the banner"
  -- means filling in these fields; a rendered PNG would be worse in every one
  -- of those respects and impossible to restyle later.
  add column if not exists is_featured boolean not null default false,
  add column if not exists featured_logo_url text,
  -- Which panel the logo sits on. Most event wordmarks are white and need a
  -- dark tile; ones drawn in black ink need a light one. Getting this wrong
  -- makes the logo INVISIBLE, so the admin form must show both.
  add column if not exists featured_tile text check (featured_tile is null or featured_tile in ('dark','light')),
  add column if not exists featured_accent text check (featured_accent is null or featured_accent in ('violet','cyan','gold')),
  -- A figure worth shouting about, shown as a chip: "30,000 attendees".
  add column if not exists featured_scale text check (featured_scale is null or length(featured_scale) <= 60),
  add column if not exists featured_note text check (featured_note is null or length(featured_note) <= 300),
  add column if not exists featured_sort int;

comment on column public.events.slug is
  'Shareable URL key: /event.html?e=<slug>. Stable once published — changing '
  'it breaks every link already shared.';
comment on column public.events.is_featured is
  'Shows in the Mega Events banner. The banner is composed in HTML/CSS from '
  'featured_* fields plus a logo; it is not a generated image.';

create index if not exists events_featured_idx
  on public.events (featured_sort, event_date) where is_featured;

-- ============================================================
-- 3. Slugs
-- ============================================================

create or replace function public.slugify(p_text text)
returns text
language sql
immutable
as $$
  select nullif(trim(both '-' from regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g')), '');
$$;

-- ⚠ ARABIC TITLES SLUGIFY TO NOTHING. `[^a-z0-9]` strips every Arabic
-- character, so "الذكاء الصناعي في خدمتك" yields an empty string — the same
-- trap that turns Arabic names into `member@` in provision-ms365. Two of
-- Ahmed's archived events are Arabic-titled. They fall back to
-- `event-<year>`, which is unhelpful but unique, stable and never empty;
-- staff can set a better slug by hand while the event is still unshared.
-- Transliteration would be the real fix and is not built.
create or replace function public.next_event_slug(p_title text, p_date date)
returns text
language plpgsql
stable
as $$
declare
  v_stem text;
  v_slug text;
  v_n int := 1;
begin
  v_stem := coalesce(public.slugify(p_title), 'event')
            || '-' || to_char(coalesce(p_date, current_date), 'YYYY');
  v_slug := v_stem;
  while exists (select 1 from public.events where slug = v_slug) loop
    v_n := v_n + 1;
    v_slug := v_stem || '-' || v_n::text;
  end loop;
  return v_slug;
end;
$$;

create or replace function public.events_set_slug()
returns trigger
language plpgsql
as $$
begin
  if new.slug is null or trim(new.slug) = '' then
    new.slug := public.next_event_slug(new.title, new.event_date);
  end if;
  return new;
end;
$$;

drop trigger if exists events_slug_trg on public.events;
create trigger events_slug_trg
  before insert on public.events
  for each row execute procedure public.events_set_slug();

-- Backfill. Numbered in one pass rather than row-by-row, because
-- next_event_slug() reads a table this statement is still writing.
-- ⚠ `created_at` is selected in `base` ON PURPOSE, and removing it breaks
-- this. The first version omitted it and `numbered` said
-- `order by created_at` — which failed on application with
-- `42703: column "created_at" does not exist`. A CTE can only see the columns
-- the CTE before it EXPOSES, not the columns of the table that CTE read from.
-- The statement is grammatically perfect, so the SQL parse checker passed it;
-- only a real database catches scope.
with base as (
  select id,
         created_at,
         coalesce(public.slugify(title), 'event') || '-' || to_char(coalesce(event_date, current_date), 'YYYY') as stem
    from public.events
   where slug is null
),
numbered as (
  select id, stem, row_number() over (partition by stem order by created_at, id) as n
    from base
)
update public.events e
   set slug = case when n.n = 1 then n.stem else n.stem || '-' || n.n::text end
  from numbered n
 where e.id = n.id;

alter table public.events drop constraint if exists events_slug_key;
alter table public.events add constraint events_slug_key unique (slug);

-- ============================================================
-- 4. Cleaning what is already there
-- ============================================================
--
-- ⚠ Both deletions below are IRREVERSIBLE and were asked for by name. They
-- run before the duplicate guard in §5, which cannot be created while
-- duplicates exist.

-- "Thursday Advanced Badminton Games Dubai" — swept in from a meetup import
-- and not an AI event. Ahmed: "It was added by mistake, remove it".
delete from public.events
 where lower(trim(title)) = 'thursday advanced badminton games dubai';

-- The duplicated summit. Keeps the oldest row and drops later copies.
--
-- ⚠ A duplicate carrying REGISTRATIONS is deliberately NOT deleted. Deleting
-- it would cascade to event_registrations and destroy somebody's place at an
-- event, silently. If one survives, the unique index in §5 fails to build and
-- this migration stops — which is the correct outcome: a human then decides
-- which row keeps the registrations.
with ranked as (
  select id,
         row_number() over (
           partition by lower(trim(title)), event_date
           order by created_at, id
         ) as rn
    from public.events
)
delete from public.events e
 using ranked r
 where e.id = r.id
   and r.rn > 1
   and not exists (select 1 from public.event_registrations x where x.event_id = e.id);

-- Country clean-up. `country` currently holds "Online" on 14 rows — Online is
-- not a country, it is a MODE, and `mode` already records it. The country
-- filter shows in-person events only, so those rows must have no country at
-- all rather than a fake one. City-qualified values are folded up: the city
-- already lives in `location`.
update public.events set country = null  where country = 'Online';
update public.events set country = 'UAE' where country in ('Dubai, UAE', 'Abu Dhabi, UAE');

-- ============================================================
-- 5. No more duplicates
-- ============================================================
--
-- Ahmed: "make sure to check while adding new event if it is duplicated not to
-- add". Enforced by the database rather than by the importer being careful —
-- events arrive from an admin form, an Edge Function import and a SQL session,
-- and only one of those three can be trusted to remember a rule.
--
-- Title + date, case- and whitespace-insensitive. A recurring meetup is NOT
-- caught, because its dates differ — which is right; "Dubai AI Meetup — DIFC"
-- in March and in April are two events.
create unique index if not exists events_no_duplicates_idx
  on public.events (lower(trim(title)), event_date);

-- ============================================================
-- 6. The organizers we already know
-- ============================================================
--
-- Seeded from Ahmed's archive and from the events already in the database.
-- ⚠ Deliberately NOT seeded: the twelve meetup.com events and fourteen luma.com
-- ones. Their real organizer is the community or company that created the
-- listing, and that name is only on the listing page — inventing it here would
-- put words in somebody else's mouth. They are linked once the names are read
-- from the source.

insert into public.organizers (name, slug, category, is_partner, sort_order, website) values
  ('Sahaba Club',      'sahaba-club',      'Sahaba Club', false, 0,  'https://www.sahabaclub.ai'),
  ('Microsoft',        'microsoft',        'Microsoft',   true,  10, 'https://www.microsoft.com'),
  ('AWS',              'aws',              'AWS',         true,  11, 'https://aws.amazon.com'),
  ('Google',           'google',           'Google',      true,  12, 'https://about.google'),
  ('Google DevFest',   'google-devfest',   'Google',      true,  13, null),
  ('IEEE',             'ieee',             'Community',   true,  20, 'https://www.ieee.org'),
  ('Aqua Energy Expo', 'aqua-energy-expo', 'Others',      true,  30, null),
  ('ExpertsLive',      'expertslive',      'Community',   true,  21, 'https://expertslive.ae'),
  ('GITEX',            'gitex',            'Others',      false, 40, 'https://gitex.com')
on conflict (slug) do update set
  category   = excluded.category,
  is_partner = excluded.is_partner,
  sort_order = excluded.sort_order;

-- ============================================================
-- 7. Reading it back
-- ============================================================
--
-- `security_invoker = on`, like `my_notification_counts` in 0044: RLS on the
-- underlying tables already says "everyone may read published events", so the
-- view needs no predicate of its own and cannot be broken by removing one.

drop view if exists public.event_organizer_list;
create view public.event_organizer_list
with (security_invoker = on) as
  select
    e.id as event_id,
    e.slug as event_slug,
    -- The real names, lead first, for display.
    array_agg(o.name order by eo.is_lead desc, o.sort_order, o.name) as organizer_names,
    -- The filter buckets, de-duplicated. Two Microsoft entities on one event
    -- must not make it match "Microsoft" twice.
    array_agg(distinct o.category) as categories,
    bool_or(o.slug = 'sahaba-club') as is_ours
  from public.events e
  join public.event_organizers eo on eo.event_id = e.id
  join public.organizers o on o.id = eo.organizer_id
  group by e.id, e.slug;

revoke all on public.event_organizer_list from anon, authenticated;
grant select on public.event_organizer_list to anon, authenticated;

-- ============================================================
-- Verification
-- ============================================================
--
-- ⚠ RUN CHECK 0 BEFORE APPLYING. If it returns anything, a duplicate carries
-- registrations, §4 will refuse to delete it, and §5 will fail — resolve it by
-- hand first and decide which row keeps the registrations:
--
--   select e.id, e.title, e.event_date, count(r.id) as registrations
--     from public.events e
--     left join public.event_registrations r on r.event_id = e.id
--    where (lower(trim(e.title)), e.event_date) in (
--            select lower(trim(title)), event_date from public.events
--             group by 1, 2 having count(*) > 1)
--    group by e.id, e.title, e.event_date order by e.title;
--
-- 1. The two deletions happened (expect 0 and 0):
--
--   select count(*) from public.events
--    where lower(trim(title)) = 'thursday advanced badminton games dubai';
--   select count(*) from (select 1 from public.events
--     group by lower(trim(title)), event_date having count(*) > 1) d;
--
-- 2. Every event has a unique, non-empty slug (expect 0 rows):
--
--   select id, title from public.events where slug is null or trim(slug) = '';
--
--    …and the Arabic fallback is visible rather than silently broken — these
--    are the ones worth renaming by hand before anybody shares them:
--
--   select slug, title from public.events where slug like 'event-%' order by slug;
--
-- 3. Country no longer claims "Online" is a country (expect 0):
--
--   select count(*) from public.events where country = 'Online';
--
-- 4. The duplicate guard actually bites. This must RAISE:
--
--   insert into public.events (title, event_date)
--   select title, event_date from public.events limit 1;
--   -- expect: duplicate key value violates unique constraint "events_no_duplicates_idx"
--
-- 5. The slug trigger fills itself in. Insert without a slug, confirm one
--    appears, then delete it:
--
--   insert into public.events (title, event_date) values ('Slug Trigger Probe', '2030-01-01')
--   returning slug;   -- expect 'slug-trigger-probe-2030'
--   delete from public.events where title = 'Slug Trigger Probe';
--
-- 6. anon can read organizers and the join (expect 2 rows, both 'SELECT'):
--
--   select table_name, privilege_type from information_schema.table_privileges
--    where table_schema = 'public' and grantee = 'anon'
--      and table_name in ('organizers', 'event_organizers');
--
--    …and cannot write them (expect 0 rows):
--
--   select table_name, privilege_type from information_schema.table_privileges
--    where table_schema = 'public' and grantee = 'anon'
--      and table_name in ('organizers', 'event_organizers')
--      and privilege_type in ('INSERT','UPDATE','DELETE');
--
-- 7. ⚠ AS AN ORDINARY MEMBER — organizers are readable (they are public) but
--    not writable:
--
--   select count(*) from public.organizers;              -- expect 9
--   update public.organizers set name = 'x';             -- expect: 0 rows / refused
--   insert into public.organizers (name, slug, category)
--        values ('Forged', 'forged', 'Others');          -- expect: RLS violation
--
-- 8. The category constraint refuses a seventh bucket:
--
--   insert into public.organizers (name, slug, category)
--        values ('Nope', 'nope', 'Partner');             -- expect: check constraint
