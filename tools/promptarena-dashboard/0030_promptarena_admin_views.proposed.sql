-- PROPOSED, NOT APPLIED, AND DELIBERATELY NOT IN supabase/migrations/
-- ============================================================================
-- Three staff-only views that `app/admin/promptarena.html` needs and that 0029
-- does not provide. This file is here so the gap is written down and reviewable;
-- it is NOT a migration and must not be applied by whoever finds it. Moving it
-- into `supabase/migrations/` is a deliberate act with a review attached, and
-- the numbering must be checked against whatever 0030 turns out to be.
--
-- ============================================================================
-- WHY THIS FILE EXISTS
-- ============================================================================
--
-- 0029 is emphatic and correct that the three `promptarena_legacy_*` tables are
-- the most sensitive thing in the schema: real names, personal email addresses
-- and mobile numbers for 152 people who never signed up to this website. It
-- closes them completely — RLS on, no policy of any kind, grants revoked — and
-- says plainly how staff are meant to reach them:
--
--     "Staff read these through the service role or a SQL session, exactly as
--      they read prospect_profiles (0027)."
--
-- That is a coherent decision, and `tools/promptarena-campaign/stage-campaign.sql`
-- is built on it: it says "run it as the service role ... there is no other way".
--
-- Ahmed then asked for something that decision does not allow:
--
--     "one unified dashboard showing the results, and you can relate the users
--      to the current club members, whoever belongs to the club, link that; if
--      new, use the data for the marketing and outreach"
--
-- A browser holding a staff member's JWT is the `authenticated` role. It is not
-- the service role and must never be — the service-role key bypasses RLS
-- entirely and cannot be shipped to a page. So "show me who is a member and who
-- is an outreach candidate, in the admin dashboard" cannot be satisfied without
-- a staff-readable route into those tables. Either the ask changes, or this file
-- (or something like it) gets applied. The dashboard is built to work either
-- way: with these views it shows the people, without them it says exactly which
-- object is missing rather than rendering an empty list as if nobody matched.
--
-- ============================================================================
-- THE THREE RULES THIS FILE FOLLOWS
-- ============================================================================
--
-- 1. **The staff check is INSIDE the view, not in the UI.** Every view below is
--    `security_invoker = off`, which means it reads its base tables with the
--    owner's rights and RLS does not apply. A view like that granted to
--    `authenticated` with no predicate is readable by every logged-in member.
--    So each one carries `where public.is_staff()` in its own body. Deleting
--    that line publishes 152 people's mobile numbers to anyone with a free
--    account, and nothing in the browser would notice.
--
-- 2. **Never trust a stored total, and never let a NULL become a 0.** Every
--    total below is recomputed from `promptarena_legacy_submissions.score`.
--    `scored_rounds` is `count(score)`, which skips NULLs and counts a genuine
--    0 — the two are different facts and 0029 spends a page saying so.
--
-- 3. **The outreach view reuses `stage-campaign.sql`'s segment and exclusion
--    definitions verbatim**, because a dashboard that shows a different list
--    from the one the campaign would mail is worse than no dashboard. Where the
--    campaign reads a value from its `pa_settings` temp table, that value is a
--    literal here and is named in a comment as belonging to that file. If the
--    campaign's settings change, this file changes with it.

-- ============================================================================
-- The shared "may this submission be counted" predicate
-- ============================================================================
--
-- 0029 records the defect on a column (`invalid_reason`), and
-- `stage-campaign.sql` derives it with a self-join that tests the artefact
-- itself. 0029's own verification block asserts the two agree.
--
-- This file requires BOTH: a row counts only when it is neither flagged nor
-- exhibits the artefact. That cannot be more permissive than the campaign, so
-- the dashboard can never show a total the campaign would not send. The
-- disagreement between the two is exposed as a column on the event view instead
-- of being silently resolved, because if the importer forgets to set
-- `invalid_reason` the right outcome is somebody seeing that, not the dashboard
-- quietly compensating for it.
--
-- The artefact test is the three-part one from 0029 and stage-campaign, and the
-- first part is the trap: without "the event carries judge comments at all", the
-- comment comparison is satisfied by every wide-export row (all their comments
-- are NULL, and two NULLs compare equal under `is not distinct from`), and any
-- player who happened to score the same in rounds 4 and 5 loses a real mark.

create or replace view public.promptarena_legacy_submission_validity
with (security_invoker = off) as
select
  s.id,
  s.player_id,
  s.event_id,
  s.round_number,
  s.score,
  s.judge_comment,
  s.prompt_text,
  s.invalid_reason,
  (
    s.round_number = 5
    and exists (
      select 1 from public.promptarena_legacy_submissions c
      where c.event_id = s.event_id and c.judge_comment is not null
    )
    and exists (
      select 1 from public.promptarena_legacy_submissions r4
      where r4.player_id = s.player_id
        and r4.round_number = 4
        and r4.score         is not distinct from s.score
        and r4.judge_comment is not distinct from s.judge_comment
    )
  ) as matches_round5_artefact
from public.promptarena_legacy_submissions s
where public.is_staff();

revoke all on public.promptarena_legacy_submission_validity from anon, authenticated;
grant select on public.promptarena_legacy_submission_validity to authenticated;

-- ============================================================================
-- 1. The players, with their recomputed numbers and who they turned out to be
-- ============================================================================
--
-- ⚠ THIS VIEW CARRIES EMAIL ADDRESSES AND MOBILE NUMBERS. That is the point of
-- it — outreach needs a way to reach somebody — and it is why the `is_staff()`
-- predicate below is the whole security property of this file.
--
-- One row per legacy player ROW, not per person: 159 rows, 152 people. The
-- de-duplication happens in the outreach view, where it decides who gets mailed.
-- Here both halves of a duplicate pair stay visible, for 0029's reason —
-- merging them means choosing which registration timestamp and which typed alias
-- is the real one, and nothing in the data decides that.

create or replace view public.promptarena_legacy_player_directory
with (security_invoker = off) as
select
  pl.id                             as player_id,
  ev.id                             as event_id,
  ev.slug                           as event_slug,
  ev.name                           as event_name,
  ev.held_on,
  ev.date_last,
  ev.is_single_day,

  pl.full_name,
  pl.email,
  lower(btrim(pl.email))            as email_key,
  pl.mobile,

  -- Route 1 to "this person is already one of us": the importer linked them.
  pl.user_id,
  pl.linked_at,

  -- Route 2: they signed up with the same address and nothing ever linked them.
  -- 0029 does not touch `handle_new_user()`, so this is the common case rather
  -- than the exception, and a dashboard that only read `pl.user_id` would call
  -- real members prospects.
  acct.user_id                      as matched_user_id,
  acct.full_name                    as matched_member_name,
  acct.role                         as matched_member_role,

  -- Route 3: not a member, but the club has already written them a prospect
  -- profile (0027). Joined on either address, because a prospect is keyed on
  -- the mailbox and a legacy player may have signed up with a personal one.
  pr.id                             as prospect_id,
  pr.full_name                      as prospect_name,
  pr.is_published                   as prospect_is_published,

  case
    when pl.user_id is not null or acct.user_id is not null then 'member'
    when pr.id is not null                                  then 'prospect'
    else 'unmatched'
  end                               as match_state,

  -- The club provisions @sahabaclub.com, so an address at that domain is one of
  -- our own whether or not anything has linked them. 39 of the 152 are here, and
  -- they are the entire roster of the two long-format events.
  (lower(btrim(pl.email)) like '%@sahabaclub.com') as is_club_mailbox,

  coalesce(sb.rounds_played, 0)     as rounds_played,
  coalesce(sb.scored_rounds, 0)     as scored_rounds,
  sb.total_score,
  sb.best_score,
  sb.avg_score,
  coalesce(sb.wrote_in_arabic, false) as wrote_in_arabic,
  coalesce(sb.rows_excluded_invalid, 0) as rows_excluded_invalid,

  -- stage-campaign.sql: "More rounds than this in one event is a demo or staff
  -- account, not a guest." One account produced 53 of july18's 256 submissions,
  -- including 26 attempts at round 1. The threshold (15) is that file's
  -- `pa_settings.demo_account_rounds` and must move with it.
  (coalesce(sb.rounds_played, 0) > 15) as is_demo_account

from public.promptarena_legacy_players pl
join public.promptarena_legacy_events ev on ev.id = pl.event_id

left join lateral (
  select
    -- Played means they wrote something. A wide export carries a row per round
    -- whether or not it was attempted, so counting rows credits people with
    -- rounds they never saw.
    count(*) filter (where btrim(coalesce(v.prompt_text, '')) <> ''
                       and not v.matches_round5_artefact
                       and v.invalid_reason is null)              as rounds_played,
    -- count(score), never count(*): NULL is "never attempted", 0 is a verdict.
    count(v.score) filter (where not v.matches_round5_artefact
                             and v.invalid_reason is null)        as scored_rounds,
    sum(v.score)   filter (where not v.matches_round5_artefact
                             and v.invalid_reason is null)        as total_score,
    max(v.score)   filter (where not v.matches_round5_artefact
                             and v.invalid_reason is null)        as best_score,
    round(avg(v.score) filter (where not v.matches_round5_artefact
                                 and v.invalid_reason is null), 1) as avg_score,
    bool_or(v.prompt_text ~ '[؀-ۿ]')                    as wrote_in_arabic,
    count(*) filter (where v.matches_round5_artefact
                        or v.invalid_reason is not null)          as rows_excluded_invalid
  from public.promptarena_legacy_submission_validity v
  where v.player_id = pl.id
) sb on true

left join lateral (
  select u.id as user_id, p.full_name, p.role
  from auth.users u
  join public.profiles p on p.user_id = u.id
  where lower(u.email) = lower(btrim(pl.email))
  limit 1
) acct on true

left join lateral (
  select pp.id, pp.full_name, pp.is_published
  from public.prospect_profiles pp
  where lower(coalesce(pp.email, '')) = lower(btrim(pl.email))
     or lower(pp.ms365_mailbox)       = lower(btrim(pl.email))
  limit 1
) pr on true

where public.is_staff();

comment on view public.promptarena_legacy_player_directory is
  'Staff-only. Carries the personal email and mobile of 152 people who never signed up here — the is_staff() predicate inside the view is the only thing between them and every logged-in member. Every total is recomputed; no stored aggregate is read.';

revoke all on public.promptarena_legacy_player_directory from anon, authenticated;
grant select on public.promptarena_legacy_player_directory to authenticated;

-- ============================================================================
-- 2. The outreach list — the campaign's own definitions, read-only
-- ============================================================================
--
-- ⚠ This view is `tools/promptarena-campaign/stage-campaign.sql` Part 1,
-- re-expressed as a permanent view so the dashboard can SHOW the campaign
-- rather than describe it. Every exclusion is a named boolean for that file's
-- stated reason: "a count that drops with no explanation is a count nobody
-- trusts". Two lists that disagree about who gets mailed is the failure this is
-- written to avoid, so if one changes the other must.
--
-- It writes nothing and it cannot send anything. It has no knowledge of
-- `campaign_recipients` and must not grow any.

create or replace view public.promptarena_outreach_candidates
with (security_invoker = off) as
with pool as (
  select d.*
  from public.promptarena_legacy_player_directory d
  where d.email is not null
    and btrim(d.email) <> ''
    -- A shape test, not a delivery test. A malformed address is a guaranteed
    -- bounce and bounces are what cost the sending domain.
    and d.email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$'
),
person as (
  -- Exactly one person in the whole dataset played two events, so this is nearly
  -- a no-op — but "nearly" is not a reason to mail somebody twice, and the order
  -- decides which letter they get. A real score wins every tie, so nobody who
  -- has a score can land in the segment written for people who have none.
  select distinct on (email_key) *
  from pool
  order by email_key,
           (scored_rounds > 0) desc,
           total_score desc nulls last,
           held_on desc nulls last,
           player_id
)
select
  p.player_id,
  p.email_key,
  p.email,
  p.full_name,
  p.mobile,
  p.event_slug,
  p.event_name,
  p.held_on,
  p.is_single_day,
  p.match_state,
  p.rounds_played,
  p.scored_rounds,
  p.total_score,
  p.best_score,
  p.avg_score,
  p.wrote_in_arabic,

  mc.id          as contact_id,
  mc.email       as contact_email,
  mc.first_name  as contact_first_name,
  mc.full_name   as contact_full_name,

  -- ---- the exclusions, each one named ----------------------------------
  (mc.id is null)                            as excl_no_contact_row,
  (mc.unsubscribed_at is not null)           as excl_unsubscribed,
  (mc.bounced_at is not null)                as excl_bounced,
  coalesce(mc.is_test, false)                as excl_test,
  (mc.id is not null and not mc.email_valid) as excl_invalid_email,

  -- Already one of us, route one: an account. Three ways to the same fact,
  -- because any one alone leaves a hole.
  (p.user_id is not null
     or mc.linked_user_id is not null
     or p.matched_user_id is not null)       as excl_member,

  -- Already one of us, route two: a club mailbox. Not a rounding error — every
  -- player of both long events is at that domain, which is why those two events
  -- vanish from this campaign entirely. They need the other email, the one that
  -- says their rating is already on their dashboard.
  (p.is_club_mailbox or mc.sahaba_mailbox is not null) as excl_club_mailbox,

  p.is_demo_account                          as excl_demo_account,

  -- ---- the segments ----------------------------------------------------
  -- 'scored' requires a real mark, so the subject line's "you scored N" is true
  -- by construction. 'registered_only' requires that they wrote nothing at all,
  -- so its letter can claim neither a score nor a turn. Somebody who wrote
  -- prompts and has no score at all is in NEITHER, on purpose: they would have
  -- to be told a number we do not have. The dashboard counts them as
  -- `wrote_but_unscored` and a large number there means the import nulled real
  -- scores.
  case
    when p.scored_rounds > 0 then 'scored'
    when p.rounds_played = 0 then 'registered_only'
  end                                        as segment,

  -- The single boolean the UI filters on, so the dashboard's "would be mailed"
  -- list and the campaign's recipient list cannot drift apart by one clause.
  (
    case when p.scored_rounds > 0 then true
         when p.rounds_played = 0 then true
         else false end
    and mc.id is not null
    and mc.unsubscribed_at is null
    and mc.bounced_at is null
    and not coalesce(mc.is_test, false)
    and mc.email_valid
    and p.user_id is null and mc.linked_user_id is null and p.matched_user_id is null
    and not p.is_club_mailbox and mc.sahaba_mailbox is null
    and not p.is_demo_account
  )                                          as would_be_mailed

from person p
left join public.marketing_contacts mc on lower(mc.email) = p.email_key;

comment on view public.promptarena_outreach_candidates is
  'One row per person from the legacy events, with the segment and every exclusion named, mirroring tools/promptarena-campaign/stage-campaign.sql Part 1. Read-only: it cannot queue or send anything.';

revoke all on public.promptarena_outreach_candidates from anon, authenticated;
grant select on public.promptarena_outreach_candidates to authenticated;

-- ============================================================================
-- 3. Calibration, reachable by staff
-- ============================================================================
--
-- 0029 builds `promptarena_challenge_calibration` and grants it to nobody,
-- reasoning that "a member who could read this could read the difficulty
-- model". That reasoning is intact — this wrapper does not widen it, it adds
-- the staff predicate 0029 left to the service role.
--
-- Nothing is recomputed here. A second definition of "average score for this
-- challenge" is a second answer to the same question.

create or replace view public.promptarena_challenge_calibration_staff
with (security_invoker = off) as
select c.*
from public.promptarena_challenge_calibration c
where public.is_staff();

comment on view public.promptarena_challenge_calibration_staff is
  'The 0029 calibration view with a staff predicate, so app/admin/promptarena.html can read it without a service-role key in a browser. No number is recomputed.';

revoke all on public.promptarena_challenge_calibration_staff from anon, authenticated;
grant select on public.promptarena_challenge_calibration_staff to authenticated;

-- ============================================================================
-- Verification — run these before believing any of it
-- ============================================================================
--
-- ⚠ THE ONE THAT MATTERS. Signed in as an ordinary member (role = 'member'),
-- every one of these must return ZERO rows. If any returns a row, the
-- is_staff() predicate has been dropped from that view and 152 people's contact
-- details are readable by anyone with a free account:
--   select count(*) from public.promptarena_legacy_player_directory;
--   select count(*) from public.promptarena_outreach_candidates;
--   select count(*) from public.promptarena_challenge_calibration_staff;
--   select count(*) from public.promptarena_legacy_submission_validity;
--
-- anon reaches nothing at all (expect zero rows):
--   select table_name, privilege_type from information_schema.role_table_grants
--    where grantee = 'anon'
--      and table_name like 'promptarena_%';
--
-- The flag and the artefact test agree — 0029's importer set `invalid_reason`
-- on exactly the rows the self-join finds. Expect 0 for both:
--   select
--     count(*) filter (where matches_round5_artefact and invalid_reason is null)
--       as artefact_not_flagged,
--     count(*) filter (where invalid_reason is not null and not matches_round5_artefact)
--       as flagged_but_no_artefact
--   from public.promptarena_legacy_submission_validity;
--
-- No total came from a stored aggregate: every scored player's recomputed total
-- is positive. Expect 0 (53 players' stored `TotalScore` reads 0 while their
-- rounds sum to 12–36):
--   select count(*) from public.promptarena_legacy_player_directory
--    where scored_rounds > 0 and coalesce(total_score, 0) <= 0;
--
-- The dashboard's outreach list and the campaign's recipient list are the same
-- people. Run stage-campaign.sql parts 0–2, then expect 0 rows:
--   select email_key from public.promptarena_outreach_candidates where would_be_mailed
--   except
--   select email_key from pa_return_segment;
--   -- and the other direction
--   select email_key from pa_return_segment
--   except
--   select email_key from public.promptarena_outreach_candidates where would_be_mailed;
