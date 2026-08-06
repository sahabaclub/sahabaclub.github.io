-- 0051 — the email copy of a critical notification
-- ============================================================
--
-- `0046` section 6 ends with: the email copy needs a sender that reads
-- `notifications` and honours `should_notify(user, kind, 'email')`, and until
-- it exists reminders are in-app only. This is that sender's half of the
-- database.
--
-- ⚠ WHY NOT `send-license-reminders`, WHICH ALREADY EXISTS AND ALREADY MAILS
-- ABOUT EXPIRY. Two reasons, either sufficient, both recorded in `0046`:
-- it uses thresholds 30/14/7/1 against the 30/10/3/1 Ahmed asked for, and it
-- predates `notification_optouts` entirely — so it would email members who
-- switched those emails off, breaking the control this whole feature exists
-- to give them. It stays unscheduled. This path replaces it.

-- ============================================================
-- 1. Track what has been emailed
-- ============================================================
--
-- 0046 already added `notifications.emailed_at` for exactly this. Nothing to
-- add here; the column is the reason a retry does not re-mail everybody.

-- ============================================================
-- 2. The queue
-- ============================================================
--
-- One function, mirroring `push_queue` in 0047, and for the same reason: WHO
-- SHOULD BE EMAILED is decided here, in the database, beside every other
-- expression of that rule. A sender that re-implemented the eligibility filter
-- in TypeScript would be a second place for it to drift from `should_notify`,
-- and the drift would show up as members receiving mail they had switched off.
--
-- ⚠ THIS FUNCTION RETURNS MEMBERS' EMAIL ADDRESSES. It is `security definer`
-- so it can read `auth.users`, which `authenticated` cannot touch at all, and
-- it is revoked from every client role and granted ONLY to `service_role`.
-- Nothing in a browser may call it. Check the grants in the verification block
-- rather than trusting this comment.

create or replace function public.email_queue(p_limit int default 100)
returns table (
  notification_id uuid,
  recipient_email text,
  full_name text,
  kind text,
  title text,
  body text,
  href text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    n.id,
    u.email::text,
    coalesce(nullif(trim(p.full_name), ''), 'there'),
    n.kind,
    n.title,
    n.body,
    n.href
  from public.notifications n
  join public.notification_kinds k on k.kind = n.kind
  join auth.users u on u.id = n.user_id
  left join public.profiles p on p.user_id = n.user_id
  where n.emailed_at is null
    -- Only kinds that actually use email. Per Ahmed's decision that is the
    -- three with a deadline attached: Microsoft 365 expiry, membership
    -- renewal, and the hour before an event you registered for. Everything
    -- else is in-app and push only, and this join is what enforces it.
    and 'email' = any (k.default_channels)
    -- The member's own choice, expressed once and read everywhere.
    and public.should_notify(n.user_id, n.kind, 'email')
    -- ⚠ Already read in the app? Then the email is noise. Somebody who has
    -- seen "your licence expires tomorrow" on their dashboard does not need it
    -- again in their inbox, and every avoidable email is a small push toward
    -- the spam button — which on a shared sending domain costs the club its
    -- ability to send anything at all.
    and n.read_at is null
    -- ⚠ A horizon, deliberately, exactly as push_queue has. Without it, the
    -- first run after deployment would mail every eligible notification ever
    -- created. A deadline reminder that arrives a week late is worse than one
    -- that never arrives: it is wrong AND it is from us.
    and n.created_at > now() - interval '24 hours'
    -- ⚠ NEVER MAIL AN UNCONFIRMED ADDRESS. Anyone can type anyone's email at
    -- signup; sending to one that was never proven means mailing a stranger
    -- about somebody else's account, and it is the fastest route to a spam
    -- complaint from a person who has no idea who we are.
    and u.email is not null
    and u.email_confirmed_at is not null
  order by n.created_at
  limit greatest(1, least(p_limit, 500));
$$;

create or replace function public.mark_emailed(p_ids uuid[])
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
       set emailed_at = now()
     where id = any (p_ids) and emailed_at is null
    returning 1
  )
  select count(*)::int into v_count from updated;
  return v_count;
end;
$$;

-- ============================================================
-- 3. Grants — the trap 0047 already caught once
-- ============================================================
--
-- ⚠ Postgres grants EXECUTE to PUBLIC by default; every migration here
-- revokes that, and `service_role` is an ordinary role so the revoke removes
-- it from service_role too. Every Edge Function runs as service_role. Without
-- the explicit grant back, the sender fails on its first call with
-- "permission denied for function" — inside a scheduled job where nobody reads
-- the output. This is the same bug 0047 caught for push; it is written down
-- twice because it will happen a third time.

revoke execute on function public.email_queue(int) from public, anon, authenticated;
revoke execute on function public.mark_emailed(uuid[]) from public, anon, authenticated;

grant execute on function public.email_queue(int) to service_role;
grant execute on function public.mark_emailed(uuid[]) to service_role;

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. ⚠ THE ONE THAT MATTERS MOST. email_queue returns email addresses, so no
--    client role may execute it (expect ZERO rows):
--
--   select routine_name, grantee from information_schema.routine_privileges
--    where routine_schema = 'public'
--      and routine_name in ('email_queue', 'mark_emailed')
--      and grantee in ('anon', 'authenticated', 'PUBLIC');
--
--    …and service_role MUST have both, or the sender dies in a cron job
--    (expect 2 rows):
--
--   select routine_name, grantee from information_schema.routine_privileges
--    where routine_schema = 'public' and grantee = 'service_role'
--      and routine_name in ('email_queue', 'mark_emailed');
--
-- 2. What is actually due right now, and who for. Run BEFORE deploying the
--    sender so the first real run holds no surprises — if this returns 400
--    rows, something is wrong with the horizon, not with the mail:
--
--   select count(*) as due from public.email_queue(500);
--
--   select kind, count(*) from public.email_queue(500) group by kind order by 2 desc;
--
-- 3. Only the three deadline kinds can ever appear. Anything else here means
--    a kind gained 'email' in its default_channels by accident (expect
--    exactly: premium_renewal, ms365_expiring_30/10/3/1, event_starting_soon):
--
--   select kind, default_channels from public.notification_kinds
--    where 'email' = any (default_channels) order by kind;
--
-- 4. An unconfirmed address is never queued. With a signed-up-but-unconfirmed
--    user holding an eligible notification, they must NOT appear:
--
--   select u.email, u.email_confirmed_at
--     from auth.users u
--    where u.email_confirmed_at is null
--      and exists (select 1 from public.notifications n
--                   where n.user_id = u.id and n.emailed_at is null);
--   -- any rows here must be ABSENT from public.email_queue(500)
--
-- 5. mark_emailed is idempotent — a second call over the same ids returns 0:
--
--   select public.mark_emailed(array(select notification_id from public.email_queue(5)));
--   select public.mark_emailed(array(select notification_id from public.email_queue(5)));
--   -- the second must be 0, and the queue must have shrunk
--
-- 6. ⚠ AS AN ORDINARY MEMBER — the queue is unreachable. This is the check
--    that proves member emails are not exposed, and it cannot be answered by
--    reading a grant:
--
--   select * from public.email_queue(10);
--   -- expect: ERROR permission denied for function email_queue
