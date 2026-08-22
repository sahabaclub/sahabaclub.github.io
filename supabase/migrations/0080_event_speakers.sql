-- 0080 — club members as event speakers
-- ============================================================
--
-- Ahmed, 22 Aug 2026: relate a Hub event to the member who delivered it, up to
-- three per event, chosen from the club by name or by their Microsoft 365
-- mailbox. Their profile should then show the sessions they gave, so a reader
-- can jump to the recording — or book the next one they are speaking at.
--
-- ⚠ A TABLE, NOT AN ARRAY ON events. Unlike the gallery (0078), this is a real
-- relationship to a real person: it is read from BOTH ends — the event page
-- lists its speakers, the profile page lists their events — and the second
-- direction is a query no array can serve without scanning every event.
--
-- ⚠ `events.presenter` STAYS AND IS NOT REPLACED. It is free text, filled in
-- on 17 events, and it holds the name of whoever presented — usually somebody
-- who is not a member of the club and never will be. Speakers here are members
-- with accounts. An event can have both: a guest speaker in `presenter` and a
-- member of ours in this table.
--
-- ⚠ THE CAP OF THREE IS A UNIQUE CONSTRAINT, NOT A TRIGGER. `slot` is 1, 2 or
-- 3 and is unique per event, so a fourth speaker has nowhere to go. A trigger
-- counting rows would be the obvious alternative and is worse: it fires on
-- every insert, it can be deferred or disabled, and it states the rule in
-- procedural code instead of in the schema.

create table if not exists public.event_speakers (
  event_id  uuid not null references public.events(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  slot      smallint not null check (slot between 1 and 3),
  created_at timestamptz not null default now(),
  primary key (event_id, user_id),
  unique (event_id, slot)
);

create index if not exists event_speakers_user_idx on public.event_speakers(user_id);

comment on table public.event_speakers is
  'Which club members delivered an event. Max 3 per event, enforced by slot '
  '1-3 being unique per event. Separate from events.presenter, which is free '
  'text for guests who are not members. 0080.';

-- ============================================================
-- Reading it
-- ============================================================

alter table public.event_speakers enable row level security;

-- ⚠ PUBLIC READ, DELIBERATELY. Event pages are public — a signed-out visitor
-- can see an event and must be able to see who spoke at it. This table holds
-- only two ids and a slot number, so on its own it says nothing about anybody;
-- the names come from the view below, which is where the actual disclosure is.
drop policy if exists "event speakers: public read" on public.event_speakers;
create policy "event speakers: public read"
  on public.event_speakers for select
  using (true);

-- Writing is the events section, matching every other event table.
drop policy if exists "event speakers: section write" on public.event_speakers;
create policy "event speakers: section write"
  on public.event_speakers for all
  using (public.has_admin_section('events'))
  with check (public.has_admin_section('events'));

revoke all on public.event_speakers from public, anon, authenticated;
grant select on public.event_speakers to anon, authenticated;
grant insert, update, delete on public.event_speakers to authenticated;

-- ============================================================
-- The view the pages actually read
-- ============================================================
--
-- ⚠⚠ THIS PUBLISHES A MEMBER'S NAME, PICTURE AND HEADLINE TO ANYONE, INCLUDING
-- SIGNED-OUT VISITORS — and only for members somebody has explicitly recorded
-- as a speaker at an event. That is the disclosure, it is intended, and it is
-- narrow: speaking at a public event is a public act, and an event page that
-- would not name its speaker is not much of an event page.
--
-- It exposes FOUR fields and no more. No email, no mailbox, no city, no
-- company. `member_directory` is not reused for this because that view hides
-- anybody who is not discoverable — and a speaker who later turns discovery
-- off would silently vanish from the record of an event they actually spoke
-- at, which is a rewriting of history rather than a privacy control.
--
-- `is_linkable` carries the discoverability instead, so the pages can name the
-- speaker either way and only LINK to a profile that exists to be visited.
create or replace view public.event_speakers_public as
  select
    s.event_id,
    s.user_id,
    s.slot,
    p.full_name,
    p.avatar_url,
    p.headline,
    (p.is_discoverable and public.profile_is_complete(p.*)) as is_linkable
  from public.event_speakers s
  join public.profiles p on p.user_id = s.user_id;

revoke all on public.event_speakers_public from public, anon, authenticated;
grant select on public.event_speakers_public to anon, authenticated;

comment on view public.event_speakers_public is
  'Speaker name, picture and headline for the event and profile pages. '
  'Readable by anyone: event pages are public. Exposes four fields and no '
  'contact details. is_linkable says whether a profile link should be drawn — '
  'a speaker who is not discoverable is still NAMED, because they did speak. '
  '0080.';
