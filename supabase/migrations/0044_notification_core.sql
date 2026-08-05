-- 0044 — the notification core
-- ============================================================
--
-- Ahmed's ask, 5 Aug 2026: every department in the menu carries its own unread
-- count, the dashboard grows a Notifications tab listing them with a link
-- straight to the thing each one is about, and a member can switch off any
-- kind they do not want. This migration builds the engine. The things that
-- FIRE notifications — messages, follows, events, episodes, licence expiry —
-- are 0045; nothing here emits anything on its own.
--
-- Three decisions are load-bearing, and each one is here to avoid a trap this
-- project has already fallen into:
--
--   1. **Preferences are rows, not columns on `profiles`.** The most repeated
--      bug in this codebase is adding a member-editable column to `profiles`
--      and forgetting its `grant update` (0002 → 0005 → 0017 → 0019 → 0023 is
--      an allowlist, so a new column is unwritable by default). Twelve kinds
--      across three channels would be thirty-six chances to make that mistake.
--      `notification_optouts` has one grant, made once, and a new notification
--      kind needs no schema change and no backfill at all.
--
--   2. **Absence of a row means ON.** The alternative — a row per member per
--      kind saying "yes please" — means every new kind starts silent for every
--      existing member until a backfill runs, and a backfill that half-runs
--      leaves the club in two states. Opt-out rows are only written when
--      somebody actually says no.
--
--   3. **`my_notification_counts` is `security_invoker = on`.** That is the
--      opposite of this project's habit, and deliberate. Every other view here
--      is a definer view whose own `is_staff()` predicate is the only thing
--      standing between a member and someone else's data — and 0043 exists
--      because one of them lost that predicate and nobody noticed for four
--      days. This view needs no such predicate: RLS on `notifications` already
--      says "your own rows", so an invoker view inherits exactly the right
--      answer and CANNOT leak if someone edits it carelessly later. Prefer
--      invoker whenever the underlying RLS already expresses the rule.
--
-- The `emit_*` functions are `security definer` because a trigger on
-- `member_messages` must write a row into the RECIPIENT's notification list,
-- and the sender has no business writing to another member's rows. Note that
-- Postgres grants EXECUTE on a new function to PUBLIC by default — every one
-- of them is explicitly revoked below. That default is how a definer function
-- becomes a hole.

-- ============================================================
-- 1. The registry of kinds
-- ============================================================
--
-- Every notification kind is declared here before it can be emitted. Three
-- things fall out of that, and the third is the reason it is a table rather
-- than a check constraint:
--
--   * `emit_notification` raises on an unknown kind instead of writing a row
--     nobody will ever render — a typo fails loudly at the trigger.
--   * `department` lives with the kind, in one place. The menu badge groups by
--     department; deriving it from the kind at read time would mean a CASE
--     expression kept in sync in the client and the database both.
--   * `app/settings.html` renders its switches FROM this table. Adding a kind
--     makes it appear in everyone's settings with no client change, which is
--     what stops the controls and the engine drifting apart.

create table if not exists public.notification_kinds (
  kind text primary key,
  department text not null check (department in (
    'dashboard', 'messages', 'connect', 'events', 'eduhackai', 'podcast', 'all'
  )),
  label text not null,
  description text not null,
  -- Which channels this kind uses when nobody has opted out. 'push' is
  -- recorded now and delivered in phase 2 — the web push work (service
  -- worker, manifest, VAPID) is deliberately not in this migration. Recording
  -- it here means phase 2 ships a sender, not a data migration.
  default_channels text[] not null default '{inapp}'::text[],
  -- Losing this one costs the member something concrete: a mailbox, a
  -- subscription, an event they paid for. The settings page makes switching
  -- these off deliberate rather than a stray tap; it does not forbid it,
  -- because Ahmed asked for control over *any* kind.
  is_critical boolean not null default false,
  sort_order int not null default 100
);

comment on table public.notification_kinds is
  'Declares every notification kind. emit_notification() rejects anything not '
  'listed here, settings renders its switches from it, and department drives '
  'the menu badge grouping.';

-- The wildcard. A member who wants nothing at all on a channel writes one
-- opt-out row against '*' rather than one per kind — and a kind added next
-- month is then silent for them too, which is what they asked for. It lives in
-- this table so `notification_optouts.kind` can carry a real foreign key.
insert into public.notification_kinds
  (kind, department, label, description, default_channels, is_critical, sort_order)
values
  ('*', 'all', 'Everything',
   'Switch off every notification on this channel, including any kind added later.',
   '{}'::text[], false, 0),

  -- Dashboard — the member's own account.
  ('system_message', 'dashboard', 'Club announcements',
   'Messages from the Sahaba Club team.', '{inapp,push}', false, 10),
  ('avatar_changed', 'dashboard', 'Your profile picture changed',
   'Told when your picture is updated or redrawn, so a change is never a surprise.',
   '{inapp}', false, 20),
  ('premium_renewal', 'dashboard', 'Membership renewal',
   'Told before your Premium membership renews or lapses.',
   '{inapp,email,push}', true, 30),
  ('ms365_expiring_30', 'dashboard', 'Microsoft 365 — 30 days left',
   'A month before your Microsoft 365 licence expires.',
   '{inapp,email,push}', true, 40),
  ('ms365_expiring_10', 'dashboard', 'Microsoft 365 — 10 days left',
   'Ten days before your Microsoft 365 licence expires.',
   '{inapp,email,push}', true, 41),
  ('ms365_expiring_3', 'dashboard', 'Microsoft 365 — 3 days left',
   'Three days before your Microsoft 365 licence expires.',
   '{inapp,email,push}', true, 42),
  ('ms365_expiring_1', 'dashboard', 'Microsoft 365 — tomorrow',
   'The day before your Microsoft 365 licence expires.',
   '{inapp,email,push}', true, 43),
  ('event_upcoming', 'dashboard', 'Events coming up',
   'A nudge about events you have registered for.', '{inapp,push}', false, 50),
  ('event_starting_soon', 'dashboard', 'An event starts in an hour',
   'One hour before an event you registered for begins.',
   '{inapp,email,push}', true, 51),

  -- Messages.
  ('message_received', 'messages', 'New message',
   'When another member sends you a message.', '{inapp,push}', false, 60),

  -- Connect.
  ('new_follower', 'connect', 'New follower',
   'When another member follows you.', '{inapp,push}', false, 70),
  ('member_joined', 'connect', 'New member',
   'When somebody new joins the club and publishes their profile.',
   '{inapp}', false, 71),

  -- Events, EduHackAI, Podcast.
  ('event_published', 'events', 'New event',
   'When a new event is added to the calendar.', '{inapp,push}', false, 80),
  ('eduhackai_launch', 'eduhackai', 'EduHackAI announcements',
   'When a new EduHackAI round or version is announced.', '{inapp,push}', false, 90),
  ('episode_published', 'podcast', 'New podcast episode',
   'When a new Tech Talk with Zoka episode is published.', '{inapp,push}', false, 100)
on conflict (kind) do update set
  department       = excluded.department,
  label            = excluded.label,
  description      = excluded.description,
  default_channels = excluded.default_channels,
  is_critical      = excluded.is_critical,
  sort_order       = excluded.sort_order;

alter table public.notification_kinds enable row level security;

-- Members read it because the settings page is built from it. Nobody but
-- staff writes it, and in practice only a migration does.
drop policy if exists "kinds: readable by members" on public.notification_kinds;
create policy "kinds: readable by members" on public.notification_kinds
  for select using (auth.uid() is not null);

drop policy if exists "kinds: staff write" on public.notification_kinds;
create policy "kinds: staff write" on public.notification_kinds
  for all using (public.is_staff()) with check (public.is_staff());

revoke all on public.notification_kinds from anon, authenticated;
grant select on public.notification_kinds to authenticated;

-- ============================================================
-- 2. The notifications themselves
-- ============================================================

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Denormalised from notification_kinds so the badge query is one grouped
  -- read of one table. The trigger in §4 keeps it honest; it is never passed
  -- in by a caller.
  department text not null check (department in (
    'dashboard', 'messages', 'connect', 'events', 'eduhackai', 'podcast'
  )),
  kind text not null references public.notification_kinds (kind),
  title text not null check (length(title) between 1 and 200),
  body text check (body is null or length(body) <= 1000),
  -- Where clicking it goes. Ahmed's example: the Microsoft 365 expiry
  -- notification lands you on the renewal page, not on a list of notifications.
  -- Site-relative only — see the check. An absolute URL here would let anyone
  -- who ever gains write access turn the club's own notification list into a
  -- phishing surface, and there is no reason a notification should ever point
  -- off-site.
  href text check (href is null or (href ~ '^/[A-Za-z0-9._~!$&''()*+,;=:@%/?#-]*$' and href !~ '^//')),
  -- Who caused it: the message sender, the new follower. Null for anything the
  -- club itself did. `on delete set null` so a departing member does not take
  -- other people's notification history with them.
  actor_id uuid references auth.users (id) on delete set null,
  -- What it is about: the message id, the event id, the episode id. Not a
  -- foreign key, because it points at six different tables.
  subject_id uuid,
  -- Idempotency. `unique (user_id, dedupe_key)` below means a reminder sweep
  -- that runs twice — or a cron that fires late and overlaps itself — writes
  -- one row, not two. Every scheduled kind MUST set this; see 0045.
  dedupe_key text check (dedupe_key is null or length(dedupe_key) <= 200),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- The unread-count query and the notifications tab both read this shape.
create index if not exists notifications_unread_idx
  on public.notifications (user_id, department, created_at desc)
  where read_at is null;

create index if not exists notifications_user_recent_idx
  on public.notifications (user_id, created_at desc);

-- Partial, because most notifications have no dedupe key and two nulls are
-- not equal to each other anyway.
create unique index if not exists notifications_dedupe_idx
  on public.notifications (user_id, dedupe_key)
  where dedupe_key is not null;

alter table public.notifications enable row level security;

-- Read your own. That is the whole policy set for clients: there is
-- deliberately no INSERT, UPDATE or DELETE policy at all. Writing happens
-- through the definer functions in §3, and marking read through §5, so there
-- is exactly one way in and it can be audited in one place.
drop policy if exists "notifications: read own" on public.notifications;
create policy "notifications: read own" on public.notifications
  for select using (auth.uid() = user_id);

revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;

comment on table public.notifications is
  'One row per member per thing that happened. Written only by the definer '
  'emit_* functions; read by the owner; marked read through mark_*_read().';

-- ============================================================
-- 3. Emitting
-- ============================================================
--
-- `should_notify` is the one place the opt-out rule is expressed. Both emit
-- functions call it, the email sender in 0045 calls it, and phase 2's push
-- sender will call it — so "this member said no" cannot mean one thing in one
-- path and something else in another.

create or replace function public.should_notify(
  p_user_id uuid,
  p_kind text,
  p_channel text default 'inapp'
) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    -- The kind must use this channel at all …
    exists (
      select 1 from public.notification_kinds k
       where k.kind = p_kind and p_channel = any (k.default_channels)
    )
    -- … and the member must not have switched it off, either by name or
    -- through the wildcard.
    and not exists (
      select 1 from public.notification_optouts o
       where o.user_id = p_user_id
         and o.channel = p_channel
         and o.kind in (p_kind, '*')
    );
$$;

comment on function public.should_notify is
  'The single expression of "does this member want this, on this channel". '
  'Every delivery path must ask it — in-app, email, and push in phase 2.';

create or replace function public.emit_notification(
  p_user_id uuid,
  p_kind text,
  p_title text,
  p_body text default null,
  p_href text default null,
  p_actor_id uuid default null,
  p_subject_id uuid default null,
  p_dedupe_key text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_department text;
  v_id uuid;
begin
  -- An unknown kind is a programming error, not a runtime condition. Raise
  -- rather than writing a row that no settings switch controls and no client
  -- knows how to render.
  select k.department into v_department
    from public.notification_kinds k
   where k.kind = p_kind;

  if v_department is null then
    raise exception 'emit_notification: unknown kind %', p_kind
      using hint = 'Add it to public.notification_kinds first.';
  end if;

  if v_department = 'all' then
    raise exception 'emit_notification: % is a settings wildcard, not an emittable kind', p_kind;
  end if;

  -- Never notify somebody about their own action. Cheaper to say once here
  -- than to remember in every trigger.
  if p_actor_id is not null and p_actor_id = p_user_id then
    return null;
  end if;

  if not public.should_notify(p_user_id, p_kind, 'inapp') then
    return null;
  end if;

  insert into public.notifications
    (user_id, department, kind, title, body, href, actor_id, subject_id, dedupe_key)
  values
    (p_user_id, v_department, p_kind, p_title, p_body, p_href,
     p_actor_id, p_subject_id, p_dedupe_key)
  on conflict (user_id, dedupe_key) where dedupe_key is not null
  do nothing
  returning id into v_id;

  return v_id;
end;
$$;

-- Fan-out for the club-wide kinds: a new event, a new episode, an EduHackAI
-- announcement. One row per member, opt-outs honoured per member, and the
-- shared `p_dedupe_key` is unique PER MEMBER because the index is
-- (user_id, dedupe_key) — so re-running this for the same event is a no-op
-- rather than a second copy in everyone's list.
create or replace function public.emit_notification_to_members(
  p_kind text,
  p_title text,
  p_body text default null,
  p_href text default null,
  p_subject_id uuid default null,
  p_dedupe_key text default null,
  p_exclude_user_id uuid default null
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_department text;
  v_count integer;
begin
  select k.department into v_department
    from public.notification_kinds k
   where k.kind = p_kind;

  if v_department is null or v_department = 'all' then
    raise exception 'emit_notification_to_members: unusable kind %', p_kind;
  end if;

  with recipients as (
    select p.user_id
      from public.profiles p
     where (p_exclude_user_id is null or p.user_id <> p_exclude_user_id)
       and public.should_notify(p.user_id, p_kind, 'inapp')
  ),
  inserted as (
    insert into public.notifications
      (user_id, department, kind, title, body, href, subject_id, dedupe_key)
    select r.user_id, v_department, p_kind, p_title, p_body, p_href,
           p_subject_id, p_dedupe_key
      from recipients r
    on conflict (user_id, dedupe_key) where dedupe_key is not null
    do nothing
    returning 1
  )
  select count(*)::int into v_count from inserted;

  return v_count;
end;
$$;

-- ⚠ Postgres grants EXECUTE on a new function to PUBLIC by default. Left
-- alone, `emit_notification` would let any signed-in member write a
-- notification into anybody else's list, saying anything, linking anywhere —
-- a definer function is only as safe as its grant. These three are for
-- triggers and the service role; nothing in a browser calls them.
revoke execute on function public.should_notify(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.emit_notification(uuid, text, text, text, text, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.emit_notification_to_members(text, text, text, text, uuid, text, uuid) from public, anon, authenticated;

-- ============================================================
-- 4. `department` cannot be lied about
-- ============================================================
--
-- The column is denormalised for the badge query, so it has to be derived and
-- not supplied. The emit functions already do that — this trigger is what
-- makes it true for the service role and for a SQL session as well, which is
-- where the next person will insert a test row by hand.

create or replace function public.notifications_set_department()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select k.department into new.department
    from public.notification_kinds k
   where k.kind = new.kind;

  if new.department is null or new.department = 'all' then
    raise exception 'notifications: kind % has no emittable department', new.kind;
  end if;

  return new;
end;
$$;

drop trigger if exists notifications_department_trg on public.notifications;
create trigger notifications_department_trg
  before insert or update of kind on public.notifications
  for each row execute procedure public.notifications_set_department();

-- ============================================================
-- 5. What a member may do: preferences, and marking read
-- ============================================================

create table if not exists public.notification_optouts (
  -- `default auth.uid()` so the client never sends its own id. Without it
  -- every caller has to fetch the session, remember to include user_id, and
  -- get it right — and the RLS insert policy below would reject the row
  -- anyway, so the only thing a client-supplied id can do is be wrong. With
  -- the default, "switch this off" is a two-column insert and the policy
  -- still decides whose row it is.
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- '*' is the wildcard row in notification_kinds; the foreign key is what
  -- stops a client writing an opt-out against a kind that does not exist and
  -- then wondering why it did nothing.
  kind text not null references public.notification_kinds (kind) on delete cascade,
  channel text not null check (channel in ('inapp', 'email', 'push')),
  created_at timestamptz not null default now(),
  primary key (user_id, kind, channel)
);

alter table public.notification_optouts enable row level security;

drop policy if exists "optouts: own only" on public.notification_optouts;
create policy "optouts: own only" on public.notification_optouts
  for select using (auth.uid() = user_id);

drop policy if exists "optouts: switch off own" on public.notification_optouts;
create policy "optouts: switch off own" on public.notification_optouts
  for insert with check (auth.uid() = user_id);

-- Switching a notification back on is deleting the row. No UPDATE policy: the
-- table has nothing updatable that is not part of its own primary key.
drop policy if exists "optouts: switch on own" on public.notification_optouts;
create policy "optouts: switch on own" on public.notification_optouts
  for delete using (auth.uid() = user_id);

revoke all on public.notification_optouts from anon, authenticated;
grant select, insert, delete on public.notification_optouts to authenticated;

comment on table public.notification_optouts is
  'A row means OFF. Absence means ON, so a kind added later is on by default '
  'for everybody with no backfill. kind = ''*'' silences a whole channel.';

-- Marking read is a function rather than a column-level UPDATE grant on
-- `read_at`. Same reasoning as §1: a grant is a thing to forget, and a member
-- who could UPDATE their own rows could also rewrite the title and href of a
-- notification the club sent them, which is a small but real way to make the
-- club appear to have said something it did not.
create or replace function public.mark_notifications_read(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'mark_notifications_read: not signed in';
  end if;

  with updated as (
    update public.notifications
       set read_at = now()
     where user_id = v_uid          -- the boundary, and it is not optional
       and id = any (p_ids)
       and read_at is null
    returning 1
  )
  select count(*)::int into v_count from updated;

  return v_count;
end;
$$;

create or replace function public.mark_department_read(p_department text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'mark_department_read: not signed in';
  end if;

  with updated as (
    update public.notifications
       set read_at = now()
     where user_id = v_uid
       and department = p_department
       and read_at is null
    returning 1
  )
  select count(*)::int into v_count from updated;

  return v_count;
end;
$$;

revoke execute on function public.mark_notifications_read(uuid[]) from public, anon;
revoke execute on function public.mark_department_read(text) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
grant execute on function public.mark_department_read(text) to authenticated;

-- ============================================================
-- 6. The badge numbers
-- ============================================================
--
-- `security_invoker = on` — see decision 3 in the header. RLS on
-- `notifications` already restricts this to the caller's own rows, so the view
-- needs no predicate of its own and cannot be broken by removing one.

drop view if exists public.my_notification_counts;
create view public.my_notification_counts
with (security_invoker = on) as
  select n.department,
         count(*)::int as unread,
         max(n.created_at) as latest_at
    from public.notifications n
   where n.read_at is null
     -- Redundant under RLS for a member, and NOT redundant for the service
     -- role, which bypasses RLS: without it, anything server-side that read
     -- this view would get the whole club's counts added together and look
     -- like one member's badge. With it, a role that has no auth.uid() gets
     -- zero rows, which is the honest answer.
     and n.user_id = auth.uid()
   group by n.department;

-- `create view` re-runs Supabase's default grants — anon gets ALL on a new
-- object unless told otherwise. This is the revoke-then-grant order that 0038
-- and 0041 both had to learn.
revoke all on public.my_notification_counts from anon, authenticated;
grant select on public.my_notification_counts to authenticated;

comment on view public.my_notification_counts is
  'Per-department unread counts for the signed-in member. One read paints '
  'every badge in the menu.';

-- ============================================================
-- 7. Realtime
-- ============================================================
--
-- Two tables go on the wire. `notifications` so a badge increments while the
-- member is looking at the page, and `member_messages` so Ahmed's actual
-- requirement — send "hi", get the reply without refreshing — is met by the
-- database pushing rather than the page polling.
--
-- Realtime authorises `postgres_changes` against RLS, so a member receives
-- only rows they could have selected anyway: their own notifications, and
-- messages where they are one of the two parties. That is why this is safe to
-- turn on without a second access-control mechanism.
--
-- `alter publication ... add table` raises if the table is already a member,
-- and this migration must be re-runnable, hence the guard.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'member_messages'
  ) then
    alter publication supabase_realtime add table public.member_messages;
  end if;
exception
  when undefined_object then
    raise notice 'supabase_realtime publication not found — enable Realtime for this project, then re-run section 7.';
end;
$$;

-- ============================================================
-- Verification
-- ============================================================
--
-- ⚠ Checks 6 and 7 need AN ORDINARY MEMBER SESSION, not a SQL session and not
-- a staff account. This project has a leak in its history that survived four
-- days precisely because the check that would have caught it needed a
-- non-staff session and was never run. Reading a policy and being refused by
-- one are different classes of evidence. Do not tick 6 and 7 off by reading
-- them.
--
-- 1. Every object exists (expect 3 tables, 1 view):
--
--   select table_name, table_type from information_schema.tables
--    where table_schema = 'public'
--      and table_name in ('notifications','notification_optouts','notification_kinds')
--   union all
--   select table_name, 'VIEW' from information_schema.views
--    where table_schema = 'public' and table_name = 'my_notification_counts';
--
-- 2. anon reaches NOTHING (expect zero rows):
--
--   select table_name, privilege_type from information_schema.table_privileges
--    where table_schema = 'public' and grantee = 'anon'
--      and table_name in ('notifications','notification_optouts',
--                         'notification_kinds','my_notification_counts');
--
-- 3. Members cannot WRITE notifications — check the specific privileges, not a
--    count of all of them, because Supabase hands out SELECT/INSERT/REFERENCES
--    on new objects by default (expect zero rows):
--
--   select grantee, privilege_type from information_schema.table_privileges
--    where table_schema = 'public' and table_name = 'notifications'
--      and grantee in ('anon','authenticated')
--      and privilege_type in ('INSERT','UPDATE','DELETE');
--
-- 4. The emit functions are NOT executable by a client role. This is the one
--    that matters most in this file: a definer function granted to PUBLIC is
--    the hole. Expect zero rows:
--
--   select routine_name, grantee from information_schema.routine_privileges
--    where routine_schema = 'public'
--      and routine_name in ('emit_notification','emit_notification_to_members','should_notify')
--      and grantee in ('anon','authenticated','PUBLIC');
--
--    …and the two mark-read functions ARE (expect exactly 2 rows,
--    both 'authenticated'):
--
--   select routine_name, grantee from information_schema.routine_privileges
--    where routine_schema = 'public'
--      and routine_name in ('mark_notifications_read','mark_department_read')
--      and grantee in ('anon','authenticated');
--
-- 5. Both tables are on the wire (expect 2 rows):
--
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and schemaname = 'public'
--      and tablename in ('notifications','member_messages');
--
-- 6. ⚠ AS AN ORDINARY MEMBER — the opt-out actually silences. Have staff emit
--    one to that member first, then as the member:
--
--   -- expect 1 row:
--   select count(*) from public.notifications;
--   -- switch it off, then have staff emit the same kind again:
--   insert into public.notification_optouts (user_id, kind, channel)
--        values (auth.uid(), 'system_message', 'inapp');
--   -- expect the count to be UNCHANGED, not 2.
--
-- 7. ⚠ AS AN ORDINARY MEMBER — you cannot write into anyone's list, including
--    your own. All four must RAISE or affect zero rows:
--
--   select public.emit_notification(auth.uid(), 'system_message', 'mine');
--   insert into public.notifications (user_id, department, kind, title)
--        values (auth.uid(), 'dashboard', 'system_message', 'forged');
--   update public.notifications set title = 'rewritten';
--   delete from public.notifications;
--
-- 8. ⚠ AS AN ORDINARY MEMBER — the counts view shows only your own. With a
--    notification emitted to a DIFFERENT member and none to you, expect zero
--    rows rather than somebody else's number:
--
--   select * from public.my_notification_counts;
