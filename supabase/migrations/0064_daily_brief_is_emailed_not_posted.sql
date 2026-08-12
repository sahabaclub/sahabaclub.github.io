-- 0064 — the daily events brief is emailed to a human, not posted by a robot
-- ============================================================
--
-- Ahmed, 11 Aug 2026, changing the plan he set the same morning: instead of
-- posting to LinkedIn through the API, the job emails a ready-to-paste post to
-- Ghadir every night at 22:00 Dubai, with the next day's event images attached.
-- She posts it herself.
--
-- ⚠ THIS IS A BETTER PLAN AND THE REASON IS WORTH KEEPING. The API route was
-- blocked behind LinkedIn's Community Management API — an approval measured in
-- days, for a token that then expires on LinkedIn's schedule and takes the
-- whole job down with it when it does. The email route needs no approval, no
-- token, and no permission LinkedIn can withdraw. It also puts a person
-- between the database and the company page, which for a post naming other
-- organisations' events is the right place for a person to be.
--
-- 0063's table is kept as it is — one row per day, `post_date` unique, claimed
-- before the send. The reasoning there was never about LinkedIn: it was about a
-- daily job being able to say "I already did that", and an email sent twice is
-- only marginally less annoying than a post published twice.
--
-- What changes is the vocabulary of `status`:
--
--   'emailed'       the brief went to Ghadir
--   'email_failed'  Resend refused it, or we could not reach Resend
--
-- ⚠ 'skipped_empty' NOW MEANS SOMETHING DIFFERENT and the difference is
-- deliberate. It used to mean "nothing was posted". It now means "there is
-- nothing on tomorrow, and we said so" — because Ahmed chose a short note over
-- silence on an empty night. A person waiting on a nightly email cannot tell
-- silence apart from a broken job, and the whole point of this job is that
-- somebody is waiting on it.
--
-- The old LinkedIn values stay in the constraint rather than being dropped:
-- 'posted' and 'claimed' describe rows that could already exist, and a check
-- constraint that rejects its own history is a migration that fails on the
-- data it is supposed to describe.

alter table public.linkedin_daily_posts
  drop constraint if exists linkedin_daily_posts_status_check;

alter table public.linkedin_daily_posts
  add constraint linkedin_daily_posts_status_check
  check (status in (
    'skipped_empty',   -- nothing on that day; the "nothing tomorrow" note was sent
    'dry_run',         -- composed and shown, deliberately not sent
    'claimed',         -- the day was taken and the send is in flight
    'emailed',         -- the brief reached Resend
    'email_failed',    -- Resend refused it
    'posted',          -- historical: the API route, before 11 Aug
    'failed'           -- historical: the API route refused
  ));

-- The recipients are NOT in this table. They live in Edge Function secrets
-- (BRIEF_TO, BRIEF_CC) so an address can be changed without a deploy and
-- without a migration — which matters here, because one of them is a mailbox
-- nobody has yet confirmed exists.
comment on table public.linkedin_daily_posts is
  'One row per day the events brief ran. post_date is unique so a repeat run '
  'cannot email the same day twice; the row is claimed before the send. Since '
  '0064 the brief is emailed to a person who posts it by hand, rather than '
  'posted through the LinkedIn API.';

-- ============================================================
-- Verification
-- ============================================================
--
--   1. The new vocabulary is accepted and the old is still legal:
--
--        insert into public.linkedin_daily_posts (post_date, status)
--        values (date '1999-01-01', 'emailed'), (date '1999-01-02', 'posted');
--        -- expect: 2 rows
--        delete from public.linkedin_daily_posts where post_date < date '2000-01-01';
--
--   2. THE CONTROL — a status that is not in the list must still be refused.
--      If this succeeds the constraint is not doing anything:
--
--        insert into public.linkedin_daily_posts (post_date, status)
--        values (date '1999-01-03', 'whatever');
--        -- expect: violates check constraint
