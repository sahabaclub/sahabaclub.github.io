-- 0038 — a member may keep a real photograph as their avatar
-- ============================================================
--
-- Until now every route to a profile picture ended in a drawing. Upload a
-- photo and it is redrawn; borrow the picture from Google, Microsoft or
-- LinkedIn and that is redrawn too; run out of tries and you get a tile of
-- your initials. The photograph itself was never kept — generate-avatar holds
-- it in memory, sends it to be redrawn, wipes the memory and stamps
-- `source_purged_at` to record that it did.
--
-- Ahmed's decision, 4 Aug 2026: a member who does not like their drawing may
-- keep the photo instead. That is a product decision, not a bug fix, and it
-- changes something this project had promised in writing — see the rewrite of
-- the "Avatars are drawings, not photographs" section of privacy.html, which
-- shipped with this migration. The promise "there is nowhere in this system a
-- photograph of you could be sitting" stops being true the moment somebody
-- uses this, so it stops being made.
--
-- Two things have to be true for the feature to work at all, and neither is
-- optional:
--
--   1. Somewhere to record the choice. `avatar_is_photo` below.
--   2. The monthly job has to honour it. `avatars_due_refresh` picks up every
--      discoverable member whose `avatar_cycle` is not the current month and
--      hands them to refresh-avatars to be redrawn. Without §3 a member would
--      choose their own face, and on the 1st of next month the club would
--      quietly replace it with an illustration they had already rejected.
--      That is the whole reason this is a migration and not a client change.

-- ============================================================
-- 1. The column
-- ============================================================
--
-- NOT granted to members, and deliberately so. `profiles` revokes the
-- table-wide UPDATE and hands privileges back as an explicit column allowlist
-- (0002 → 0005 → 0017 → 0019), so a new column is unwritable by default and
-- adding nothing here is the correct action. The verification block asserts
-- that rather than trusting it.
--
-- Why it must stay ungranted: this flag is what tells the monthly job to leave
-- somebody alone. A member who could write it directly could also clear it on
-- someone else's behalf if any future code path ever took a user_id — and more
-- practically, it travels with `avatar_url`, `avatar_is_generated` and
-- `avatar_cycle`, which are already ungranted for the same reason. One writer,
-- one place: the function below.

alter table public.profiles
  add column if not exists avatar_is_photo boolean not null default false;

comment on column public.profiles.avatar_is_photo is
  'True when avatar_url is a real photograph the member chose to keep, rather '
  'than a drawing. Set only by public.keep_photo_as_avatar(). Excludes the row '
  'from avatars_due_refresh so the monthly redraw cannot overwrite the choice.';

-- ============================================================
-- 2. Keeping a photo
-- ============================================================
--
-- Two sources reach this, and they store different things:
--
--   'upload'  the member's own file, already in the `avatars` bucket under
--             their own folder — 0016's insert policy allows exactly that and
--             nothing else, so a member cannot write into anyone else's.
--   'google' | 'microsoft' | 'linkedin'
--             a LINK to the picture on the provider's own server. Nothing is
--             copied. This is the case privacy.html has always documented as
--             its "one honest exception".
--
-- The URL is not checked against the caller's storage folder, and it is worth
-- being clear that this is not an oversight. Members hold UPDATE on
-- `avatar_url` (0005) and can already set it to any string they like; a check
-- here would buy nothing while breaking the provider case, whose URLs live on
-- hosts we do not control. What this function is actually for is the
-- provenance columns beside it, which members cannot write — so the record of
-- "this is a photograph, it was not drawn, do not redraw it" can only be
-- written by code that means it.
--
-- `avatar_cycle` is stamped with the current month for the same reason
-- `avatar_is_photo` exists: belt and braces against the refresh job, so even a
-- deployment running the pre-0038 view skips this member for the rest of the
-- month rather than redrawing them immediately.

create or replace function public.keep_photo_as_avatar(p_url text, p_source text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_url text := btrim(coalesce(p_url, ''));
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  -- Length before shape: a megabyte of text in a regex is a cheap way to make
  -- the database work hard for nothing.
  if length(v_url) = 0 or length(v_url) > 2048 then
    raise exception 'avatar url missing or too long';
  end if;

  -- https only. A data: URL would put the image itself in the column and get
  -- echoed into every page that renders a member; http: would break the
  -- padlock on a site served over TLS.
  if v_url !~ '^https://' then
    raise exception 'avatar url must be https';
  end if;

  if p_source is null or p_source not in ('upload', 'google', 'microsoft', 'linkedin') then
    raise exception 'unknown photo source';
  end if;

  update public.profiles set
    avatar_url        = v_url,
    avatar_is_photo   = true,
    -- Not a drawing, and the record should not claim it was. `avatar_source`
    -- already carries this vocabulary (0015's CHECK allows exactly these four
    -- plus 'fallback').
    avatar_is_generated = false,
    avatar_source     = p_source,
    -- The source was NOT purged — it is the avatar. Null is the honest value;
    -- a timestamp here would assert a deletion that never happened.
    source_purged_at  = null,
    avatar_status     = 'ready',
    avatar_error      = null,
    avatar_cycle      = to_char(now(), 'YYYY-MM'),
    avatar_refreshed_at = now()
  where user_id = v_uid;

  if not found then
    raise exception 'no profile for this account';
  end if;
end;
$$;

-- Supabase grants EXECUTE on new functions to anon and authenticated by
-- default, so the revoke has to come first and the grant has to be explicit.
-- anon must not hold this: it reads auth.uid() and would simply raise, but a
-- signed-out role holding EXECUTE on a security-definer writer is the kind of
-- thing that stops being harmless the moment somebody edits the body.
revoke all on function public.keep_photo_as_avatar(text, text) from public, anon, authenticated;
grant execute on function public.keep_photo_as_avatar(text, text) to authenticated;

-- ============================================================
-- 2b. Taking it back
-- ============================================================
--
-- Storing a photograph of somebody with no way for them to remove it is not a
-- thing this project is going to do, and until now there was no way: no page
-- had a "remove my picture" control, and nothing anywhere called
-- storage.remove(). That was survivable while every avatar was a drawing
-- generated from a source we destroyed. It stops being survivable the moment
-- §2 above lets a real photograph be kept.
--
-- The storage object is deleted by the client, which can do it under 0016's
-- own-folder delete policy. This resets the row that goes with it — including
-- `avatar_is_photo`, which the member cannot write, and which would otherwise
-- leave them permanently excluded from the monthly redraw after clearing a
-- photo they no longer have.

create or replace function public.clear_my_avatar()
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

  update public.profiles set
    avatar_url        = null,
    avatar_is_photo   = false,
    avatar_is_generated = false,
    avatar_source     = null,
    source_purged_at  = null,
    avatar_status     = null,
    avatar_error      = null,
    -- Cleared, not stamped. Leaving the current month here would make the
    -- member invisible to the monthly job until the 1st; nulling it means the
    -- next run offers them a fresh drawing, which is the sensible default for
    -- somebody who has just removed their picture.
    avatar_cycle      = null
  where user_id = v_uid;

  if not found then
    raise exception 'no profile for this account';
  end if;
end;
$$;

revoke all on function public.clear_my_avatar() from public, anon, authenticated;
grant execute on function public.clear_my_avatar() to authenticated;

-- ============================================================
-- 3. The monthly job must skip them
-- ============================================================
--
-- Identical to 0018's view but for the last predicate. Restated in full rather
-- than patched, because `create or replace view` cannot add a WHERE clause and
-- the column list has to match 0018's exactly or the replace is rejected.

create or replace view public.avatars_due_refresh
with (security_invoker = off) as
select p.user_id, p.full_name, p.interests, p.skills, p.industry,
       p.avatar_cycle, p.avatar_refreshed_at
from public.profiles p
where p.is_discoverable
  and coalesce(p.avatar_cycle, '') is distinct from to_char(now(), 'YYYY-MM')
  and not coalesce(p.avatar_is_photo, false)
order by p.avatar_refreshed_at nulls first;

-- `create or replace view` re-runs Supabase's default grants, so a view that
-- was correctly locked down in 0018 is readable by anon again the moment it is
-- replaced. Re-revoking is not belt and braces here; it is the fix.
revoke all on public.avatars_due_refresh from anon, authenticated;

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. The column exists and members cannot WRITE it. ⚠ Check UPDATE
--    specifically — the first version of this check asked for zero client
--    grants of ANY kind and duly "failed" on application, because Supabase
--    hands every new column INSERT, REFERENCES and SELECT by default. Those
--    three are held identically by `avatar_is_generated`, the ungranted
--    provenance column this one is modelled on, and they are not the
--    privilege that matters. Expect zero rows:
--
--   select grantee, privilege_type
--     from information_schema.column_privileges
--    where table_schema = 'public' and table_name = 'profiles'
--      and column_name = 'avatar_is_photo'
--      and privilege_type = 'UPDATE'
--      and grantee in ('anon', 'authenticated');
--
--   -- and the table-wide UPDATE must still be revoked (expect zero rows):
--   select grantee from information_schema.table_privileges
--    where table_schema = 'public' and table_name = 'profiles'
--      and privilege_type = 'UPDATE' and grantee in ('anon', 'authenticated');
--
-- 2. The function is executable by members and not by anon (expect one row,
--    'authenticated'):
--
--   select grantee from information_schema.routine_privileges
--    where routine_schema = 'public' and routine_name = 'keep_photo_as_avatar'
--      and grantee in ('anon', 'authenticated');
--
-- 3. The view no longer offers up members who kept a photo (expect zero rows):
--
--   select user_id from public.avatars_due_refresh v
--    where exists (select 1 from public.profiles p
--                   where p.user_id = v.user_id and p.avatar_is_photo);
--
-- 4. The view is not readable by a client role (expect zero rows):
--
--   select grantee, privilege_type from information_schema.table_privileges
--    where table_schema = 'public' and table_name = 'avatars_due_refresh'
--      and grantee in ('anon', 'authenticated');
--
-- 5. As a signed-in member, this must SUCCEED and set the flag:
--
--   select public.keep_photo_as_avatar('https://example.com/me.jpg', 'upload');
--   select avatar_is_photo, avatar_is_generated, avatar_source, source_purged_at
--     from public.profiles where user_id = auth.uid();
--
-- 6. And these must each RAISE:
--
--   select public.keep_photo_as_avatar('http://example.com/me.jpg', 'upload');
--   select public.keep_photo_as_avatar('https://example.com/me.jpg', 'stolen');
--   select public.keep_photo_as_avatar('', 'upload');
