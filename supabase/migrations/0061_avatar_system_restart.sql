-- 0061 — the avatar system restart, one-off
-- ============================================================
--
-- Ahmed, 8 Aug 2026: "reset the photo creation limit, make the consumption 0,
-- let them generate new avatar, then update all of them avatar image based on
-- the new prompt."
--
-- ⚠ PASTE THIS IN SMALL PIECES. The Supabase SQL editor silently refuses
-- statements over ~1,000 characters — it reports "Success", runs nothing, and
-- the NEXT statement executes against the OLD editor contents. Verify against
-- pg_proc / information_schema, never against the UI.
--
-- ============================================================
-- What this migration does NOT do, and why
-- ============================================================
--
-- It does not redraw anybody. It makes them ELIGIBLE to be redrawn, and
-- `refresh-avatars` does the drawing afterwards in batches. That separation is
-- deliberate: the drawing costs money per member and happens outside a
-- transaction, so a migration that did both would be a migration that cannot
-- be rolled back.
--
-- It also does not reset `avatar_attempts` for the members it makes eligible,
-- because refresh-avatars already does: "the club redrawing everyone must not
-- cost a member one of their own three tries for the month." Setting it here
-- as well would be harmless and is done anyway for the members the redraw will
-- never reach — see §3.
--
-- ============================================================
-- Three populations, not one
-- ============================================================
--
-- "Everyone who uploaded a photo" turns out to be three groups with three
-- different outcomes, because of how the redraw sources its base image.
-- refresh-avatars redraws THE MEMBER'S CURRENT AVATAR, downloaded from our own
-- bucket — the original upload was wiped at generation time and
-- `source_purged_at` is the receipt, so there is no photograph to go back to.
--
--   A. Avatar is a file in the `avatars` bucket (uploaded or previously
--      generated), not an SVG. → genuinely redrawn on the new prompt.
--
--   B. Avatar is a LINK to Google / Microsoft / LinkedIn. → storagePathFor()
--      returns null, because following an arbitrary URL out of a
--      member-writable column from a service-role job is a request-forgery
--      hole. The member gets `uploadFallback()` — THE INITIALS TILE.
--
--   C. No avatar, or sitting on last month's fallback SVG. → initials tile,
--      same path as B.
--
-- ⚠ SO "INCLUDE EVERYONE" WOULD REPLACE GROUP B's REAL PHOTOGRAPH WITH A
-- LETTER TILE. That is not a new avatar, it is the removal of one, and the
-- announcement email would be plainly false for those members. This migration
-- therefore makes only group A eligible for the forced redraw. Group B and C
-- get the allowance reset instead (§3), which is the part of the ask that is
-- actually deliverable for them: they can generate whenever they like, and the
-- club has not quietly taken their picture away to do it.
--
-- ============================================================
-- The 0038 override, and why it is recorded rather than just done
-- ============================================================
--
-- `avatar_is_photo = true` means a member saw their drawing, did not like it,
-- and kept their photograph. 0038 exists to stop the monthly job overwriting
-- that, and privacy.html was rewritten around the promise.
--
-- Ahmed's decision, 8 Aug 2026, asked twice and confirmed: include them.
--
-- That is his call to make. What is NOT acceptable is making it
-- irreversibly — so §1 snapshots every value this migration disturbs, per
-- member, BEFORE disturbing it, and §4 gives one function that puts any single
-- member back. A member who asks for their photo back can have it in one call
-- instead of a support conversation that ends in "it is gone".
--
-- ⚠ For group A photo-keepers the snapshot is what makes the restore possible
-- at all: the redraw overwrites `avatar_url`, and while the underlying file
-- usually survives in the bucket, nothing else records which URL was theirs.

-- ============================================================
-- 1. The snapshot
-- ============================================================

create table if not exists public.avatar_restart_2026_08 (
  user_id uuid primary key references auth.users(id) on delete cascade,
  cohort text not null,
  prior_avatar_url text,
  prior_avatar_is_photo boolean,
  prior_avatar_is_generated boolean,
  prior_avatar_source text,
  prior_avatar_cycle text,
  prior_avatar_attempts integer,
  recorded_at timestamptz not null default now(),
  restored_at timestamptz,
  -- ⚠ The announcement's own bookkeeping, kept HERE rather than in a second
  -- table because the audience for the mail is exactly this snapshot: the
  -- members who existed at the moment of the restart. Somebody who signs up
  -- tomorrow must not be told we redrew an avatar they never had.
  --
  -- `announced_at` is stamped only after send-transactional-email returns
  -- cleanly, so a crash mid-run costs at most one duplicate. `announce_error`
  -- is the other half: a send that fails leaves a reason behind instead of a
  -- member who is silently never told.
  announced_at timestamptz,
  announce_error text
);

create index if not exists avatar_restart_2026_08_pending_idx
  on public.avatar_restart_2026_08 (announced_at)
  where announced_at is null;

comment on table public.avatar_restart_2026_08 is
  'Point-in-time snapshot taken before the 8 Aug 2026 avatar restart. Exists '
  'so the 0038 override is reversible per member: restore_avatar_from_restart() '
  'reads it. Not a log — one row per member, written once.';

alter table public.avatar_restart_2026_08 enable row level security;

-- ⚠ Supabase grants ALL on a new table to anon and authenticated by default.
-- Revoking is the fix, not belt and braces — this table carries every
-- member's avatar URL and their photo-keeping choice.
revoke all on public.avatar_restart_2026_08 from anon, authenticated;

-- No policies at all: service_role bypasses RLS, and nothing else has business
-- reading this. A staff-read policy would be the same mistake 0047 warns about
-- on push_subscriptions.

-- ============================================================
-- 2. Record, then make group A eligible
-- ============================================================
--
-- The cohort test mirrors storagePathFor() in refresh-avatars exactly. If the
-- two ever disagree, this migration promises a redraw the job will not deliver.

insert into public.avatar_restart_2026_08 (
  user_id, cohort, prior_avatar_url, prior_avatar_is_photo,
  prior_avatar_is_generated, prior_avatar_source,
  prior_avatar_cycle, prior_avatar_attempts
)
select
  p.user_id,
  case
    when coalesce(p.avatar_url, '') like '%/storage/v1/object/public/avatars/%'
     and lower(split_part(p.avatar_url, '?', 1)) not like '%.svg'
     and position('..' in p.avatar_url) = 0
    then 'A_redrawable'
    when coalesce(p.avatar_url, '') <> '' then 'B_external_link'
    else 'C_no_avatar'
  end,
  p.avatar_url, p.avatar_is_photo, p.avatar_is_generated,
  p.avatar_source, p.avatar_cycle, p.avatar_attempts
from public.profiles p
on conflict (user_id) do nothing;

-- Group A: eligible for the redraw. Clearing `avatar_cycle` is what puts them
-- into `avatars_due_refresh`; clearing `avatar_is_photo` is the 0038 override.
update public.profiles p
   set avatar_cycle = null,
       avatar_attempts = 0,
       avatar_is_photo = false
 where exists (
         select 1 from public.avatar_restart_2026_08 r
          where r.user_id = p.user_id and r.cohort = 'A_redrawable'
       );

-- ============================================================
-- 3. Everyone else: the allowance, and nothing else
-- ============================================================
--
-- The allowance is what they need: `avatar_attempts_this_cycle()` reads the
-- stored count only while the cycle is the current month, so zeroing it hands
-- back all three tries immediately.

update public.profiles p
   set avatar_attempts = 0
 where exists (
         select 1 from public.avatar_restart_2026_08 r
          where r.user_id = p.user_id and r.cohort <> 'A_redrawable'
       )
   and coalesce(p.avatar_attempts, 0) <> 0;

-- ⚠⚠ AND THIS STATEMENT, WHICH THE FIRST VERSION OF THIS MIGRATION DID NOT
-- HAVE. Read the reasoning it replaces, because the mistake is instructive.
--
-- That version argued: "`avatar_cycle` is deliberately NOT cleared for these
-- members. Clearing it would put them into `avatars_due_refresh` and the job
-- would hand them an initials tile instead of the picture they have now."
--
-- Every word of that is true and the conclusion is still wrong, because it
-- assumed they had a cycle to leave alone. **THEY DID NOT.** Measured on the
-- real database, 8 Aug: group B 4 of 4 and group C 7 of 7 had
-- `avatar_cycle IS NULL` — they have never had an avatar generated, so they
-- were ALREADY sitting in `avatars_due_refresh` and had been all along.
-- Declining to clear a null protected nobody. `avatars_due_refresh` returned
-- **19** where the migration expected 8.
--
-- The redraw would therefore have processed all 19 and given the four members
-- holding a real Google or Microsoft photograph a two-letter tile — the exact
-- outcome the "Three populations" section exists to prevent, arrived at by a
-- different road.
--
-- ⚠ It was caught only because verification 2 asked for the number instead of
-- assuming it. A migration that had trusted its own comment would have looked
-- entirely successful right up until the pictures vanished.
--
-- Stamping the current cycle takes them out of the queue for this run. It
-- costs them nothing — their allowance is already back to three, set above,
-- because `avatar_attempts_this_cycle()` reads the stored count only when the
-- cycle matches, and it now does.

update public.profiles p
   set avatar_cycle = to_char(now(), 'YYYY-MM')
 where exists (
         select 1 from public.avatar_restart_2026_08 r
          where r.user_id = p.user_id and r.cohort <> 'A_redrawable'
       );

-- ⚠ THIS IS A PATCH ON THIS MONTH, NOT A FIX. Next month these members fall
-- out of the current cycle and back into `avatars_due_refresh`, and whoever
-- runs the monthly job then will hand group B their initials tile after all.
--
-- The real fix is that `avatars_due_refresh` should never offer a member whose
-- avatar is not redrawable in the first place: refresh-avatars' fallback branch
-- was written for "a member with no avatar at all, and one sitting on last
-- month's fallback SVG", and the provider-link case that 0038 introduced later
-- was never added to its reasoning. That is a change to the monthly job's
-- behaviour for everybody, so it is written down here and deliberately NOT
-- done as a side effect of a one-off announcement.

-- ============================================================
-- 4. Putting one member back
-- ============================================================
--
-- Deliberately one member at a time and deliberately not a bulk undo: by the
-- time anybody calls this, other members will have generated avatars of their
-- own that they chose and want to keep. A blanket rollback would take those
-- away too.

create or replace function public.restore_avatar_from_restart(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  if not public.is_staff() then
    raise exception 'not allowed';
  end if;

  select * into v
    from public.avatar_restart_2026_08
   where user_id = p_user_id and restored_at is null;

  if not found then
    return false;
  end if;

  update public.profiles
     set avatar_url = v.prior_avatar_url,
         avatar_is_photo = v.prior_avatar_is_photo,
         avatar_is_generated = v.prior_avatar_is_generated,
         avatar_source = v.prior_avatar_source
   where user_id = p_user_id;

  update public.avatar_restart_2026_08
     set restored_at = now()
   where user_id = p_user_id;

  return true;
end;
$$;

-- ⚠ A definer function executable by PUBLIC is a hole, and revoking from
-- PUBLIC also removes service_role, which is what every Edge Function runs as.
-- 0047 §4 is the precedent: grant it back explicitly.
revoke all on function public.restore_avatar_from_restart(uuid) from public, anon;
grant execute on function public.restore_avatar_from_restart(uuid) to authenticated, service_role;

comment on function public.restore_avatar_from_restart(uuid) is
  'Puts one member back to their pre-8-Aug-2026 avatar and photo-keeping '
  'choice. Staff only. Returns false if there is nothing to restore.';

-- ============================================================
-- Verification — run every one of these
-- ============================================================
--
-- ⚠ Read the counts BEFORE running §2/§3 as well, so "0 rows changed" can be
-- told apart from "0 rows matched".
--
-- 1. The three populations, and their sizes. Group A is what the redraw will
--    cost money on; B is who would have been downgraded to letters:
--
--   select cohort, count(*), count(*) filter (where prior_avatar_is_photo) as photo_keepers
--     from public.avatar_restart_2026_08 group by cohort order by cohort;
--
-- 2. Everyone in group A is now due, and nobody else moved into the queue.
--    The second number must equal the first:
--
--   select (select count(*) from public.avatar_restart_2026_08 where cohort = 'A_redrawable'
--            and prior_avatar_is_photo is not null) as group_a,
--          (select count(*) from public.avatars_due_refresh) as due_now;
--
--    ⚠ `due_now` can legitimately be SMALLER: avatars_due_refresh also
--    requires `is_discoverable`. A member who is hidden from the directory is
--    not redrawn, which is correct. If it is LARGER, something else cleared a
--    cycle and this migration is not the only thing running.
--
-- 3. Nobody outside group A had their cycle disturbed (expect 0):
--
--   select count(*) from public.profiles p
--     join public.avatar_restart_2026_08 r using (user_id)
--    where r.cohort <> 'A_redrawable' and p.avatar_cycle is distinct from r.prior_avatar_cycle;
--
-- 4. Every member now has their full allowance (expect 0):
--
--   select count(*) from public.profiles where coalesce(avatar_attempts, 0) <> 0;
--
-- 5. The snapshot is unreachable from a client (expect 0 rows):
--
--   select grantee, privilege_type from information_schema.table_privileges
--    where table_schema = 'public' and table_name = 'avatar_restart_2026_08'
--      and grantee in ('anon', 'authenticated');
--
-- 6. The restore actually works, and this is the check worth not skipping —
--    the whole reversibility argument rests on it. Pick one group A member who
--    is NOT a photo-keeper, note their avatar_url, call the function, confirm
--    the URL came back, then call it again and confirm it returns false:
--
--   select public.restore_avatar_from_restart('<user_id>');
--
--    ⚠ Do this BEFORE the redraw runs, while prior_avatar_url is still the
--    live one, so a failure costs nothing. Then re-clear that member's cycle
--    so they are picked up with everybody else:
--      update public.profiles set avatar_cycle = null, avatar_is_photo = false
--       where user_id = '<user_id>';
--      update public.avatar_restart_2026_08 set restored_at = null
--       where user_id = '<user_id>';
