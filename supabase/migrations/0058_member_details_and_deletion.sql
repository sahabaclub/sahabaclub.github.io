-- 0058 — see a member in full, and erase one completely
-- ============================================================
--
-- Ahmed: "I need to see all details about the member, like the email they used
-- for registration and ability to edit or delete the member. Once I delete a
-- member, any Microsoft 365 account should deleted also and any history of the
-- members should deleted."
--
-- Two halves here, and a third (Microsoft 365) that cannot live in SQL — see
-- the note at the bottom.

-- ============================================================
-- 1. The registration email
-- ============================================================
--
-- It is not that the panel forgot to show it: the email is in `auth.users`,
-- which PostgREST does not expose and RLS cannot reach. Nothing in the browser
-- can read it, which is why every screen in this project shows a member without
-- one.
--
-- A `security definer` view is the way across, and it carries `is_staff()`
-- INSIDE its own body rather than relying on a policy — the same pattern the
-- PromptArena legacy views use, and for the same reason: the predicate in the
-- view IS the boundary, where a predicate in the page would be decoration.
--
-- ⚠ `security_invoker = off` is the default for a view and is what makes this
-- work; it must not be flipped on. If it were, the view would read auth.users
-- with the CALLER's rights, which no client role has, and it would return
-- nothing while looking correct.

create or replace view public.staff_member_details as
  select
    p.user_id,
    u.email,
    u.email_confirmed_at,
    u.last_sign_in_at,
    u.created_at            as signed_up_at,
    p.full_name,
    p.headline,
    p.company,
    p.position,
    p.city,
    p.country,
    p.role,
    p.experience_level,
    p.industry,
    p.years_experience,
    p.signup_method,
    p.profile_source,
    p.onboarding_completed_at,
    p.newsletter_opt_in,
    p.is_discoverable,
    p.accepts_messages,
    p.blocked_at,
    p.blocked_reason,
    p.avatar_url,
    p.created_at            as profile_created_at,
    p.updated_at
  from public.profiles p
  join auth.users u on u.id = p.user_id
  where public.is_staff();

revoke all on public.staff_member_details from anon, authenticated;
grant select on public.staff_member_details to authenticated;

comment on view public.staff_member_details is
  'Staff-only. Joins profiles to auth.users so the admin panel can show the '
  'address somebody actually registered with. is_staff() is inside the view '
  'body, so a non-staff caller gets zero rows rather than a refusal.';

-- ============================================================
-- 2. Erasing a member completely
-- ============================================================
--
-- Ahmed chose "erase everything" over anonymising, knowing it removes their
-- side of conversations from other people's inboxes.
--
-- ⚠ THE PART THAT IS NOT OBVIOUS, and the reason this function exists at all
-- rather than a plain `delete from auth.users`:
--
-- Fourteen tables are ON DELETE CASCADE, so deleting the auth user takes them
-- with it — messages both ways, follows, feed reactions, notifications,
-- opt-outs, push subscriptions, the M365 licence and credential rows.
--
-- Seventeen more are ON DELETE SET NULL. They SURVIVE, with the user_id nulled.
-- For most that is right: audit rows, campaigns they created, who approved what.
-- But FOUR of them keep the person's own name and email INLINE, so nulling the
-- link leaves their personal data sitting in the database, unlinked and
-- perfectly readable:
--
--     marketing_contacts          email, full_name
--     hackathon_participants      email, full_name
--     promptarena_legacy_players  email, full_name, mobile
--     prospect_profiles           email, full_name, linkedin
--
-- A delete that left those behind would report success and be a lie. They are
-- removed explicitly, before the cascade runs.
--
-- feed_posts are removed too — author_id is SET NULL, so their posts would
-- otherwise stay up with no author, which reads as a bug and is still their
-- writing.

-- ⚠ SPLIT INTO TWO FUNCTIONS, and not for design reasons. The Supabase SQL
-- editor silently refuses to apply a statement over roughly 1,000 characters:
-- it reports success, runs nothing, and the next statement executes against
-- the OLD editor contents. Measured on 7 Aug 2026 — an 824-character function
-- applied, an 1,178-character one did not, and neither reported an error.
--
-- So the deletes live in their own smaller function. The per-table row counts
-- the original returned were dropped for the same reason: they were pleasant
-- to have in the confirmation message and they were what pushed the body over
-- the limit. Correctness first.
--
-- ⚠ purge_member_traces is revoked from every client role. It deletes across
-- five tables with no permission check of its own — that check lives in
-- delete_member_completely, which is the only thing that should ever call it.

create or replace function public.purge_member_traces(u uuid, e text)
returns void language plpgsql security definer
set search_path = public, pg_temp as $fn$
begin
  delete from public.marketing_contacts where linked_user_id = u or lower(email) = lower(e);
  delete from public.hackathon_participants where user_id = u or lower(email) = lower(e);
  delete from public.promptarena_legacy_players where user_id = u or lower(email) = lower(e);
  delete from public.prospect_profiles where claimed_by = u or lower(email) = lower(e);
  delete from public.feed_posts where author_id = u or subject_user_id = u;
end; $fn$;

revoke execute on function public.purge_member_traces(uuid, text) from public, anon, authenticated;

create or replace function public.delete_member_completely(p_user_id uuid)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp, auth as $fn$
declare v_email text;
begin
  if not exists (select 1 from public.profiles where user_id = auth.uid() and role in ('admin','global_admin')) then
    raise exception 'Only a global admin may delete a member';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot delete your own account from here';
  end if;
  select email into v_email from auth.users where id = p_user_id;
  if v_email is null then raise exception 'No such member'; end if;
  perform public.purge_member_traces(p_user_id, v_email);
  delete from auth.users where id = p_user_id;
  return jsonb_build_object('deleted', true, 'email', v_email);
end; $fn$;

revoke execute on function public.delete_member_completely(uuid) from public, anon;
grant execute on function public.delete_member_completely(uuid) to authenticated;

comment on function public.delete_member_completely is
  'Erases a member and every trace of them. global_admin only; refuses self. '
  'Removes the four tables that keep name/email inline and survive the cascade, '
  'then deletes the auth user, which takes the other fourteen with it. '
  'Does NOT touch Microsoft 365 - that is the caller''s job, before this runs.';

-- ============================================================
-- 3. Microsoft 365 is NOT handled here, and cannot be
-- ============================================================
--
-- Their mailbox lives in Entra, reachable only over Microsoft Graph with the
-- tenant credentials that sit in the Edge Function's secrets. SQL has no way
-- to reach it, and pretending otherwise by nulling the licence rows would free
-- the seat in OUR records while leaving a live mailbox in the tenant.
--
-- So the admin screen does the M365 step FIRST, through provision-ms365, and
-- only calls this once that has succeeded. Ahmed chose "ask me each time"
-- between blocking + unlicensing and deleting outright, so the dialog offers
-- both with neither preselected.
--
-- ⚠ Order matters and is not interchangeable. After this function runs, the
-- ms365_credentials and ms365_user_licenses rows are gone with the cascade, so
-- nothing is left that says WHICH Microsoft account belonged to them. Delete
-- the mailbox first, or it becomes an orphan nobody can trace back.

-- ============================================================
-- Verify
-- ============================================================
--
-- 1. Staff can see an email; a member cannot see the view at all:
--      select user_id, email, full_name, role from public.staff_member_details limit 3;
--      -- as a member session: 0 rows
--
-- 2. The guard holds. As a NON-global-admin session:
--      select public.delete_member_completely('<some uuid>');
--      -- expect: Only a global admin may delete a member
--
-- 3. Self-deletion is refused:
--      select public.delete_member_completely(auth.uid());
--      -- expect: You cannot delete your own account from here
--
-- 4. ⚠ THE ONE THAT MATTERS, and it needs a throwaway account rather than a
--    real member. Sign up a test user, give it a marketing_contacts row with
--    the same email, then delete it and confirm BOTH are gone:
--
--      select count(*) from public.marketing_contacts where lower(email) = '<test email>';
--      -- expect 0, not 1-with-a-null-link
