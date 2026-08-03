-- Sahaba Club — EduHackAI: the rounds as Ahmed ran them, and round 5's interest list
-- ============================================================================
--
-- NOT APPLIED. This file has never been run against any database. Every claim
-- below about what is currently stored comes from reading
-- `supabase/seed/hackathons/eduhackai-seed.sql` and its README, not from
-- querying the live database — there was no database access while writing it.
-- The verification block at the end is the thing that turns those claims into
-- facts. Run it.
--
-- ----------------------------------------------------------------------------
-- Where the facts in this file come from
-- ----------------------------------------------------------------------------
--
-- 0020 created the schema. The seed in `supabase/seed/hackathons/` harvested
-- rounds 1–4 out of SharePoint and wrote up, honestly, everything it could not
-- find: rounds 3 and 4 had no placings anywhere in the tenant, round 4 had no
-- end date, three of the four rounds had no venue, and `mode` was left NULL
-- everywhere it was not stated in words.
--
-- This migration fills those gaps from a different source: **the club owner
-- (Ahmed), who ran the rounds.** That is a stronger source than SharePoint for
-- what actually happened, and a weaker one for what was written down at the
-- time. Where the two disagree, this file now prefers him — he was shown each
-- disagreement by name and asked, and answered on 2026-08-03. That is a
-- deliberate policy and it is worth stating plainly, because it means parts of
-- this file publish claims that no document supports:
--
--   ⚠ THE ROUND 3 AND ROUND 4 PLACINGS BELOW COME FROM THE OWNER'S MEMORY,
--   ⚠ NOT FROM THE ROUND'S OWN RECORDS. The hackathons page previously said
--   ⚠ those placings were never recorded, because no document in the tenant
--   ⚠ states them. Rounds 1 and 2 are different: their placings come from
--   ⚠ `Winners_Of_EduHackAI.xlsx` and were cross-checked name-by-name against
--   ⚠ the team rosters. If a round 3 or 4 placing is ever disputed, this
--   ⚠ comment is where the answer is — there is no file to go back to.
--
--   ⚠ THE COACH LISTS IN §3 REPLACE WHAT THE ROUNDS RECORDED, rather than
--   ⚠ adding to it. One person stops being a coach and three participant rows
--   ⚠ are created out of nothing but a first name. §3c has the detail and §9
--   ⚠ of the verification block has the full list of what rests on his word
--   ⚠ alone. The overridden record survives, unedited, in
--   ⚠ `supabase/seed/hackathons/README.md`.
--
-- Rounds 1 and 2 placings are NOT TOUCHED anywhere in this file. Ahmed
-- confirmed them as correct and they already have a documentary source.
--
-- ----------------------------------------------------------------------------
-- The dates change meaning, and that is the biggest single edit here
-- ----------------------------------------------------------------------------
--
-- The seed set `ends_on` from the Demo Day / winner-announcement calendar
-- event. Ahmed's dates are the 10-day hackathon window — start plus ten days,
-- exactly, for all four rounds, which is a strong independent check that these
-- are the build windows and not a misremembering:
--
--   round 1  2025-05-24 → 2025-06-03      round 3  2025-08-23 → 2025-09-02
--   round 2  2025-07-12 → 2025-07-22      round 4  2025-12-06 → 2025-12-16
--
-- `starts_on` is unchanged for all four — it already agreed. `ends_on` moves,
-- and the Demo Day dates that used to live in it would otherwise be lost, so
-- they are recorded here before being overwritten:
--
--   round 1  ends_on was 2025-06-28  ("EduHackAI-1 Live & Online Demo" +
--                                     "EduHackAI-1 Winner Announcement!")
--   round 2  ends_on was 2025-08-02  ("EduHackAI-2.0 Demo Day - AI Builders
--                                     Arena", 6:00–9:00 PM)
--   round 3  ends_on was 2025-09-26  ("EduHackAI-3 Demo Day - Live from Cairo")
--   round 4  ends_on was NULL        (no Demo Day event exists in the calendar)
--
-- After this migration the schema holds no Demo Day *date* at all — only the
-- Demo Day *venue*, in `location`. Adding a demo-day date column would mean
-- the front end changes too, and the front end is being written by another
-- agent right now, so it is not done here. If those dates matter, the four
-- values above are the source.
--
-- ----------------------------------------------------------------------------
-- How the round 5 form reaches this table, and what it is NOT allowed to do
-- ----------------------------------------------------------------------------
--
-- The one rule: **the browser never writes.** `anon` is granted nothing at all
-- on `public.hackathon_interest` — not INSERT, not SELECT, nothing — and the
-- reasoning is in section 5. Everything below is about which of the two
-- service-role paths the Edge Function uses; both are safe, neither is open to
-- the public.
--
-- Path A, and what `supabase/functions/register-interest` actually does today
-- (that function was written in parallel with this file; it was read, not
-- edited, and this file is shaped to fit it):
--
--   It holds the service role, so it reads and writes the table directly —
--   SELECT to find an existing registration, INSERT to add one, UPDATE to set
--   `notified_at` once the mail is accepted. Its own validation is stricter
--   than every CHECK constraint below (name ≤ 120, email ≤ 254, mobile ≤ 32
--   with 7–15 digits, job ≤ 120, all four required), so a constraint here can
--   only ever fire on a caller that is not that function. It lower-cases the
--   email before writing and handles 23505 as "already registered", which the
--   unique index below is exactly what makes reliable.
--
-- Path B, provided here and currently unused:
--
--   select * from public.register_hackathon_interest(
--     p_slug        => 'eduhackai-5',
--     p_full_name   => '…',
--     p_email       => '…',
--     p_mobile      => '…' or null,
--     p_current_job => '…' or null
--   );
--   -- returns exactly one row: (interest_id uuid, is_new boolean)
--
--   One statement instead of select-then-insert, so a double submission cannot
--   race at all rather than racing and being caught. `is_new` is false on a
--   re-submission, which is the same signal path A gets from its lookup. It is
--   kept because it costs nothing, it is `security definer` with EXECUTE
--   granted to `service_role` alone, and it is the path to move to if the
--   23505 branch ever turns out to be doing real work.
--
-- Either way, "Ahmed was told" is recorded the same way, by the caller, after
-- the send actually succeeds:
--
--   update public.hackathon_interest
--      set notified_at = now()
--    where id = $1 and notified_at is null;
--
-- Two harmless differences from the shape `register-interest` documents in its
-- own header: `mobile` and `current_job` are NULLABLE here (the function
-- requires both, so no row will have a null, but the column should not lie
-- about being mandatory when the schema is not what enforces it), and there is
-- an `updated_at` the function does not set — it defaults, and only path B
-- moves it.
--
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ⚠ RUN THIS FILE AS ONE SCRIPT, NOT STATEMENT BY STATEMENT
-- ----------------------------------------------------------------------------
--
-- Sections 0 and 2 abort with RAISE EXCEPTION when the data is not what this
-- file expects, and they are only useful if that abort takes the rest of the
-- file with it. There is no explicit BEGIN/COMMIT here because no migration in
-- this project has one and both apply paths already provide the transaction:
-- `supabase db push` wraps each migration file in one, and pasting the whole
-- file into the SQL editor sends it as a single multi-statement query, which
-- Postgres runs as one implicit transaction.
--
-- If you run it another way, wrap it yourself. Half of this file applied is
-- worse than none of it: it would leave rounds 3 and 4 with new dates and a
-- description promising placings that were never written.

-- ============================================================
-- 0. Preflight — refuse to run against a database that is not the one this
--    file was written for
-- ============================================================
--
-- Everything below matches on `slug`. A silent zero-row UPDATE is the failure
-- mode this whole file is written to avoid, so the slugs are checked once,
-- loudly, before anything is written.

do $preflight$
declare
  v_missing text[];
begin
  select array_agg(t.s order by t.s) into v_missing
  from unnest(array['eduhackai-1','eduhackai-2','eduhackai-3','eduhackai-4']) as t(s)
  where not exists (select 1 from public.hackathons h where h.slug = t.s);

  if v_missing is not null then
    raise exception
      '0036 preflight: hackathons rows missing for slug(s) %. The EduHackAI seed '
      '(supabase/seed/hackathons/eduhackai-seed.sql) has not been loaded into this '
      'database. Load it first; this migration edits rows, it does not create them.',
      array_to_string(v_missing, ', ');
  end if;

  -- Round 5 is created below, so it must NOT already exist under a different
  -- shape. If it does, someone added it by hand and this file would silently
  -- disagree with them.
  if exists (select 1 from public.hackathons where slug = 'eduhackai-5') then
    raise notice
      '0036 preflight: eduhackai-5 already exists. The insert below is ON CONFLICT '
      'DO UPDATE, so it will be brought in line with this file — including clearing '
      'any dates somebody has since entered. Check that is what you want.';
  end if;
end
$preflight$;

-- ============================================================
-- 1. The four rounds as Ahmed ran them
-- ============================================================
--
-- `mode` = 'online' for all four. The seed only set it on round 1, because
-- round 1 was the only one where a document said the word "online". Ahmed
-- states it for all four, and an online round is exactly what the description
-- describes, so it is now recorded on all four.
--
-- `location` carries the Demo Day venue, labelled. This is a deliberate
-- decision and it needs stating, because "location" on an online round is
-- otherwise a lie waiting to be read the wrong way:
--
--   * `location` is `text`, so size is not the constraint — two demo days fit
--     in one value comfortably. The constraint is meaning.
--   * The seed already used `location` this way for round 2 ('CodersHQ -
--     Emirates Towers'), and flagged in its README that this was the Demo Day
--     venue and *not* where the hackathon ran. Rather than invent a second
--     convention, that one is kept and made explicit in the text itself: every
--     value now begins with "Demo Day", so no reader can mistake it for where
--     the ten days happened.
--   * Round 2 had two demo days and gets both in one field, separated by " · ".
--     A `hackathon_demo_days` child table would be the "correct" model, but it
--     would need the front end to join it, and the front end is being written
--     by another agent in parallel. Two labelled venues in one text field is
--     legible today and loses nothing that a table would have kept.
--
-- The description is Ahmed's wording, identical for all four rounds. Rounds 2
-- and 3 already held almost this exact sentence (harvested verbatim from their
-- SitePages); the only change is the word "online". The typographic apostrophe
-- (’ U+2019) is kept from the existing rows so those two rounds change by one
-- word and nothing else.
--
-- Round 4 gets one clause appended, because it is the Arabic Edition and the
-- description otherwise gives no hint of that. It is appended with an em dash
-- rather than a newline: `hackathons-ui.js` renders the description inside a
-- single <p> through escapeHtml, so a newline would collapse to a space and
-- read as a run-on sentence.
--
-- Round 4's previous description is preserved here before being overwritten,
-- because it was harvested verbatim from the round's own SitePage and this is
-- the only remaining copy outside the seed file:
--
--   'EduHackAI is a 10-day practical learning journey where you build a real AI
--    application using Microsoft Power Platform and Azure AI — even if you’re a
--    complete beginner. You join a team, complete daily challenges, attend live
--    sessions, and submit your final demo on Demo Day.'
--
-- `tagline`, `partner`, `cover_image_url`, `source_url`, `status` and
-- `registration_closes_on` are NOT touched on any of the four rounds.

with blurb as (
  select
    '10-day global online hackathon where you’ll learn how to build your own '
    'AI-powered app using: Microsoft Power Platform (Power Apps, Power Automate, '
    'AI Builder), ASP.NET Core (Full Code Track), Azure AI Services (Vision, NLP, '
    'Generative AI & more)'::text as body
)
update public.hackathons h
   set starts_on   = v.starts_on,
       ends_on     = v.ends_on,
       mode        = 'online',
       location    = v.location,
       description = case
                       when v.slug = 'eduhackai-4'
                         then b.body || ' — this round ran in Arabic.'
                       else b.body
                     end,
       updated_at  = now()
  from (values
    ('eduhackai-1', date '2025-05-24', date '2025-06-03',
     'Demo Day: Mercure Hotel, Dubai'),
    ('eduhackai-2', date '2025-07-12', date '2025-07-22',
     'Demo Day 1: CodersHQ, Dubai · Demo Day 2: Cairo, Egypt'),
    ('eduhackai-3', date '2025-08-23', date '2025-09-02',
     'Demo Day: Cairo, Egypt'),
    ('eduhackai-4', date '2025-12-06', date '2025-12-16',
     'Demo Day: Cairo, Egypt')
  ) as v(slug, starts_on, ends_on, location),
  blurb b
 where h.slug = v.slug;

-- Four rows, no more, no less. An UPDATE ... FROM that matches nothing is
-- silent, which is exactly the failure this file exists to prevent.
do $rounds_check$
declare
  v_n int;
begin
  select count(*) into v_n
  from public.hackathons
  where slug in ('eduhackai-1','eduhackai-2','eduhackai-3','eduhackai-4')
    and mode = 'online'
    and starts_on is not null
    and ends_on is not null
    and location like 'Demo Day%';

  if v_n <> 4 then
    raise exception
      '0036 §1: expected 4 rounds updated, found % carrying the new values. '
      'Nothing has been committed.', v_n;
  end if;
end
$rounds_check$;

-- ============================================================
-- 2. Placings for rounds 3 and 4
-- ============================================================
--
-- Six teams, three per round, from the owner. See the warning at the top of
-- this file: these have no documentary source, unlike rounds 1 and 2.
--
-- Matching is on `lower(btrim(name))` within the right `hackathon_id`, and a
-- team that does not match EXACTLY ONE row aborts the whole migration. That is
-- the strictest rule in this file and it is deliberate: a 2nd-place medal
-- attached to the wrong team is a public, personal, and permanent insult to
-- two sets of real people, and it is worse than the page continuing to say
-- "not recorded". A zero-row UPDATE would be silent; a two-row UPDATE would be
-- worse than silent.
--
-- `is_winner` is TRUE for all three placed teams, not just first place. Ahmed
-- was asked and chose this: "winner" here means "on the podium", which is the
-- convention rounds 1 and 2 already use — the seed set `is_winner = true` on
-- all three placed teams in both. So after this migration all four rounds read
-- the same way: 3 winners each, and `rank` still says which is which.
--
-- Rounds 1 and 2 are not touched to achieve this; they were already correct.
-- Harmonising upwards rather than downwards is the reason why.
--
-- ⚠ This is not a cosmetic flag. `member_directory` (0023) publishes
-- ⚠ `is_winner` per member inside each person's `hackathons` aggregate, so
-- ⚠ this decides what appears on the profiles of the ~15 people who placed 2nd
-- ⚠ or 3rd in rounds 3 and 4 — they become winners on their own profile pages.
-- ⚠ That is the intended outcome, and it is the reason it is written down
-- ⚠ here. `hackathon_teams_winner_idx` (a partial index on `is_winner`) also
-- ⚠ widens from 6 rows to 12. `hackathons-ui.js` is unaffected: it draws
-- ⚠ podiums and medals from `rank` and never reads `is_winner`.
--
-- `award` is the placing label. Rounds 1 and 2 have `award` NULL, because
-- their source file headed the column "Position" and named no categories, and
-- inventing labels for them retrospectively is not this file's business.

do $placings$
declare
  r        record;
  v_hid    uuid;
  v_ids    uuid[];
  v_n      int;
begin
  for r in
    select * from (values
      ('eduhackai-3', 'MeyaSports',        1, '1st Place'),
      ('eduhackai-3', 'AI Falcons',        2, '2nd Place'),
      ('eduhackai-3', 'Code Trackers',     3, '3rd Place'),
      ('eduhackai-4', 'MAINTENEX',         1, '1st Place'),
      ('eduhackai-4', 'AI Exam Generator', 2, '2nd Place'),
      ('eduhackai-4', 'Innovate AI',       3, '3rd Place')
    ) as t(slug, team_name, rank, award)
  loop
    select id into v_hid from public.hackathons where slug = r.slug;

    -- Team names in the source had stray leading/trailing spaces (the seed
    -- README lists ' Innovate AI' as one of nine it trimmed on load). btrim on
    -- both sides means this still resolves if any survived.
    select coalesce(array_agg(id), '{}'::uuid[]) into v_ids
    from public.hackathon_teams
    where hackathon_id = v_hid
      and lower(btrim(name)) = lower(btrim(r.team_name));

    v_n := coalesce(array_length(v_ids, 1), 0);

    if v_n <> 1 then
      -- No %L here: RAISE only understands %, so a %L would consume an
      -- argument and then print a stray "L".
      raise exception
        '0036 §2: team "%" in round % matched % rows, expected exactly 1. No '
        'placing has been written for any team — the whole migration is rolled '
        'back. List the round''s real team names with: select name from '
        'public.hackathon_teams t join public.hackathons h on h.id = '
        't.hackathon_id where h.slug = ''%'';',
        r.team_name, r.slug, v_n, r.slug;
    end if;

    -- is_winner for ranks 1, 2 AND 3 — see the note above. Every team this
    -- loop touches has a rank, so this is unconditionally true rather than a
    -- predicate; writing `(r.rank in (1,2,3))` would only look like a
    -- condition while never being false.
    update public.hackathon_teams
       set rank       = r.rank,
           award      = r.award,
           is_winner  = true,
           updated_at = now()
     where id = v_ids[1];
  end loop;
end
$placings$;

-- ============================================================
-- 3. Coaches
-- ============================================================
--
-- Coaching is `hackathon_participants.is_mentor = true`. 0020 has no separate
-- coach table and does not need one.
--
-- ---- 3a. Deterministic order, and why a column was added ----
--
-- Requirement: Ahmed appears first wherever coaches are listed. Today nothing
-- can deliver that. `hackathon_roster` has no ORDER BY, `hackathons-ui.js`
-- selects from it with no `.order()`, and the browser therefore shows whatever
-- order Postgres happens to return — which changes as rows are updated. There
-- is no existing column that sorts him first either: alphabetically "Ahmed
-- Zoka" is not first, and `created_at` is import order.
--
-- So: one nullable `display_order` column, lowest first, NULLs last. NULL
-- means "no opinion", which is true of all 150 competitors and stays true.
-- Values are spaced by 10 so a coach can be inserted between two others
-- without renumbering.
--
-- The ordering is baked into the VIEW as well as exposed as a column. Baked
-- in, because it fixes the front end without the front end changing (another
-- agent is editing it right now, and a fix that needs two agents to land
-- together is a fix that does not land). Exposed as a column, because a view's
-- ORDER BY is a courtesy that PostgREST can override the moment somebody adds
-- an `.order()`, and the front end should be able to say what it means:
--
--   .order("display_order", { ascending: true, nullsFirst: false })
--   .order("full_name",     { ascending: true })
--
-- ---- 3b. The name "Zoka" ----
--
-- Ahmed is stored as 'Ahmed Zoka' in all four rounds (from each round's own
-- Members list). He asked to be listed as the bare "Zoka", was told plainly
-- that this drops the surname from a roster anonymous visitors can read, and
-- chose it anyway. It is his own name and his own call, so it is applied.
--
-- Scope: the PARTICIPANT display name only. `profiles`, `auth.users` and
-- `ms365_accounts` are not touched — this changes what the hackathons page
-- calls him, not who he is to the platform. His participant rows carry no
-- email in this file either way; matching downstream (`link_hackathon_history`
-- in 0020) is on email and mailbox, never on `full_name`, so the rename cannot
-- break his account linking.
--
-- Both recorded spellings are covered, so this is also the statement that
-- guarantees no participant is left called 'Ahmed Zoka'. It runs BEFORE the
-- coach matching below, which is why that matching looks for 'zoka'.

update public.hackathon_participants p
   set full_name = 'Zoka'
  from public.hackathons h
 where h.id = p.hackathon_id
   and h.slug like 'eduhackai-%'
   and lower(btrim(p.full_name)) in ('ahmed zoka', 'ahmed abdel razek');

alter table public.hackathon_participants
  add column if not exists display_order int;

comment on column public.hackathon_participants.display_order is
  'Explicit roster ordering, lowest first, NULLs last. Set for coaches only — '
  'NULL means "no opinion", which is the honest value for every competitor. '
  'Added in 0036 because nothing else put the organiser first deterministically.';

-- The view gains one column at the end and an ORDER BY. CREATE OR REPLACE is
-- used rather than DROP + CREATE precisely because it keeps the existing
-- grants and cannot silently change the columns the front end already selects
-- — appending is the only edit it permits. Everything above `display_order` is
-- byte-for-byte 0020's definition, including the comment, which is the privacy
-- boundary and must not drift.
create or replace view public.hackathon_roster
with (security_invoker = off) as
select
  p.hackathon_id,
  p.team_id,
  p.full_name,
  p.role_in_team,
  p.is_mentor,
  p.is_judge,
  case when pr.is_discoverable then p.user_id end as profile_user_id,
  case when pr.is_discoverable then pr.avatar_url end as avatar_url,
  case when pr.is_discoverable then pr.headline end as headline,
  p.display_order
from public.hackathon_participants p
left join public.profiles pr on pr.user_id = p.user_id
where exists (
  select 1 from public.hackathons h
  where h.id = p.hackathon_id and h.status <> 'draft'
)
order by p.hackathon_id, p.is_mentor desc, p.display_order asc nulls last, p.full_name asc;

-- CREATE OR REPLACE preserves privileges, so this is belt and braces rather
-- than a fix — but Supabase's default grants are the most repeated bug in this
-- project, and re-asserting them costs nothing. Revoke first: a column-level
-- or role-level grant that was never made cannot be revoked, and assuming a
-- clean slate is how `anon` ends up holding ALL on a new object.
revoke all on public.hackathon_roster from anon, authenticated;
grant select on public.hackathon_roster to anon, authenticated;

-- ---- 3c. The coach set is REPLACED, not added to ----
--
-- ⚠ Read this before changing anything here. An earlier draft of this file
-- ⚠ refused to clear a coach flag or create a participant row, on the grounds
-- ⚠ that Ahmed's lists said who coached and not who didn't. That was put to
-- ⚠ him directly. He was shown, by name, that the stored records place Mahmoud
-- ⚠ in round 3, Mohi in round 2 and Ansari nowhere at all, and he answered
-- ⚠ that his list is the correct one. So his list is now treated as the whole
-- ⚠ truth about who coached each round:
-- ⚠
-- ⚠   R1: Zoka, Mahmoud, Esraa, Ansari, Mohi
-- ⚠   R2: Zoka, Badawy, Gangothri
-- ⚠   R3: Zoka, Badawy, Gangothri
-- ⚠   R4: Zoka, Badawy, Emad
-- ⚠
-- ⚠ After this migration `is_mentor` is TRUE for exactly those people in each
-- ⚠ round and FALSE for everyone else in it. Two consequences that are
-- ⚠ deliberate and were chosen with the alternative in view:
-- ⚠
-- ⚠  * Mohamed Mohi El-Dien STOPS being a round 2 coach. The seed flagged him
-- ⚠    from round 2's own SharePoint "Coaches" web part; Ahmed says round 1.
-- ⚠    Both cannot be right and the owner's account wins.
-- ⚠  * Three round-1 participant rows are CREATED, because Ahmed names three
-- ⚠    round-1 coaches who have no round-1 record at all.
-- ⚠
-- ⚠ This is the one place in this file where the owner's memory overrides a
-- ⚠ written record rather than filling a hole in one. If it is ever disputed,
-- ⚠ the record it overrode is in `supabase/seed/hackathons/README.md`, which
-- ⚠ still says what each round's web part listed.
--
-- Nobody is DELETED. Mahmoud keeps his round 3 participant row and Mohi keeps
-- his round 2 one — they took part in those rounds and that is not in
-- question; only the coach flag is being corrected. Adding a round-1 row for a
-- person does not remove their row anywhere else.
--
-- ---- Still no email addresses ----
--
-- **This repository is public.** Ahmed supplied every coach's
-- @sahabaclub.com mailbox and none of it is in this file, including on the
-- rows created below, which get `email`, `ms365_mailbox` and `user_id` NULL.
-- A mailbox here would be staff personal data published to the world. Full
-- names are a different matter — `hackathon_roster` already publishes them to
-- anonymous visitors and they are in the seed README in this same repo.
--
-- The cost of that choice lands on the created rows: with no email they are
-- outside `hackathon_participants_unique` (which is partial, `where email is
-- not null`), so nothing at the database level stops a re-run creating a
-- second 'Ansari'. The inserts below carry their own NOT EXISTS guard instead.
-- It also means `link_hackathon_history()` cannot attach these three rows to
-- an account on signup — matching is on email and mailbox. Filling those in
-- from the admin panel is what fixes both, and it is the right place for it.
--
-- ---- Matching ----
--
-- By name, in two steps, stopping at the first that returns exactly one row:
--
--   1. `lower(btrim(full_name))` against a list of known spellings, taken from
--      the seed, which took them from each round's own Members list.
--   2. A whole-word match on the short label Ahmed used ('badawy', 'esraa').
--      Whole-word, not LIKE '%x%', so 'Emad' cannot match 'Mohamed'.
--
-- Anything other than exactly one match now ABORTS the migration rather than
-- being reported and skipped. That is a change of severity from the earlier
-- draft, and it follows from the instruction: a coach set that is supposed to
-- be exactly these five people cannot be delivered by a run that quietly
-- flagged four of them. Two matches aborts as well — a coach flag on the wrong
-- person is a public claim about who taught a course, and 'Badawy' alone would
-- match Malak Badawy as readily as Ahmed Badawy.
--
-- ---- Operations is not coaching ----
--
-- Sidra ran operations for all four rounds. She is NOT flagged `is_mentor` and
-- is given no `display_order`: the schema has no column that honestly says
-- "operations", `role_in_team` is self-declared by the participant and already
-- says 'EduHackAI Organizer' for her in rounds 1 and 2, and overloading
-- `is_mentor` would publish a claim that she coached. Her rows are untouched
-- except that, like everyone outside the coach lists, the sweep below asserts
-- `is_mentor = false` on them — which is what they already were.
--
-- ---- 3d. The three round-1 rows that have to be invented ----
--
-- ⚠ THESE THREE ROWS ARE NOT A RECORD OF ANYTHING. They exist because the
-- ⚠ owner says these people coached round 1 and round 1 has no coach list of
-- ⚠ any kind — its SitePage was never edited off the Microsoft template, so
-- ⚠ there was nothing to harvest. Every other participant row in this database
-- ⚠ came out of a SharePoint Members list. These did not.
--
-- The names are short labels from a conversation, not names from a record, and
-- they are written as such rather than dressed up:
--
--   'Ansari'  — the only name given. Appears nowhere in any round.
--   'Mahmoud' — deliberately NOT expanded. Two different people called Mahmoud
--               exist in round 3 (Mahmoud Mhanna and Mahmoud Elbrembaly) and
--               nothing says which of them coached round 1, or whether it was
--               a third Mahmoud who never registered for anything. Picking one
--               would attach a real person's full name to a claim that rests
--               on a first name.
--   'Mohamed Mohi El-Dien' — the one that IS expanded, because it is not a
--               guess: exactly one Mohi exists anywhere in the data, and this
--               is the spelling round 2's own Members list uses for him.
--
-- All three carry NULL email, NULL ms365_mailbox and NULL user_id (see the
-- note above about why no address appears in this file), and no team — they
-- coached, they did not compete. Two of them will therefore show on the public
-- roster as a bare first name or surname with no avatar and no profile link.
-- That is the honest rendering of what is actually known, and Ahmed can
-- correct any of it from the admin panel, which holds their mailboxes already.
--
-- The NOT EXISTS guard is the idempotency: these rows have no email, so the
-- partial unique index on (hackathon_id, lower(email)) does not cover them and
-- a second run would otherwise duplicate them. The guard probes on a
-- whole-word match rather than the exact string, so a row added later under a
-- fuller spelling ('Ahmed Ansari') also stops this from creating a second one.

insert into public.hackathon_participants (hackathon_id, full_name, is_mentor)
select h.id, v.full_name, true
from public.hackathons h
cross join (values
  ('Mahmoud',              '(^|[^a-z])mahmoud([^a-z]|$)'),
  ('Ansari',               '(^|[^a-z])ansari([^a-z]|$)'),
  ('Mohamed Mohi El-Dien', '(^|[^a-z])mohi([^a-z]|$)')
) as v(full_name, probe)
where h.slug = 'eduhackai-1'
  and not exists (
    select 1 from public.hackathon_participants p
     where p.hackathon_id = h.id
       and lower(btrim(p.full_name)) ~ v.probe
  );

do $coaches$
declare
  r           record;
  v_hid       uuid;
  v_ids       uuid[];
  v_n         int;
  v_coach_ids uuid[] := '{}';
  v_round_ids uuid[];
  v_cleared   int;
begin
  for r in
    select * from (values
      -- slug,          order, label as Ahmed wrote it, known stored spellings.
      -- 'zoka' rather than 'ahmed zoka' because §3b renamed him already.
      ('eduhackai-1', 10, 'Zoka',      array['zoka']),
      ('eduhackai-1', 20, 'Mahmoud',   array['mahmoud']),
      ('eduhackai-1', 30, 'Esraa',     array['esraa ahmed']),
      ('eduhackai-1', 40, 'Ansari',    array['ansari']),
      ('eduhackai-1', 50, 'Mohi',      array['mohamed mohi el-dien','mohamed mohi el dien','mohamed mohi']),

      ('eduhackai-2', 10, 'Zoka',      array['zoka']),
      ('eduhackai-2', 20, 'Badawy',    array['ahmed badawy']),
      ('eduhackai-2', 30, 'Gangothri', array['gangothri rajaram']),

      ('eduhackai-3', 10, 'Zoka',      array['zoka']),
      ('eduhackai-3', 20, 'Badawy',    array['ahmed badawy']),
      ('eduhackai-3', 30, 'Gangothri', array['gangothri rajaram']),

      ('eduhackai-4', 10, 'Zoka',      array['zoka']),
      ('eduhackai-4', 20, 'Badawy',    array['ahmed badawy']),
      ('eduhackai-4', 30, 'Emad',      array['emad adel'])
    ) as t(slug, display_order, label, candidates)
    order by slug, display_order
  loop
    select id into v_hid from public.hackathons where slug = r.slug;

    -- Step 1: a spelling we know is stored.
    select coalesce(array_agg(id), '{}'::uuid[]) into v_ids
    from public.hackathon_participants
    where hackathon_id = v_hid
      and lower(btrim(full_name)) = any (r.candidates);

    v_n := coalesce(array_length(v_ids, 1), 0);

    -- Step 2: the short label as a whole word anywhere in the stored name.
    if v_n = 0 then
      select coalesce(array_agg(id), '{}'::uuid[]) into v_ids
      from public.hackathon_participants
      where hackathon_id = v_hid
        and lower(btrim(full_name)) ~ ('(^|[^a-z])' || lower(r.label) || '([^a-z]|$)');
      v_n := coalesce(array_length(v_ids, 1), 0);
    end if;

    -- Abort, not skip. The coach set has to come out exactly as Ahmed listed
    -- it, and a run that flagged four of five people would deliver something
    -- that merely looks finished. §3d creates the three round-1 rows that are
    -- known to be missing, so reaching this branch means the data is not what
    -- this file was written against — read the message, do not weaken the
    -- check.
    if v_n <> 1 then
      raise exception
        '0036 §3: coach "%" in round % matched % participant rows, expected '
        'exactly 1. No coach flag has been changed anywhere — the whole '
        'migration is rolled back. See who is in that round with: select '
        'full_name from public.hackathon_participants p join public.hackathons '
        'h on h.id = p.hackathon_id where h.slug = ''%'' order by 1;',
        r.label, r.slug, v_n, r.slug;
    end if;

    update public.hackathon_participants
       set is_mentor     = true,
           display_order = r.display_order
     where id = v_ids[1];

    v_coach_ids := v_coach_ids || v_ids[1];
  end loop;

  -- The sweep. This is what makes the lists exhaustive rather than additive:
  -- anyone in these four rounds who is not on a list stops being a coach. It
  -- runs after the loop, so a coach who is on TWO rounds' lists keeps both
  -- flags — the ids are collected across all four rounds before anything is
  -- cleared.
  --
  -- `display_order` is cleared alongside the flag: it exists to order coaches,
  -- and leaving one behind on somebody who is no longer a coach would sort a
  -- competitor to the top of a team roster for no visible reason.
  select coalesce(array_agg(id), '{}'::uuid[]) into v_round_ids
  from public.hackathons
  where slug in ('eduhackai-1','eduhackai-2','eduhackai-3','eduhackai-4');

  update public.hackathon_participants
     set is_mentor = false,
         display_order = null
   where hackathon_id = any (v_round_ids)
     and not (id = any (v_coach_ids))
     and (is_mentor or display_order is not null);

  get diagnostics v_cleared = row_count;

  if v_cleared > 0 then
    -- Expected to be 1 on a first run: Mohamed Mohi El-Dien in round 2. If it
    -- is larger, somebody was flagged as a coach since the seed and has just
    -- been un-flagged — the verification block's "no extras" query names them.
    raise notice
      '0036 §3: cleared is_mentor from % participant row(s) outside Ahmed''s '
      'coach lists (1 expected — Mohamed Mohi El-Dien in round 2).', v_cleared;
  end if;
end
$coaches$;

-- ============================================================
-- 4. EduHackAI-5 — announced, and nothing else
-- ============================================================
--
-- `status` is CHECKed against
-- ('draft','announced','open','in_progress','judging','completed','cancelled')
-- and the public read policy from 0020 is `using (status <> 'draft')`. That
-- pins the choice almost completely:
--
--   'draft'   — invisible to anon. The whole point of this row is that a
--               signed-out visitor sees it and fills in the interest form.
--   'open'    — claims registration is open. It is not; there is no form, no
--               dates, and no registration window.
--   anything later ('in_progress', 'judging', 'completed') is a lie about a
--               round that has not started.
--
-- So: 'announced'. It is the honest one — the round has been announced and
-- nothing more has been decided.
--
-- Every date column is NULL, and stays NULL: `starts_on`, `ends_on`,
-- `registration_closes_on`. `location` is NULL (no venue exists). `mode` is
-- NULL — round 5 will probably be online like the other four, but "probably"
-- is not a fact and 0020's own comment says `mode` is only set where a source
-- states it.
--
-- `description` is NULL too, and that is the one that will look wrong on the
-- page. Copying rounds 1–4's text would assert that round 5 is a 10-day online
-- hackathon on Power Platform, ASP.NET Core and Azure AI. Nobody has said
-- that. The front end already handles a NULL description ("No description was
-- recorded for this round") and for a coming-soon card it should say "coming
-- soon" instead. Ahmed can fill this in from the admin panel the moment the
-- round has a shape — it is one field, and it is the right field to leave
-- empty until then.
--
-- The team-size rules stay NULL and `allows_solo` takes its default of false,
-- for the same reason: no rules have been set.

insert into public.hackathons
  (slug, round_number, name, tagline, description, status,
   starts_on, ends_on, registration_closes_on, location, mode, partner,
   cover_image_url, source_url, team_min_size, team_max_size)
values
  ('eduhackai-5', 5, 'EduHackAI-5', null, null, 'announced',
   null, null, null, null, null, null, null, null, null, null)
on conflict (slug) do update set
  round_number           = excluded.round_number,
  name                   = excluded.name,
  status                 = excluded.status,
  starts_on              = excluded.starts_on,
  ends_on                = excluded.ends_on,
  registration_closes_on = excluded.registration_closes_on,
  location               = excluded.location,
  mode                   = excluded.mode,
  updated_at             = now();

-- ============================================================
-- 5. hackathon_interest — the round 5 waiting list
-- ============================================================
--
-- These are people who are NOT members, NOT participants, and have no account.
-- They typed their name, email, phone and job into a public form on the
-- strength of a "coming soon" card. That is the most exposed personal data on
-- the platform: no login protects it, and the person has no way to come back
-- and delete it. The design follows from that.
--
-- ---- Why `anon` gets nothing, not even INSERT ----
--
-- The obvious build is an INSERT policy on this table and `grant insert to
-- anon`. It is rejected, for four reasons:
--
--   1. A grant is a capability, and it is handed to the whole internet. The
--      publishable key is in `lib/`, in the page source, on every visitor's
--      machine. `grant insert to anon` means anyone can write rows into a
--      table of personal data, forever, at whatever rate they like, from curl.
--      There is no rate limit in Postgres to put in front of it.
--   2. An INSERT policy cannot validate. `with check` can assert shapes, but
--      it cannot normalise an email, cannot decide whether this is a
--      re-submission, and cannot tell Ahmed. All three have to happen
--      somewhere, and that somewhere is the Edge Function.
--   3. Column control. With a direct INSERT grant the caller chooses every
--      column: `notified_at`, `created_at`, any `hackathon_id` they like
--      including rounds that are over. Column-level grants would help — except
--      that a column-level REVOKE is a silent no-op in this project's
--      experience, so the table grant has to be revoked wholesale first, at
--      which point there is nothing left to be clever about.
--   4. It is not needed. The form posts to `register-interest`, which runs as
--      the service role and writes from the server. The browser never holds a
--      database write privilege at all, so there is no privilege to audit,
--      scope, or lose control of — and the throttle, the field validation and
--      the notification all live in one place, in front of the write.
--
-- The RPC (path B in the header) is `security definer` and `execute` is
-- granted to `service_role` only — explicitly revoked from PUBLIC, `anon` and
-- `authenticated` first, because `grant execute on functions to public` is the
-- default in Postgres and forgetting the revoke would hand a write path to the
-- browser through the back door the front door was just locked against.
--
-- ---- Reading it ----
--
-- Staff only, via `is_staff()`, the 0033 pattern: revoke the table from anon
-- and authenticated, grant SELECT back to authenticated alone, and let RLS
-- narrow that to staff. A signed-in member who is not staff gets zero rows —
-- which is what "no email or phone readable by authenticated" means in
-- practice. `anon` holds no grant at all, so RLS never even gets consulted.
--
-- The policy is written as `(select public.is_staff())` rather than
-- `public.is_staff()`, per 0034 §10: the subselect form is evaluated once as
-- an InitPlan instead of once per row.
--
-- ---- Columns: what is here and what is deliberately not ----
--
-- A `source` / `user_agent` / `ip` column was considered and dropped. There is
-- exactly one page that writes this table, so `source` would hold one constant
-- value; and a user agent or an IP is additional personal data about a person
-- who is not a member, collected for no question anybody has asked. If spam
-- becomes a real problem the answer is a check in the Edge Function (which
-- sees the request headers already), not a permanent column of fingerprints.
-- Minimising here is not tidiness — it is the whole justification for holding
-- this data at all.

create table if not exists public.hackathon_interest (
  id uuid primary key default gen_random_uuid(),

  -- The round they are asking about. Round 5 today; the column exists so this
  -- table does not have to be rebuilt for round 6.
  hackathon_id uuid not null references public.hackathons (id) on delete cascade,

  -- The four things the form asks for. Only name and email are required: a
  -- mandatory phone number on a "tell me when it opens" form costs sign-ups
  -- and buys nothing.
  full_name    text not null check (char_length(btrim(full_name)) between 1 and 120),
  email        text not null check (char_length(btrim(email)) between 3 and 254
                                    and position('@' in email) > 1),
  mobile       text check (mobile is null or char_length(btrim(mobile)) between 4 and 40),
  current_job  text check (current_job is null or char_length(btrim(current_job)) <= 160),

  -- Ahmed was told. Set by the Edge Function after the notification actually
  -- sends, so a row with `notified_at is null` is a genuine backlog rather
  -- than a lost email. Same shape and same reasoning as
  -- `ms365_reset_requests.notified_at` in 0021: the row is the durable part,
  -- the email is a convenience on top, and a failed send loses nothing.
  --
  -- It is NOT cleared on a re-submission. Somebody pressing submit twice is
  -- not new information for Ahmed.
  notified_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.hackathon_interest is
  'Public interest register for an unannounced EduHackAI round. Personal data '
  'belonging to people who are NOT members: readable by staff only, writable '
  'only by public.register_hackathon_interest() running as the service role. '
  'anon and authenticated hold no privilege on this table.';

-- One person, one round, one row. The key is (round, normalised email):
-- email is the only field a visitor can be expected to type identically
-- twice, and normalising it means 'A@b.com ' and 'a@b.com' are the same
-- person. Phone would have been a worse key (formats vary) and name a much
-- worse one (two people share one).
--
-- An expression index rather than a plain unique constraint, matching
-- `hackathon_participants_unique` in 0020. `lower` and `btrim` are immutable,
-- so this is indexable.
create unique index if not exists hackathon_interest_round_email_uniq
  on public.hackathon_interest (hackathon_id, lower(btrim(email)));

-- What Ahmed's admin list is sorted by: the backlog first, newest first.
create index if not exists hackathon_interest_pending_idx
  on public.hackathon_interest (hackathon_id, created_at desc)
  where notified_at is null;

alter table public.hackathon_interest enable row level security;

-- Staff read. There is deliberately NO policy for INSERT, UPDATE or DELETE for
-- any role: the only writer is `security definer` and writes as the owner, so
-- it does not need one, and a staff member editing what a member of the public
-- typed is not a feature anybody asked for.
drop policy if exists "hackathon interest: staff read" on public.hackathon_interest;
create policy "hackathon interest: staff read" on public.hackathon_interest
  for select using ((select public.is_staff()));

-- Supabase grants ALL on a new table to anon and authenticated. Without this
-- revoke, the form on a public page would be readable — and writable, and
-- deletable — by anyone holding the publishable key. Revoke BEFORE granting;
-- there is no clean slate.
revoke all on public.hackathon_interest from anon, authenticated;
grant select on public.hackathon_interest to authenticated;

-- ---- The only write path ----

create or replace function public.register_hackathon_interest(
  p_slug        text,
  p_full_name   text,
  p_email       text,
  p_mobile      text default null,
  p_current_job text default null
)
returns table (interest_id uuid, is_new boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_hid   uuid;
  v_name  text := nullif(btrim(coalesce(p_full_name, '')), '');
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_mob   text := nullif(btrim(coalesce(p_mobile, '')), '');
  v_job   text := nullif(btrim(coalesce(p_current_job, '')), '');
begin
  -- Resolved from the slug, never taken as a uuid from the caller. The Edge
  -- Function is trusted; the shape of the argument is what stops a future
  -- careless caller writing interest rows against a finished round.
  select id into v_hid from public.hackathons where slug = p_slug;
  if v_hid is null then
    raise exception 'register_hackathon_interest: no hackathon with slug %', p_slug
      using errcode = '22023';
  end if;

  if v_name is null then
    raise exception 'register_hackathon_interest: full name is required'
      using errcode = '22023';
  end if;
  -- Deliberately STRICTER than the table's CHECK constraint (length 3..254,
  -- '@' not first). Every validation in this function is: the table
  -- constraints are the last line of defence and a visitor should never be the
  -- one who discovers them — a constraint violation surfaces as a 500, not as
  -- "please check your email address".
  if v_email is null
     or char_length(v_email) < 5
     or position('@' in v_email) < 2
     or position('@' in v_email) > char_length(v_email) - 1 then
    raise exception 'register_hackathon_interest: a valid email is required'
      using errcode = '22023';
  end if;

  -- Clipped rather than rejected. Someone who pastes their whole job title
  -- into the job box should get a row, not a red error on a form whose only
  -- purpose is to say "tell me when it opens".
  v_name := left(v_name, 120);
  v_mob  := left(v_mob,  40);
  v_job  := left(v_job, 160);

  -- Same reasoning in the other direction: the table requires a mobile to be
  -- 4–40 characters, so a two-character one is dropped rather than allowed to
  -- become a constraint violation. Mobile is optional; "absent" is a perfectly
  -- good answer and is better than a failed submission.
  if v_mob is not null and char_length(v_mob) < 4 then
    v_mob := null;
  end if;

  -- The re-submission case. It is an UPDATE, not an error: the visitor sees
  -- the same thank-you either way, which is the correct thing for them to see.
  -- `created_at` keeps the FIRST time they asked, `notified_at` is not
  -- cleared, and the newer name / phone / job win because they are the more
  -- recent statement of fact about themselves.
  --
  -- `xmax = 0` is true only for a genuinely inserted row, which is what tells
  -- the Edge Function whether to bother Ahmed.
  return query
  insert into public.hackathon_interest
    (hackathon_id, full_name, email, mobile, current_job)
  values
    (v_hid, v_name, left(v_email, 254), v_mob, v_job)
  on conflict (hackathon_id, lower(btrim(email))) do update
    set full_name   = excluded.full_name,
        email       = excluded.email,
        mobile      = coalesce(excluded.mobile, hackathon_interest.mobile),
        current_job = coalesce(excluded.current_job, hackathon_interest.current_job),
        updated_at  = now()
  returning id, (xmax = 0);
end
$fn$;

comment on function public.register_hackathon_interest(text, text, text, text, text) is
  'The only write path into hackathon_interest. Called by the round-5 interest '
  'Edge Function as the service role. Idempotent per (round, email): a second '
  'submission updates the row and returns is_new = false.';

-- PUBLIC holds EXECUTE on every new function by default. Revoke first, then
-- grant to exactly one role. Without the first line the browser could call
-- this directly through PostgREST as `anon`, which would make every word in
-- section 5's preamble false.
revoke all on function public.register_hackathon_interest(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.register_hackathon_interest(text, text, text, text, text)
  to service_role;

-- ============================================================================
-- Verification — run these, do not assume
-- ============================================================================
--
-- Nothing in this file has been run. Every expectation below is derived from
-- reading `supabase/seed/hackathons/eduhackai-seed.sql`, not from a database.
-- Where a query's expected answer depends on data this author could not see,
-- it says so.
--
-- ---- 1. The four rounds ----
--
-- Expect exactly these four rows, all mode = 'online', all with a "Demo Day…"
-- location, and all four descriptions identical except round 4's trailing
-- clause:
--
-- select slug, round_number, starts_on, ends_on, mode, location,
--        ends_on - starts_on as span_days,
--        left(description, 40) as desc_head,
--        right(description, 30) as desc_tail
--   from public.hackathons
--  where slug like 'eduhackai-%'
--  order by round_number;
--   -- expect span_days = 10 on all four rounds
--   -- expect desc_head = '10-day global online hackathon where yo' on all four
--   -- expect desc_tail = '— this round ran in Arabic.' on round 4 ONLY
--
-- The descriptions really are identical apart from round 4. Expect ONE row,
-- count = 3:
--
-- select description, count(*)
--   from public.hackathons
--  where slug in ('eduhackai-1','eduhackai-2','eduhackai-3')
--  group by description;
--
-- ---- 2. The six new placings ----
--
-- Expect exactly six rows: ranks 1,2,3 in round 3 (MeyaSports, AI Falcons,
-- Code Trackers) and 1,2,3 in round 4 (MAINTENEX, AI Exam Generator,
-- Innovate AI), each with a '1st/2nd/3rd Place' award:
--
-- select h.slug, t.rank, t.name, t.award, t.is_winner
--   from public.hackathon_teams t
--   join public.hackathons h on h.id = t.hackathon_id
--  where h.slug in ('eduhackai-3','eduhackai-4') and t.rank is not null
--  order by h.slug, t.rank;
--
-- And nothing else in those rounds acquired a rank. Expect zero rows:
--
-- select h.slug, t.name, t.rank
--   from public.hackathon_teams t
--   join public.hackathons h on h.id = t.hackathon_id
--  where h.slug in ('eduhackai-3','eduhackai-4')
--    and t.rank is not null
--    and t.name not in ('MeyaSports','AI Falcons','Code Trackers',
--                       'MAINTENEX','AI Exam Generator','Innovate AI');
--
-- Rounds 1 and 2 are untouched. Expect Innovation Geeks / Finova / ExamAi and
-- The AI Geeks (Clever Mart) / Everest / Pioneers, all with award = NULL and
-- all six with is_winner = true:
--
-- select h.slug, t.rank, t.name, t.award, t.is_winner
--   from public.hackathon_teams t
--   join public.hackathons h on h.id = t.hackathon_id
--  where h.slug in ('eduhackai-1','eduhackai-2') and t.rank is not null
--  order by h.slug, t.rank;
--
-- ---- 3. All four rounds now have three winners each ----
--
-- Expect winners = 3 and placed = 3 on every one of the four rounds. Rounds 3
-- and 4 were brought up to rounds 1 and 2's convention, not the other way
-- round, and rounds 1 and 2 were not written to at all:
--
-- select h.slug,
--        count(*) filter (where t.is_winner)          as winners,
--        count(*) filter (where t.rank is not null)   as placed
--   from public.hackathon_teams t
--   join public.hackathons h on h.id = t.hackathon_id
--  where h.slug like 'eduhackai-%'
--  group by h.slug order by h.slug;
--
-- No team is a winner without a placing, in any round. Expect zero rows — this
-- is the one way the flag could have been widened too far:
--
-- select h.slug, t.name, t.rank, t.is_winner
--   from public.hackathon_teams t
--   join public.hackathons h on h.id = t.hackathon_id
--  where t.is_winner and t.rank is null;
--
-- What this actually publishes, which is the reason it was a decision and not
-- a detail: the members of the six rounds-3-and-4 teams now carry
-- `is_winner: true` in their profile's hackathon aggregate. Expect roughly 15
-- people, all from the six named teams:
--
-- select p.full_name, h.slug, t.name, t.rank
--   from public.hackathon_participants p
--   join public.hackathon_teams t on t.id = p.team_id
--   join public.hackathons h on h.id = p.hackathon_id
--  where h.slug in ('eduhackai-3','eduhackai-4') and t.is_winner
--  order by h.slug, t.rank, p.full_name;
--
-- ---- 4. Coaches, per round, in the order they will be shown ----
--
-- Expect 5, 3, 3, 3 — Ahmed's lists exactly. Not "at least"; exactly. The
-- migration aborts rather than under-flagging, and sweeps rather than
-- over-flagging, so any other answer here means something ran that this file
-- did not write:
--
-- select h.slug, count(*) as coaches
--   from public.hackathon_participants p
--   join public.hackathons h on h.id = p.hackathon_id
--  where h.slug like 'eduhackai-%' and p.is_mentor
--  group by h.slug order by h.slug;
--
-- Read out in full. Zoka must be the FIRST row of every round, and the names
-- must be these and no others:
--
--   eduhackai-1  Zoka, Mahmoud, Esraa Ahmed, Ansari, Mohamed Mohi El-Dien
--   eduhackai-2  Zoka, Ahmed Badawy, Gangothri Rajaram
--   eduhackai-3  Zoka, Ahmed Badawy, Gangothri Rajaram
--   eduhackai-4  Zoka, Ahmed Badawy, Emad Adel
--
-- select h.slug, p.display_order, p.full_name, p.role_in_team
--   from public.hackathon_participants p
--   join public.hackathons h on h.id = p.hackathon_id
--  where h.slug like 'eduhackai-%' and p.is_mentor
--  order by h.round_number, p.display_order nulls last, p.full_name;
--
-- The same thing as a pass/fail rather than something to eyeball. Both halves
-- must return zero rows: the first names a coach Ahmed listed who is not
-- flagged, the second names somebody flagged who Ahmed did not list.
--
-- with wanted(slug, label) as (values
--   ('eduhackai-1','Zoka'), ('eduhackai-1','Mahmoud'), ('eduhackai-1','Esraa'),
--   ('eduhackai-1','Ansari'), ('eduhackai-1','Mohi'),
--   ('eduhackai-2','Zoka'), ('eduhackai-2','Badawy'), ('eduhackai-2','Gangothri'),
--   ('eduhackai-3','Zoka'), ('eduhackai-3','Badawy'), ('eduhackai-3','Gangothri'),
--   ('eduhackai-4','Zoka'), ('eduhackai-4','Badawy'), ('eduhackai-4','Emad')
-- ), flagged as (
--   select h.slug, p.id, p.full_name
--     from public.hackathon_participants p
--     join public.hackathons h on h.id = p.hackathon_id
--    where h.slug like 'eduhackai-%' and p.is_mentor
-- )
-- select 'missing' as problem, w.slug, w.label as who
--   from wanted w
--  where not exists (
--    select 1 from flagged f
--     where f.slug = w.slug
--       and lower(btrim(f.full_name)) ~ ('(^|[^a-z])' || lower(w.label) || '([^a-z]|$)')
--  )
-- union all
-- select 'extra', f.slug, f.full_name
--   from flagged f
--  where not exists (
--    select 1 from wanted w
--     where w.slug = f.slug
--       and lower(btrim(f.full_name)) ~ ('(^|[^a-z])' || lower(w.label) || '([^a-z]|$)')
--  )
--  order by 1, 2, 3;
--
-- The ordering survives into the public view — this is what the page shows,
-- and Zoka must be first in each round's coach block:
--
-- select hackathon_id, full_name, is_mentor, display_order
--   from public.hackathon_roster
--  where is_mentor
--  limit 40;
--
-- No competitor is left carrying an ordering. Expect zero rows — the sweep
-- clears display_order alongside the flag, so this also catches a coach who
-- was un-flagged but left sorted to the top of a roster:
--
-- select full_name, display_order from public.hackathon_participants
--  where display_order is not null and not is_mentor;
--
-- ---- 5. The three things that were overridden or invented ----
--
-- These are the changes Ahmed authorised against the written record, so each
-- one gets its own check rather than being folded into the counts above.
--
-- (a) THE RENAME. Expect zero rows — nobody is called 'Ahmed Zoka' any more —
--     and then exactly four rows called 'Zoka', one per round:
--
-- select id, full_name from public.hackathon_participants
--  where lower(btrim(full_name)) in ('ahmed zoka','ahmed abdel razek');
--
-- select h.slug, p.full_name, p.email is not null as has_email
--   from public.hackathon_participants p
--   join public.hackathons h on h.id = p.hackathon_id
--  where lower(btrim(p.full_name)) = 'zoka'
--  order by h.round_number;
--
--     His profile and his account are NOT renamed — only the participant
--     display name. Expect his profile to still read as it did:
--
-- select full_name from public.profiles
--  where lower(full_name) like '%zoka%' or lower(full_name) like '%razek%';
--
-- (b) THE THREE INVENTED ROUND-1 ROWS. Expect exactly three, all is_mentor,
--     all with NULL email, NULL ms365_mailbox, NULL user_id and no team. If
--     any of them has an email, somebody has since filled it in from the admin
--     panel, which is the intended fix and not a failure:
--
-- select p.full_name, p.is_mentor, p.display_order,
--        p.email, p.ms365_mailbox, p.user_id, p.team_id, p.created_at
--   from public.hackathon_participants p
--   join public.hackathons h on h.id = p.hackathon_id
--  where h.slug = 'eduhackai-1'
--    and lower(btrim(p.full_name)) in ('mahmoud','ansari','mohamed mohi el-dien')
--  order by p.display_order;
--
--     Running the file twice must not make six of them. Expect 1, 1, 1:
--
-- select lower(btrim(p.full_name)) as name, count(*)
--   from public.hackathon_participants p
--   join public.hackathons h on h.id = p.hackathon_id
--  where h.slug = 'eduhackai-1'
--    and lower(btrim(p.full_name)) in ('mahmoud','ansari','mohamed mohi el-dien')
--  group by 1 order by 1;
--
--     And the rows those three people already had elsewhere are still there —
--     only the coach flag moved, nobody was deleted. Expect Mahmoud Mhanna and
--     Mahmoud Elbrembaly in round 3 and Mohamed Mohi El-Dien in round 2, all
--     with is_mentor now false:
--
-- select h.slug, p.full_name, p.is_mentor, t.name as team
--   from public.hackathon_participants p
--   join public.hackathons h on h.id = p.hackathon_id
--   left join public.hackathon_teams t on t.id = p.team_id
--  where lower(btrim(p.full_name)) ~ '(^|[^a-z])(mahmoud|mohi)([^a-z]|$)'
--  order by h.round_number, p.full_name;
--
-- (c) THE CLEARED FLAG. Mohamed Mohi El-Dien is no longer a round 2 coach.
--     Expect exactly one row, is_mentor false:
--
-- select h.slug, p.full_name, p.is_mentor, p.display_order
--   from public.hackathon_participants p
--   join public.hackathons h on h.id = p.hackathon_id
--  where h.slug = 'eduhackai-2'
--    and lower(btrim(p.full_name)) like 'mohamed mohi%';
--
-- Who IS in a round, when a name needs checking by hand (names only — this is
-- the roster the public already sees):
--
-- select p.full_name from public.hackathon_participants p
--   join public.hackathons h on h.id = p.hackathon_id
--  where h.slug = 'eduhackai-1' order by p.full_name;
--
-- ---- 6. Round 5 exists and claims nothing ----
--
-- Expect exactly one row, status 'announced', NULL in every other column shown
-- except `allows_solo`, which is `not null default false` and so reads false —
-- read that as "no team rules have been set", the same as NULL beside it:
--
-- select slug, round_number, name, status, starts_on, ends_on,
--        registration_closes_on, location, mode, description,
--        team_min_size, team_max_size, allows_solo
--   from public.hackathons where slug = 'eduhackai-5';
--
-- It is visible to a signed-out visitor. Run this with the anon key — expect
-- one row:
--
-- select slug, name, status from public.hackathons where slug = 'eduhackai-5';
--
-- ---- 7. The grants on hackathon_interest are exactly what was intended ----
--
-- Expect NO row with grantee = 'anon', and exactly one row for 'authenticated'
-- reading SELECT. service_role and the owner keep their default privileges:
--
-- select grantee, privilege_type
--   from information_schema.role_table_grants
--  where table_schema = 'public' and table_name = 'hackathon_interest'
--  order by grantee, privilege_type;
--
-- The narrower assertion, on its own, because it is the one that matters.
-- Expect zero rows:
--
-- select grantee, privilege_type
--   from information_schema.role_table_grants
--  where table_schema = 'public' and table_name = 'hackathon_interest'
--    and (grantee = 'anon'
--         or (grantee = 'authenticated' and privilege_type <> 'SELECT'));
--
-- The function is not callable by the browser. Expect an ACL containing
-- `service_role=X/postgres` and the owner, and NO bare `=X/` entry (which is
-- PUBLIC), no `anon=X`, no `authenticated=X`:
--
-- select proname, proacl from pg_proc
--  where pronamespace = 'public'::regnamespace
--    and proname = 'register_hackathon_interest';
--
-- RLS is on and there is exactly one policy, SELECT for staff:
--
-- select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr
--   from pg_policy where polrelid = 'public.hackathon_interest'::regclass;
--   -- expect one row: SELECT, and `(SELECT is_staff() AS is_staff)`
--
-- select relrowsecurity from pg_class
--  where oid = 'public.hackathon_interest'::regclass;   -- expect true
--
-- ---- 8. The behaviour, not just the privileges ----
--
-- As `anon` (the publishable key), ALL FOUR must be denied. This is the test
-- that the section-5 preamble is true rather than merely well argued:
--
-- select * from public.hackathon_interest;                        -- must fail
-- insert into public.hackathon_interest (hackathon_id, full_name, email)
--   values ((select id from public.hackathons where slug='eduhackai-5'),
--           'x','x@example.com');                                 -- must fail
-- select * from public.register_hackathon_interest(
--   'eduhackai-5','x','x@example.com');                           -- must fail
-- -- and the same three as an ordinary signed-in member: the SELECT must
-- -- return zero rows (RLS), the INSERT and the RPC must fail (no grant).
--
-- Path A end to end, which is the one the site actually uses: POST the form on
-- the round 5 card twice with the same email, then expect ONE row and a single
-- notification. `register-interest` returns { ok: true, already: true } the
-- second time and must not return an error to the visitor:
--
-- select id, full_name, email, notified_at, created_at
--   from public.hackathon_interest
--  where hackathon_id = (select id from public.hackathons where slug='eduhackai-5')
--  order by created_at desc limit 10;
--
-- Path B, as the service role, on a throwaway address — the second call is the
-- whole point of the unique index:
--
-- select * from public.register_hackathon_interest(
--   'eduhackai-5', 'Test Person', ' Test@Example.COM ', '+971500000000', 'Tester');
--   -- expect is_new = true
-- select * from public.register_hackathon_interest(
--   'eduhackai-5', 'Test Person Renamed', 'test@example.com');
--   -- expect is_new = FALSE and the SAME interest_id — one row, not two,
--   -- and no error for the visitor to see
--
-- select id, full_name, email, mobile, current_job, notified_at,
--        created_at, updated_at
--   from public.hackathon_interest where lower(email) = 'test@example.com';
--   -- expect ONE row; full_name updated; mobile and current_job PRESERVED
--   -- from the first call (the second sent null and null must not erase);
--   -- created_at unchanged, updated_at moved
--
-- delete from public.hackathon_interest where lower(email) = 'test@example.com';
--
-- A bad round must be refused rather than silently writing nothing, and bad
-- input must be refused by the FUNCTION rather than by a CHECK constraint —
-- the function raises 22023 (which the Edge Function can turn into "please
-- check your details"), a CHECK raises 23514 and reads as a server fault:
--
-- select * from public.register_hackathon_interest(
--   'eduhackai-99','x','x@example.com');       -- must raise, errcode 22023
-- select * from public.register_hackathon_interest(
--   'eduhackai-5','','x@example.com');         -- must raise, errcode 22023
-- select * from public.register_hackathon_interest(
--   'eduhackai-5','x','not-an-email');         -- must raise, errcode 22023
-- select * from public.register_hackathon_interest(
--   'eduhackai-5','x','a@b');                  -- must raise, errcode 22023
--
-- A too-short mobile is dropped, not rejected. Expect one row, is_new = true,
-- mobile NULL — and no error:
--
-- select * from public.register_hackathon_interest(
--   'eduhackai-5','Short Mobile','short.mobile@example.com','12');
-- select mobile from public.hackathon_interest
--  where lower(email) = 'short.mobile@example.com';   -- expect NULL
-- delete from public.hackathon_interest
--  where lower(email) = 'short.mobile@example.com';
--
-- ---- 9. The things this file is most likely to be wrong about ----
--
-- Most of this migration is checkable: a date can be held against a calendar,
-- a privilege against a query. Four things are not, and all four are the same
-- kind of thing — the owner's account of what happened, published as fact,
-- with no document behind it and in three cases against one. Every one of them
-- was put to him explicitly and confirmed on 2026-08-03. If the hackathons
-- page is ever questioned, this is the list, and there is nothing else to go
-- back to.
--
--   1. Six placings in rounds 3 and 4. No document in the tenant records them;
--      the page previously said so.
--   2. Round 1's coach list. Three of its five people had no round-1 record at
--      all and now have participant rows created by this file — two of them
--      under a bare first name or surname, which is all that was given.
--   3. Mohamed Mohi El-Dien is no longer a round 2 coach, although round 2's
--      own SharePoint page listed him as one.
--   4. 'Mahmoud' in round 1 is not tied to either of the two real Mahmouds in
--      the data. Nobody knows which of them it is, or whether it is a third
--      person. If somebody later "tidies" that row by expanding the name, they
--      will be inventing a fact, not correcting a typo.
--
-- The record that items 2–4 overrode is still in
-- `supabase/seed/hackathons/README.md`, unedited. Read it before reversing
-- any of this.
