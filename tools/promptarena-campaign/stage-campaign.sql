-- PromptArena return campaign — segments, copy, and staging
-- ============================================================================
-- Brings back the people who played PromptArena on Microsoft Forms at live
-- events, now that it is being rebuilt as an always-on feature.
--
-- ⚠ THIS SCRIPT NEVER SENDS ANYTHING, AND IT MUST NEVER LEARN HOW.
--
-- It writes `campaigns` rows with status 'draft' and `campaign_recipients`
-- rows with status 'generated'. `send-campaign` only ever mails recipients
-- whose status is 'approved' (its own comment: "'generated' is not enough —
-- that is the whole point of the review step existing"). Nothing here creates
-- an approved row, so there is no path from running this to an email leaving
-- the building. Ahmed approves in app/admin/campaigns.html and types SEND.
--
-- `send-newsletter` is not involved and must not be: it has no per-recipient
-- state, so a retry re-mails everyone it already mailed, and it attaches no
-- unsubscribe link at all.
--
-- Run it as the service role, in the Supabase SQL editor or a psql session.
-- The three `promptarena_legacy_*` tables have RLS on and NO policies at all
-- (0029) — a client role reaches nothing, by design, so there is no other way.
--
-- Order of business:
--   Part 0  settings — the play URL, which you must set
--   Part 1  the segment definitions          (temp views, writes nothing)
--   Part 2  the copy                         (temp functions, writes nothing)
--   Part 3  counts and exclusions            (read-only)
--   Part 4  preview real recipients          (read-only)
--   Part 5  contacts that do not exist yet   (writes, opt-in, run deliberately)
--   Part 6  stage the two campaigns          (writes drafts)
--   Part 7  verification — prove nothing is queued
--
-- Parts 1 and 2 are session-scoped (`create temporary view`, `pg_temp.`
-- functions). They are not a schema change, they need no migration, and they
-- vanish when you disconnect. Run parts 0–2 first, every session.
--
-- ============================================================================
-- THE TWO SEGMENTS, AND THE ONE THAT ALMOST GOT WRITTEN
-- ============================================================================
--
--   'scored'          They played and they have a real score. Their number goes
--                     in the subject line. ~86 people.
--
--   'registered_only' They registered, took a seat, and submitted nothing. No
--                     prompt exists for them, so no score exists either. They
--                     get their own letter that claims neither. ~33 people.
--
-- ⚠ An earlier draft of this file had a third segment built on the belief that
-- judging never ran for the Cairo AWS TechUp and Aug 30 events and that their
-- 85 players had never been scored. THAT IS FALSE and the email written for it
-- has been deleted. Measured against the workbooks: both events were judged,
-- per-round scores are real (means 4.91 and 4.89, in line with the events
-- nobody doubted), and every zero is a round the player never attempted — no
-- played round scored 0. What is broken is only the aggregate `TotalScore`
-- column, which is 0 for 53 players whose rounds really sum to 2–36. The two
-- files that spell it `Total_Score` are fine; the two that spell it `TotalScore`
-- never had the aggregation step run.
--
-- Which is why NOTHING BELOW EVER READS A STORED TOTAL. Every total in this
-- file is recomputed from the round scores. If a future importer lands a
-- `total_score` column, do not use it here.
--
-- ============================================================================
-- What this depends on, and what was assumed
-- ============================================================================
--
-- Migration 0029 (`promptarena_legacy_events` / `_players` / `_submissions`)
-- and 0011 (`campaigns`, `campaign_recipients`) and 0010 (`marketing_contacts`).
--
-- ⚠ 0029 carries a comment saying two of the six events were never judged and
-- that its importer should write NULL scores for them. That comment rests on
-- the same refuted premise as the deleted segment above. If the importer acts
-- on it, the ~86 people in the 'scored' segment collapse to ~26 and Part 3 will
-- show it immediately — a `scored` count near 26 with `no_scored_rounds` near
-- 60 means the import nulled real scores, not that this file is wrong.
--
-- ⚠ Nothing here has been run: at the time of writing 0029 was not applied and
-- the legacy import had not happened. Part 3 is the first thing to run and its
-- numbers are the check on all of this. Expected, from the workbooks:
-- 159 player rows → 152 distinct people; 40 rows on @sahabaclub.com addresses
-- (every player of both long events); 33 registered-only; 86 scored.


-- ============================================================================
-- Part 0 — settings
-- ============================================================================

drop table if exists pa_settings;
create temporary table pa_settings (
  play_url                text not null,
  campaign_scored         text not null,
  campaign_registered     text not null,
  from_name               text not null,
  from_email              text not null,
  reply_to                text,
  -- Events whose date must not be named in copy. `july18` is not one event:
  -- the SharePoint list stayed open from July 2025 to July 2026, so its
  -- `held_on` is whatever single date the importer picked, and naming it would
  -- tell most of those players they played on a day they did not.
  undated_event_patterns  text[] not null,
  -- More rounds than this in one event is a demo or staff account, not a guest.
  -- One account produced 53 of July 18's 256 submissions.
  demo_account_rounds     int not null,
  -- A club mailbox means the club provisioned it, which means a member.
  club_mail_domain        text not null
);

-- ⚠ SET play_url TO A PAGE THAT EXISTS AND IS PLAYABLE.
--
-- Today the site has no PromptArena page — `index.html` has an anchor,
-- `#promptarena`, on a marketing card, and 0029 is the schema with no UI on
-- top of it yet. Both emails below are one instruction: go and play. Sending
-- a hundred people to a card describing a feature they cannot use is worse
-- than not sending at all, and it cannot be taken back.
--
-- Part 6 refuses to run while this says REPLACE_ME.
insert into pa_settings values (
  'REPLACE_ME',
  'PromptArena return — they have a score',
  'PromptArena return — registered, never played',
  'Sahaba Club',
  'membership@sahabaclub.com',
  null,
  array['%July%18%', '%july18%'],
  15,
  '@sahabaclub.com'
);


-- ============================================================================
-- Part 1 — the segments
-- ============================================================================

-- ---- which submissions may be counted --------------------------------------
--
-- ⚠ ROUND 5 IS NOT ALWAYS REAL. In both long-format events every round-5 row
-- duplicates the same player's round-4 score AND judge comment byte for byte —
-- 41 of 41 in one, 7 of 7 in the other. It is an export artefact, not a round
-- anybody played, and counting it inflates a total by up to a fifth.
--
-- The test below is the artefact itself rather than a list of file names: a
-- round-5 row is dropped only when the event actually carries judge comments
-- (which the wide exports never do) and this row is identical to the same
-- player's round 4 on both score and comment. `is not distinct from` because
-- two NULL comments must compare equal here, and `=` would not.
--
-- Consequence: genuine round 5s in the wide events — which have no comment
-- column at all, so cannot match — are untouched. Verified in Part 3.
drop view if exists pa_valid_submission;
create temporary view pa_valid_submission as
select s.*
from public.promptarena_legacy_submissions s
where not (
  s.round_number = 5
  and exists (
    select 1 from public.promptarena_legacy_submissions c
    where c.event_id = s.event_id and c.judge_comment is not null
  )
  and exists (
    select 1 from public.promptarena_legacy_submissions r4
    where r4.player_id = s.player_id
      and r4.round_number = 4
      and r4.score        is not distinct from s.score
      and r4.judge_comment is not distinct from s.judge_comment
  )
);

-- ---- everyone who played, with their event and their numbers ---------------
--
-- `total_score` is RECOMPUTED here and never read from an aggregate column.
-- See the header: the stored totals are zero for 53 real players.
--
-- `rounds_played` counts rounds where they actually wrote something. A wide
-- export carries a row per round whether or not it was attempted, so counting
-- rows would credit people with rounds they never saw.
drop view if exists pa_return_pool;
create temporary view pa_return_pool as
select
  pl.id                               as player_id,
  pl.user_id                          as player_user_id,
  lower(btrim(pl.email))              as email_key,
  nullif(btrim(pl.full_name), '')     as full_name,
  ev.id                               as event_id,
  ev.slug                             as event_slug,
  ev.name                             as event_name,
  ev.held_on,
  coalesce(sb.rounds_played, 0)       as rounds_played,
  coalesce(sb.scored_rounds, 0)       as scored_rounds,
  sb.total_score,
  sb.best_score,
  sb.avg_score,
  coalesce(sb.wrote_in_arabic, false) as wrote_in_arabic
from public.promptarena_legacy_players pl
join public.promptarena_legacy_events ev on ev.id = pl.event_id
left join lateral (
  select
    count(*) filter (where btrim(coalesce(s.prompt_text, '')) <> '') as rounds_played,
    -- count(score), not count(*): 0029 is emphatic that NULL means "never
    -- judged" and 0 means "judged and given zero". Nothing here coalesces one
    -- into the other in either direction.
    count(s.score)                                                   as scored_rounds,
    sum(s.score)                                                     as total_score,
    max(s.score)                                                     as best_score,
    round(avg(s.score), 1)                                           as avg_score,
    -- Arabic block, U+0600..U+06FF. Postgres ARE understands \uXXXX.
    bool_or(s.prompt_text ~ '[؀-ۿ]')                       as wrote_in_arabic
  from pa_valid_submission s
  where s.player_id = pl.id
) sb on true
where pl.email is not null
  and btrim(pl.email) <> ''
  -- "No usable email" is a shape test, not a delivery test. A malformed
  -- address is a guaranteed bounce, and bounces are what cost the domain.
  and pl.email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$';

-- ---- one row per human -----------------------------------------------------
--
-- Exactly one person in the whole dataset played two events, so this is nearly
-- a no-op — but "nearly" is not a reason to mail somebody twice, and the
-- ordering decides which letter they get. A real score wins every tie, so
-- nobody who has a score can be sent the letter for people who have none.
drop view if exists pa_return_person;
create temporary view pa_return_person as
select distinct on (email_key) *
from pa_return_pool
order by
  email_key,
  (scored_rounds > 0) desc,
  total_score desc nulls last,
  held_on desc nulls last,
  player_id;

-- ---- who may actually be mailed -------------------------------------------
--
-- Every exclusion is a named boolean rather than a WHERE clause, so Part 3 can
-- report *why* the segment is smaller than the guest list. A count that drops
-- with no explanation is a count nobody trusts.
--
-- `contact_id` is not optional plumbing: `campaign_recipients.contact_id` is a
-- NOT NULL foreign key to `marketing_contacts`, and `send-campaign` re-reads
-- consent from that row at the moment of sending. A legacy player with no
-- contact row therefore cannot be a recipient at all — see Part 5.
drop view if exists pa_return_candidate;
create temporary view pa_return_candidate as
select
  p.*,
  mc.id          as contact_id,
  mc.email       as contact_email,
  mc.first_name  as contact_first_name,
  mc.full_name   as contact_full_name,

  (mc.id is null)                            as excl_no_contact_row,
  (mc.unsubscribed_at is not null)           as excl_unsubscribed,
  (mc.bounced_at is not null)                as excl_bounced,
  coalesce(mc.is_test, false)                as excl_test,
  (mc.id is not null and not mc.email_valid) as excl_invalid_email,

  -- Already one of us, route one: an account. Three ways to the same fact,
  -- because any one alone leaves a hole — 0029 links the legacy player row on
  -- import, 0010 links the contact row on signup, and somebody who signed up
  -- with this address and was never linked by either is still a member.
  (p.player_user_id is not null
     or mc.linked_user_id is not null
     or acct.user_id is not null)            as excl_member,

  -- Already one of us, route two: a club mailbox. The club provisions
  -- @sahabaclub.com addresses to its own people, so an address at that domain
  -- is a member by definition, whether or not anything has linked them yet.
  --
  -- ⚠ This is not a rounding error. Every player of both long events — 40 of
  -- the 159 rows — is at that domain, which is why those two events vanish from
  -- this campaign entirely. It also removes the account that produced 53 of one
  -- event's 256 submissions. These people are not lost; they need the OTHER
  -- email, the one that says their rating is already on their dashboard, and
  -- that is a different campaign than this one.
  (p.email_key like ('%' || (select club_mail_domain from pa_settings))
     or mc.sahaba_mailbox is not null)       as excl_club_mailbox,

  -- A demo or staff account rather than a guest.
  (p.rounds_played > (select demo_account_rounds from pa_settings))
                                             as excl_demo_account,

  case
    when p.scored_rounds > 0                             then 'scored'
    when p.rounds_played = 0                             then 'registered_only'
  end                                        as segment
from pa_return_person p
left join public.marketing_contacts mc
  on lower(mc.email) = p.email_key
left join lateral (
  select u.id as user_id
  from auth.users u
  join public.subscriptions s on s.user_id = u.id
  where lower(u.email) = p.email_key
    and s.status = 'active'
  limit 1
) acct on true;

-- ---- the segments proper ---------------------------------------------------
--
-- ⚠ 'scored' requires `scored_rounds > 0`, so the subject line's promise — "you
-- scored N" — is true of every person in it by construction, not by the
-- template remembering to check.
--
-- ⚠ 'registered_only' requires `rounds_played = 0`: they wrote nothing at all.
-- Their letter claims no score because none exists, and it does not claim they
-- played, because they did not.
--
-- Somebody who wrote prompts but has no scores at all is in NEITHER segment.
-- They would have to be told either a number we do not have or a story about
-- their event that is not true of it. Part 3 counts them under
-- `wrote_but_unscored` so they are visible rather than lost — and if that
-- number is large, the import nulled real scores and this campaign should not
-- go out until that is fixed.
drop view if exists pa_return_segment;
create temporary view pa_return_segment as
select *
from pa_return_candidate
where segment is not null
  and not excl_no_contact_row
  and not excl_unsubscribed
  and not excl_bounced
  and not excl_test
  and not excl_invalid_email
  and not excl_member
  and not excl_club_mailbox
  and not excl_demo_account;


-- ============================================================================
-- Part 2 — the copy
-- ============================================================================
--
-- Defined once, as functions, and used by BOTH the preview in Part 4 and the
-- staging in Part 6. Two copies of an email body is two emails that can differ,
-- and the one you would eyeball is not the one that would be sent.
--
-- These render the PLAIN TEXT body, which is what `send-campaign` consumes
-- (`campaign_recipients.body_text`). The recipient still receives both parts:
-- send-campaign posts `text` and `html` to Resend, deriving the HTML from this
-- text, and appends the unsubscribe footer and the `List-Unsubscribe` /
-- `List-Unsubscribe-Post` headers itself, from the contact's own token. That
-- placement is deliberate and load-bearing — read the comment at
-- supabase/functions/send-campaign/index.ts:222. It is why no template below
-- contains an unsubscribe line: a footer written per template is a footer that
-- can be edited away in the review screen, and one of these going out without
-- an opt-out costs the sending domain and every human reply with it.
--
-- Personalisation tokens, each with a fallback that reads as ordinary English
-- when the value is missing:
--   {name}    first name       → "Hi there," when absent or unusable
--   {event}   event label      → "one of our events"
--   {when}    month and year   → omitted entirely when unknown or unsafe
--   {rounds}  rounds played    → clause dropped at 0
--   {total}   recomputed total → 'scored' only, never null there
--   {best}    best round /10   → clause dropped when null

-- Numbers as a person writes them: 9, not 9.00; 8.5, not 8.50.
create or replace function pg_temp.pa_num(v numeric) returns text
language sql immutable as $$
  select case
    when v is null then null
    when v = round(v) then round(v)::bigint::text
    else rtrim(rtrim(v::text, '0'), '.')
  end;
$$;

-- A first name we are willing to put after "Hi". Junk aliases are real in this
-- data — the Forms exports carry Titles like "a", "ss", "Test" — and "Hi ss,"
-- is worse than not using a name at all.
create or replace function pg_temp.pa_first_name(p_full text, p_contact_first text, p_contact_full text)
returns text
language sql immutable as $$
  select w
  from (
    select btrim(split_part(coalesce(nullif(btrim(p_contact_first), ''),
                                     nullif(btrim(p_full), ''),
                                     nullif(btrim(p_contact_full), ''), ''), ' ', 1)) as w
  ) t
  where length(w) >= 2
    and w ~ '^[[:alpha:]][[:alpha:]''`-]+$'
    and lower(w) not in ('test', 'admin', 'user', 'player', 'anonymous', 'none', 'null');
$$;

create or replace function pg_temp.pa_greeting(p_first text) returns text
language sql immutable as $$
  select case when p_first is null then 'Hi there,' else 'Hi ' || p_first || ',' end;
$$;

-- "PromptArena Cairo AWS TechUp" reads badly after "at". Strip the prefix the
-- event names all carry and keep the part that is the occasion.
--
-- ⚠ The README for the dataset is explicit that the real event names were never
-- recorded anywhere — "AICD", "AI Skills Fest", "Cairo AWS TechUp" are
-- abbreviations off a file name and their expansions are a guess. So the label
-- is used as a jog to the memory ("at Cairo AWS TechUp") and never expanded,
-- never turned into a sentence that asserts what the event was.
create or replace function pg_temp.pa_event_label(p_name text) returns text
language sql immutable as $$
  select coalesce(
    nullif(btrim(regexp_replace(coalesce(p_name, ''), '^PromptArena[[:space:]]*', '', 'i')), ''),
    'one of our events');
$$;

-- ⚠ Returns the empty string rather than a guess. Two reasons a date is unsafe:
-- the event is on the undated list (July 18 is a list that stayed open for a
-- year, not a day), or `held_on` is null. For the four wide exports the only
-- date in the source is a registration timestamp, not a play date, so even when
-- this returns something it is deliberately a month and a year and never a day.
create or replace function pg_temp.pa_when(p_name text, p_held date) returns text
language sql stable as $$
  select case
    when p_held is null then ''
    when exists (select 1 from unnest((select undated_event_patterns from pa_settings)) pat
                 where coalesce(p_name, '') ilike pat) then ''
    else ' in ' || to_char(p_held, 'FMMonth YYYY')
  end;
$$;

create or replace function pg_temp.pa_rounds(n int) returns text
language sql immutable as $$
  select case when n = 1 then 'one round' else n::text || ' rounds' end;
$$;

-- ---- subjects --------------------------------------------------------------
--
-- ⚠ 'scored' puts the number in the subject because it is the strongest thing
-- we own: specific, theirs, and nobody else can send it.
-- ⚠ 'registered_only' must survive being read by someone who never wrote a
-- prompt, so it contains no number and nothing implying one.
create or replace function pg_temp.pa_subject(
  p_segment text, p_total numeric, p_event text
) returns text
language sql immutable as $$
  select case
    when p_segment = 'scored' and p_total is not null
      then 'You scored ' || pg_temp.pa_num(p_total) || ' in PromptArena. Beat it?'
    when p_segment = 'scored'
      then 'You played PromptArena with us. It is back, and it is always on.'
    else
      'You signed up for PromptArena at ' || pg_temp.pa_event_label(p_event)
      || ' and never got a turn'
  end;
$$;

-- ---- the people who have a score -------------------------------------------
--
-- Ahmed's framing, which the measurements now support for everyone in it: "Do
-- you remember your score in PromptArena a year back? Come and beat it."
--
-- Every claim is checkable against their own rows. What it deliberately does
-- NOT claim: that the old score carries over (it does not); that they will
-- appear on a leaderboard (0029 defaults `show_in_promptarena_ranking` to false
-- and no email may promise what the schema refuses to do); or that the old
-- total and the new rating are the same kind of number — they are not, which is
-- why the best single round is named as the thing that is comparable.
create or replace function pg_temp.pa_body_scored(
  p_first text, p_event text, p_held date, p_rounds int,
  p_total numeric, p_best numeric, p_url text
) returns text
language sql stable as $tpl$
  select
    pg_temp.pa_greeting(p_first) || E'\n\n' ||
    'Do you remember your PromptArena score? You played at '
      || pg_temp.pa_event_label(p_event) || pg_temp.pa_when(p_event, p_held) || ', '
      || case when p_rounds > 0 then 'got through ' || pg_temp.pa_rounds(p_rounds) || ', '
              else '' end
      || 'and scored ' || pg_temp.pa_num(p_total) || '.'
      || case when p_best is not null
              then ' Your best single round was ' || pg_temp.pa_num(p_best) || ' out of 10.'
              else '' end
      || E'\n\n' ||
    'It has been sitting in a spreadsheet ever since, which is not much of a prize.'
      || E'\n\n' ||
    'PromptArena is now a permanent part of the Sahaba Club site rather than something '
      || 'that only happens in a room once a year. New challenges whenever you want one. A '
      || 'judge that scores your prompt out of 10 and then explains itself — what was strong, '
      || 'what to change, what to try next time — instead of a number with nothing behind it. '
      || 'And a leaderboard, if you want one: it is off by default, and you decide whether '
      || 'your name ever appears on it.' || E'\n\n' ||
    'Your old score does not carry over, and it is not meant to. It is the number to beat — '
      || 'and since the new arena marks every prompt out of 10 and your rating is the average, '
      || case when p_best is not null
              then 'the one to aim past is that ' || pg_temp.pa_num(p_best) || '.'
              else 'ten is the one to aim at.' end
      || E'\n\n' ||
    p_url || E'\n\n' ||
    'You will need an account, which is free — there is no tier to buy and no waiting list.'
      || E'\n\n' ||
    E'— Ahmed\nSahaba Club';
$tpl$;

-- ---- the people who took a seat and never wrote anything -------------------
--
-- ⚠ THE ONE RULE FOR THIS TEMPLATE: it must never imply they played or scored.
-- No number appears in it. It does not scold, and it does not invent a reason
-- they missed the round — we do not know whether the room ran out of time, the
-- laptop would not connect, or they simply watched. It says only what is on the
-- record: they signed up, and no prompt of theirs exists.
create or replace function pg_temp.pa_body_registered(
  p_first text, p_event text, p_held date, p_url text
) returns text
language sql stable as $tpl$
  select
    pg_temp.pa_greeting(p_first) || E'\n\n' ||
    'You signed up for PromptArena at ' || pg_temp.pa_event_label(p_event)
      || pg_temp.pa_when(p_event, p_held) || ', and then never got a prompt in. '
      || 'We have no answer from you and no score for you — the rounds were short and the '
      || 'room was busy, and you would not be the first person that happened to.'
      || E'\n\n' ||
    'So there is nothing for you to remember and nothing to defend, which makes you the '
      || 'easiest person to invite back.' || E'\n\n' ||
    'PromptArena is now a permanent part of the Sahaba Club site instead of a round you had '
      || 'to catch on the day. You get a challenge, you write a prompt, and a judge scores it '
      || 'out of 10 and explains the score — what was strong, what to change, what to try next '
      || 'time. No timer, no room, no queue. There is a leaderboard too, off by default; you '
      || 'decide whether your name ever appears on it.' || E'\n\n' ||
    'Start with one challenge and see what it says:' || E'\n\n' ||
    p_url || E'\n\n' ||
    'You will need an account, which is free — there is no tier to buy and no waiting list.'
      || E'\n\n' ||
    E'— Ahmed\nSahaba Club';
$tpl$;

-- ---- the Arabic block ------------------------------------------------------
--
-- Not a separate campaign and not a translation swap: the English body stays,
-- with a short Arabic restatement under it, for the people who wrote their
-- prompts to us in Arabic.
--
-- ⚠ This is about respect, not remediation. Arabic answers did not score worse
-- — 5.60 against 4.87 — so nothing here treats an Arabic writer as needing
-- help. The block says the same thing the English said.
--
-- Why a block and not a whole Arabic email: writing a prompt in Arabic at a
-- bilingual Cairo event is not evidence that somebody wants their email in
-- Arabic, and send-campaign's HTML wrapper sets no `dir="rtl"`, so an
-- Arabic-only body would arrive left-aligned. Four lines cost a reader who does
-- not need them nothing, and gain a reader who does the whole message.
--
-- ⚠ The unsubscribe footer send-campaign appends is English only. Nothing here
-- can change that — the token belongs to the contact and is resolved at send
-- time — and the `List-Unsubscribe` header is language-neutral and does the
-- real work in Gmail and Outlook either way.
create or replace function pg_temp.pa_arabic_block(
  p_event text, p_total numeric, p_best numeric, p_url text
) returns text
language sql immutable as $tpl$
  select
    E'\n\n---\n\n'
    || 'هل تذكر نتيجتك في PromptArena؟ لعبت معنا في ' || pg_temp.pa_event_label(p_event)
    || ' وحصلت على ' || pg_temp.pa_num(p_total) || ' نقطة'
    || case when p_best is not null
            then '، وكانت أفضل جولة لك ' || pg_temp.pa_num(p_best) || ' من 10.'
            else '.' end
    || E'\n\n'
    || 'أصبحت PromptArena الآن جزءًا دائمًا من موقع Sahaba Club، وليست جولة تُقام مرة في '
    || 'العام: تحديات جديدة متى شئت، ومُحكِّم يمنح إجابتك درجة من 10 ويشرح سببها — ما كان '
    || 'قويًا، وما يمكن تغييره، وما تجربه في المرة القادمة. ولوحة الصدارة مغلقة افتراضيًا، '
    || 'وأنت من يقرر إن كان اسمك سيظهر فيها.'
    || E'\n\n'
    || 'نتيجتك القديمة لا تُنقل، وليس المقصود أن تُنقل — بل أن تتجاوزها:'
    || E'\n\n' || p_url;
$tpl$;

-- ---- one entry point, so preview and staging cannot diverge ----------------
create or replace function pg_temp.pa_render(
  p_segment text, p_lang text, p_first text, p_event text, p_held date,
  p_rounds int, p_total numeric, p_best numeric, p_url text
) returns text
language sql stable as $$
  select case
    when p_segment = 'scored' then
      pg_temp.pa_body_scored(p_first, p_event, p_held, p_rounds, p_total, p_best, p_url)
      || case when p_lang = 'ar'
              then pg_temp.pa_arabic_block(p_event, p_total, p_best, p_url)
              else '' end
    else
      pg_temp.pa_body_registered(p_first, p_event, p_held, p_url)
  end;
$$;

-- Everything the two writers below need, resolved once.
--
-- Note that `registered_only` is always English: the Arabic signal is "they
-- wrote to us in Arabic", and these are the people who wrote nothing. Guessing
-- a language from a name would be a guess about a person, which is exactly the
-- kind of personalisation that reads as a machine talking.
drop view if exists pa_return_rendered;
create temporary view pa_return_rendered as
select
  c.*,
  pg_temp.pa_first_name(c.full_name, c.contact_first_name, c.contact_full_name) as first_name_used,
  case when c.segment = 'scored' and c.wrote_in_arabic then 'ar' else 'en' end  as lang,
  pg_temp.pa_subject(c.segment, c.total_score, c.event_name)                    as subject,
  pg_temp.pa_render(
    c.segment,
    case when c.segment = 'scored' and c.wrote_in_arabic then 'ar' else 'en' end,
    pg_temp.pa_first_name(c.full_name, c.contact_first_name, c.contact_full_name),
    c.event_name, c.held_on, c.rounds_played, c.total_score, c.best_score,
    (select play_url from pa_settings)
  )                                                                             as body_text
from pa_return_segment c;


-- ============================================================================
-- Part 3 — counts, and why the numbers are smaller than the guest list
-- ============================================================================

-- The headline: how many people each email is going to.
select segment,
       count(*)                                        as people,
       count(*) filter (where lang = 'ar')             as arabic_block,
       count(*) filter (where first_name_used is null) as no_usable_first_name,
       min(total_score) as min_total, max(total_score) as max_total
from pa_return_rendered
group by segment
order by segment;

-- Everyone who played or registered, and where they went. Every legacy player
-- with a usable address is in exactly one row of this.
select
  count(*)                                                    as players_with_a_usable_email,
  count(*) filter (where segment = 'scored')                  as scored_before_exclusions,
  count(*) filter (where segment = 'registered_only')         as registered_only_before_exclusions,
  -- ⚠ If this is large the import nulled real scores. See the header.
  count(*) filter (where segment is null)                     as wrote_but_unscored,
  count(*) filter (where excl_no_contact_row)                 as no_marketing_contact_row,
  count(*) filter (where excl_unsubscribed)                   as unsubscribed,
  count(*) filter (where excl_bounced)                        as bounced,
  count(*) filter (where excl_test)                           as test_records,
  count(*) filter (where excl_invalid_email)                  as marked_invalid,
  count(*) filter (where excl_member)                         as already_has_an_account,
  count(*) filter (where excl_club_mailbox)                   as has_a_club_mailbox,
  count(*) filter (where excl_demo_account)                   as demo_or_staff_account
from pa_return_candidate;

-- ⚠ CHECK THE CLUB-MAILBOX ASSUMPTION RATHER THAN TRUSTING IT. The exclusion
-- above rests on "a @sahabaclub.com address means the club provisioned it,
-- which means a member". This is the query that says whether that is true of
-- these 40 people, or whether it has just silently removed a fifth of the
-- audience. If `with_an_account` is far below `club_mailbox_people`, they are
-- not members after all and the exclusion needs a different justification —
-- most likely a third campaign written for them, not a flag flipped here.
select
  count(*)                                       as club_mailbox_people,
  count(*) filter (where excl_member)            as with_an_account,
  count(*) filter (where not excl_member)        as without_an_account,
  count(*) filter (where segment = 'scored')     as of_which_have_a_score
from pa_return_candidate
where excl_club_mailbox;

-- Dropped by the shape test on the address, and lost to de-duplication.
-- Expect: 159 player rows, 152 distinct people, and 0 with no email at all.
select
  (select count(*) from public.promptarena_legacy_players)          as legacy_player_rows,
  (select count(*) from pa_return_pool)                             as rows_with_usable_email,
  (select count(*) from pa_return_person)                           as distinct_people,
  (select count(*) from public.promptarena_legacy_players
     where email is null or btrim(email) = '')                      as no_email_at_all;

-- ⚠ The round-5 artefact, before and after. Expect the two long events to lose
-- every round-5 row (41 and 7), and the wide events to lose none.
select
  ev.name,
  count(*) filter (where s.round_number = 5)                            as round5_rows_in_source,
  count(*) filter (where s.round_number = 5 and v.id is not null)       as round5_rows_kept,
  bool_or(s.judge_comment is not null)                                  as event_has_judge_comments
from public.promptarena_legacy_submissions s
join public.promptarena_legacy_events ev on ev.id = s.event_id
left join pa_valid_submission v on v.id = s.id
group by ev.name
order by ev.name;

-- ⚠ And that no total was taken from a stored aggregate. Recomputed totals must
-- be positive for everyone in the 'scored' segment. Expect 0 rows.
select count(*) as scored_people_with_a_null_or_zero_total
from pa_return_rendered
where segment = 'scored' and coalesce(total_score, 0) <= 0;

-- ⚠ No 'registered_only' subject or body may contain a digit or a claim of a
-- result. Expect 0 for all three.
select
  count(*) filter (where subject ~ '[0-9]')                                as subject_has_a_digit,
  count(*) filter (where body_text ~ '[0-9]+[[:space:]]*(/|out of)[[:space:]]*10') as body_claims_a_mark,
  count(*) filter (where body_text ~* 'you scored|your score|you got')     as body_claims_a_result
from pa_return_rendered
where segment = 'registered_only';


-- ============================================================================
-- Part 4 — the dry run
-- ============================================================================
--
-- Renders what a real person would actually receive. It writes nothing, it
-- sends nothing, and it reads the same functions Part 6 writes with.
--
-- ⚠ The output includes real names and real addresses. It belongs on screen and
-- nowhere else — not in a file in this repository, which is public, and not
-- pasted into a chat.
--
-- The footer is reproduced from send-campaign so that what you read here is the
-- whole email and not most of it. `{token}` stands in for the contact's own
-- `unsubscribe_token`, resolved at send time.

-- Five from each segment. Change the limit, not the shape.
(select
   segment, lang, contact_email as to_address, subject,
   body_text
   || E'\n\n—\nYou''re receiving this because you registered for a Sahaba Club event.'
   || E'\nUnsubscribe: https://www.sahabaclub.ai/unsubscribe.html?t={token}' as exact_email_text
 from pa_return_rendered where segment = 'scored'
 order by total_score desc nulls last limit 5)
union all
(select
   segment, lang, contact_email, subject,
   body_text
   || E'\n\n—\nYou''re receiving this because you registered for a Sahaba Club event.'
   || E'\nUnsubscribe: https://www.sahabaclub.ai/unsubscribe.html?t={token}'
 from pa_return_rendered where segment = 'registered_only' limit 5);

-- The awkward ones, which are the ones worth reading: no usable first name, no
-- date to name, a single round, the lowest score in the set, the Arabic block.
(select segment, lang, first_name_used, rounds_played, total_score, best_score,
        held_on, subject, body_text
   from pa_return_rendered
  where first_name_used is null or held_on is null or rounds_played <= 1 or lang = 'ar'
  limit 8)
union all
(select segment, lang, first_name_used, rounds_played, total_score, best_score,
        held_on, subject, body_text
   from pa_return_rendered
  where segment = 'scored' order by total_score asc limit 2);


-- ============================================================================
-- Part 5 — legacy players with no marketing_contacts row  (WRITES)
-- ============================================================================
--
-- `campaign_recipients.contact_id` is NOT NULL and references
-- `marketing_contacts`, and send-campaign re-reads consent from that row before
-- every single send. So a legacy player who is not in that table cannot be
-- mailed by any route, and creating the row is not a formality — it is the act
-- of putting a person on a marketing list.
--
-- The basis is the one the rest of that table rests on (0010: "these people
-- handed over an address to attend an event"), and it is the same basis as this
-- campaign. It is still a decision, so it is a separate statement you run on
-- purpose. Run Part 3 first and look at `no_marketing_contact_row`.
--
-- Uncomment to run.

-- insert into public.marketing_contacts (email, full_name, first_name, notes)
-- select
--   p.email_key,
--   p.full_name,
--   pg_temp.pa_first_name(p.full_name, null, null),
--   'Added from the PromptArena legacy import (' || p.event_name || ').'
-- from pa_return_candidate p
-- where p.excl_no_contact_row
--   and p.segment is not null
--   and not p.excl_club_mailbox
--   and not p.excl_demo_account
-- on conflict do nothing;
--
-- -- and the interaction that justifies it, so the next campaign can see it
-- insert into public.contact_engagements (contact_id, source_file, event_name, engagement_type, occurred_at, details)
-- select
--   mc.id, ev.source_file, ev.name, 'registration', ev.held_on,
--   jsonb_build_object('feature', 'promptarena', 'rounds_played', p.rounds_played)
-- from pa_return_candidate p
-- join public.marketing_contacts mc on lower(mc.email) = p.email_key
-- join public.promptarena_legacy_events ev on ev.id = p.event_id
-- where p.segment is not null
-- on conflict (contact_id, source_file, engagement_type) do nothing;


-- ============================================================================
-- Part 6 — stage the two campaigns  (WRITES DRAFTS, SENDS NOTHING)
-- ============================================================================
--
-- Two campaigns, not one, because they are two different letters to two
-- different audiences and Ahmed has to be able to see, approve, count and
-- release them separately. `campaigns.segment` records the definition rather
-- than the resolved list, in the spirit of 0011's comment on that column.
--
-- Recipients are created with status 'generated' — "the model wrote it", the
-- state 0011 defines as *waiting for a human*. They appear under "Waiting for
-- you" in app/admin/campaigns.html with their subject and body, and can be
-- read, edited, rewritten, skipped or approved there.
--
-- ⚠ NOTHING IS CREATED WITH STATUS 'approved'. send-campaign selects
-- `.eq("status", "approved")` and nothing else, so after this script runs the
-- number of emails it is possible to send is exactly zero until a person clicks
-- Approve. That is the whole design and it is not to be optimised away.

do $$
declare
  v_url text;
begin
  select play_url into v_url from pa_settings;
  if v_url is null or v_url = 'REPLACE_ME' or v_url !~ '^https://' then
    raise exception
      'Set pa_settings.play_url to the real, playable PromptArena URL before staging. Both emails are an instruction to go and play; staging them around a dead link bakes it into every draft.';
  end if;
end $$;

-- Refuse to touch a campaign somebody has already started working through.
-- Re-running this script must be safe; silently rewriting an approved draft
-- would not be.
do $$
declare
  v_locked int;
begin
  select count(*) into v_locked
  from public.campaign_recipients r
  join public.campaigns c on c.id = r.campaign_id
  where c.name in ((select campaign_scored from pa_settings),
                   (select campaign_registered from pa_settings))
    and (r.status in ('approved', 'sending', 'sent') or r.edited);
  if v_locked > 0 then
    raise exception
      'These campaigns already contain % approved, sent or hand-edited drafts. Rename the campaigns in pa_settings and stage a fresh pair rather than overwriting somebody''s review.', v_locked;
  end if;
end $$;

-- ---- the campaign rows -----------------------------------------------------
insert into public.campaigns (name, brief, must_include, tone, language, segment, from_name, from_email, reply_to, status, notes)
select
  s.campaign_scored,
  'Bring back the people who played PromptArena at a live event and were scored. '
    || 'Their real score — recomputed from the round scores, never from the broken TotalScore '
    || 'column — is the asset, and it goes in the subject line. The ask is to play the '
    || 'always-on version and beat it.',
  s.play_url,
  'warm', 'match',
  jsonb_build_object(
    'kind', 'promptarena_legacy_return',
    'value', 'scored',
    'definition', 'legacy players with at least one non-null round score, round-5 export '
      || 'artefacts removed; excludes unsubscribed, bounced, test, invalid-email, '
      || 'no-contact-row, club mailboxes, demo accounts and anyone with an active account',
    'built_by', 'tools/promptarena-campaign/stage-campaign.sql'),
  s.from_name, s.from_email, s.reply_to,
  'draft',
  'Drafts written from a fixed template, not from a model. Nothing is approved.'
from pa_settings s
where not exists (select 1 from public.campaigns c where c.name = s.campaign_scored);

insert into public.campaigns (name, brief, must_include, tone, language, segment, from_name, from_email, reply_to, status, notes)
select
  s.campaign_registered,
  'Bring back the people who registered for PromptArena at a live event and submitted '
    || 'nothing at all. They have no prompt and no score, and must never be told they had '
    || 'either. The hook is that there is nothing to defend.',
  s.play_url,
  'warm', 'en',
  jsonb_build_object(
    'kind', 'promptarena_legacy_return',
    'value', 'registered_only',
    'definition', 'legacy players with zero submitted prompts; same exclusions as the scored '
      || 'segment; no score is read or rendered anywhere in this segment',
    'built_by', 'tools/promptarena-campaign/stage-campaign.sql'),
  s.from_name, s.from_email, s.reply_to,
  'draft',
  'Drafts written from a fixed template, not from a model. Nothing is approved. '
    || 'No number appears in this segment''s copy at all.'
from pa_settings s
where not exists (select 1 from public.campaigns c where c.name = s.campaign_registered);

-- ---- the drafts ------------------------------------------------------------
--
-- `context_used` is what 0011 asks it to be: what the writer was working from,
-- kept because when a draft says something wrong the only useful question is
-- what produced it. `personalisation_note` is rendered in the review screen
-- under "Used:", which is where a wrong number would be caught.
insert into public.campaign_recipients (
  campaign_id, contact_id, email, full_name, subject, body_text,
  context_used, model, generated_at, status
)
select
  c.id,
  r.contact_id,
  r.contact_email,
  coalesce(r.contact_full_name, r.full_name),
  r.subject,
  r.body_text,
  jsonb_build_object(
    'segment', r.segment,
    'language', r.lang,
    'event', r.event_name,
    'held_on', r.held_on,
    'rounds_played', r.rounds_played,
    'scored_rounds', r.scored_rounds,
    'total_score_recomputed', r.total_score,
    'best_score', r.best_score,
    'avg_score', r.avg_score,
    'first_name_used', r.first_name_used,
    'personalisation_note',
      case when r.segment = 'scored'
        then 'Total ' || coalesce(pg_temp.pa_num(r.total_score), '?') || ' recomputed from '
             || r.scored_rounds || ' scored round(s) at ' || coalesce(r.event_name, '?')
             || ' (round-5 export artefacts excluded, stored TotalScore never read). Best round '
             || coalesce(pg_temp.pa_num(r.best_score), '?') || '/10. The total is in the subject line.'
             || case when r.lang = 'ar' then ' Arabic block appended — they wrote in Arabic.' else '' end
        else 'Registered at ' || coalesce(r.event_name, '?') || ' and submitted nothing: no prompt, '
             || 'no score, and no number anywhere in this email.'
      end),
  'template:promptarena-return-v2',
  now(),
  'generated'
from pa_return_rendered r
join public.campaigns c
  on c.name = case r.segment
                when 'scored' then (select campaign_scored from pa_settings)
                else               (select campaign_registered from pa_settings)
              end
on conflict (campaign_id, contact_id) do nothing;


-- ============================================================================
-- Part 7 — verification. Run it. Do not assume.
-- ============================================================================

-- What Ahmed will see on the campaigns screen. `approved` must be 0 on both.
select name, status, recipient_count, generated_count, approved_count, sent_count, failed_count
from public.campaigns
where name in ((select campaign_scored from pa_settings),
               (select campaign_registered from pa_settings));

-- ⚠ THE ONE THAT MATTERS. send-campaign mails `status = 'approved'` and nothing
-- else, so this is the number of emails that could leave the building right
-- now. Expect 0.
select count(*) as emails_that_could_be_sent_right_now
from public.campaign_recipients r
join public.campaigns c on c.id = r.campaign_id
where c.name in ((select campaign_scored from pa_settings),
                 (select campaign_registered from pa_settings))
  and r.status = 'approved';

-- Nothing has been sent, and nothing is mid-flight. Expect 0.
select count(*) as already_sent
from public.campaign_recipients r
join public.campaigns c on c.id = r.campaign_id
where c.name in ((select campaign_scored from pa_settings),
                 (select campaign_registered from pa_settings))
  and (r.status in ('sending', 'sent') or r.sent_at is not null);

-- Every draft has both halves, or the send would fail per-recipient later.
-- Expect 0.
select count(*) as drafts_missing_subject_or_body
from public.campaign_recipients r
join public.campaigns c on c.id = r.campaign_id
where c.name in ((select campaign_scored from pa_settings),
                 (select campaign_registered from pa_settings))
  and (r.subject is null or btrim(r.subject) = '' or r.body_text is null or btrim(r.body_text) = '');

-- ⚠ No 'registered_only' draft claims a score. Expect 0 for all three.
select
  count(*) filter (where r.subject ~ '[0-9]')                              as subject_has_a_digit,
  count(*) filter (where r.body_text ~ '[0-9]+[[:space:]]*(/|out of)[[:space:]]*10') as body_claims_a_mark,
  count(*) filter (where r.body_text ~* 'you scored|your score|you got')   as body_claims_a_result
from public.campaign_recipients r
join public.campaigns c on c.id = r.campaign_id
where c.name = (select campaign_registered from pa_settings);

-- ⚠ Every number in a 'scored' draft is that person's own. Recompute the total
-- straight from the submissions and compare it to what the draft says it is.
-- Expect 0 rows — a row here is an email about to tell somebody a score that is
-- not theirs.
select count(*) as drafts_whose_total_does_not_recompute
from public.campaign_recipients r
join public.campaigns c on c.id = r.campaign_id
join pa_return_rendered x on x.contact_id = r.contact_id
where c.name = (select campaign_scored from pa_settings)
  and (r.context_used ->> 'total_score_recomputed')::numeric is distinct from x.total_score;

-- Every recipient is still mailable at this instant. send-campaign re-checks
-- this at send time too, which is the check that counts — but a segment that
-- was wrong here was wrong when it was built. Expect 0.
select count(*) as recipients_who_should_not_be_here
from public.campaign_recipients r
join public.campaigns c on c.id = r.campaign_id
join public.marketing_contacts mc on mc.id = r.contact_id
where c.name in ((select campaign_scored from pa_settings),
                 (select campaign_registered from pa_settings))
  and (mc.unsubscribed_at is not null or mc.bounced_at is not null
       or mc.is_test or not mc.email_valid or mc.linked_user_id is not null
       or mc.sahaba_mailbox is not null);

-- Nobody is in both campaigns. Expect 0.
select count(*) as people_in_both_campaigns
from (
  select r.contact_id
  from public.campaign_recipients r
  join public.campaigns c on c.id = r.campaign_id
  where c.name in ((select campaign_scored from pa_settings),
                   (select campaign_registered from pa_settings))
  group by r.contact_id
  having count(distinct r.campaign_id) > 1
) x;

-- Every contact has an unsubscribe token, or send-campaign sends that person no
-- footer and no List-Unsubscribe header at all. Expect 0.
select count(*) as recipients_without_an_unsubscribe_token
from public.campaign_recipients r
join public.campaigns c on c.id = r.campaign_id
join public.marketing_contacts mc on mc.id = r.contact_id
where c.name in ((select campaign_scored from pa_settings),
                 (select campaign_registered from pa_settings))
  and mc.unsubscribe_token is null;
