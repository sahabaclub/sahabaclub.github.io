-- Sahaba Club — Microsoft 365 licence plans, admin control, and reminders
-- ------------------------------------------------------------
-- Until now every mailbox was the same thing: a 3-month trial that expires.
-- Three cases actually exist, and the difference is *why* the licence is
-- alive, not just when it dies:
--
--   trial     3 months from provisioning, then grace, then deletion.
--   lifetime  Alive as long as the member's Sahaba Club account is active.
--             Comped: coaches, influencers, close connections.
--   premium   Alive as long as the paid subscription is.
--
-- Only 'trial' has an expiry date, which is what makes the reminder job and
-- the member's countdown simple: no date, no countdown, nothing to chase.

-- ============================================================
-- Plans
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'ms365_plan') then
    create type public.ms365_plan as enum ('trial', 'lifetime', 'premium');
  end if;
end $$;

alter table public.ms365_accounts
  add column if not exists plan public.ms365_plan not null default 'trial';

-- Who comped this account and why. A lifetime licence is a real cost given
-- away, so "who approved this" needs to survive the conversation that
-- authorised it — six months on, nobody remembers.
alter table public.ms365_accounts
  add column if not exists granted_by uuid references auth.users (id) on delete set null;
alter table public.ms365_accounts
  add column if not exists granted_at timestamptz;
alter table public.ms365_accounts
  add column if not exists granted_note text;

-- ============================================================
-- Reminder tracking
-- ============================================================

-- The stage last sent, in days-before-expiry (30, 14, 7, 1). Storing the
-- stage rather than a bare timestamp is what stops the job sending the same
-- warning twice if it runs more than once a day, or catches up after an
-- outage and fires every stage at once.
alter table public.ms365_accounts
  add column if not exists reminder_stage int;
alter table public.ms365_accounts
  add column if not exists last_reminder_at timestamptz;

-- ============================================================
-- Staff control
-- ============================================================

-- 0003 gave staff SELECT on this table and nothing else, so the admin panel
-- could look at licences but never change one. Granting a lifetime licence,
-- extending a trial, or revoking access all need UPDATE.
--
-- Insert too: an admin adding a member who already had a mailbox before the
-- platform existed is a real case.
drop policy if exists "ms365_accounts: staff update" on public.ms365_accounts;
create policy "ms365_accounts: staff update" on public.ms365_accounts
  for update using (public.is_staff()) with check (public.is_staff());

drop policy if exists "ms365_accounts: staff insert" on public.ms365_accounts;
create policy "ms365_accounts: staff insert" on public.ms365_accounts
  for insert with check (public.is_staff());

-- Members must never be able to extend their own licence. They already have
-- SELECT on their own row from 0001; deliberately no UPDATE for them, and
-- Supabase's default grants are revoked so a future column can't leak in.
revoke update on public.ms365_accounts from authenticated, anon;
grant update (
  plan, status, license_expires_at, grace_ends_at,
  granted_by, granted_at, granted_note,
  reminder_stage, last_reminder_at, mailbox, pre_existing, updated_at
) on public.ms365_accounts to authenticated;

-- ============================================================
-- Days remaining, in one place
-- ============================================================

-- Both the member's countdown and the admin table need "how long left", and
-- two implementations of that would drift. Lifetime and premium return null
-- rather than a huge number, because "no expiry" is a different statement
-- from "expires in 9999 days" and the UI should be able to tell them apart.
create or replace function public.ms365_days_left(
  p_plan public.ms365_plan,
  p_expires date
)
returns int
language sql
immutable
as $fn$
  select case
    when p_plan <> 'trial' then null
    when p_expires is null then null
    else (p_expires - current_date)
  end;
$fn$;
