-- Sahaba Club — favourites, attendance signals, and who's going
-- ------------------------------------------------------------
-- Three things at once, because they share the same shape: what a member
-- has saved, what they've looked at, and who else is going. Together they
-- also become the input to event recommendations.

-- ============================================================
-- Member cards: name and photo, and nothing else
-- ============================================================

-- Google hands us a profile picture at sign-in; store it so attendee lists
-- have faces rather than initials.
alter table public.profiles
  add column if not exists avatar_url text;

-- Whether this member appears in "who's going" lists. Defaults to visible,
-- because a club where nobody can see who's coming defeats the point — but
-- it's a real privacy setting and members can turn it off in their profile.
alter table public.profiles
  add column if not exists show_in_attendees boolean not null default true;

-- 0002 revoked the table-wide UPDATE on profiles and granted back only the
-- columns a member may edit. New columns are therefore NOT editable by
-- default — which is the right default, but it means these two have to be
-- named explicitly or the privacy toggle below would be read-only and
-- members could never opt out of being listed.
--
-- Note the grant is additive: it does not disturb the 12 columns from 0002,
-- and role/tier stay off the list where they belong.
grant update (avatar_url, show_in_attendees) on public.profiles to authenticated;

-- Members need to see each other's name and photo on an event, but must NOT
-- see each other's bio, goals, timezone or industry.
--
-- This cannot be done with a policy. RLS is row-level: any policy that lets
-- one member SELECT another's profile row exposes EVERY column of that row.
-- Same trap as the role column in 0002. A view is the column-level answer.
--
-- security_invoker = off (the default, stated explicitly so nobody "tidies"
-- it later) means the view runs with its owner's rights and is not subject to
-- the profiles policies — which is exactly why it can only ever expose the
-- three columns named here.
create or replace view public.member_cards
with (security_invoker = off) as
  select user_id, full_name, avatar_url
  from public.profiles
  where show_in_attendees = true;

-- Signed-in members only. A public visitor has no business seeing the
-- membership list.
--
-- The revoke is the important half, and leaving it out was a real bug (see
-- 0006, which repaired a live database). Supabase grants anon and
-- authenticated ALL privileges on every new object in public by default, so
-- "not granting" anon is not the same as anon not having it. Worse here than
-- anywhere else: this is a simple auto-updatable view with
-- security_invoker = off, so it runs as its owner, RLS on profiles does not
-- apply, and these grants are the only access control there is.
revoke all on public.member_cards from anon, authenticated;
grant select on public.member_cards to authenticated;

-- ============================================================
-- Favourites
-- ============================================================

create table public.event_favourites (
  user_id uuid not null references auth.users (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

create index event_favourites_user_idx on public.event_favourites (user_id);

alter table public.event_favourites enable row level security;

-- Favourites are private. Staff can see them in aggregate for recommendations
-- work later, but a member's saved list is their own.
create policy "favourites: read own" on public.event_favourites
  for select using (auth.uid() = user_id or public.is_staff());
create policy "favourites: add own" on public.event_favourites
  for insert with check (auth.uid() = user_id);
create policy "favourites: remove own" on public.event_favourites
  for delete using (auth.uid() = user_id);

-- ============================================================
-- View history — the browsing signal for recommendations
-- ============================================================

-- One row per member per event, updated on each visit rather than appended,
-- so this can't grow without bound as someone browses. view_count still
-- captures repeat interest, which is the part worth knowing.
create table public.event_views (
  user_id uuid not null references auth.users (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete cascade,
  view_count int not null default 1,
  last_viewed_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

create index event_views_user_idx on public.event_views (user_id, last_viewed_at desc);

alter table public.event_views enable row level security;

create policy "views: read own" on public.event_views
  for select using (auth.uid() = user_id or public.is_staff());
create policy "views: record own" on public.event_views
  for insert with check (auth.uid() = user_id);
create policy "views: update own" on public.event_views
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- Who's going
-- ============================================================

-- event_registrations already exists from 0003, but its read policy only let
-- a member see their own row. Attendee lists need members to see each other's
-- registrations — limited to people who opted into being listed.
--
-- This exposes only the fact of a registration. The join to a name and photo
-- goes through member_cards above, which is where the column limit lives.
create policy "registrations: members see fellow attendees" on public.event_registrations
  for select using (
    auth.uid() is not null
    and exists (
      select 1 from public.profiles p
      where p.user_id = event_registrations.user_id
        and p.show_in_attendees = true
    )
  );

-- A member marks themselves as attending, or as merely interested, and can
-- change their mind — so updating their own row has to be allowed.
create policy "registrations: update own" on public.event_registrations
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 'interested' joins the existing statuses: it's what we record when someone
-- opens the registration page but tells us afterwards they didn't sign up.
-- Worth keeping rather than discarding — it's a genuine signal of interest,
-- and it feeds recommendations.
alter table public.event_registrations
  drop constraint if exists event_registrations_status_check;
alter table public.event_registrations
  add constraint event_registrations_status_check
  check (status in ('registered', 'interested', 'attended', 'cancelled'));
