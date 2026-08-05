-- 0040 — remember that the welcome email has been sent
-- ============================================================
--
-- Ahmed's ask, 5 Aug 2026: a member should get a welcome email when they join,
-- and a Microsoft 365 email when their mailbox is created OR linked, both to
-- their personal address with him copied in.
--
-- The `welcome` template has existed since the beginning and NOTHING HAS EVER
-- SENT IT, so the first thing a new member ever heard from the club was a
-- Microsoft password with no context. The new `member-email` function sends it
-- — but it is triggered from the browser when onboarding opens, and a browser
-- reloads. Without somewhere to record "already sent", a member who refreshes
-- that page three times gets three welcome emails, and Ahmed gets three copies.
--
-- One column, and the guard lives server-side in the function that owns it.
-- NOT granted to members: `profiles` revokes the table-wide UPDATE and hands
-- privileges back as an explicit column allowlist (0002 → 0005 → 0017 → 0019),
-- so a new column is unwritable by default and adding nothing here is correct.
-- A member who could clear it could re-send themselves — and Ahmed — the
-- welcome email as often as they liked.

alter table public.profiles
  add column if not exists welcome_email_sent_at timestamptz;

comment on column public.profiles.welcome_email_sent_at is
  'When the welcome email was sent. Set only by the member-email Edge Function, '
  'which refuses to send a second one. Ungranted to clients on purpose: it is a '
  'send-once guard, and a member who could clear it could mail themselves and '
  'Ahmed repeatedly.';

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. The column exists (expect one row):
--
--   select column_name, data_type from information_schema.columns
--    where table_schema='public' and table_name='profiles'
--      and column_name='welcome_email_sent_at';
--
-- 2. ⚠ Members cannot WRITE it. Check UPDATE specifically — Supabase grants
--    every new column INSERT, REFERENCES and SELECT by default and those are
--    not the privilege that matters (this is the check 0038 got wrong first
--    time round). Expect zero rows:
--
--   select grantee from information_schema.column_privileges
--    where table_schema='public' and table_name='profiles'
--      and column_name='welcome_email_sent_at'
--      and privilege_type='UPDATE' and grantee in ('anon','authenticated');
--
-- 3. Nobody has been mailed twice — every stamped row has exactly one value,
--    which is trivially true of a scalar column, so the real check is
--    behavioural: call member-email with {"kind":"welcome"} twice as the same
--    member. The second call must answer {"ok":true,"skipped":"already_sent"}
--    and Resend must show exactly one message.
