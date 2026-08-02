-- Sahaba Club — PromptArena
-- ------------------------------------------------------------
-- A practice mode for prompt engineering. A member is served a challenge, they
-- write a prompt against it, an AI judge scores it 1..10 and explains itself.
-- Their rating is the average of everything they have completed.
--
-- Ahmed, on who may play: "you must be logged-in even with standard free
-- account." So there is deliberately NO `subscriptions.tier` predicate
-- anywhere in this file. Every policy and every view gates on `authenticated`
-- and nothing else. If a paywall is ever wanted it belongs in one place, added
-- deliberately — not smuggled in as a join somebody adds while fixing
-- something else.
--
-- ============================================================
-- Scope: one of the two modes, and the wreckage of the other
-- ============================================================
--
-- PromptArena as it was pitched had two halves: **Online Practice Mode**, which
-- is what this file builds, and a live-event mode where a room full of people
-- enter a participant code and compete in rounds. The live mode ran six times
-- on Microsoft Forms and is explicitly out of scope — there is no participant
-- code, no session, no round timer and no lobby in this migration, and adding
-- one is a new migration and a new conversation.
--
-- What IS here is the *history* of those six events, because real people took
-- part in them and that record is being imported. Measured from the six
-- workbooks rather than remembered:
--
--   6 events · 159 player rows · 152 distinct people · 556 submissions.
--
-- Every figure quoted anywhere in the legacy section of this file comes from
-- that measurement, which is written up at `C:\sctools\promptarena-data\`.
-- ⚠ That directory must never be copied into this repository: it sits beside
-- an `events.json` holding un-redacted names, personal addresses and mobile
-- numbers for all 152 people, and this repository is PUBLIC.
--
-- Keeping their history is not the same as rebuilding the mode that produced
-- it. See the legacy section at the bottom, which is the most privacy-sensitive
-- part of this file: it holds names, personal email addresses and mobile
-- numbers for people who never signed up to anything on this website.
--
-- ============================================================
-- The one rule this schema is organised around: store only what cannot be derived
-- ============================================================
--
-- Almost every number PromptArena shows is a fact about the submissions table.
-- A rating is an average of scores. "Challenges completed" is a count of rows.
-- "Highest score" is a max. The brief says it in as many words — the rating is
-- "simply the average of all completed challenges".
--
-- Stored copies of those numbers would each be a second source of truth, kept
-- in step by a trigger, and the failure mode is not an error — it is a member
-- whose displayed rating quietly disagrees with their own submission list. That
-- has no loud symptom and no easy fix once the drift has been there a while.
-- Worse, a stored `rating` column is a *writable* rating column: it would need
-- a grant discipline of its own, and the first time somebody granted it by
-- accident, members could set their own score.
--
-- So per-member stats are a VIEW (`promptarena_member_stats`), computed from
-- submissions every time they are read. The costs are real and worth naming:
-- the leaderboard aggregates the whole submissions table on every read, and at
-- some size that needs a materialized view refreshed on a schedule. That is a
-- performance change made against a measurement, and it does not change any of
-- the reasoning above — a materialized view is still derived, still has one
-- definition, and still cannot be written by a member.
--
-- The single number that is genuinely NOT derivable is `times_served`: being
-- shown a challenge and walking away leaves no row anywhere, so serving has to
-- be counted where it happens. It is therefore the only counter stored on a
-- table in this file, and it is writable by the service role alone.

-- ============================================================
-- 1. The challenge bank
-- ============================================================
--
-- Challenges are generated, not written by hand. That is the point of the
-- feature — the bank grows, and it is supposed to learn which challenges are
-- too easy, too hard, and which people actually finish.
--
-- The generation axes are columns rather than a free-text `tags` array because
-- the generator is asked to *cover* them: "give me a hard, constrained,
-- creative brief in healthcare for a beginner audience". A text array cannot
-- answer "how many hard healthcare challenges do we have", and that question is
-- exactly what stops the bank filling up with forty variations of the same
-- thing.

create table if not exists public.promptarena_challenges (
  id uuid primary key default gen_random_uuid(),

  title text not null,

  -- What the member is asked to achieve, in their own words, with a prompt.
  brief text not null,

  -- 1 easiest … 5 hardest. An int rather than a label because "is this
  -- challenge harder than that one" is a comparison, and comparing labels means
  -- a CASE expression in every query that ever wants to order by difficulty.
  -- The UI names them; the database ranks them.
  difficulty int not null default 3 check (difficulty between 1 and 5),

  -- The generation axes. Free text with a NOT NULL default rather than a
  -- lookup table: these come out of a model and the vocabulary is expected to
  -- drift, and a foreign key here would turn "the generator invented a new
  -- domain" into a failed insert rather than a row somebody can look at.
  domain text not null default 'general',           -- 'healthcare', 'marketing', 'code'
  target_audience text not null default 'general',  -- 'beginner', 'developer', 'executive'

  -- How much room the brief leaves for invention. Same 1..5 shape as difficulty
  -- and for the same reason: it is ordered, so it is a number.
  creativity int not null default 3 check (creativity between 1 and 5),

  -- The rules the member's prompt has to respect — "under 60 words", "must not
  -- name the product". An array because the UI lists them as checkboxes beside
  -- the brief, and because the judge is handed them one by one.
  constraints text[] not null default '{}',

  -- What the judge is told to weight, e.g.
  --   {"clarity": 3, "specificity": 3, "constraint_adherence": 2, "creativity": 2}
  --
  -- ⚠ This is the marking scheme, and it is why `promptarena_challenges` is not
  -- readable by any client role. A member holding the rubric is a member who
  -- writes to the rubric instead of to the brief, which is precisely the skill
  -- the mode exists NOT to teach. Members read `promptarena_challenge_deck`
  -- below, whose column list omits this.
  rubric jsonb not null default '{}'::jsonb,

  -- Provenance, in the same spirit as `prospect_profiles.sources` (0027): when
  -- a challenge turns out to be incoherent or accidentally offensive, the first
  -- question is which model and which generation prompt produced it, and the
  -- answer should not depend on anybody remembering.
  generated_by_model text,
  generator_version text,
  generation_params jsonb not null default '{}'::jsonb,
  generated_at timestamptz,

  -- Retirement, not deletion. A challenge that turns out to be broken must stop
  -- being served without taking the submissions of everyone who already
  -- attempted it down with it — and their ratings depend on those rows.
  is_active boolean not null default true,
  retired_reason text,

  -- ⚠ The only stored counter in this file, and the exception to the rule at
  -- the top. A member who is shown a challenge and abandons it writes no
  -- submission, so "how often has this been served" cannot be recovered from
  -- anything else afterwards. Serving increments it, and serving happens in an
  -- Edge Function running as the service role.
  --
  -- Everything a reader might expect to sit beside it — attempts, completions,
  -- average score, the score distribution — is NOT here, because all of it is a
  -- GROUP BY over submissions. See `promptarena_challenge_calibration` below,
  -- which is where the "too easy / too hard / nobody finishes it" signal
  -- actually lives.
  times_served int not null default 0 check (times_served >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.promptarena_challenges is
  'AI-generated practice challenges. Not client-readable: the rubric is the marking scheme. Members read promptarena_challenge_deck.';
comment on column public.promptarena_challenges.rubric is
  'What the judge weights. Deliberately absent from every client-facing view — a member who can read it optimises for it.';
comment on column public.promptarena_challenges.times_served is
  'The one counter that cannot be derived: an abandoned challenge leaves no submission row. Written by the service role only.';

create index if not exists promptarena_challenges_pick_idx
  on public.promptarena_challenges (difficulty, domain) where is_active;
create index if not exists promptarena_challenges_served_idx
  on public.promptarena_challenges (times_served) where is_active;

drop trigger if exists promptarena_challenges_set_updated_at on public.promptarena_challenges;
create trigger promptarena_challenges_set_updated_at
  before update on public.promptarena_challenges
  for each row execute function public.set_updated_at();

-- ============================================================
-- 2. Submissions — one row per attempt
-- ============================================================
--
-- The structured-feedback decision is the whole of this table's shape, so it is
-- worth being explicit about what was rejected.
--
-- A single `feedback jsonb` blob would have been less typing. It also makes
-- three things impossible without writing a parser first: rendering "what was
-- good" and "what to improve" as separate blocks in the UI, checking that the
-- judge actually answered all four questions, and asking a year from now
-- whether the judge got harsher — because "harsher" means comparing the *same*
-- field across thousands of rows, and a blob has no same field, only whatever
-- each model run happened to emit.
--
-- So the four things the brief requires an evaluation to say are four columns,
-- and a CHECK constraint makes "judged" mean "explained". An unexplained score
-- cannot be stored; the judge either produces the whole evaluation or records a
-- failure. There is no third state where a member sees a 4 and no reason.

create table if not exists public.promptarena_submissions (
  id uuid primary key default gen_random_uuid(),

  -- `default auth.uid()` so the client never supplies it — which is what lets
  -- the INSERT grant below be column-level and name only two columns. If the
  -- default ever fails to apply the insert fails NOT NULL, loudly, rather than
  -- writing a row owned by nobody.
  user_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,

  -- No ON DELETE CASCADE from the challenge on purpose: challenges are retired
  -- (is_active = false), never deleted, precisely so that deleting one cannot
  -- silently lower somebody's rating. RESTRICT makes an attempted delete fail
  -- instead of quietly rewriting history.
  challenge_id uuid not null
    references public.promptarena_challenges (id) on delete restrict,

  -- The member's work. The only column they write, together with challenge_id.
  prompt_text text not null check (btrim(prompt_text) <> ''),

  -- 'pending'  submitted, the judge has not answered yet
  -- 'judged'   scored and explained — the only state that counts toward a rating
  -- 'failed'   the judge errored or returned something unusable; `judge_error`
  --            says what. The attempt stays visible to the member as unjudged
  --            rather than vanishing, and the service role may retry it.
  judge_status text not null default 'pending'
    check (judge_status in ('pending', 'judged', 'failed')),

  -- Nullable, and null until judged. See the CHECK below.
  score int check (score is null or score between 1 and 10),

  -- The four questions the brief requires every evaluation to answer, one
  -- column each. Arrays for the two that are naturally lists, because the UI
  -- renders them as bullets and a joined string would have to be split again.
  feedback_summary text,           -- why this score
  feedback_strengths text[],       -- what was good
  feedback_improvements text[],    -- what could be better
  feedback_how_to_improve text,    -- what to do differently next time

  -- Per-criterion marks against the challenge's rubric, e.g.
  --   {"clarity": 8, "specificity": 5, "constraint_adherence": 9}
  -- This is what makes judge consistency answerable later: an overall score
  -- drifting is ambiguous, but "the judge started marking specificity two
  -- points lower in March" is a finding. jsonb rather than columns because the
  -- criteria belong to the challenge's rubric and differ between challenges.
  rubric_scores jsonb not null default '{}'::jsonb,

  -- Which judge produced this. Without these, a consistency question can only
  -- be answered as "scores changed", never "the model changed underneath us".
  judge_model text,
  judge_version text,
  judge_error text,

  submitted_at timestamptz not null default now(),
  judged_at timestamptz,
  updated_at timestamptz not null default now(),

  -- A score only exists on a judged row, and a judged row is fully explained.
  -- This is the brief's "every evaluation must explain why" expressed as
  -- something the database enforces rather than something the Edge Function is
  -- trusted to remember.
  constraint promptarena_submissions_judged_is_explained check (
    case judge_status
      when 'judged' then
        score is not null
        and judged_at is not null
        and coalesce(btrim(feedback_summary), '') <> ''
        and coalesce(array_length(feedback_strengths, 1), 0) > 0
        and coalesce(array_length(feedback_improvements, 1), 0) > 0
        and coalesce(btrim(feedback_how_to_improve), '') <> ''
      else
        score is null
    end
  )
);

comment on table public.promptarena_submissions is
  'One row per attempt. Members insert challenge_id and prompt_text and nothing else; score and feedback are written by the judge running as the service role.';
comment on constraint promptarena_submissions_judged_is_explained on public.promptarena_submissions is
  'A judged submission must carry a score AND all four parts of the explanation. An unexplained score cannot be stored.';

create index if not exists promptarena_submissions_mine_idx
  on public.promptarena_submissions (user_id, submitted_at desc);
create index if not exists promptarena_submissions_rating_idx
  on public.promptarena_submissions (user_id, challenge_id) where judge_status = 'judged';
create index if not exists promptarena_submissions_challenge_idx
  on public.promptarena_submissions (challenge_id) where judge_status = 'judged';
-- The judge worker's queue.
create index if not exists promptarena_submissions_pending_idx
  on public.promptarena_submissions (submitted_at) where judge_status = 'pending';

drop trigger if exists promptarena_submissions_set_updated_at on public.promptarena_submissions;
create trigger promptarena_submissions_set_updated_at
  before update on public.promptarena_submissions
  for each row execute function public.set_updated_at();

-- ============================================================
-- 3. Access to the two live tables
-- ============================================================
--
-- Supabase grants ALL on a newly created table to anon and authenticated. Both
-- revokes below are therefore load-bearing, not tidiness: without them the
-- rubric — the marking scheme — and every member's prompts are world-readable
-- the moment this migration applies.

alter table public.promptarena_challenges enable row level security;
revoke all on public.promptarena_challenges from anon, authenticated;

-- No client role gets SELECT on the table itself at any tier; members reach
-- challenges through the deck view, whose column list is the boundary.
--
-- ⚠ Read this before wiring up an admin screen. The policy below is currently
-- INERT, and deliberately so. Grants are checked before policies, and ALL is
-- revoked from `authenticated` on the line above — staff are `authenticated`
-- too, so the policy grants them nothing today. It is written anyway because it
-- states the intended rule, and because that is the shape 0020 uses for
-- `hackathon_participants` for the same reason.
--
-- The consequence, said plainly so nobody debugs it twice: the challenge bank
-- is maintained by the service role, from an Edge Function or a SQL session. If
-- staff are ever to manage it directly from the browser, adding this policy is
-- not enough — a grant has to be added as well, and it should be `select,
-- insert, update` naming columns rather than `all`, because `rubric` leaking to
-- a staff member's browser session is a smaller problem than `all` quietly
-- including DELETE on rows that member submissions reference.
drop policy if exists "promptarena challenges: staff write" on public.promptarena_challenges;
create policy "promptarena challenges: staff write" on public.promptarena_challenges
  for all using (public.is_staff()) with check (public.is_staff());

alter table public.promptarena_submissions enable row level security;
revoke all on public.promptarena_submissions from anon, authenticated;

-- A member reads their own attempts, including their own feedback. That is the
-- whole point of the mode — you are meant to go back and read why you got a 6.
drop policy if exists "promptarena submissions: read own" on public.promptarena_submissions;
create policy "promptarena submissions: read own" on public.promptarena_submissions
  for select using (auth.uid() = user_id);

-- Staff may read submissions, because judging quality is something the club has
-- to be able to inspect and the judge is the thing most likely to go wrong.
-- SELECT only — nobody edits a member's prompt or a judge's verdict through a
-- policy. Note this reads member-written content; it is the same trust level
-- 0020 gives staff over `hackathon_participants`.
drop policy if exists "promptarena submissions: staff read" on public.promptarena_submissions;
create policy "promptarena submissions: staff read" on public.promptarena_submissions
  for select using (public.is_staff());

drop policy if exists "promptarena submissions: insert own" on public.promptarena_submissions;
create policy "promptarena submissions: insert own" on public.promptarena_submissions
  for insert with check (
    auth.uid() = user_id
    -- Belt and braces with the column-level INSERT grant below. The grant is
    -- the structural control; this is the one that still holds if a future
    -- migration widens the grant without reading this comment.
    and score is null
    and judge_status = 'pending'
    and judged_at is null
  );

-- ⚠ THE ACCESS DECISION OF THIS FILE, stated once, in full.
--
-- `authenticated` gets SELECT, and INSERT on exactly two columns. It does not
-- get UPDATE. It does not get DELETE. Neither omission is an oversight:
--
--   * **No UPDATE, so a member cannot write their own `score`.** The judge
--     assigns the score, and the judge is an Edge Function running as the
--     service role, which bypasses RLS and grants entirely. Scoring is a
--     service-role operation and nothing else in this schema may perform it.
--     A table-level INSERT grant would have been enough to let a member post a
--     row claiming a 10, so the grant is column-level and names the two columns
--     they legitimately write. `user_id` is not among them because it defaults
--     to `auth.uid()`.
--     ⚠ A column-level revoke cannot carve an exception out of a table-level
--     grant (0002 learned this the hard way) — so if UPDATE is ever needed here
--     for some new member-editable field, it must be granted column by column,
--     never granted table-wide and then narrowed.
--
--   * **No DELETE, and that is an anti-cheat control, not caution.** The rating
--     is an average over judged submissions. A member who could delete a row
--     could delete every score below their average and climb the leaderboard
--     without writing a single better prompt. Deriving the rating is what makes
--     this control sufficient: there is no stored number to correct afterwards,
--     so denying the delete denies the whole attack.
grant select on public.promptarena_submissions to authenticated;
grant insert (challenge_id, prompt_text) on public.promptarena_submissions to authenticated;

-- ============================================================
-- 4. What a member is allowed to see of a challenge
-- ============================================================
--
-- `security_invoker = off` for the reason `member_directory` (0023) and
-- `prospect_directory` (0027) are: it reads a table `authenticated` deliberately
-- holds no SELECT on, and the column list is what keeps that safe.
--
-- What is NOT here and must never be added: `rubric` (the marking scheme),
-- `generation_params` and `generator_version` (the recipe for producing more of
-- the same, which is a shortcut to predicting them), and `times_served` (a
-- serving counter a member can watch is a serving counter a member can game by
-- reloading until a rare challenge appears).
drop view if exists public.promptarena_challenge_deck;

create view public.promptarena_challenge_deck
with (security_invoker = off) as
select
  c.id,
  c.title,
  c.brief,
  c.difficulty,
  c.domain,
  c.target_audience,
  c.creativity,
  c.constraints,
  c.created_at
from public.promptarena_challenges c
where c.is_active
  and auth.uid() is not null;   -- logged in, any tier. See the header.

comment on view public.promptarena_challenge_deck is
  'The playable face of the challenge bank. No rubric, no generation params, no serving counter — the column list is the boundary.';

revoke all on public.promptarena_challenge_deck from anon, authenticated;
grant select on public.promptarena_challenge_deck to authenticated;

-- ============================================================
-- 5. Calibration — which challenges are too easy, too hard, ignored
-- ============================================================
--
-- The brief wants the bank to learn. This is where that lives, and it is a view
-- rather than columns on the challenge for the reason at the top of the file:
-- every number below except `times_served` is a GROUP BY over submissions, and
-- a stored copy is a copy that can be wrong.
--
-- `completion_rate` is the one that needs both halves — attempts come from
-- submissions, servings come from the stored counter — and it is the number
-- that actually answers "is this challenge too hard": a challenge people are
-- shown and walk away from is a different problem from one people attempt and
-- score 3 on.
--
-- Staff-facing. Not granted to any client role: it is keyed by challenge and
-- carries score distributions, which is enough to reverse-engineer the
-- difficulty model, and it has no member-facing use.
drop view if exists public.promptarena_challenge_calibration;

create view public.promptarena_challenge_calibration
with (security_invoker = off) as

-- Aggregated in CTEs and joined in, rather than one big LEFT JOIN with a GROUP
-- BY. The first draft of this view cross-joined `generate_series(1, 10)` to
-- build the histogram in the same pass as the counts, which multiplied every
-- row by ten and made `attempts` and `distinct_players` silently ten times too
-- large. Aggregating each shape separately is the version that is right.
with per_challenge as (
  select
    s.challenge_id,
    count(*)                                                        as attempts,
    count(*) filter (where s.judge_status = 'judged')                as completions,
    count(distinct s.user_id)                                        as distinct_players,
    -- Parenthesised before the cast on purpose: `agg() filter (...)::numeric`
    -- is not something to guess at, and `stddev_pop` over an int returns double
    -- precision, for which two-argument `round` does not exist at all.
    round((avg(s.score) filter (where s.judge_status = 'judged'))::numeric, 2)
                                                                     as avg_score,
    min(s.score) filter (where s.judge_status = 'judged')            as min_score,
    max(s.score) filter (where s.judge_status = 'judged')            as max_score,
    round((stddev_pop(s.score) filter (where s.judge_status = 'judged'))::numeric, 2)
                                                                     as score_spread,
    max(s.judged_at)                                                 as last_completed_at
  from public.promptarena_submissions s
  group by s.challenge_id
),

-- The distribution proper: {"3": 11, "4": 2, "9": 40}. A mean of 5 made of
-- fives and a mean of 5 made of ones and nines are different challenges, and
-- only one of them is calibrated. Sparse — a score nobody has been given has no
-- key, and a missing key means zero.
histogram as (
  select g.challenge_id, jsonb_object_agg(g.score::text, g.n) as score_histogram
  from (
    select challenge_id, score, count(*) as n
    from public.promptarena_submissions
    where judge_status = 'judged' and score is not null
    group by challenge_id, score
  ) g
  group by g.challenge_id
)

select
  c.id                                as challenge_id,
  c.title,
  c.difficulty                        as intended_difficulty,
  c.domain,
  c.target_audience,
  c.is_active,
  c.times_served,

  coalesce(p.attempts, 0)             as attempts,
  coalesce(p.completions, 0)          as completions,
  coalesce(p.distinct_players, 0)     as distinct_players,

  -- Of the people who were shown it, how many produced a judged attempt.
  -- Null rather than 0 when nothing has been served yet — "we have no idea"
  -- and "nobody finishes it" must not render as the same number.
  case when c.times_served > 0
       then round(coalesce(p.completions, 0)::numeric / c.times_served, 3)
  end                                 as completion_rate,

  p.avg_score,
  p.min_score,
  p.max_score,
  p.score_spread,
  coalesce(h.score_histogram, '{}'::jsonb) as score_histogram,
  p.last_completed_at
from public.promptarena_challenges c
left join per_challenge p on p.challenge_id = c.id
left join histogram     h on h.challenge_id = c.id;

comment on view public.promptarena_challenge_calibration is
  'Per-challenge difficulty and engagement signal, derived from submissions. Staff/service-role only — a member who could read this could read the difficulty model.';

-- No grant to anon or authenticated at all. Staff reach it through the service
-- role or a SQL session, the same way they reach prospect_profiles (0027).
revoke all on public.promptarena_challenge_calibration from anon, authenticated;

-- ============================================================
-- 6. The privacy flag
-- ============================================================
--
-- The brief: a member chooses "show my PromptArena ranking publicly" or "hide".
--
-- ⚠ This section is deliberately BEFORE the two views that read the column.
-- Section order is execution order, and 0019 had three failed attempts to apply
-- because a view selected a column that a later section added. Columns before
-- the things that read them.
--
-- **Default false, and that is not a preference.** Everyone who has ever
-- submitted anything appears in `promptarena_member_stats` the moment it is
-- created. Defaulting the flag to true would put all of them on a public
-- ranking with their name and their average, retroactively, without anyone
-- having been asked. Note that 0019 did default `is_discoverable` to true —
-- that was a considered decision about a directory people had already filled in
-- a profile for, and it does not transfer to a scoreboard, which publishes a
-- judgement of how good you are at something rather than a description of who
-- you are.

alter table public.profiles
  add column if not exists show_in_promptarena_ranking boolean not null default false;

comment on column public.profiles.show_in_promptarena_ranking is
  'Opt-in to the PromptArena leaderboard. Defaults to false — nobody is ranked publicly until they say so.';

-- ⚠⚠ THE SINGLE MOST REPEATED BUG IN THIS PROJECT, AND THE REASON THIS LINE IS
-- HERE. `public.profiles` uses an explicit column-level UPDATE allowlist: 0002
-- revoked the table-wide grant and every migration since (0005 → 0017 → 0019 →
-- 0022 → 0023) has had to hand the privilege back one column at a time. A new
-- column therefore arrives UNWRITABLE.
--
-- This one is member-editable — it is a consent toggle, so it is by definition
-- the member's to set — and it must be granted. The failure mode if it is not
-- is silent: a column-level REVOKE is a no-op where the grant was never made,
-- PostgREST returns success with zero rows changed, the switch springs back to
-- "hidden", and the member sees no error at all. 0017 exists entirely because
-- that happened to six other columns.
grant update (show_in_promptarena_ranking) on public.profiles to authenticated;

-- ============================================================
-- 7. Per-member stats — one definition, two exposures
-- ============================================================
--
-- This view is the single definition of what a rating is. `promptarena_my_stats`
-- and `promptarena_leaderboard` both read it and neither recomputes it, because
-- two copies of an average is two averages that can disagree — and the version a
-- member sees on their own page disagreeing with the one on the leaderboard is
-- the exact bug that makes people stop trusting a score.
--
-- It is internal. **No client role gets a grant on it**, in either direction:
-- it covers every member including those who have not opted into the ranking.
-- The two views below are the only routes in, and their WHERE clauses are what
-- make them safe. Same internal/wrapper split as 0027's claim functions, for
-- the same reason.
--
-- Two definitions that the brief left open and that are settled here:
--
--   **Rating counts every judged attempt**, exactly as worded — "simply the
--   average of all completed challenges". Retries are allowed and each judged
--   retry counts. The honest cost: a member can lift their average by replaying
--   an easy challenge, and `challenges_completed` (distinct) will sit below
--   `judged_attempts` when they do, which is why both are exposed rather than
--   just the one. If that turns out to matter, "best attempt per challenge" or
--   "first attempt only" is a change to the `judged` CTE below and nothing
--   else — which is the practical payoff of deriving the rating instead of
--   storing it. A stored rating would need a backfill and a trigger rewrite.
--
--   **A streak is consecutive days on which you completed something**, in
--   Asia/Dubai, and it survives until a whole day passes with nothing. Dates are
--   computed in the club's timezone rather than UTC on purpose: UTC midnight is
--   4am in Dubai, so a member playing late in the evening and again the next
--   evening would be recorded on the same UTC date, and one playing at 2am would
--   silently break their own streak. A streak that punishes people for their
--   own timezone is a broken streak.
drop view if exists public.promptarena_leaderboard;
drop view if exists public.promptarena_my_stats;
drop view if exists public.promptarena_member_stats;

create view public.promptarena_member_stats
with (security_invoker = off) as
with judged as (
  select
    s.user_id,
    s.challenge_id,
    s.score,
    (s.judged_at at time zone 'Asia/Dubai')::date as played_on
  from public.promptarena_submissions s
  where s.judge_status = 'judged'
    and s.score is not null
),
per_member as (
  select
    j.user_id,
    round(avg(j.score)::numeric, 2)   as rating,
    count(distinct j.challenge_id)    as challenges_completed,
    count(*)                          as judged_attempts,
    max(j.score)                      as highest_score,
    min(j.score)                      as lowest_score,
    max(j.played_on)                  as last_played_on
  from judged j
  group by j.user_id
)
select
  m.user_id,
  m.rating,
  m.challenges_completed,
  m.judged_attempts,
  m.highest_score,
  m.lowest_score,
  m.last_played_on,
  coalesce(st.current_streak, 0) as current_streak
from per_member m
-- The leading run of consecutive days, and only the leading run. Numbering the
-- distinct days newest-first and keeping those where `day = anchor - (n - 1)`
-- works because once a gap appears the day falls behind the counter and can
-- never catch up again — the counter drops by exactly one per row, the days by
-- at least one. The guard on `last_played_on` is what makes a stale streak zero
-- instead of resurrecting a run from last March; yesterday still counts, so the
-- streak does not evaporate at midnight while the member is asleep.
left join lateral (
  select count(*)::int as current_streak
  from (
    select d.played_on,
           row_number() over (order by d.played_on desc) as rn
    from (select distinct j.played_on
            from judged j where j.user_id = m.user_id) d
  ) x
  where m.last_played_on >= (now() at time zone 'Asia/Dubai')::date - 1
    -- (rn - 1) cast explicitly: row_number() is bigint and `date - bigint` has
    -- no operator, so without the cast this fails to parse rather than
    -- misbehaving quietly.
    and x.played_on = m.last_played_on - (x.rn - 1)::int
) st on true;

comment on view public.promptarena_member_stats is
  'The single definition of a PromptArena rating, derived from submissions. Internal: covers every member including those who have not opted into the ranking, so no client role may read it.';

-- Supabase grants ALL on a new view to anon and authenticated. This one is
-- never granted back to anything.
revoke all on public.promptarena_member_stats from anon, authenticated;

-- ---- What a member sees about themselves ----------------------------
--
-- Scoped twice over. The predicate restricts it to the caller, and it is
-- `security_invoker = off` only because its source view is unreadable by
-- clients — so the predicate is the boundary and is written plainly rather than
-- inherited from anything.
create view public.promptarena_my_stats
with (security_invoker = off) as
select
  s.user_id,
  s.rating,
  s.challenges_completed,
  s.judged_attempts,
  s.highest_score,
  s.lowest_score,
  s.current_streak,
  s.last_played_on,
  -- Their own opt-in state, so the page can render the toggle without a second
  -- round trip to `profiles`. Their own row, so nothing is disclosed.
  coalesce(p.show_in_promptarena_ranking, false) as show_in_ranking
from public.promptarena_member_stats s
left join public.profiles p on p.user_id = s.user_id
where s.user_id = auth.uid()
  and auth.uid() is not null;

revoke all on public.promptarena_my_stats from anon, authenticated;
grant select on public.promptarena_my_stats to authenticated;

-- ============================================================
-- 8. The leaderboard
-- ============================================================
--
-- ⚠ THE RANKING IS COMPUTED OVER THE OPTED-IN POPULATION ONLY. The filter is in
-- the CTE, the window function is outside it, and that order is the entire
-- privacy property of this view. Do not move the `rank()` inside a CTE that
-- still contains hidden members, and do not "fix" a leaderboard that starts at
-- 1 by ranking everyone first and filtering afterwards.
--
-- Why it matters, concretely. Rank everyone and then filter, and the numbering
-- comes out 1, 2, 4, 5, 9 — every gap announces a member who chose to be
-- hidden, how many of them there are, and exactly where their rating sits
-- between the two visible rows on either side. With ten visible rows either
-- side of a hidden one, their average is pinned to a range of a few hundredths.
-- A member who chose "hide" would have had their rank and very nearly their
-- score published anyway, by arithmetic.
--
-- Ranking after the filter makes hidden members not exist here at all. The
-- numbering is contiguous 1..N over the visible rows and carries no information
-- about anybody else — not their rank, not their score, not their number.
--
-- The tiebreak is total (rating, then challenges completed, then user_id), so
-- `rank()` never ties and the numbering has no gaps of any kind. That is
-- deliberate on two counts: gaps are the thing this view must not produce, and
-- 0028 already paid for the lesson that a non-unique sort key makes
-- OFFSET/LIMIT paging show some rows twice and drop others.
--
-- What this view exposes, and what it does not:
--
--   exposed — rank, display name, avatar, rating, challenges completed,
--             highest score. That is a scoreboard.
--
--   NOT exposed — prompt text, judge feedback, per-challenge scores, streak,
--             last played. Those describe *when and how* somebody plays, and
--             consenting to be ranked is not consenting to publish an activity
--             log. A streak in particular says which days a person was at their
--             keyboard.
--
--   NOT exposed — anything at all about a member who has not opted in, including
--             their existence, their count, and any statistic computed over
--             them. There is no "you are 14th of 92" here: the denominator is
--             the visible population, and a total that included hidden members
--             would leak how many there are.
--
-- `authenticated` only, never `anon`. "Publicly" in the brief means "to the
-- club" — no member surface in this schema has ever been readable without an
-- account (0019, 0020, 0023, 0027, 0028 all revoke anon), and reading the
-- narrower meaning of a consent phrase is the right way round to be wrong.
create view public.promptarena_leaderboard
with (security_invoker = off) as
with opted_in as (
  -- ⚠ The filter. Everything below this line sees only members who said yes.
  select
    s.user_id,
    s.rating,
    s.challenges_completed,
    s.highest_score,
    p.full_name,
    p.avatar_url,
    p.is_discoverable
  from public.promptarena_member_stats s
  join public.profiles p on p.user_id = s.user_id
  where p.show_in_promptarena_ranking
)
select
  (rank() over (
    order by o.rating desc, o.challenges_completed desc, o.user_id
  ))::int as rank,

  -- The row key. A uuid on its own discloses nothing — `profiles` is "read own"
  -- only (0001), so this cannot be turned into a profile — and the page needs
  -- it to highlight "this is you" without a second query.
  o.user_id,

  o.full_name,
  o.avatar_url,

  -- The clickable link, and only for members who are also in Connect. Same
  -- pattern and same reasoning as `hackathon_roster` (0020): opting into the
  -- ranking is consent to be ranked, not consent to be browsed.
  case when o.is_discoverable then o.user_id end as profile_user_id,

  o.rating,
  o.challenges_completed,
  o.highest_score
from opted_in o;

comment on view public.promptarena_leaderboard is
  'Opted-in members only, ranked among themselves. The rank() is computed after the opt-in filter so the numbering is contiguous and cannot be used to infer a hidden member''s rank or score.';

-- A view is the worst place to leave the default grant in place, because
-- security_invoker = off means anon would be reading it with the owner's rights.
revoke all on public.promptarena_leaderboard from anon, authenticated;
grant select on public.promptarena_leaderboard to authenticated;

-- ============================================================
-- 9. Legacy events — six real Microsoft Forms rounds
-- ============================================================
--
-- 152 real people across 159 player rows, with real names, personal email
-- addresses and mobile numbers, who competed at events and never signed up to
-- this website. The three tables below are the most sensitive thing in this
-- migration and they are treated the way 0027 treats `prospect_profiles`: RLS
-- on, **no client policy of any kind**, grants revoked, and a view with a
-- deliberately narrow column list as the only route in.
--
-- ⚠ EVERYTHING IN THIS SECTION WAS REWRITTEN AGAINST A MEASUREMENT. The first
-- draft was written on a premise handed to its author — "two of the six events
-- were never judged and every score in them is 0" — which was later measured
-- against the six source workbooks and refuted outright. The refutation and
-- what replaced it are recorded on `promptarena_legacy_events` below, at
-- length and on purpose: the premise is plausible enough that somebody will
-- re-derive it from the raw files within a year, and acting on it destroys
-- around 60 real people's real marks. This is the same reason 0027 records
-- that reconstructing `handle_new_user` from memory dropped the
-- `subscriptions` insert — a wrong belief that has been paid for once should
-- not have to be paid for twice.
--
-- As in 0027, no `auth.users` row is created for any of these people, and the
-- reasoning transfers exactly: an auth account is reachable by password-reset
-- mail, so creating one for somebody who never asked lets a stranger who
-- guesses their address make us email them; it corrupts every count of members
-- including the licence screens; and undoing it means deleting real accounts.
-- A legacy player is a record of something that happened, not an account.

-- ---- The events ------------------------------------------------------

create table if not exists public.promptarena_legacy_events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,

  -- ⚠ NOT AN EVENT DATE, AND THERE IS NO EVENT DATE. None of the six exports
  -- has an event-date column; the only timestamp is `Created`, which is when a
  -- row was written. So this pair is the min and max of that, named honestly,
  -- and the UI is expected to render a range or nothing rather than a day.
  --
  -- For four of the six the pair collapses to one day and the distinction is
  -- academic. For `july18` it is not, and this is the second measured fact this
  -- file was rewritten to record: **`july18` is not a single event.** Its 256
  -- rows span 2025-07-18 to 2026-07-14 because the Forms list was left open and
  -- reused — 177 rows in July 2025, then a trickle across twelve months
  -- including 38 rows on the Aug 30 event date and 6 in mid-September, the same
  -- dates as two of the other events. (No email is shared with those events, so
  -- these are different people walking up to a stale link, not duplicates.)
  --
  -- The consequence, stated so nobody quotes a `july18` number without it: any
  -- per-event statistic on `july18` is really a statistic on *everything that
  -- ever hit that link*, and printing a single date beside it tells most of
  -- those players they played on a day they did not. `cairo-aws-techup` is a
  -- milder case of the same thing — 67 rows across two days in September 2025,
  -- then one stray in January 2026 and one in February.
  held_on date,
  date_last date,

  -- Derived from the two columns above rather than asserted beside them, for
  -- the reason at the top of this file: an asserted copy is a copy that can
  -- disagree with what it describes. False is the instruction to the UI — name
  -- the range, or name no date at all.
  is_single_day boolean generated always as (
    held_on is not null and date_last is not null and held_on = date_last
  ) stored,

  -- The Microsoft Forms export this event was reconstructed from. Kept because
  -- when a number here is questioned a year from now, "which file did this come
  -- from" is the first question and nobody will remember.
  source_file text not null,
  source_system text not null default 'microsoft_forms',

  -- ============================================================
  -- ⚠⚠ `was_judged` WAS HERE. IT IS GONE. DO NOT PUT IT BACK.
  -- ============================================================
  --
  -- This file used to carry a `was_judged boolean not null default false`, and
  -- the member-facing view at the bottom gated every score and every comment on
  -- it. It existed because of one claim, made in the brief this migration was
  -- written from: that `Aug30 (Public)` and `Cairo-AWS-TechUp` were never
  -- judged and every score in them is 0.
  --
  -- **That claim was measured against the six source workbooks and refuted.**
  -- Not softened, not qualified — refuted. What the measurement found:
  --
  --   * All six events were judged.
  --   * Every 0 in those two events is a round the player never attempted:
  --     26 of 26 zero cells in `Aug30 (Public)`, 238 of 238 in
  --     `Cairo-AWS-TechUp`. **No played round in either event scored 0.**
  --   * Played rounds there mean 4.89 and 4.91, against 4.93 (`july18`), 5.39
  --     (`december-eh4`) and 4.93 (`aicd`) for the events nobody doubted. Six
  --     event means inside a 0.5-point band is the single strongest piece of
  --     evidence that one configured judge scored all six.
  --   * Exactly ONE genuine zero exists in all 556 submissions — a round-2
  --     answer in `ai-skills-fest`, and a good one. It is a judge failure, not
  --     an unjudged event.
  --
  -- What IS broken is the source's aggregate column, and only that: 53 players
  -- carry a stored total of 0 while their own rounds sum to 12–36 (`Aug30`) and
  -- 2–27 (`Cairo`). The two events spelling the column `TotalScore` never had
  -- the aggregation step run; the two spelling it `Total_Score` are correct for
  -- all 34 of their players. The eye-catching all-zero column was never the
  -- round scores. See the players table for why no total is stored here at all.
  --
  -- So the flag was not merely redundant once the premise fell — it was the
  -- mechanism by which the premise would have done damage. It defaulted to
  -- FALSE, the view suppressed `score` whenever it was false, and the importer
  -- instruction attached to it said to null those two events outright. Run as
  -- written it destroys roughly 60 real marks belonging to real people and
  -- collapses the scored population from about 86 to about 26. A per-event
  -- boolean that is true for all six rows, defaults to the value that hides
  -- data, and silently suppresses real marks when wrong is not a safety net.
  --
  -- **The distinction that matters is per-row, and the design already had it
  -- right: a NULL score means that round was never attempted, and must never
  -- render as 0.** That is now the primary and only mechanism for the question
  -- "does a mark exist here". See `promptarena_legacy_submissions.score`.
  --
  -- One piece of the old flag's reasoning was sound and is kept: *inference
  -- from a table of nulls is how the wrong sentence reaches the screen*, so a
  -- fact the UI needs should be handed to it as a column rather than deduced.
  -- That argument was simply applied to a fact that is not true. Applied to one
  -- that is, it gives the column below.

  -- A real, measured, per-event fact that genuinely varies: the two
  -- long-format exports carry a `Comment` column and the four wide ones have no
  -- comment column at all, so 262 of 556 submissions have no judge comment and
  -- never did. Without this the UI cannot tell "the judge wrote nothing about
  -- your round" from "this export format never recorded feedback", and those
  -- are different sentences to put in front of somebody.
  --
  -- ⚠ It is informational. It never gates a score, and nothing may be written
  -- that makes it gate one. Default false so a wrongly-defaulted event
  -- under-promises feedback rather than promising feedback that does not exist.
  has_judge_comments boolean not null default false,

  -- The per-event caveat a reader needs before trusting any number on this
  -- event: the reused `july18` list, the broken `TotalScore` aggregate, the
  -- absent comment column. **The name is a holdover** — it is kept only
  -- because `lib/promptarena.js` already selects it, and it no longer means
  -- "why this event has no scores", because no such event exists.
  judging_note text,

  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.promptarena_legacy_events.held_on is
  'First source timestamp, NOT an event date — no export has one. Read with date_last and is_single_day: july18 spans a year because its Forms list was left open and reused.';
comment on column public.promptarena_legacy_events.is_single_day is
  'Derived. False means this event has no single date and must not be shown with one.';
comment on column public.promptarena_legacy_events.has_judge_comments is
  'True only for the two long-format exports; the four wide ones have no comment column, so 262 of 556 submissions never had feedback. Informational — it never gates a score.';
comment on column public.promptarena_legacy_events.judging_note is
  'Per-event data caveat. The name is a holdover: all six events were judged. There is deliberately no was_judged flag — see the table definition.';

drop trigger if exists promptarena_legacy_events_set_updated_at on public.promptarena_legacy_events;
create trigger promptarena_legacy_events_set_updated_at
  before update on public.promptarena_legacy_events
  for each row execute function public.set_updated_at();

-- ---- The players -----------------------------------------------------

create table if not exists public.promptarena_legacy_players (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null
    references public.promptarena_legacy_events (id) on delete cascade,

  full_name text not null,

  -- ⚠ PERSONAL DATA. Neither of these columns appears in any view in this file,
  -- and neither may ever be added to one. They exist for exactly one purpose:
  -- matching a player to a member who signs up with the same address, below.
  -- The mobile number has no purpose in this schema at all beyond being part of
  -- the record as it was collected — it is here because discarding a field
  -- mid-import loses it permanently, not because anything reads it.
  email text,
  mobile text,

  -- Filled when the email matches a member, null otherwise. Written by the
  -- importer running as the service role.
  --
  -- ⚠ This migration deliberately does NOT touch `handle_new_user()`. 0027's
  -- rewrite of it carries a warning that every re-declaration must stay in step
  -- with 0021's body or it silently reverts things — including the
  -- `subscriptions` insert. Wiring legacy linking into signup is a change to
  -- that function and belongs with whoever owns the functions for this feature,
  -- in its own migration, diffed against 0027.
  user_id uuid references auth.users (id) on delete set null,
  linked_at timestamptz,

  -- ⚠ THERE IS DELIBERATELY NO TOTAL, AVERAGE OR BEST-SCORE COLUMN HERE, and
  -- that absence is load-bearing rather than an omission.
  --
  -- The source exports do carry a total — `TotalScore` in `Aug30 (Public)` and
  -- `Cairo-AWS-TechUp`, `Total_Score` in `AICD` and `AI Skills Fest` — and the
  -- first spelling is broken. 53 players' stored total reads 0 while their own
  -- round scores sum to between 12 and 36 (Aug30) and 2 and 27 (Cairo); not one
  -- of the 53 has a true total of 0. The aggregation step never ran for those
  -- two events. The other spelling is correct for all 34 of its players, which
  -- is exactly what makes the broken one convincing when you glance at it.
  --
  -- ⚠ IMPORTER RULE: do not import it under any name, and never trust it. The
  -- column is not here, so it cannot be read by accident, and a total is summed
  -- from `promptarena_legacy_submissions.score` at read time. That is the same
  -- rule as the rest of this file — store only what cannot be derived — and
  -- here it is also the only thing standing between 53 real people and a zero
  -- they never earned.

  created_at timestamptz not null default now()
);

comment on table public.promptarena_legacy_players is
  'Real people who competed on Microsoft Forms. Holds personal email and mobile. No client role may read this table; no auth.users row is ever created for them (see 0027).';

-- One row per person per event. Partial, because some exports have no address
-- and two nameless nulls are not a duplicate.
create unique index if not exists promptarena_legacy_players_event_email_idx
  on public.promptarena_legacy_players (event_id, lower(email))
  where email is not null;
create index if not exists promptarena_legacy_players_email_idx
  on public.promptarena_legacy_players (lower(email)) where email is not null;
create index if not exists promptarena_legacy_players_user_idx
  on public.promptarena_legacy_players (user_id) where user_id is not null;

-- ---- Their submissions -----------------------------------------------

create table if not exists public.promptarena_legacy_submissions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null
    references public.promptarena_legacy_players (id) on delete cascade,
  event_id uuid not null
    references public.promptarena_legacy_events (id) on delete cascade,

  round_number int not null check (round_number >= 1),
  question text,
  prompt_text text,

  -- ⚠ NULLABLE, AND THE NULL IS THE POINT — and since `was_judged` was removed
  -- this is the ONLY mechanism, which is what it should always have been. Null
  -- means "no mark exists for this row", which in this dataset always means the
  -- player never attempted the round. Zero means "a judge looked at this and
  -- gave it zero", which happened exactly once in 556 submissions.
  --
  -- ⚠⚠ IMPORTER RULE. This replaces the instruction that used to sit here,
  -- which told the importer to write NULL for every row in two named events
  -- because those events "were never judged". That premise was measured and
  -- refuted (the refutation is on `promptarena_legacy_events` above), and
  -- obeying the old instruction would have destroyed roughly 60 real marks. The
  -- rule is:
  --
  --   1. A round is PLAYED when its question or its answer is non-empty.
  --      **Decide played-or-not from the question and answer text, never from
  --      the score cell.** 159 player rows contain 795 round slots of which 556
  --      were played.
  --   2. For a played round, import the exported score AS-IS — including a 0.
  --      The single genuine zero in the dataset is a real verdict and belongs
  --      here. **Never null a score because of which event it came from.**
  --   3. For a round that was NOT played, the score is NULL. Whether the row is
  --      written at all with a null score, or omitted entirely, is the
  --      importer's choice and both are honest — this column is nullable so
  --      that the first option exists. What is forbidden is carrying the
  --      exported cell across: in the two wide exports that cell literally
  --      reads 0 for an unplayed round — 26 of 26 such cells in
  --      `Aug30 (Public)`, 238 of 238 in `Cairo-AWS-TechUp` — and importing it
  --      as 0 is precisely how real people get shown a zero they never earned.
  --   4. Never import or trust the source's `TotalScore` / `Total_Score`
  --      aggregate; recompute every total by summing these scores. See
  --      `promptarena_legacy_players`.
  --   5. Flag a round-5 row invalid when it exhibits the copied-verdict
  --      artefact — test the artefact, not the file name. See the column below.
  --
  -- The range starts at 0, not 1, unlike `promptarena_submissions` — the live
  -- judge scores 1..10 but the Forms export recorded a genuine 0, and narrowing
  -- the constraint would reject real history to make it match a newer rule.
  score numeric(5,2) check (score is null or score between 0 and 10),
  judge_comment text,

  -- ⚠ ROUND 5 CARRIES A VERDICT NOBODY GAVE IT, and this column is where that
  -- is recorded. NULL means the row is trustworthy. Non-null names a measured
  -- defect in the source and means the score and the comment on this row must
  -- never be shown and never be counted — the view at the bottom of this file
  -- masks both, and the event summary excludes them from `scored_count`.
  --
  -- The one value the import writes today is
  -- `'round5_verdict_copied_from_round4'`. **All 48 round-5 rows across both
  -- long-format files carry a score AND a judge comment byte-identical to the
  -- same player's round-4 row**, while the round-5 question and prompt are
  -- different: 41 of 41 in `july18`, 7 of 7 in `december-eh4`, not one escapes
  -- it. In the clearest case a round-5 water-conservation prompt carries the
  -- comment "Avoid unrelated metaphors like candy and swimming", which is about
  -- that player's round-4 blockchain answer. No other round pair in either file
  -- shares a single comment (r1/r2: 0 of 449, r2/r3: 0 of 168, r3/r4: 0 of 98),
  -- so this is a bug in the original pipeline specific to round 5 and not
  -- general copying. Round 5's verdict was copied, not produced.
  --
  -- ⚠ "Round 5" is not itself the test, and the importer must not use it as
  -- one. The four wide exports have no comment column at all, so their round-5
  -- rows are as real as any other round. The test is the artefact, in three
  -- parts, and dropping the first part is a trap:
  --
  --   a. the event carries judge comments at all (`has_judge_comments`),
  --   b. same score as this player's round 4,
  --   c. same judge comment as this player's round 4, compared with
  --      `is not distinct from` so two NULLs compare equal.
  --
  -- Without (a), (c) is satisfied by every wide-export row — all their comments
  -- are NULL, so two NULLs match — and any player who happened to score the
  -- same in rounds 4 and 5 loses a real mark. `tools/promptarena-campaign`
  -- guards it the same way. Testing the artefact rather than a list of file
  -- names is also why a seventh export landing tomorrow is handled without an
  -- edit here.
  --
  -- Why a column, rather than a CHECK or a derivation at read time:
  --
  --   * A CHECK cannot see another row, so it cannot express "identical to this
  --     player's round 4" at all. The only constraint available is the one
  --     attached here, which merely stops the reason being an empty string.
  --   * It IS derivable — `tools/promptarena-campaign` derives this exact
  --     predicate with a self-join, deliberately testing the artefact rather
  --     than a list of file names, and the verification block below asserts the
  --     two agree. But every reader would have to remember to write that join,
  --     and the cost of forgetting is a fabricated verdict shown to a real
  --     person. This is the one piece of reasoning the deleted `was_judged`
  --     flag had right — inference from the shape of the data is how the wrong
  --     number reaches the screen — applied at the grain where it is true,
  --     which is the row and not the event.
  --   * Free text rather than a boolean so that a second defect found later
  --     gets its own name instead of being folded into round 5's.
  --
  -- ⚠ Do NOT delete these rows instead, and do not null their `prompt_text`.
  -- What the player wrote is real and is theirs; only the verdict stapled to it
  -- is fabricated.
  invalid_reason text
    check (invalid_reason is null or btrim(invalid_reason) <> ''),

  created_at timestamptz not null default now()
);

comment on column public.promptarena_legacy_submissions.score is
  'NULL means the round was never attempted. 0 means judged and scored zero — which happened exactly once in 556 submissions. The two are not the same and must not render the same.';
comment on column public.promptarena_legacy_submissions.invalid_reason is
  'Non-null marks a measured defect in the source row: its score and comment must never be shown or counted. All 48 round-5 rows in the long-format exports copy the player''s round-4 verdict verbatim.';

create index if not exists promptarena_legacy_submissions_player_idx
  on public.promptarena_legacy_submissions (player_id, round_number);
create index if not exists promptarena_legacy_submissions_event_idx
  on public.promptarena_legacy_submissions (event_id, round_number);

-- ---- Access ----------------------------------------------------------
--
-- Three tables, three revokes, no client policies. Supabase grants ALL on each
-- of them to anon and authenticated at creation; without these three lines the
-- personal email addresses and mobile numbers of 152 people who never signed up
-- to this website are readable by anyone who loads the public site.
--
-- Staff read these through the service role or a SQL session, exactly as they
-- read `prospect_profiles` (0027). There is deliberately no `is_staff()` policy
-- even on the events table: the RLS-enabled-with-no-policy state is the one
-- that fails closed, and the events table is only interesting alongside the
-- players, which must stay closed.

alter table public.promptarena_legacy_events enable row level security;
revoke all on public.promptarena_legacy_events from anon, authenticated;

alter table public.promptarena_legacy_players enable row level security;
revoke all on public.promptarena_legacy_players from anon, authenticated;

alter table public.promptarena_legacy_submissions enable row level security;
revoke all on public.promptarena_legacy_submissions from anon, authenticated;

-- ---- Route in, 1 of 2: an event summary with no people in it ---------
--
-- Enough for the UI to say "six events, 2025–2026, all six judged" without
-- naming or counting anybody in a way that identifies them. Player and
-- submission counts are aggregates over the whole event, which is the same
-- shape of fact as "150 people took part in EduHackAI".
--
-- Three columns are surfaced here rather than left for the client to infer,
-- because inference from the shape of the data is how a wrong number gets
-- published — the one argument the deleted `was_judged` flag got right:
--
--   `is_single_day`      false means this event has no single date. A client
--                        that renders `held_on` regardless tells most of
--                        `july18`'s players they played on a day they did not.
--   `has_judge_comments` false means the export never had a comment column, so
--                        "no feedback" is a property of the file and not a
--                        verdict on the player.
--   `invalid_count`      rows whose stored verdict is known fabricated. Broken
--                        out so `submission_count - scored_count` is never
--                        mistaken for "rounds nobody played".
--
-- ⚠ `scored_count` counts rows carrying a real mark: non-null AND not flagged
-- invalid. It must never be computed as `count(score)` alone, because that
-- silently readmits the 48 copied round-5 verdicts.
drop view if exists public.promptarena_legacy_event_summary;

create view public.promptarena_legacy_event_summary
with (security_invoker = off) as
select
  e.id,
  e.slug,
  e.name,
  e.held_on,
  e.date_last,
  e.is_single_day,
  e.has_judge_comments,
  e.judging_note,
  (select count(*) from public.promptarena_legacy_players pl
    where pl.event_id = e.id)                             as player_count,
  (select count(*) from public.promptarena_legacy_submissions ls
    where ls.event_id = e.id)                             as submission_count,
  (select count(*) from public.promptarena_legacy_submissions ls
    where ls.event_id = e.id
      and ls.score is not null
      and ls.invalid_reason is null)                      as scored_count,
  (select count(*) from public.promptarena_legacy_submissions ls
    where ls.event_id = e.id
      and ls.invalid_reason is not null)                  as invalid_count
from public.promptarena_legacy_events e
where auth.uid() is not null;

comment on view public.promptarena_legacy_event_summary is
  'Legacy events with counts only. No names, no email, no mobile, no scores per person. scored_count excludes rows flagged invalid_reason.';

revoke all on public.promptarena_legacy_event_summary from anon, authenticated;
grant select on public.promptarena_legacy_event_summary to authenticated;

-- ---- Route in, 2 of 2: your own legacy results ------------------------
--
-- The 0027 framing — *this is your history with us* — applied to PromptArena. A
-- member who signed up with the same address they used at the event sees what
-- they wrote and what it scored. Nobody sees anybody else's, ever: this view
-- has no "browse the results of event X" mode and must not grow one, because
-- these people consented to compete in a room, not to be published.
--
-- ⚠ The viewer is resolved from `auth.uid()` inside the view. There is no
-- function taking a player id or an email, and there must never be one — that
-- would be an oracle for "did this address attend a Sahaba event", answerable
-- for any address anyone cared to type. 0021, 0027 and 0028 all make this
-- argument at length. A view is the strongest form of it: there is no argument
-- to pass.
--
-- What is NOT here and must never be added: `email`, `mobile`, `full_name` of
-- any player, or any row belonging to a different player.
drop view if exists public.my_promptarena_legacy_results;

create view public.my_promptarena_legacy_results
with (security_invoker = off) as
select
  e.slug        as event_slug,
  e.name        as event_name,

  -- ⚠ Not an event date. `is_single_day = false` means the source list was
  -- reused over months and a client must render the range or nothing. Carried
  -- onto every row so the caller cannot print a date without also having been
  -- handed the fact that it is not one.
  e.held_on,
  e.date_last,
  e.is_single_day,

  -- False means the export had no comment column, so `judge_comment` being
  -- null says nothing about this player's round.
  e.has_judge_comments,
  e.judging_note,

  s.round_number,
  s.question,
  s.prompt_text,

  -- ⚠ THE MASK IS PER-ROW NOW, and it is the row's own defect that drives it —
  -- never the event's. What used to be here gated `score` and `judge_comment`
  -- on an event-level `was_judged` flag that defaulted to false and was, on
  -- measurement, false about nothing: it would have blanked roughly 60 real
  -- marks for two whole events. It is gone.
  --
  -- What survives the mask, and what does not:
  --
  --   * A score of 0 on a played round is REAL and is shown. There is exactly
  --     one in the dataset and it is a genuine verdict.
  --   * A NULL score is a round the player never attempted. It stays null so a
  --     client that reads only `score` still cannot mistake it for a zero, and
  --     `has_score` gives the same answer without the client needing to know
  --     what null means in its JSON library.
  --   * A row with `invalid_reason` set is masked — its stored score and
  --     comment are fabrications of the export pipeline, currently the 48
  --     round-5 rows that copy the player's round-4 verdict verbatim. The
  --     reason is passed through so the UI can say why rather than rendering a
  --     silent blank, and the prompt they actually wrote is left intact,
  --     because that part is theirs.
  s.invalid_reason,
  case when s.invalid_reason is null then s.score end          as score,
  (s.invalid_reason is null and s.score is not null)           as has_score,
  case when s.invalid_reason is null then s.judge_comment end  as judge_comment
from public.promptarena_legacy_submissions s
join public.promptarena_legacy_players p on p.id = s.player_id
join public.promptarena_legacy_events  e on e.id = s.event_id
where p.user_id = auth.uid()
  and auth.uid() is not null;   -- a null uid must match nothing, not everything

comment on view public.my_promptarena_legacy_results is
  'A linked member''s own Microsoft Forms history. Scoped by auth.uid() inside the view — there is no argument and there must never be one. No contact details of any kind.';

revoke all on public.my_promptarena_legacy_results from anon, authenticated;
grant select on public.my_promptarena_legacy_results to authenticated;

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- ---- The privacy flag, which is the bug that keeps recurring ----------
--
-- The grant exists (expect exactly one row, UPDATE). If this is empty the
-- toggle is dead and nothing will say so — PostgREST returns success and zero
-- rows changed:
--   select privilege_type from information_schema.column_privileges
--    where table_name = 'profiles'
--      and column_name = 'show_in_promptarena_ranking'
--      and grantee = 'authenticated';
--
-- And prove it end to end, signed in as a member, because the grant existing
-- and the save working are different claims:
--   update public.profiles set show_in_promptarena_ranking = true
--    where user_id = auth.uid();
--   -- expect UPDATE 1, not UPDATE 0
--
-- It defaults to hidden (expect 'false'), and nobody was opted in by applying
-- this migration (expect 0):
--   select column_default from information_schema.columns
--    where table_name = 'profiles' and column_name = 'show_in_promptarena_ranking';
--   select count(*) from public.profiles where show_in_promptarena_ranking;
--
-- The table-wide UPDATE grant from 0002 is still revoked, or the column list is
-- decorative (expect zero rows):
--   select privilege_type from information_schema.role_table_grants
--    where table_name = 'profiles' and grantee = 'authenticated'
--      and privilege_type = 'UPDATE';
--
-- ---- anon reaches nothing ---------------------------------------------
--
-- Expect ZERO rows. Every table and view added by this migration:
--   select table_name, privilege_type from information_schema.role_table_grants
--    where grantee = 'anon'
--      and table_name in (
--        'promptarena_challenges', 'promptarena_submissions',
--        'promptarena_legacy_events', 'promptarena_legacy_players',
--        'promptarena_legacy_submissions',
--        'promptarena_challenge_deck', 'promptarena_challenge_calibration',
--        'promptarena_member_stats', 'promptarena_my_stats',
--        'promptarena_leaderboard', 'promptarena_legacy_event_summary',
--        'my_promptarena_legacy_results');
--
-- And as anon, every one of these must be denied rather than empty:
--   select count(*) from public.promptarena_leaderboard;
--   select count(*) from public.promptarena_challenge_deck;
--   select count(*) from public.promptarena_legacy_players;
--
-- authenticated reaches the base tables only as designed. Expect exactly:
-- promptarena_submissions → SELECT, INSERT. Nothing at all for the challenge
-- bank or any of the three legacy tables:
--   select table_name, privilege_type from information_schema.role_table_grants
--    where grantee = 'authenticated'
--      and table_name like 'promptarena%'
--    order by table_name, privilege_type;
--
-- ---- A member cannot score themselves ---------------------------------
--
-- The INSERT grant is column-level and names two columns (expect exactly
-- challenge_id and prompt_text — if `score` appears, stop):
--   select column_name from information_schema.column_privileges
--    where table_name = 'promptarena_submissions'
--      and grantee = 'authenticated' and privilege_type = 'INSERT'
--    order by column_name;
--
-- No UPDATE and no DELETE for authenticated (expect zero rows for both):
--   select privilege_type from information_schema.role_table_grants
--    where table_name = 'promptarena_submissions' and grantee = 'authenticated'
--      and privilege_type in ('UPDATE','DELETE');
--   select column_name from information_schema.column_privileges
--    where table_name = 'promptarena_submissions'
--      and grantee = 'authenticated' and privilege_type = 'UPDATE';
--
-- Signed in as a member, all four of these must FAIL, not succeed quietly:
--   insert into public.promptarena_submissions (challenge_id, prompt_text, score)
--     values ('<a challenge id>', 'x', 10);          -- no privilege on score
--   update public.promptarena_submissions set score = 10 where user_id = auth.uid();
--   delete from public.promptarena_submissions where user_id = auth.uid();
--   insert into public.promptarena_submissions (challenge_id, prompt_text)
--     select id, 'x' from public.promptarena_challenge_deck limit 1;  -- this one SUCCEEDS
--
-- An unexplained score cannot be stored. As the SERVICE ROLE (which bypasses
-- RLS and grants, so this is the only place the constraint is the last line of
-- defence), this must raise a check violation:
--   update public.promptarena_submissions
--      set judge_status = 'judged', score = 7, judged_at = now()
--    where id = '<a pending submission>';
--   -- expect ERROR: promptarena_submissions_judged_is_explained
--
-- ---- The rubric never leaves the building -----------------------------
--
-- The column list is the boundary, so check what the deck actually exposes
-- rather than trusting the definition (expect zero rows):
--   select column_name from information_schema.columns
--    where table_name = 'promptarena_challenge_deck'
--      and column_name in ('rubric','generation_params','generator_version','times_served');
--
-- ---- The leaderboard excludes non-opted-in members --------------------
--
-- The count must equal the number of opted-in members who have completed
-- something — never the number of players (expect true):
--   select (select count(*) from public.promptarena_leaderboard)
--        = (select count(*) from public.promptarena_member_stats s
--             join public.profiles p on p.user_id = s.user_id
--            where p.show_in_promptarena_ranking);
--
-- Not one hidden member is present (expect zero rows):
--   select l.user_id from public.promptarena_leaderboard l
--     join public.profiles p on p.user_id = l.user_id
--    where not p.show_in_promptarena_ranking;
--
-- ⚠ The rank cannot leak a hidden member's position. The numbering must be
-- contiguous 1..N with no gaps whatsoever — a gap is a hidden member with a
-- number on them. All three must hold:
--   select count(*) = max(rank) from public.promptarena_leaderboard;   -- true
--   select count(*) = count(distinct rank) from public.promptarena_leaderboard; -- true
--   select min(rank) = 1 from public.promptarena_leaderboard;          -- true
--
-- Prove it changes nothing when a hidden member outranks a visible one — this
-- is the actual attack, so run it rather than reasoning about it. Take the top
-- member, hide them, and confirm the ranks below simply close up:
--   select rank, user_id, rating from public.promptarena_leaderboard order by rank limit 5;
--   update public.profiles set show_in_promptarena_ranking = false
--    where user_id = '<the rank 1 user>';
--   select rank, user_id, rating from public.promptarena_leaderboard order by rank limit 5;
--   -- expect: the old rank 2 is now rank 1, and no gap appears anywhere
--
-- No activity data on the scoreboard (expect zero rows):
--   select column_name from information_schema.columns
--    where table_name = 'promptarena_leaderboard'
--      and column_name in ('current_streak','last_played_on','prompt_text',
--                          'feedback_summary','judged_attempts');
--
-- The internal stats view is reachable by nobody (expect zero rows):
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'promptarena_member_stats'
--      and grantee in ('anon','authenticated');
--
-- ---- Rating really is the average, and really is derived --------------
--
-- Recompute it by hand for one member and compare (expect true):
--   select s.rating = (select round(avg(x.score)::numeric, 2)
--                        from public.promptarena_submissions x
--                       where x.user_id = s.user_id and x.judge_status = 'judged')
--     from public.promptarena_member_stats s limit 1;
--
-- There is no stored rating column anywhere — if this ever returns a row, the
-- single-source-of-truth argument at the top of this file has been broken
-- (expect zero rows):
--   select table_name, column_name from information_schema.columns
--    where table_schema = 'public'
--      and column_name in ('rating','promptarena_rating','promptarena_score');
--
-- A member who has never played gets no row rather than a rating of 0, so the
-- UI can say "you haven't started" instead of "your rating is zero":
--   select count(*) from public.promptarena_my_stats;   -- expect 0 for a new member
--
-- ---- Legacy contact details are absent from every client-readable view -
--
-- ⚠ The most important check in this file. Expect ZERO rows:
--   select table_name, column_name from information_schema.columns
--    where table_schema = 'public'
--      and table_name in ('promptarena_legacy_event_summary',
--                         'my_promptarena_legacy_results',
--                         'promptarena_leaderboard',
--                         'promptarena_challenge_deck')
--      and column_name in ('email','mobile','phone','ms365_mailbox');
--
-- Stronger, and the version to actually run — no client-readable object
-- anywhere in this schema exposes a mobile number (expect zero rows):
--   select c.table_name, c.column_name
--     from information_schema.columns c
--     join information_schema.role_table_grants g
--       on g.table_name = c.table_name and g.table_schema = c.table_schema
--    where c.table_schema = 'public'
--      and g.grantee in ('anon','authenticated')
--      and c.column_name in ('mobile','email');
--
-- The three legacy tables are unreachable by a client role (expect zero rows):
--   select table_name, grantee from information_schema.role_table_grants
--    where table_name like 'promptarena_legacy%'
--      and grantee in ('anon','authenticated');
--
-- RLS is on and there are no policies on the legacy tables — the fail-closed
-- state (expect three rows with rowsecurity = true, and zero policies):
--   select relname, relrowsecurity from pg_class
--    where relname like 'promptarena_legacy%';
--   select tablename, policyname from pg_policies
--    where tablename like 'promptarena_legacy%';
--
-- ---- The import did not destroy real scores ---------------------------
--
-- ⚠ THIS BLOCK EXISTS BECAUSE THE FIRST DRAFT OF THIS MIGRATION WOULD HAVE
-- FAILED IT. It was written to prove "two events were never judged and all
-- their scores are null" — which is the false premise, turned into a test that
-- would have certified the damage as correct. These replace it, and they are
-- the ones that catch the class of error.
--
-- ⚠ NO EVENT MAY HAVE ALL OF ITS MARKS AT ZERO. If an event comes back here,
-- either judging really did fail for it — which the source workbooks say of
-- none of the six — or the importer nulled/zeroed real scores. Expect ZERO
-- rows:
--   select e.slug,
--          count(*)                                  as marked_rows,
--          count(*) filter (where s.score > 0)       as above_zero
--     from public.promptarena_legacy_events e
--     join public.promptarena_legacy_submissions s on s.event_id = e.id
--    where s.score is not null
--      and s.invalid_reason is null
--    group by e.slug
--   having count(*) filter (where s.score > 0) = 0;
--
-- The same failure seen from the other side, and the cheaper one to eyeball.
-- Every event must have marks at all — an event with none is an event whose
-- scores were thrown away (expect zero rows):
--   select e.slug from public.promptarena_legacy_events e
--    where not exists (
--      select 1 from public.promptarena_legacy_submissions s
--       where s.event_id = e.id and s.score is not null and s.invalid_reason is null);
--
-- And the measured shape, so a quiet loss shows up as a number rather than as
-- nothing. Against the six workbooks expect six rows, event means between 4.8
-- and 5.4, and no event mean at or near 0:
--   select e.slug, count(s.score) as marks, round(avg(s.score), 2) as mean_mark
--     from public.promptarena_legacy_events e
--     left join public.promptarena_legacy_submissions s
--       on s.event_id = e.id and s.invalid_reason is null
--    group by e.slug order by e.slug;
--
-- 556 of the 795 round slots were played. So expect 556 rows if the importer
-- omitted unplayed rounds, or 795 rows of which 556 carry a score if it kept
-- them — but NEVER 795 rows with 795 scores, which is the whole failure:
--   select count(*) as rows, count(score) as scored
--     from public.promptarena_legacy_submissions;
--
-- Genuine zeros survive — the importer must not have "helpfully" nulled them.
-- Exactly one played round in the whole dataset scored 0, in `ai-skills-fest`
-- (expect exactly one row: ai-skills-fest, count 1):
--   select e.slug, count(*) from public.promptarena_legacy_submissions s
--     join public.promptarena_legacy_events e on e.id = s.event_id
--    where s.score = 0 and s.invalid_reason is null group by e.slug;
--
-- ---- Round 5's verdict is fabricated in the long-format exports --------
--
-- ⚠ NO ROUND-5 ROW MAY DUPLICATE ITS PLAYER'S ROUND-4 SCORE AND COMMENT WHILE
-- STILL LOOKING VALID. This is the artefact itself rather than a list of file
-- names, so it keeps working if another export is imported later. The join to
-- `has_judge_comments` is not optional: without it every wide-export row
-- matches on two NULL comments and the query condemns real marks. Expect ZERO
-- rows:
--   select s.id, s.event_id, s.player_id
--     from public.promptarena_legacy_submissions s
--     join public.promptarena_legacy_events e on e.id = s.event_id
--    where s.round_number = 5
--      and s.invalid_reason is null
--      and e.has_judge_comments
--      and exists (
--        select 1 from public.promptarena_legacy_submissions r4
--         where r4.player_id      = s.player_id
--           and r4.round_number   = 4
--           and r4.score          is not distinct from s.score
--           and r4.judge_comment  is not distinct from s.judge_comment);
--
-- And the mirror, so "zero rows" cannot be passed by importing nothing. All 48
-- known-bad rows must be present and flagged — 41 in `july18`, 7 in
-- `december-eh4`, none anywhere else (expect exactly those two rows, 41 and 7):
--   select e.slug, count(*) from public.promptarena_legacy_submissions s
--     join public.promptarena_legacy_events e on e.id = s.event_id
--    where s.invalid_reason = 'round5_verdict_copied_from_round4'
--    group by e.slug order by e.slug;
--
-- Nothing was flagged that should not have been. A flagged row must actually
-- exhibit the artefact, and must not be a wide-export round 5 condemned by the
-- two-NULL-comments false positive (expect zero rows):
--   select s.id from public.promptarena_legacy_submissions s
--     join public.promptarena_legacy_events e on e.id = s.event_id
--    where s.invalid_reason = 'round5_verdict_copied_from_round4'
--      and (not e.has_judge_comments
--           or s.round_number <> 5
--           or not exists (
--             select 1 from public.promptarena_legacy_submissions r4
--              where r4.player_id      = s.player_id
--                and r4.round_number   = 4
--                and r4.score          is not distinct from s.score
--                and r4.judge_comment  is not distinct from s.judge_comment));
--
-- The member-facing view never emits a fabricated mark or comment, whatever is
-- in the table (expect zero rows, as a member with legacy history):
--   select * from public.my_promptarena_legacy_results
--    where invalid_reason is not null
--      and (score is not null or judge_comment is not null or has_score);
--
-- ---- `july18` is a reused list, not an event --------------------------
--
-- Its dates must span more than a day, and `is_single_day` must say so —
-- otherwise the UI will print one date beside a year of submissions (expect
-- is_single_day = false for july18, and date_last well after held_on):
--   select slug, held_on, date_last, is_single_day
--     from public.promptarena_legacy_events order by slug;
--
-- The pair is coherent, or `is_single_day` is meaningless (expect zero rows):
--   select slug from public.promptarena_legacy_events
--    where date_last < held_on
--       or (held_on is null) <> (date_last is null);
--
-- ⚠ And the part no query can check: a client that reads `held_on` without
-- also reading `is_single_day` will print a day beside `july18` regardless.
-- Grep the front end for `held_on` and confirm every use is guarded.
--
-- ---- No event-level flag ever suppresses a score again -----------------
--
-- ⚠ `was_judged` was removed because it defaulted to hiding data and was false
-- about nothing. If it — or anything shaped like it — comes back, this catches
-- it (expect zero rows):
--   select table_name, column_name from information_schema.columns
--    where table_schema = 'public'
--      and table_name like 'promptarena_legacy%'
--      and column_name in ('was_judged','is_judged','judged','scores_valid');
--
-- ---- No auth accounts were created for legacy players ------------------
--
-- Every linked player points at an account that already existed. This must
-- return zero rows — a legacy player whose auth.users row appeared at import
-- time means somebody made an account on their behalf (see 0027):
--   select p.full_name, u.created_at, e.imported_at
--     from public.promptarena_legacy_players p
--     join auth.users u on u.id = p.user_id
--     join public.promptarena_legacy_events e on e.id = p.event_id
--    where u.created_at >= e.imported_at;
--
-- ⚠ This check previously compared `u.created_at` against `e.held_on`, in the
-- `<` direction, while the sentence above it asserted the opposite direction —
-- and `held_on` is not an event date anyway (see the events table), so for
-- `july18` it would have compared accounts against an arbitrary point inside a
-- year-long window. `imported_at` is the timestamp that actually distinguishes
-- "this person signed up" from "the import made them an account".
--
-- And the member count did not move. Compare before and after the import:
--   select count(*) from auth.users;
--
-- ---- Free tier can play -----------------------------------------------
--
-- ⚠ Ahmed: "you must be logged-in even with standard free account." No object
-- in this file may reference subscriptions or a tier (expect zero rows):
--   select dependent.relname
--     from pg_depend d
--     join pg_rewrite r on r.oid = d.objid
--     join pg_class dependent on dependent.oid = r.ev_class
--     join pg_class source on source.oid = d.refobjid
--    where source.relname = 'subscriptions'
--      and dependent.relname like '%promptarena%';
--
-- End to end, signed in as a member on the free tier: the deck returns rows and
-- an insert succeeds.
--   select count(*) from public.promptarena_challenge_deck;   -- expect > 0
