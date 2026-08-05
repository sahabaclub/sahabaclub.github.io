-- 0039 — show a member their own Microsoft 365 starter password
-- ============================================================
--
-- Ahmed's ask, 4 Aug 2026: the credential email is not arriving, and members
-- should be able to see their Microsoft 365 address and password on their own
-- dashboard, hidden behind a reveal.
--
-- WHAT IS ACTUALLY BEING STORED, because it decides everything below. Accounts
-- are created by _shared/graph.ts with:
--
--     passwordProfile: { password: tempPassword, forceChangePasswordNextSignIn: true }
--
-- so this is a ONE-USE STARTER PASSWORD. Microsoft invalidates it the moment
-- the member first signs in and makes them choose their own. The club never
-- has, and after this migration still never has, a member's real Microsoft
-- password. Anything in the UI that implies otherwise is wrong and should be
-- fixed rather than explained.
--
-- ⚠ WHY THIS IS NOT A COLUMN ON `ms365_accounts`, which is the obvious place.
-- That table carries `ms365_accounts: staff read all` (0003) — a policy that
-- lets any staff account SELECT every row. A password column there would be
-- readable by every staff member for every member, and a starter password plus
-- a mailbox is enough to sign in AS that member before they ever do. A separate
-- table with one policy is the difference between "the member can see their own
-- password" and "staff can see everybody's".
--
-- There is deliberately NO staff policy here. Staff who need to help someone
-- who cannot get in already have the right tool: the reset request flow
-- (`request_ms365_password_reset`, 0021), which issues a fresh password through
-- an audited path instead of reading an old one.

create table if not exists public.ms365_credentials (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  -- The starter password, exactly as handed to Microsoft. Not hashed, because
  -- a hash cannot be shown to the member and showing it to the member is the
  -- entire purpose. This is why the row is short-lived and narrowly readable.
  temp_password text        not null,
  created_at    timestamptz not null default now(),
  -- After this the row is invisible to the member (see the policy) and only the
  -- service role can still see it, so a forgotten credential does not sit
  -- readable for ever. Thirty days is far longer than the intended lifetime —
  -- the password dies at first sign-in — and short enough to be a real bound.
  expires_at    timestamptz not null default now() + interval '30 days'
);

comment on table public.ms365_credentials is
  'One-use Microsoft 365 starter passwords, readable only by the member they '
  'belong to and only until expires_at. Microsoft forces a password change at '
  'first sign-in, so this is never the member''s real password. No staff read '
  'policy, deliberately — see 0039.';

alter table public.ms365_credentials enable row level security;

-- The only policy on the table. Two predicates, both load-bearing:
--   auth.uid() = user_id   nobody reads anybody else's
--   expires_at > now()     an old credential stops being readable by itself,
--                          with no job needing to have run
drop policy if exists "ms365_credentials: read own unexpired" on public.ms365_credentials;
create policy "ms365_credentials: read own unexpired" on public.ms365_credentials
  for select using (auth.uid() = user_id and expires_at > now());

-- Supabase grants ALL on a new table to anon and authenticated, so the revoke
-- has to come first and the grant has to be narrow. Members read; they never
-- write. provision-ms365 writes with the service role, which bypasses RLS and
-- these grants alike.
revoke all on public.ms365_credentials from anon, authenticated;
grant select on public.ms365_credentials to authenticated;

-- ============================================================
-- Throwing it away
-- ============================================================
--
-- A member who has signed in and set their own password has no further use for
-- this, and the honest thing is to let them delete it rather than wait out the
-- thirty days. security definer because they hold no DELETE on the table and
-- are not going to be given one — a policy allowing DELETE would also allow a
-- row to be deleted by anything else running as that member.

create or replace function public.forget_my_ms365_password()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;
  delete from public.ms365_credentials where user_id = v_uid;
end;
$$;

revoke all on function public.forget_my_ms365_password() from public, anon, authenticated;
grant execute on function public.forget_my_ms365_password() to authenticated;

-- Housekeeping for whoever runs it: expired rows are already unreadable, but
-- unreadable is not the same as gone. Service-role only — no grant to clients.
create or replace function public.purge_expired_ms365_credentials()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from public.ms365_credentials where expires_at <= now();
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.purge_expired_ms365_credentials() from public, anon, authenticated;

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. Members may read, and may not write (expect exactly one row, SELECT):
--
--   select grantee, privilege_type from information_schema.table_privileges
--    where table_schema='public' and table_name='ms365_credentials'
--      and grantee in ('anon','authenticated');
--
-- 2. Exactly one policy, and it is a SELECT policy (expect one row):
--
--   select policyname, cmd, qual from pg_policies
--    where schemaname='public' and tablename='ms365_credentials';
--
-- 3. ⚠ There must be NO staff read path. Expect zero rows — if this ever
--    returns anything, a later migration has undone the point of this one:
--
--   select policyname from pg_policies
--    where schemaname='public' and tablename='ms365_credentials'
--      and qual ilike '%is_staff%';
--
-- 4. RLS is actually on (expect true):
--
--   select relrowsecurity from pg_class where oid = 'public.ms365_credentials'::regclass;
--
-- 5. As a signed-in member, an expired row must be invisible even to its owner:
--
--   -- as service role: insert a row with expires_at = now() - interval '1 day'
--   -- as that member:  select * from public.ms365_credentials;  -> zero rows
--
-- 6. forget_my_ms365_password is executable by members, not anon (expect one
--    row, 'authenticated'), and purge_expired_ms365_credentials by neither
--    (expect zero rows):
--
--   select routine_name, grantee from information_schema.routine_privileges
--    where routine_schema='public'
--      and routine_name in ('forget_my_ms365_password','purge_expired_ms365_credentials')
--      and grantee in ('anon','authenticated');
