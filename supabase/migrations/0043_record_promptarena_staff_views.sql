-- 0043 — record the four PromptArena staff views that existed in no migration
-- ============================================================
--
-- These four views have been live since 2 Aug and were never in
-- supabase/migrations. They were applied straight from
-- tools/promptarena-dashboard/0030_promptarena_admin_views.proposed.sql, which
-- is why `schema_migrations` has not described this database for three days and
-- why a rebuild from migrations alone would not have reproduced it.
--
-- That gap had a cost. A source-only security audit on 5 Aug enumerated every
-- table, view, grant and policy in this repo and could not see these four at
-- all; the only reason the leak below surfaced is that the Supabase advisor
-- named the view. Recording them is what closes that blind spot permanently.
--
-- ⚠ THE LEAK, and it is worth reading how it happened.
--
-- `promptarena_outreach_candidates` selects email, contact_email and mobile for
-- 152 legacy PromptArena players. Three of its four sibling views end in
-- `where public.is_staff()`. It did not — and it was granted to
-- `authenticated`, so any signed-in member could read those people's contact
-- details. 0042 revoked the grant as an emergency stop; this migration restores
-- the view WITH the predicate and re-grants, so the admin page works again.
--
-- The proposal file was not careless about this. It says, in its own words:
--
--     "⚠ THE ONE THAT MATTERS. Signed in as an ordinary member, every one of
--      these must return ZERO rows. If any returns a row, the is_staff()
--      predicate has been dropped from that view and 152 people's contact
--      details are readable by anyone with a free account:
--        select count(*) from public.promptarena_outreach_candidates;"
--
-- The check that would have caught this was written down, named the right view,
-- and was never run — it needs a real member session, and nobody had one. The
-- lesson is not "write better checks". It is that a check nobody executes is
-- documentation, and this project has now been bitten by that twice.
--
-- Everything below is lifted VERBATIM from the proposal file by
-- tools/record-0030-views.mjs, except the one predicate marked "ADDED IN 0043".
-- Nothing was retyped.

-- ------------------------------------------------------------------
-- promptarena_legacy_submission_validity
-- ------------------------------------------------------------------

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

-- ------------------------------------------------------------------
-- promptarena_legacy_player_directory
-- ------------------------------------------------------------------

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

-- ------------------------------------------------------------------
-- promptarena_outreach_candidates   ⚠ GUARD ADDED HERE
-- ------------------------------------------------------------------

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
left join public.marketing_contacts mc on lower(mc.email) = p.email_key

-- ⚠ ADDED IN 0043. The proposal file this view came from omitted it, while
-- its own verification section named this exact view in the check that must
-- return zero rows for an ordinary member. Without it, every signed-in member
-- could read the email and mobile of 152 people.
where public.is_staff();

comment on view public.promptarena_outreach_candidates is
  'One row per person from the legacy events, with the segment and every exclusion named, mirroring tools/promptarena-campaign/stage-campaign.sql Part 1. Read-only: it cannot queue or send anything.';

revoke all on public.promptarena_outreach_candidates from anon, authenticated;
grant select on public.promptarena_outreach_candidates to authenticated;

-- ------------------------------------------------------------------
-- promptarena_challenge_calibration_staff
-- ------------------------------------------------------------------

create or replace view public.promptarena_challenge_calibration_staff
with (security_invoker = off) as
select c.*
from public.promptarena_challenge_calibration c
where public.is_staff();

comment on view public.promptarena_challenge_calibration_staff is
  'The 0029 calibration view with a staff predicate, so app/admin/promptarena.html can read it without a service-role key in a browser. No number is recomputed.';

revoke all on public.promptarena_challenge_calibration_staff from anon, authenticated;
grant select on public.promptarena_challenge_calibration_staff to authenticated;

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. All four carry the predicate now (expect 4 rows, all true):
--
--   select c.relname, pg_get_viewdef(c.oid) ilike '%is_staff%' as guarded
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind = 'v'
--      and c.relname in ('promptarena_legacy_submission_validity',
--                        'promptarena_legacy_player_directory',
--                        'promptarena_outreach_candidates',
--                        'promptarena_challenge_calibration_staff');
--
-- 2. anon reaches none of them (expect zero rows):
--
--   select table_name, privilege_type from information_schema.role_table_grants
--    where grantee = 'anon' and table_name like 'promptarena_%';
--
-- 3. ⚠ THE ONE THAT MATTERS, and the one nobody ran last time. Signed in as an
--    ORDINARY MEMBER — not staff — every one of these must return 0:
--
--   select count(*) from public.promptarena_legacy_player_directory;
--   select count(*) from public.promptarena_outreach_candidates;
--   select count(*) from public.promptarena_challenge_calibration_staff;
--   select count(*) from public.promptarena_legacy_submission_validity;
--
--    A non-zero answer means the predicate is gone again. Until somebody has
--    actually run this as a member, treat these views as unverified.
--
-- 4. From outside, as a signed-in member, this must be refused:
--
--   GET /rest/v1/promptarena_outreach_candidates?select=email,mobile&limit=1
