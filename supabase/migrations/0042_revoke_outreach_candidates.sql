-- 0042 — a live PII leak, closed
-- ============================================================
--
-- Found 5 Aug 2026 while auditing the four views that exist in the database but
-- in NO migration — the 0030 staff views applied from
-- `tools/promptarena-dashboard/0030_promptarena_admin_views.proposed.sql` and
-- never recorded. That gap is why nothing caught this for four days: a
-- source-only audit of this repo cannot see those views at all, and the only
-- reason they surfaced was the Supabase advisor naming them.
--
-- THE FINDING. `promptarena_outreach_candidates` selects, among other things:
--
--     email, contact_email, mobile, full_name, contact_full_name
--
-- for the 152 legacy PromptArena players. It carries NO `is_staff()` predicate,
-- and it was granted to `authenticated`. So ANY SIGNED-IN MEMBER could read
-- those people's email addresses and phone numbers by asking PostgREST for
-- them. privacy.html promises the exact opposite, in its first bullet:
--
--     "Your email address and phone number are never shown to another member.
--      Not on a profile, not in the directory, not in a message header. They
--      are not in any of the tables other members can read."
--
-- That sentence was false while this grant existed.
--
-- The other three views from the same batch —
-- `promptarena_legacy_player_directory`,
-- `promptarena_legacy_submission_validity` and
-- `promptarena_challenge_calibration_staff` — all carry
-- `where public.is_staff()`. This one was simply missed, which is exactly the
-- failure mode the handoff warns about for definer views: the predicate is the
-- only boundary, and a predicate that is merely forgotten leaves no trace.
--
-- ⚠ The view currently returns zero rows, because the legacy seed has not been
-- loaded. That is luck, not mitigation. The grant is the vulnerability; it
-- would have started returning 152 people the moment the seed landed.

revoke all on public.promptarena_outreach_candidates from anon, authenticated;

comment on view public.promptarena_outreach_candidates is
  'Campaign targeting for the legacy PromptArena comeback. Selects email and '
  'mobile, so NO CLIENT ROLE MAY HOLD A GRANT ON IT — revoked in 0042 after it '
  'was found readable by every signed-in member. Read it with the service role, '
  'or add a `where public.is_staff()` predicate the way the other three views '
  'from the same batch do, before granting anything back.';

-- ============================================================
-- Still owed, and deliberately not done here
-- ============================================================
--
-- These four views must be recorded as a real migration (task #33). Until they
-- are, `schema_migrations` does not describe the database, a rebuild from
-- migrations alone would not reproduce it, and the next audit has the same
-- blind spot this one did. This migration does NOT do that work, because
-- recreating a view from `pg_get_viewdef` output is a transcription job that
-- deserves to be checked against the original proposal file rather than
-- reconstructed from a dashboard cell at the end of a long session.
--
-- If `app/admin/promptarena.html` reads this view directly it will now fail.
-- That is the correct trade against a live PII leak, and the fix is to give the
-- view an `is_staff()` predicate and re-grant, not to put the bare grant back.

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. No client role holds anything on it (expect zero rows):
--
--   select grantee, privilege_type from information_schema.table_privileges
--    where table_schema='public' and table_name='promptarena_outreach_candidates'
--      and grantee in ('anon','authenticated');
--
-- 2. The sibling views still work as intended (expect all three is_staff()):
--
--   select c.relname,
--          pg_get_viewdef(c.oid) ilike '%is_staff%' as guarded
--     from pg_class c join pg_namespace n on n.oid=c.relnamespace
--    where n.nspname='public' and c.relkind='v'
--      and c.relname in ('promptarena_legacy_player_directory',
--                        'promptarena_legacy_submission_validity',
--                        'promptarena_challenge_calibration_staff');
--
-- 3. From outside, with the publishable key, as a signed-in member — must be
--    refused rather than returning rows:
--
--   GET /rest/v1/promptarena_outreach_candidates?select=email,mobile&limit=1
