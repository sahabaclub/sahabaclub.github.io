-- Sahaba Club — when the free 3 months actually start, and staff control
-- ------------------------------------------------------------
-- Two things this fixes.
--
-- 1. The free period had no start. `link_my_ms365_mailbox()` (0021) recorded
--    the mailbox but never set `license_expires_at`, so the dashboard fell
--    through to "Your free 3 months start as soon as the account is ready" —
--    for members whose account already existed and was ready years ago. The
--    clock now starts the day a member links or creates, which is the day the
--    club's obligation actually begins, not the day the mailbox was made.
--
-- 2. Staff had no controls. There was no way to block someone, remove
--    someone, or say "this person's licence never lapses".
--
-- On "no expiry": a NULL `license_expires_at` already means "not started
-- yet", so it cannot also mean "never expires" without the two becoming
-- indistinguishable. Hence an explicit `licence_exempt` flag. Exempt accounts
-- are never deactivated by any automated sweep — only a human can take the
-- licence away, which is what was asked for.

-- ============================================================
-- Columns
-- ============================================================

alter table public.ms365_accounts
  add column if not exists licence_exempt boolean not null default false;

comment on column public.ms365_accounts.licence_exempt is
  'Staff-set. When true the free-period clock does not apply and no automated '
  'sweep may deactivate this licence — removal is a manual act only.';

alter table public.profiles
  add column if not exists blocked_at timestamptz,
  add column if not exists blocked_reason text;

-- NOTE for anyone adding to profiles later: this table uses an explicit
-- column-level UPDATE allowlist (0002 → 0005 → 0017 → 0019). `blocked_at` and
-- `blocked_reason` are staff-only, so they are deliberately NOT granted here.
-- Remember that a column-level REVOKE is a no-op when the grant was never
-- made — the protection comes from never granting, not from revoking.

-- ============================================================
-- Start the clock on linking
-- ============================================================

-- Same contract as 0021: no arguments, keyed on auth.uid()'s own confirmed
-- email. See 0021's header for why that is load-bearing.
create or replace function public.link_my_ms365_mailbox()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_mailbox text;
  v_linked boolean;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  select m.mailbox, m.already_linked into v_mailbox, v_linked
  from public.my_ms365_match() m;

  if v_mailbox is null then
    raise exception 'no Microsoft 365 account is on record for your email address';
  end if;
  if v_linked then
    return v_mailbox;
  end if;

  -- The free period starts today, because today is when this member claimed
  -- it. The mailbox may be years old; that is not the member's benefit.
  insert into public.ms365_accounts
    (user_id, mailbox, status, pre_existing, license_expires_at, credential_sent_at)
  values
    (v_uid, v_mailbox, 'active', true, (current_date + interval '3 months')::date, null)
  on conflict (user_id) do update
    set mailbox = excluded.mailbox,
        pre_existing = true,
        status = 'active',
        -- Never restart a clock that is already running, and never overwrite
        -- an exemption a human has granted.
        license_expires_at = case
          when public.ms365_accounts.licence_exempt then public.ms365_accounts.license_expires_at
          when public.ms365_accounts.license_expires_at is null then (current_date + interval '3 months')::date
          else public.ms365_accounts.license_expires_at
        end,
        updated_at = now();

  return v_mailbox;
end;
$fn$;

revoke all on function public.link_my_ms365_mailbox() from public, anon;
grant execute on function public.link_my_ms365_mailbox() to authenticated;

-- ============================================================
-- Staff control
-- ============================================================

-- Every function here is staff-gated on its first line rather than relying on
-- RLS, because they are all `security definer` and therefore bypass it.

create or replace function public.admin_set_ms365_expiry(
  p_user_id uuid,
  p_expires_on date
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  update public.ms365_accounts
     set license_expires_at = p_expires_on,
         licence_exempt = false,
         updated_at = now()
   where user_id = p_user_id;
end;
$fn$;

-- "Remove the expiry date and stop it ever being deactivated automatically."
create or replace function public.admin_exempt_ms365_licence(
  p_user_id uuid,
  p_exempt boolean default true
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  update public.ms365_accounts
     set licence_exempt = p_exempt,
         -- Exempting clears the date so nothing downstream reads a stale one;
         -- un-exempting restarts the clock from today rather than reviving a
         -- date that has silently gone by.
         license_expires_at = case
           when p_exempt then null
           else (current_date + interval '3 months')::date
         end,
         status = case when p_exempt then 'active' else status end,
         updated_at = now()
   where user_id = p_user_id;
end;
$fn$;

-- Blocking uses auth.users.banned_until, which is what actually stops a
-- sign-in. A flag on profiles alone would leave the account perfectly usable.
create or replace function public.admin_block_member(
  p_user_id uuid,
  p_blocked boolean default true,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp, auth
as $fn$
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  if p_user_id = auth.uid() then
    raise exception 'you cannot block your own account';
  end if;

  update auth.users
     set banned_until = case when p_blocked then 'infinity'::timestamptz else null end
   where id = p_user_id;

  update public.profiles
     set blocked_at = case when p_blocked then now() else null end,
         blocked_reason = case when p_blocked then p_reason else null end,
         updated_at = now()
   where user_id = p_user_id;
end;
$fn$;

-- Forgets the mailbox on our side. It does NOT delete the Microsoft account —
-- that is a Graph call and belongs in an Edge Function, because doing it here
-- would mean the database could silently destroy tenant objects.
create or replace function public.admin_forget_ms365_account(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  delete from public.ms365_accounts where user_id = p_user_id;
end;
$fn$;

-- Deletes the member outright. Everything keyed to the user cascades from
-- auth.users, so this really is irreversible.
create or replace function public.admin_delete_member(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp, auth
as $fn$
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  if p_user_id = auth.uid() then
    raise exception 'you cannot delete your own account';
  end if;
  -- Staff and admins are not deletable through this path. Removing the last
  -- admin by accident is not a recoverable mistake from inside the app.
  if exists (select 1 from public.profiles
              where user_id = p_user_id and role in ('staff','admin')) then
    raise exception 'demote this member from staff before deleting them';
  end if;

  delete from auth.users where id = p_user_id;
end;
$fn$;

-- ============================================================
-- Access
-- ============================================================

revoke all on function public.admin_set_ms365_expiry(uuid, date) from public, anon, authenticated;
revoke all on function public.admin_exempt_ms365_licence(uuid, boolean) from public, anon, authenticated;
revoke all on function public.admin_block_member(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.admin_forget_ms365_account(uuid) from public, anon, authenticated;
revoke all on function public.admin_delete_member(uuid) from public, anon, authenticated;

-- `authenticated` needs EXECUTE for the admin screen to call these at all;
-- the is_staff() check inside each one is the real gate, and a non-staff
-- caller gets 'not allowed' rather than silent success.
grant execute on function public.admin_set_ms365_expiry(uuid, date) to authenticated;
grant execute on function public.admin_exempt_ms365_licence(uuid, boolean) to authenticated;
grant execute on function public.admin_block_member(uuid, boolean, text) to authenticated;
grant execute on function public.admin_forget_ms365_account(uuid) to authenticated;
grant execute on function public.admin_delete_member(uuid) to authenticated;

-- ============================================================
-- Backfill
-- ============================================================

-- Anyone already linked but with no clock started gets one from today. This
-- is the row behind Ahmed's screenshot: an active mailbox, no expiry, and a
-- dashboard message about the account not being ready yet.
update public.ms365_accounts
   set license_expires_at = (current_date + interval '3 months')::date,
       updated_at = now()
 where license_expires_at is null
   and licence_exempt = false
   and status = 'active';

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- No active account should be left without a clock or an exemption:
--   select count(*) from public.ms365_accounts
--    where status = 'active' and license_expires_at is null and not licence_exempt;
--   -- expect 0
--
-- The admin functions must all be staff-gated. As a non-staff member every one
-- of these must raise 'not allowed':
--   select public.admin_block_member('<some user id>', true);
--
-- Members must NOT be able to write the new columns (expect zero rows):
--   select column_name from information_schema.column_privileges
--    where table_schema='public' and table_name='profiles'
--      and column_name in ('blocked_at','blocked_reason')
--      and privilege_type='UPDATE' and grantee in ('anon','authenticated');
--
-- Blocking really blocks — banned_until is what auth checks:
--   select banned_until from auth.users where id = '<user id>';
