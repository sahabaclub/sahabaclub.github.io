-- 0041 — security audit remediation, 5 Aug 2026
-- ============================================================
--
-- Prompted by a wall of CRITICAL findings in the Supabase Security Advisor.
-- The audit that followed is written up in full at the foot of this file,
-- because the most useful thing it produced was *not* a list of holes — it was
-- evidence about which findings are real. Summarised:
--
--   * RLS is enabled on all 41 tables. No exceptions.
--   * Probed from outside with the anon key, 59 of 63 tables and views refuse
--     to return anything. The four that answer are `events`, `hackathons`,
--     `hackathon_teams` and `hackathon_roster` — the public events listing and
--     the EduHackAI roster, both of which privacy.html already declares public.
--   * The "Security Definer View" criticals are a lint about a PATTERN. Every
--     one of those views either carries its own `where public.is_staff()` /
--     `auth.uid()` predicate, or filters on a consent column the member
--     controls (`show_in_attendees`, `is_discoverable`,
--     `show_in_promptarena_ranking`).
--   * The "Exposed Auth Users" criticals are `contact_link_status` and
--     `avatars_due_refresh`. The second is revoked from every client role. The
--     first ends in `where public.is_staff();` as its OUTER filter, so a
--     non-staff member selecting from it gets zero rows.
--
-- ONE FINDING WAS REAL, and it is what this migration fixes.

-- ============================================================
-- 1. `hackathon_roster` hands an auth user id to anonymous visitors
-- ============================================================
--
-- The view is granted to `anon` on purpose: the EduHackAI roster is the single
-- public exception privacy.html names, and it is what makes the hackathons page
-- work for someone who has not signed up. That part is fine and stays.
--
-- What is not fine is the column list. `profile_user_id` is a member's
-- `auth.users` id, and it was readable by anyone with the publishable key —
-- confirmed by probing production, not by reading the source:
--
--   GET /rest/v1/hackathon_roster?select=*&limit=1   ->  200, and the row
--   carried profile_user_id = a real member's UUID.
--
-- That pairs a real person's name with the internal identifier every other
-- table joins on. Nothing can be done with it directly — every member-facing
-- endpoint is behind RLS and requires a session — but it is a join key handed
-- to strangers for no benefit, and a public name-to-uuid mapping is exactly the
-- raw material an enumeration attack wants.
--
-- The fix is column-level: anon keeps everything the public page renders and
-- loses the one column it has no business seeing. Members keep the lot, because
-- the profile link only does anything once you are signed in anyway.
--
-- ⚠ Column-level REVOKE is a no-op against a table-level grant — revoking the
-- table grant first and re-granting the allowlist is the only thing that works.
-- This is the same trap `profiles` has been navigating since 0002.

revoke all on public.hackathon_roster from anon;

grant select (
  hackathon_id,
  team_id,
  full_name,
  role_in_team,
  is_mentor,
  is_judge,
  avatar_url,
  headline,
  display_order
) on public.hackathon_roster to anon;

-- Signed-in members keep the whole row, including profile_user_id, so the
-- roster can still link through to a profile.
grant select on public.hackathon_roster to authenticated;

comment on view public.hackathon_roster is
  'The public EduHackAI roster. anon holds a column-level grant that EXCLUDES '
  'profile_user_id (0041) — a public name-to-auth-uuid mapping is a join key '
  'strangers do not need. authenticated sees the whole row. '
  'hackathons-ui.js only requests profile_user_id when a session exists; '
  'asking for it as anon makes PostgREST refuse the entire query.';

-- ============================================================
-- 2. Deliberately NOT changed, with reasons
-- ============================================================
--
-- Recorded here so the next person does not "fix" something that is already
-- right, and so the Advisor's red badges can be read with the right weight.
--
-- `contact_link_status` — CRITICAL "Exposed Auth Users" + "Security Definer
--   View". It reads `auth.users` in an EXISTS subquery to answer "does a
--   confirmed account exist for this address", which is the entire point of the
--   view, and it ends in `where public.is_staff()`. Non-staff get zero rows.
--   Converting it to security_invoker would break it outright: `authenticated`
--   cannot read `auth.users` at all, so staff would get nothing either. The
--   definer + internal guard pattern is the correct shape here. What would
--   genuinely improve it is moving the whole thing behind a staff-gated RPC so
--   the grant disappears; that is a bigger change than an audit should make
--   without being able to test the admin page against a real staff session.
--
-- `avatars_due_refresh` — same lint, but `revoke all ... from anon,
--   authenticated` means no client role can reach it. Service role only.
--
-- `member_cards`, `member_directory`, `prospect_directory`,
--   `promptarena_leaderboard` — definer views granted to `authenticated` with
--   no caller predicate. That is intentional and correct: they filter on
--   CONSENT (`show_in_attendees`, `is_discoverable`,
--   `show_in_promptarena_ranking`), so every member legitimately sees the same
--   set. Checked column by column: none of them selects an email, a phone
--   number or a mailbox. `member_directory` and `prospect_directory` mention
--   those words only in comments that forbid adding them.
--
-- `prospect_profiles`, `promptarena_legacy_*` — RLS enabled with NO policies,
--   which is deny-all for every client role and reachable only by the service
--   role. Adding a policy here would INCREASE exposure, so nothing is added.
--   The open governance question — that a prospect has no self-service route to
--   object — is a product decision, not a vulnerability, and is left where it
--   is rather than being answered by a migration.

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. anon must NOT hold a column-level grant on profile_user_id (expect zero):
--
--   select grantee, column_name from information_schema.column_privileges
--    where table_schema='public' and table_name='hackathon_roster'
--      and grantee='anon' and column_name='profile_user_id';
--
-- 2. anon MUST still hold the nine public columns (expect 9):
--
--   select count(*) from information_schema.column_privileges
--    where table_schema='public' and table_name='hackathon_roster'
--      and grantee='anon' and privilege_type='SELECT';
--
-- 3. authenticated must still see the whole row (expect 10):
--
--   select count(*) from information_schema.column_privileges
--    where table_schema='public' and table_name='hackathon_roster'
--      and grantee='authenticated' and privilege_type='SELECT';
--
-- 4. From outside, with the publishable key — the first must still return a
--    row, the second must now be refused:
--
--   GET /rest/v1/hackathon_roster?select=full_name,headline&limit=1   -> 200
--   GET /rest/v1/hackathon_roster?select=profile_user_id&limit=1      -> 401/403
