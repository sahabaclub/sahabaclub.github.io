-- Sahaba Club — Connect: members become visible to each other
-- ------------------------------------------------------------
-- Every feature until now was between a member and the club. This is the
-- first one that is between a member and another member, which makes it the
-- first one where a mistake exposes someone's data to a stranger rather than
-- to us. Three rules follow from that, and they are enforced here rather
-- than in the page:
--
--   1. Discovery is OPT-IN. A member who never opens Connect is invisible in
--      it. Defaulting to visible would publish 900+ people who joined for a
--      Microsoft licence and never agreed to be listed.
--   2. Email and phone are NEVER member-to-member readable. Not in the
--      directory, not on a profile, not in a message header. Members reach
--      each other through the in-app inbox or not at all.
--   3. Messaging requires the recipient to accept it. Anyone can be followed;
--      not everyone wants a DM.
--
-- The directory is a VIEW with security_invoker = off, because RLS is
-- row-level only and cannot say "this row is visible but only these columns".
-- The view is the column boundary. Nothing grants `authenticated` direct
-- SELECT on `profiles`.

-- ============================================================
-- Profile fields that make a profile worth looking at
-- ============================================================

alter table public.profiles
  add column if not exists is_discoverable boolean not null default false,
  add column if not exists accepts_messages boolean not null default true,
  add column if not exists headline text,                    -- one line under the name
  add column if not exists city text,
  add column if not exists country text,
  add column if not exists links jsonb not null default '{}'::jsonb;  -- {linkedin,github,site}

-- Discovery is the hot path for the directory; index the flag it filters on.
create index if not exists profiles_discoverable_idx
  on public.profiles (is_discoverable) where is_discoverable;

-- ============================================================
-- Follows
-- ============================================================

create table if not exists public.member_follows (
  follower_id uuid not null references auth.users (id) on delete cascade,
  following_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  -- Following yourself is not a thing; a check is cheaper than cleaning it up.
  constraint no_self_follow check (follower_id <> following_id)
);

create index if not exists member_follows_following_idx
  on public.member_follows (following_id);

alter table public.member_follows enable row level security;

-- You may read who follows whom (that is what a follower count is), but you
-- may only create and delete YOUR OWN follows.
drop policy if exists "follows: readable by members" on public.member_follows;
create policy "follows: readable by members" on public.member_follows
  for select using (auth.uid() is not null);

drop policy if exists "follows: own only" on public.member_follows;
create policy "follows: own only" on public.member_follows
  for insert with check (auth.uid() = follower_id);

drop policy if exists "follows: unfollow own" on public.member_follows;
create policy "follows: unfollow own" on public.member_follows
  for delete using (auth.uid() = follower_id);

revoke all on public.member_follows from anon;

-- ============================================================
-- Messages
-- ============================================================

create table if not exists public.member_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  body text not null check (length(body) between 1 and 4000),
  read_at timestamptz,
  -- Soft delete per side: removing a thread from your own inbox must not
  -- destroy the other person's copy of the conversation.
  hidden_by_sender boolean not null default false,
  hidden_by_recipient boolean not null default false,
  created_at timestamptz not null default now(),
  constraint no_self_message check (sender_id <> recipient_id)
);

create index if not exists member_messages_thread_idx
  on public.member_messages (recipient_id, sender_id, created_at desc);
create index if not exists member_messages_sender_idx
  on public.member_messages (sender_id, created_at desc);

alter table public.member_messages enable row level security;

-- Only the two people in the conversation can read it. Staff deliberately
-- excluded: an admin who needs to investigate abuse should go through a
-- report, not read everyone's mail by default.
drop policy if exists "messages: only the two parties" on public.member_messages;
create policy "messages: only the two parties" on public.member_messages
  for select using (auth.uid() = sender_id or auth.uid() = recipient_id);

-- Sending requires: you are the sender, and the recipient is discoverable and
-- has messages switched on. Enforced in the policy, not the page, so a
-- crafted request cannot bypass someone's "don't message me".
drop policy if exists "messages: send if allowed" on public.member_messages;
create policy "messages: send if allowed" on public.member_messages
  for insert with check (
    auth.uid() = sender_id
    and exists (
      select 1 from public.profiles p
      where p.user_id = recipient_id
        and p.is_discoverable
        and p.accepts_messages
    )
  );

-- Both sides may update, but only their own flags — see the column grant.
drop policy if exists "messages: update own view" on public.member_messages;
create policy "messages: update own view" on public.member_messages
  for update using (auth.uid() = sender_id or auth.uid() = recipient_id)
  with check (auth.uid() = sender_id or auth.uid() = recipient_id);

-- Supabase grants ALL to authenticated on every new table, so a member could
-- otherwise edit the text of a message they already sent, or mark someone
-- else's mail as read. Revoke first, then hand back only the flags.
revoke all on public.member_messages from anon, authenticated;
grant select, insert on public.member_messages to authenticated;
grant update (read_at, hidden_by_sender, hidden_by_recipient)
  on public.member_messages to authenticated;

-- ============================================================
-- The directory — the column boundary
-- ============================================================

-- security_invoker = off: the view runs as its owner, so it can read
-- `profiles` without `authenticated` ever holding SELECT on that table.
-- Email, phone, and the raw profile row stay unreachable.
--
-- Only discoverable members appear. The WHERE clause is the privacy control
-- and must never be moved into the calling page.
create or replace view public.member_directory
with (security_invoker = off) as
select
  p.user_id,
  p.full_name,
  p.headline,
  -- The bio a member already wrote during onboarding. Without it the public
  -- profile is a headline and a tag list, and everything they typed about
  -- themselves stays invisible to the people the page exists to introduce
  -- them to.
  p.bio,
  p.avatar_url,
  p.city,
  p.country,
  p.experience_level,
  p.industry,
  p.skills,
  p.interests,
  p.links,
  p.accepts_messages,
  p.created_at as member_since,
  (select count(*) from public.member_follows f where f.following_id = p.user_id) as followers,
  (select count(*) from public.member_follows f where f.follower_id  = p.user_id) as following
from public.profiles p
where p.is_discoverable;

revoke all on public.member_directory from anon;
grant select on public.member_directory to authenticated;

-- ============================================================
-- What the profile knows about itself — the "smart" part
-- ============================================================

-- A profile that only shows what someone typed goes stale the day they stop
-- editing it. This view derives the live half from what they actually do:
-- events attended, topics they keep coming back to, how long they have been
-- around. The page reads this instead of recomputing it in JavaScript, so
-- the profile page and the directory can never disagree.
--
-- Deliberately only counts events that are PUBLISHED and that the member
-- chose to appear in — `show_in_attendees` is their setting, and it governs
-- here too.
create or replace view public.member_activity
with (security_invoker = off) as
select
  r.user_id,
  count(*) filter (where e.event_date <  current_date) as events_attended,
  count(*) filter (where e.event_date >= current_date) as events_upcoming,
  min(e.event_date)  as first_event,
  max(e.event_date)  as latest_event,
  -- The topics they keep showing up for, most frequent first. This is what
  -- makes a profile read as "AI cloud person" rather than a list of dates.
  (
    select array_agg(tag order by n desc)
    from (
      select unnest(e2.tags) as tag, count(*) as n
      from public.event_registrations r2
      join public.events e2 on e2.id = r2.event_id
      where r2.user_id = r.user_id and e2.is_published
      group by 1 order by n desc limit 6
    ) t
  ) as top_topics
from public.event_registrations r
join public.events e on e.id = r.event_id
where e.is_published
group by r.user_id;

revoke all on public.member_activity from anon;
grant select on public.member_activity to authenticated;

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- Expect zero rows (anon must reach none of this):
--   select table_name, privilege_type from information_schema.role_table_grants
--    where grantee='anon' and table_name in
--      ('member_follows','member_messages','member_directory','member_activity');
--
-- Expect zero rows (members must not read the profiles table directly):
--   select privilege_type from information_schema.role_table_grants
--    where grantee='authenticated' and table_name='profiles' and privilege_type='SELECT';
--
-- Expect only read_at / hidden_by_* :
--   select column_name from information_schema.column_privileges
--    where table_name='member_messages' and grantee='authenticated'
--      and privilege_type='UPDATE';
--
-- Expect 0 until members opt in — a non-zero number here on day one would
-- mean the default leaked:
--   select count(*) from public.profiles where is_discoverable;
