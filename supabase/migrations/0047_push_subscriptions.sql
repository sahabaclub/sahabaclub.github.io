-- 0047 — web push subscriptions
-- ============================================================
--
-- Phase 2 of the notification system. `notification_kinds.default_channels`
-- has carried 'push' since 0044 and nothing has ever delivered it; this is
-- where the browser's end of that gets stored.
--
-- ============================================================
-- ⚠ A PUSH SUBSCRIPTION IS A CAPABILITY, NOT A CONTACT DETAIL
-- ============================================================
--
-- This is the single most important thing about this table, and it is why its
-- policies are tighter than anything else in this schema.
--
-- A row here is `{endpoint, p256dh, auth}`. Anyone holding all three can send
-- a notification that appears on that person's phone, with the club's name on
-- it, without going through this database at all — the endpoint is a URL at
-- Google/Mozilla/Apple's push service and those three values are the entire
-- credential. It is not like an email address, which merely identifies where
-- to write. It is closer to a signing key.
--
-- Consequences, all deliberate:
--
--   * **No staff read policy.** Staff can send a push through
--     `staff_send_notification` (which writes a notification row and lets the
--     sender do the delivery) but cannot read anyone's subscription. Same
--     reasoning as `member_messages` in 0013 and `ms365_credentials` in 0039:
--     the ability to act is not the ability to read the credential.
--   * **No `authenticated` SELECT beyond your own rows**, and RLS is the only
--     thing standing between one member and another's. There is no view over
--     this table and there must not be one.
--   * **The service role reads it**, because the sender has to. That is the
--     only path that ever sees another person's subscription.
--
-- If a future admin screen wants "how many members have push on", give it a
-- COUNT through a security definer function. Do not grant read on the rows.

-- ============================================================
-- 1. Where a browser says "send here"
-- ============================================================

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  -- Defaulted so the client never sends its own id, same as
  -- notification_optouts in 0044. The RLS policy decides whose row it is.
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,

  -- The push service URL. Unique GLOBALLY, not per user: an endpoint
  -- identifies one browser installation, and if the same browser is later
  -- signed in as somebody else the row must move rather than duplicate. The
  -- upsert in lib/push.js relies on this.
  endpoint text not null unique check (endpoint ~ '^https://' and length(endpoint) <= 2000),

  -- The two halves of the encryption credential, base64url as the browser
  -- produced them. Never rendered anywhere, never logged.
  p256dh text not null check (length(p256dh) between 1 and 200),
  auth text not null check (length(auth) between 1 and 100),

  -- Which browser this is, so a member can recognise a device in Settings and
  -- remove one they no longer use. Truncated by the client; this is a label,
  -- not a fingerprint, and nothing reads it programmatically.
  user_agent text check (user_agent is null or length(user_agent) <= 300),

  created_at timestamptz not null default now(),
  last_used_at timestamptz,

  -- A push service answers 404 or 410 when a subscription is dead — the
  -- browser was uninstalled, the permission revoked, the token rotated. The
  -- sender deletes on those. This counts the softer failures (timeouts, 5xx)
  -- so a permanently broken endpoint can be retired without a hard signal.
  failure_count int not null default 0
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- Your own, and only ever your own. Note what is NOT here: no staff policy,
-- no UPDATE policy for clients. A member creates and deletes; the sender
-- (service role) is the only thing that updates last_used_at or failure_count.
drop policy if exists "push subs: read own" on public.push_subscriptions;
create policy "push subs: read own" on public.push_subscriptions
  for select using (auth.uid() = user_id);

drop policy if exists "push subs: create own" on public.push_subscriptions;
create policy "push subs: create own" on public.push_subscriptions
  for insert with check (auth.uid() = user_id);

drop policy if exists "push subs: delete own" on public.push_subscriptions;
create policy "push subs: delete own" on public.push_subscriptions
  for delete using (auth.uid() = user_id);

-- ⚠ An UPDATE grant is needed for the upsert in lib/push.js — the same
-- browser re-subscribing must refresh its keys rather than fail on the unique
-- endpoint. Scoped to the three columns a re-subscribe legitimately changes,
-- because a member has no business writing `failure_count` or `last_used_at`:
-- those are the sender's record of how this endpoint is behaving, and a member
-- who could zero `failure_count` could keep a dead endpoint alive forever.
drop policy if exists "push subs: refresh own" on public.push_subscriptions;
create policy "push subs: refresh own" on public.push_subscriptions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, delete on public.push_subscriptions to authenticated;
grant update (p256dh, auth, user_agent) on public.push_subscriptions to authenticated;

comment on table public.push_subscriptions is
  'Web push credentials, one row per browser. A row is a CAPABILITY to notify '
  'that device - treat it like a key, not like an address. No staff read '
  'policy, deliberately; see the header of 0047.';

-- ============================================================
-- 2. Track what has been pushed
-- ============================================================
--
-- Mirrors `emailed_at` from 0046, and for the same reason: the in-app row, the
-- email and the push are three deliveries of one fact, and a retry that cannot
-- tell them apart re-notifies everybody. `read_at` cannot serve — a member who
-- never opens the site has read nothing, and they are exactly who the push is
-- for.

alter table public.notifications
  add column if not exists pushed_at timestamptz;

comment on column public.notifications.pushed_at is
  'When this notification was handed to the push services. Null means not '
  'sent: not eligible, not yet, or failed.';

create index if not exists notifications_push_pending_idx
  on public.notifications (created_at)
  where pushed_at is null;

-- ============================================================
-- 3. Housekeeping the sender needs
-- ============================================================
--
-- `security definer` because it writes columns members cannot, and revoked
-- from every client role — only the service role calls it.

create or replace function public.record_push_result(
  p_endpoint text,
  p_ok boolean,
  p_gone boolean default false
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- 404/410 from a push service means the subscription is permanently dead.
  -- Deleting is right: keeping it would mean retrying forever, and a member
  -- who reinstalls gets a fresh endpoint anyway.
  if p_gone then
    delete from public.push_subscriptions where endpoint = p_endpoint;
    return;
  end if;

  if p_ok then
    update public.push_subscriptions
       set last_used_at = now(), failure_count = 0
     where endpoint = p_endpoint;
  else
    update public.push_subscriptions
       set failure_count = failure_count + 1
     where endpoint = p_endpoint;

    -- Twenty consecutive soft failures without a single success is a dead
    -- endpoint that never sent us a hard signal. Retrying it forever is how a
    -- send job gets slower every week.
    delete from public.push_subscriptions
     where endpoint = p_endpoint and failure_count >= 20;
  end if;
end;
$$;

revoke execute on function public.record_push_result(text, boolean, boolean) from public, anon, authenticated;

-- How many devices a member has registered, for Settings. A function rather
-- than a grant, so the count is available without the rows being readable —
-- and it can only ever answer about the caller.
create or replace function public.my_push_device_count()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::int from public.push_subscriptions where user_id = auth.uid();
$$;

revoke execute on function public.my_push_device_count() from public, anon;
grant execute on function public.my_push_device_count() to authenticated;

-- ============================================================
-- 4. The send queue, and the grant that makes it reachable
-- ============================================================
--
-- ⚠ THE GRANT BELOW IS NOT OPTIONAL AND IS EASY TO MISS. Postgres grants
-- EXECUTE on a new function to PUBLIC by default. 0044, 0045 and 0046 all
-- revoke that — correctly, because a definer function left executable by
-- PUBLIC is a hole. But `service_role` is an ordinary role, so
-- `revoke ... from public` takes the privilege away from IT TOO. Every Edge
-- Function runs as service_role. Without an explicit grant back, the sender
-- would fail on its first call with "permission denied for function", and it
-- would fail in a scheduled job where nobody is watching.
--
-- So: revoke from the client roles, then grant deliberately to the one server
-- role that needs it. Naming service_role explicitly also documents which
-- functions are part of a server-side contract.
--
-- One function rather than "fetch notifications, then fetch kinds, then ask
-- should_notify per row, then fetch subscriptions". The eligibility rule —
-- which kinds push, and who has switched push off — stays in the database
-- beside every other expression of it, and the sender receives exactly the
-- rows it should act on. A sender that reimplemented that filter in
-- TypeScript would be a second place for it to drift.

create or replace function public.push_queue(p_limit int default 200)
returns table (
  notification_id uuid,
  title text,
  body text,
  href text,
  tag text,
  endpoint text,
  p256dh text,
  auth text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    n.id,
    n.title,
    n.body,
    n.href,
    -- The browser replaces a notification carrying the same tag rather than
    -- stacking it, so six messages in one conversation become one banner.
    -- Falls back to the row id, which is unique, when there is no dedupe key.
    coalesce(n.dedupe_key, n.id::text),
    s.endpoint,
    s.p256dh,
    s.auth
  from public.notifications n
  join public.notification_kinds k on k.kind = n.kind
  join public.push_subscriptions s on s.user_id = n.user_id
  where n.pushed_at is null
    -- Never push something the member has already read somewhere else.
    and n.read_at is null
    -- ⚠ A horizon, deliberately. Without it, applying this migration to a
    -- database that already holds a backlog of notifications would push every
    -- one of them at once — a member opening their phone to forty banners on
    -- the day push was switched on. Anything older than a day has missed its
    -- moment and belongs in the dashboard list only.
    and n.created_at > now() - interval '24 hours'
    and 'push' = any (k.default_channels)
    and public.should_notify(n.user_id, n.kind, 'push')
  order by n.created_at
  limit greatest(1, least(p_limit, 1000));
$$;

create or replace function public.mark_pushed(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with updated as (
    update public.notifications
       set pushed_at = now()
     where id = any (p_ids) and pushed_at is null
    returning 1
  )
  select count(*)::int into v_count from updated;
  return v_count;
end;
$$;

revoke execute on function public.push_queue(int) from public, anon, authenticated;
revoke execute on function public.mark_pushed(uuid[]) from public, anon, authenticated;

-- The explicit grants back to the one role that runs the sender.
grant execute on function public.push_queue(int) to service_role;
grant execute on function public.mark_pushed(uuid[]) to service_role;
grant execute on function public.record_push_result(text, boolean, boolean) to service_role;
-- push_queue calls this internally as its definer owner, so this grant is not
-- what makes the queue work — it is here because the email sender in task #9
-- will call should_notify directly and will hit exactly the same wall.
grant execute on function public.should_notify(uuid, text, text) to service_role;

-- ============================================================
-- Verification
-- ============================================================
--
-- ⚠ Checks 3, 4 and 5 need AN ORDINARY MEMBER SESSION. This table is the one
-- in the whole schema where "can another member read this" has the highest
-- cost of being wrong, because the answer is a capability rather than a
-- record. Do not tick them off by reading the policies.
--
-- 1. anon reaches nothing (expect zero rows):
--
--   select privilege_type from information_schema.table_privileges
--    where table_schema = 'public' and table_name = 'push_subscriptions'
--      and grantee = 'anon';
--
-- 2. Members may UPDATE only the three re-subscribe columns. Expect exactly
--    p256dh, auth, user_agent — and NOT failure_count or last_used_at:
--
--   select column_name from information_schema.column_privileges
--    where table_schema = 'public' and table_name = 'push_subscriptions'
--      and privilege_type = 'UPDATE' and grantee = 'authenticated'
--    order by column_name;
--
--    …and the table-wide UPDATE must be absent (expect zero rows):
--
--   select grantee from information_schema.table_privileges
--    where table_schema = 'public' and table_name = 'push_subscriptions'
--      and privilege_type = 'UPDATE' and grantee in ('anon','authenticated');
--
-- 3. ⚠ AS AN ORDINARY MEMBER, with a subscription belonging to a DIFFERENT
--    member present in the table. Expect to see only your own:
--
--   select count(*) from public.push_subscriptions;
--   -- must equal your own device count, never the table total
--
-- 4. ⚠ AS AN ORDINARY MEMBER — you cannot forge one for somebody else:
--
--   insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
--   values ('<another member uuid>', 'https://example.com/x', 'k', 'a');
--   -- expect: new row violates row-level security policy
--
-- 5. ⚠ AS AN ORDINARY MEMBER — the sender's bookkeeping is not writable:
--
--   update public.push_subscriptions set failure_count = 0;
--   -- expect: permission denied for column failure_count
--
-- 6. There is NO staff read policy on this table, and this is the check that
--    catches somebody adding one for convenience later (expect zero rows):
--
--   select polname from pg_policy
--    where polrelid = 'public.push_subscriptions'::regclass
--      and pg_get_expr(polqual, polrelid) ilike '%is_staff%';
--
-- 7. The count function answers only about the caller. As two different
--    members with different device counts, each must get their own number:
--
--   select public.my_push_device_count();
--
-- 8. ⚠ THE ONE THAT WILL BITE. service_role can execute the sender's four
--    functions. If this is wrong the failure happens inside a scheduled job,
--    with "permission denied for function" going nowhere anybody reads.
--    Expect FOUR rows:
--
--   select routine_name, grantee from information_schema.routine_privileges
--    where routine_schema = 'public' and grantee = 'service_role'
--      and routine_name in ('push_queue','mark_pushed','record_push_result','should_notify')
--    order by routine_name;
--
--    …and the same four must NOT be reachable from a browser (expect zero):
--
--   select routine_name, grantee from information_schema.routine_privileges
--    where routine_schema = 'public'
--      and routine_name in ('push_queue','mark_pushed','record_push_result','should_notify')
--      and grantee in ('anon','authenticated','PUBLIC');
--
-- 9. The 24-hour horizon really is applied — otherwise switching push on
--    pushes the whole backlog at once. With a notification older than a day
--    that is unread and unpushed, it must NOT appear:
--
--   select count(*) from public.push_queue(1000);
--   select count(*) from public.notifications
--    where pushed_at is null and read_at is null
--      and created_at <= now() - interval '24 hours';
--   -- the second number can be large; those rows must not be in the first.
