-- 0062 — Connect visibility needs only a name
-- ============================================================
--
-- Ahmed, 10 Aug 2026: "remove the condition if having 1 interest at least and
-- make it visible once you have a name at least."
--
-- ---- What this fixes -------------------------------------------------
--
-- Measured on the live database the same day: **26 members, all 26 flagged
-- `is_discoverable`, and 12 in `member_directory`.** Fourteen people had
-- switched themselves on and never appeared, because 0018 also demanded a
-- photograph, a bio or headline, and at least one interest. Of those fourteen:
--
--     all 14  had no interests        <- the universal blocker
--         9   had no avatar
--         7   had no bio and no headline
--         3   had no name at all
--
-- The gate was defensible — a directory of blank cards helps nobody — but it
-- was SILENT. Nothing on the site told those members why they were missing,
-- and every one of them was held out by the interests field alone. More than
-- half the membership was invisible in the club's own directory.
--
-- ⚠ It also skewed a number that looked like something else entirely: Connect
-- listed 74 people of whom only 12 were members and 62 were unclaimed prospect
-- profiles. That reads as "the club is mostly strangers". It was not — it was
-- most members being filtered out of their own directory.
--
-- ---- What the rule is now --------------------------------------------
--
-- A name. Nothing else.
--
-- ⚠ THIS IS A DELIBERATE TRADE, NOT AN OVERSIGHT. 11 members become visible
-- immediately and 6 of them will show a thin card — no picture, or no line of
-- text under their name. That is Ahmed's call and it is the right way round:
-- a member with a name and no photograph is a person somebody can find and
-- message, and being findable is what Connect is for. An empty card is a
-- smaller harm than an absent member.
--
-- ⚠ THREE MEMBERS STILL WILL NOT APPEAR, and they are not a bug: they have no
-- `full_name` at all. There is nothing to put on a card and nothing to search
-- for. They appear the moment they type a name.
--
-- ---- Everything this touches, in one place ---------------------------
--
-- `profile_is_complete` is called from five places and redefining it moves all
-- of them together, which is why the fix is one function and not five edits:
--
--     public.member_directory        (0023) the directory itself
--     public.enforce_connect_gate    (0018) refuses/withdraws discoverability
--     public.feed_on_member_visible  (0019) the "joined the club" post
--     admin_import_rows              (0033) staff import warning
--     0034's remediation check
--
-- ⚠ THE FEED TRIGGER IS THE ONE TO WATCH. `feed_on_member_visible` posts a
-- "joined the club" item when a row is inserted or updated while visible and
-- complete, and it does not fire on this migration — a function redefinition
-- updates no rows. So nothing is posted today. But the next time one of those
-- eleven profiles is updated for any reason, that member gets their joined
-- post, possibly weeks after they actually joined. It fires at most once each
-- (it checks for an existing post first), so the worst case is eleven late
-- announcements, not a loop. Left alone deliberately: suppressing it would
-- mean these members never get the post at all, which is worse than getting
-- it late.

-- ============================================================
-- 1. The rule
-- ============================================================

-- ⚠ The NAME of this function is now wider than what it checks, and renaming
-- it would ripple through a view, two triggers and two staff functions for no
-- behavioural gain. Read it as "complete enough to be listed", which is what
-- every caller actually asks it.
create or replace function public.profile_is_complete(p public.profiles)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select nullif(trim(coalesce(p.full_name, '')), '') is not null;
$fn$;

comment on function public.profile_is_complete(public.profiles) is
  'Is this profile listable in Connect? Since 0062: a non-empty full_name and '
  'nothing else. It previously also required an avatar, a bio or headline, and '
  'at least one interest, which silently held 14 of 26 members out of the '
  'directory they had opted into.';

-- ============================================================
-- 2. The sentence a member reads
-- ============================================================

-- ⚠ THE MESSAGE HAD TO MOVE WITH THE RULE. It read "a name, a photo, a short
-- bio or headline, and at least one interest" — four requirements, three of
-- which no longer exist. A refusal that names conditions the system does not
-- enforce sends somebody to fill in fields that were never the problem, and it
-- is exactly the kind of stale sentence this project keeps finding.
create or replace function public.enforce_connect_gate()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if new.is_discoverable and not public.profile_is_complete(new) then
    if coalesce(old.is_discoverable, false) then
      -- Was visible, profile has since lost its name. Withdraw quietly rather
      -- than blocking the edit they are in the middle of.
      new.is_discoverable := false;
    else
      raise exception
        'Add your name before joining Connect — it is the one thing a listing needs.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$fn$;

-- The trigger itself is unchanged and is NOT recreated here: it already points
-- at this function by name, and dropping it would risk a window in which a row
-- could be written past the gate.

-- ============================================================
-- 3. Verification — run these, do not assume
-- ============================================================
--
-- Expected on the live database on 10 Aug 2026, measured before writing this:
--
--   1. How many members can now be listed. Was 12, expect 23.
--
--        select count(*) from public.member_directory;
--
--   2. Who is still out, and it should be exactly 3, all for want of a name.
--
--        select count(*) from public.profiles p
--         where p.is_discoverable and not public.profile_is_complete(p);
--
--   3. The rule really is name-only: a profile with a name and nothing else
--      passes. Read-only, no row is written.
--
--        select public.profile_is_complete(
--          (select p from public.profiles p
--            where nullif(trim(coalesce(p.full_name,'')),'') is not null
--              and coalesce(array_length(p.interests,1),0) = 0
--            limit 1)
--        );                                            -- expect: true
--
--   4. THE CONTROL: the gate is relaxed, not removed. A profile with no name
--      must still fail, and the count must equal the three named above — if
--      this returns 0, the function is answering true for everything and the
--      rule has been deleted rather than widened.
--
--        select count(*) from public.profiles p
--         where not public.profile_is_complete(p);     -- expect: 3
