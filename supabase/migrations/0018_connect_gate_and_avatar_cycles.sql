-- Sahaba Club — Connect requires a real profile, avatars refresh monthly
-- ------------------------------------------------------------
-- Two changes:
--   1. You cannot appear in Connect until your profile is worth showing.
--   2. Avatar generation is a monthly cycle, not a one-off allowance.

-- ============================================================
-- 1. The Connect gate
-- ============================================================

-- What "filled in" means, in one place. Both the gate below and any page that
-- wants to show a progress meter read this, so the rule can never drift
-- between what we enforce and what we tell the member they still need.
create or replace function public.profile_is_complete(p public.profiles)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select
        nullif(trim(coalesce(p.full_name, '')), '')  is not null
    and nullif(trim(coalesce(p.avatar_url, '')), '') is not null
    and (
         nullif(trim(coalesce(p.bio, '')), '')      is not null
      or nullif(trim(coalesce(p.headline, '')), '') is not null
    )
    and coalesce(array_length(p.interests, 1), 0) > 0;
$fn$;

-- Enforced with a trigger rather than a CHECK constraint: a CHECK would also
-- reject rows that are already discoverable when an unrelated column changes,
-- and would fire on the seeded rows. This only objects at the moment someone
-- tries to *become* discoverable.
--
-- It also silently un-discovers anyone whose profile stops being complete —
-- clearing your avatar should take you out of the directory, not leave a
-- half-empty card on the wall.
create or replace function public.enforce_connect_gate()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if new.is_discoverable and not public.profile_is_complete(new) then
    if coalesce(old.is_discoverable, false) then
      -- Was visible, profile has since lost something required. Withdraw
      -- quietly rather than blocking the edit they are in the middle of.
      new.is_discoverable := false;
    else
      raise exception
        'Finish your profile before joining Connect: a name, a photo, a short bio or headline, and at least one interest.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists profiles_connect_gate on public.profiles;
create trigger profiles_connect_gate
  before insert or update on public.profiles
  for each row execute function public.enforce_connect_gate();

-- ============================================================
-- 2. Avatar cycles
-- ============================================================

-- The three tries were never meant to be a lifetime allowance — they are
-- three shots at getting a likeness the member is happy with. Every month
-- the club regenerates everyone's avatar on a fresh theme, which is the
-- point of the feature: the same person, rendered differently, so the wall
-- looks alive rather than frozen. The cost is the club's, deliberately.
alter table public.profiles
  add column if not exists avatar_cycle text,           -- 'YYYY-MM' of the current allowance
  add column if not exists avatar_theme text,           -- the month's theme, for the prompt
  add column if not exists avatar_refreshed_at timestamptz;

-- Attempts are per-cycle. Reading through this function instead of the raw
-- column means a member who has not been seen since last month gets their
-- three tries back automatically, with no reset job required.
create or replace function public.avatar_attempts_this_cycle(p public.profiles)
returns int
language sql
stable
set search_path = public, pg_temp
as $fn$
  select case
    when p.avatar_cycle is distinct from to_char(now(), 'YYYY-MM') then 0
    else coalesce(p.avatar_attempts, 0)
  end;
$fn$;

-- Members cannot write any of these three, and it is worth being precise about
-- WHY, because the obvious line here would be a no-op:
--
--   revoke update (avatar_cycle, ...) on public.profiles from authenticated;
--
-- A column-level REVOKE only removes a privilege that was actually granted.
-- These columns were never granted, so that statement succeeds, changes
-- nothing, and leaves behind a line that reads like a control while doing no
-- work. Worse, the natural verification query then passes for the wrong
-- reason and would keep passing even if someone later granted them.
--
-- What genuinely protects them is 0002's design, continued by 0017: the
-- table-wide UPDATE on profiles is revoked and privileges are handed back as
-- an explicit column allowlist. A new column is unwritable by default. So the
-- correct action here is to add nothing, and to say so.
--
-- The check below is therefore the real control: it asserts the allowlist
-- never picked these up.

-- Who the monthly job should pick up: everyone discoverable whose avatar was
-- not already generated in the current cycle. Ordered oldest-first so an
-- interrupted run resumes sensibly instead of re-doing the same people.
create or replace view public.avatars_due_refresh
with (security_invoker = off) as
select p.user_id, p.full_name, p.interests, p.skills, p.industry,
       p.avatar_cycle, p.avatar_refreshed_at
from public.profiles p
where p.is_discoverable
  and coalesce(p.avatar_cycle, '') is distinct from to_char(now(), 'YYYY-MM')
order by p.avatar_refreshed_at nulls first;

revoke all on public.avatars_due_refresh from anon, authenticated;

-- ============================================================
-- Verification
-- ============================================================
--
-- The gate: as a member with an empty profile, this must RAISE, not succeed —
--   update public.profiles set is_discoverable = true where user_id = auth.uid();
--
-- Completeness and gate must agree (expect zero rows: nobody visible while
-- incomplete):
--   select user_id from public.profiles p
--    where p.is_discoverable and not public.profile_is_complete(p);
--
-- Attempts must reset across a month boundary (expect 0 for anyone whose
-- avatar_cycle is not the current month):
--   select user_id, avatar_attempts, public.avatar_attempts_this_cycle(p)
--   from public.profiles p where avatar_cycle is distinct from to_char(now(),'YYYY-MM')
--   limit 5;
--
-- Members must not be able to write the cycle columns (expect zero rows):
--   select column_name from information_schema.column_privileges
--    where table_name='profiles' and grantee='authenticated'
--      and privilege_type='UPDATE'
--      and column_name in ('avatar_cycle','avatar_theme','avatar_refreshed_at');
