-- 0082 — speakers who are not members yet
-- ============================================================
--
-- Ahmed, 22 Aug 2026: "add the speakers names hyper to their profiles if they
-- exist, if not in the club it will be name only, I can change it to member
-- account later."
--
-- 0080 could only credit a club member, because `user_id` was NOT NULL and
-- pointed at auth.users. "Taming the Beast" is the case that breaks it: three
-- people on the poster, one of them a member and two of them guests. Under
-- 0080 that event could either name one third of its speakers or none.
--
-- ⚠ A GUEST IS THE SAME ROW, NOT A SECOND TABLE. The alternative was
-- `event_guest_speakers` alongside this one, and it is worse in the way that
-- matters: slots would then be unique per table rather than per event, so
-- "up to three speakers" would stop being enforceable, and every reader would
-- have to union two shapes and sort the result. One table also makes Ahmed's
-- "I can change it to member account later" a single UPDATE — set user_id,
-- clear guest_name — instead of a delete and an insert across two tables,
-- which would lose the slot ordering.

-- ⚠ THE PRIMARY KEY MOVES FROM (event_id, user_id) TO (event_id, slot).
-- It has to: a nullable column cannot be part of a primary key, and two guests
-- on one event would both have a null user_id. (event_id, slot) was ALREADY
-- unique, so this is the same guarantee wearing a different hat — and it is
-- the better key anyway, because the slot is what orders the credits.
--
-- ⚠ THE ORDER OF THESE THREE STATEMENTS IS LOAD-BEARING. Dropping NOT NULL
-- first fails with 42P16 "column user_id is in a primary key": Postgres will
-- not let a primary-key column become nullable, so the key has to go first.
alter table public.event_speakers drop constraint if exists event_speakers_pkey;
alter table public.event_speakers drop constraint if exists event_speakers_event_id_slot_key;
alter table public.event_speakers add constraint event_speakers_pkey primary key (event_id, slot);

alter table public.event_speakers alter column user_id drop not null;
alter table public.event_speakers add column if not exists guest_name  text;
alter table public.event_speakers add column if not exists guest_title text;

-- ⚠ The old primary key was also what stopped the same MEMBER being credited
-- twice on one event. Losing it silently would be the kind of gap nobody sees
-- until a profile lists the same session twice, so it comes back explicitly as
-- a partial unique index. Guests are exempt: two people can genuinely share a
-- name, and there is no id to tell them apart by.
create unique index if not exists event_speakers_one_member_per_event
  on public.event_speakers(event_id, user_id) where user_id is not null;

-- ⚠ EXACTLY ONE OF THE TWO, NEVER BOTH AND NEVER NEITHER. Without this a row
-- can carry a user_id AND a guest_name that disagree — and the view below
-- prefers the profile, so the guest_name would sit in the table looking
-- authoritative while no page ever showed it. `<>` on two booleans is XOR.
alter table public.event_speakers drop constraint if exists event_speakers_member_or_guest;
alter table public.event_speakers add constraint event_speakers_member_or_guest
  check ((user_id is null) <> (nullif(btrim(guest_name), '') is null));

comment on column public.event_speakers.guest_name is
  'Name of a speaker who is not a club member. Mutually exclusive with '
  'user_id. To promote a guest to a member later: set user_id and null both '
  'guest columns, in one update. 0082.';

-- ============================================================
-- The view gains nothing and loses nothing
-- ============================================================
--
-- Same seven columns as 0081 — no new field is published, so nothing about
-- the disclosure changes. A guest simply arrives through `guest_name` instead
-- of through `profiles`.
--
-- ⚠ is_linkable REQUIRES user_id NOT NULL, first. A guest has no profile to
-- visit, so they are NAMED and not linked — which is exactly what Ahmed asked
-- for, and it becomes a link by itself on the day the row is given a user_id.
create or replace view public.event_speakers_public as
  select
    s.event_id,
    s.user_id,
    s.slot,
    coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(s.guest_name), '')) as full_name,
    p.avatar_url,
    coalesce(nullif(btrim(p.headline), ''), nullif(btrim(s.guest_title), '')) as headline,
    (s.user_id is not null
     and nullif(btrim(p.full_name), '') is not null
     and p.is_discoverable
     and public.profile_is_complete(p.*)) as is_linkable
  from public.event_speakers s
  left join public.profiles p on p.user_id = s.user_id;

revoke all on public.event_speakers_public from public, anon, authenticated;
grant select on public.event_speakers_public to anon, authenticated;

comment on view public.event_speakers_public is
  'Speaker name, picture and headline for the event and profile pages. '
  'Readable by anyone: event pages are public. Seven columns, no contact '
  'details. A speaker is either a club member (name from profiles) or a guest '
  '(name from guest_name) — never both, enforced by a check constraint. '
  'is_linkable is true only for a member with a complete, discoverable '
  'profile; everyone else is still NAMED, because they did speak. 0080, '
  'amended 0081 and 0082.';
