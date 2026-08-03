-- Sahaba Club — 0034: remediation of the schema audit
-- ============================================================
--
-- ⚠⚠ THIS MIGRATION HAS **NOT** BEEN APPLIED TO ANY DATABASE. It was written
-- against the files in this repository, by reading 0001–0033, with no
-- connection to Postgres at any point. Nothing in it has been executed, no
-- number in it has been measured, and no EXPLAIN in the verification block at
-- the end has been run. Apply it by hand, in a transaction, and then run that
-- block — it exists because the whole point of this file is that several of
-- the things it fixes were comments asserting a control that was not there.
--
-- Nine changes and one withdrawal, ordered by severity rather than by table.
-- The numbering is the audit's, kept as it was so the two can be read side by
-- side — which is why §8 is a note and not a change.
--
--   1. `member_activity` leaks the event history of every member, including
--      everyone who opted out of attendee lists. LIVE. Fix first.
--   2. `authenticated` still holds Supabase's default ALL on the three
--      marketing tables, so staff write them directly and the consent rule in
--      0033 §6 is advisory rather than enforced.
--   3. Two missing indexes — one of them the only quadratic term in Connect.
--   4. The leaderboard computes a per-member streak it never selects.
--   5. `data_field_stats` does one full table scan per catalogued column.
--   6. `admin_import_rows` de-duplicates with a plpgsql array — quadratic in
--      both time and memory at its own advertised ceiling.
--   7. `avatars_due_refresh` redraws dormant members for ever.
--   8. WITHDRAWN — see §8. Already fixed by 0032, which is written and
--      committed but was never merged to main.
--   9. `prospect_profiles` has RLS on and no policies, so there is no route
--      for staff to unpublish a profile and none for the person to object.
--  10. `is_staff()` is called per row in six policies.
--
-- ⚠ §2 AND `app/admin/contacts.html` MUST SHIP TOGETHER, IN THAT ORDER OF
-- THOUGHT IF NOT OF TIME. §2 removes UPDATE on `marketing_contacts` from
-- `authenticated`. That page used to save through a direct PostgREST update,
-- which is exactly the hole §2 closes; it now calls
-- `public.admin_update_contact(id, patch)`, which handles all three fields it
-- writes (`notes`, `is_test`, `unsubscribed_at`), audits the change with a
-- source, and refuses to clear an unsubscribe.
--
-- So: applying this migration WITHOUT that page change breaks saving contacts
-- with a permission error, and deploying that page change without this
-- migration leaves the direct write path open for anything else to use. Ship
-- both. If you are applying this to a database whose front end is older than
-- the page change, apply §2 last and be ready to re-grant.

-- ============================================================
-- 1. member_activity — the privacy control the comment already claims
-- ============================================================
--
-- ⚠ THIS IS A LIVE DISCLOSURE, NOT A HARDENING. State it plainly before the
-- SQL, because the next person to read 0013 will read the comment and believe
-- it, which is exactly what happened the first time.
--
-- 0013:183-185 says of this view: "Deliberately only counts events that are
-- PUBLISHED and that the member chose to appear in — `show_in_attendees` is
-- their setting, and it governs here too."
--
-- `show_in_attendees` does not appear anywhere in the view body, and the view
-- is not redefined in 0014–0033. Only the `is_published` half of that sentence
-- was ever true.
--
-- Why the setting does not arrive on its own. The view is
-- `security_invoker = off`, so it reads `event_registrations` with the owner's
-- rights and row-level security does not apply to it. The policy that DOES
-- carry the rule — 0005:122-131, "registrations: members see fellow
-- attendees", which requires the registrant's `show_in_attendees` — is
-- therefore never consulted. `authenticated` holds SELECT on the view, so any
-- signed-in member can GET /rest/v1/member_activity with no filter and receive
-- every member's attended and upcoming counts, first and latest event dates,
-- and top six topics — including the members who switched attendee listing
-- off, and including members who are not discoverable in Connect at all.
--
-- The fix is the row filter and only the row filter. The column list is
-- unchanged on purpose: `lib/connect.js` selects these six names explicitly
-- (ACTIVITY_COLUMNS), `app/connect.html` and `app/member.html` render them,
-- and `member_directory` / `connect_directory` do not read this view at all —
-- so nothing downstream needs to change, and nothing downstream will notice
-- except that opted-out members now return no row, which is the same thing a
-- member with no event history has always returned and which both callers
-- already treat as zero rather than as an error.
--
-- Two decisions inside the predicate, both worth defending:
--
--   * `r.user_id = auth.uid()` — a member always sees their own activity, even
--     with the setting off. Their own page is the one place the numbers are
--     not a disclosure, and without this clause switching off attendee
--     listing would silently blank a member's own profile statistics.
--
--   * `is_discoverable` is deliberately NOT part of this. The rule being
--     restored is the one the table's own policy enforces, and mirroring that
--     policy exactly is what makes the view no more permissive than the table
--     underneath it. The two flags are also genuinely independent: a member
--     who is listed at events but not browsable in Connect is a supported
--     combination, and gating on discoverability here would hide activity from
--     the attendee surfaces that are entitled to it.
--
-- `create or replace` rather than drop-and-create: the column list is
-- identical, nothing depends on the view, and replacing in place keeps the
-- existing grants rather than re-creating an object that Supabase would
-- re-grant ALL on.
create or replace view public.member_activity
with (security_invoker = off) as
select
  r.user_id,
  count(*) filter (where e.event_date <  current_date) as events_attended,
  count(*) filter (where e.event_date >= current_date) as events_upcoming,
  min(e.event_date)  as first_event,
  max(e.event_date)  as latest_event,
  -- Unchanged from 0013. It is correlated to `r.user_id`, which the WHERE
  -- clause below has already restricted to members who may be reported on, so
  -- it cannot reach anybody the outer query has excluded. Restating the
  -- predicate inside it would be a second copy of the rule, which is how the
  -- two halves come to disagree.
  (
    select array_agg(tag order by n desc)
    from (
      select unnest(e2.tags) as tag, count(*) as n
      from public.event_registrations r2
      join public.events e2 on e2.id = r2.event_id
      where r2.user_id = r.user_id and e2.is_published
      group by 1 order by n desc limit 6
    ) t
  ) as top_topics
from public.event_registrations r
join public.events e on e.id = r.event_id
where e.is_published
  -- ⚠ THE PRIVACY CONTROL. It is an EXISTS rather than a join so that a
  -- registration whose profile row is missing cannot duplicate a group, and so
  -- that "no profile" fails closed instead of being an inner-join accident.
  and (
    r.user_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.user_id = r.user_id
        and p.show_in_attendees
    )
  )
group by r.user_id;

comment on view public.member_activity is
  'Event activity per member, derived from published events only, and only for '
  'members whose show_in_attendees is on (plus the caller''s own row). The WHERE '
  'clause is the privacy control: this view is security_invoker = off, so the '
  'RLS policy on event_registrations never fires and the rule has to be here.';

-- Re-asserted rather than assumed. These are already correct on a database
-- that has run 0013, but a rebuild-from-scratch reader should not have to go
-- and check, and `create or replace` on a view that had been dropped and
-- re-created by hand would arrive with Supabase's default ALL.
revoke all on public.member_activity from anon, authenticated;
grant select on public.member_activity to authenticated;

-- ============================================================
-- 2. The marketing tables — take the write grants back
-- ============================================================
--
-- 0010:188-190 revokes ALL from `anon` on all three tables and stops there.
-- `authenticated` keeps the grant Supabase makes automatically on every new
-- table, which is ALL: INSERT, UPDATE, DELETE and TRUNCATE included.
--
-- RLS is not the second line of defence people assume here, because the policy
-- is `for all using (public.is_staff())` — so for staff the policy permits
-- everything and the grant is the only remaining limit. A staff session
-- therefore holds a direct PostgREST write path into 2,200 people's contact
-- details, and `app/admin/contacts.html:365` already uses it.
--
-- What that costs, concretely: 0033:1021-1028 states as a guarantee that "an
-- unsubscribe or a bounce cannot be cleared from here", and enforces it inside
-- `admin_update_contact`. A direct `update marketing_contacts set
-- unsubscribed_at = null` does not go through that function and is not
-- refused. The guarantee is real only if the gated function is the only way
-- in, which is what these six lines make true.
--
-- Revoke-then-grant rather than `revoke insert, update, delete`. Same house
-- rule as everywhere else: enumerate what is wanted, not what is unwanted, so
-- a privilege nobody thought of (TRUNCATE, REFERENCES, TRIGGER) is not left
-- behind. `anon` is included again although 0010 already did it — repeating a
-- revoke is free and reading two files to find out is not.
--
-- Reads are preserved deliberately. `app/admin/contacts.html` and
-- `app/admin/campaigns.html` both select from `marketing_contacts` and
-- `contact_engagements`, `app/admin/data-admin.js` selects `*` from
-- `marketing_contacts`, and the RLS policies already scope every one of those
-- to staff. `contact_imports` has no reader in the app today; SELECT is
-- granted anyway rather than discovering later that something offline used it.
revoke all on public.marketing_contacts  from anon, authenticated;
revoke all on public.contact_engagements from anon, authenticated;
revoke all on public.contact_imports     from anon, authenticated;

grant select on public.marketing_contacts  to authenticated;
grant select on public.contact_engagements to authenticated;
grant select on public.contact_imports     to authenticated;

-- The write path that remains, for the avoidance of doubt: the `admin_*`
-- functions in 0033 §5 and §6 are `security definer`, so they execute with the
-- owner's rights and are entirely unaffected by the revoke above. They keep
-- working, they set `sc.audit_source` so the audit trail can tell a panel edit
-- from an import, and they enforce the consent rule. Nothing else writes these
-- tables except the service role, which has its own grant.

-- ============================================================
-- 3. Two indexes that are not there
-- ============================================================

-- ⚠ The only quadratic term in Connect. `prospect_directory` (0027:174) joins
-- `lower(hp.ms365_mailbox) = lower(p.ms365_mailbox)` for every prospect row it
-- returns. 0020:131 indexes `lower(email)` — the other identifier — so this
-- join has nothing to use and falls back to a sequential scan of
-- `hackathon_participants` per prospect. Connect reads that view on every
-- directory page load.
create index if not exists hackathon_participants_ms365_mailbox_idx
  on public.hackathon_participants (lower(ms365_mailbox));

-- `lib/promptarena.js` reads `promptarena_challenge_deck` with
-- `order by created_at desc limit 200` (DECK_CAP). The deck view filters on
-- `is_active`, and 0029's two indexes on this table are on
-- `(difficulty, domain)` and `(times_served)` — neither can serve the sort, so
-- every deck load sorts the whole active bank. Partial on `is_active` because
-- that is the only population the deck can return, and retired challenges are
-- kept for ever by design (0029:136-140).
create index if not exists promptarena_challenges_deck_idx
  on public.promptarena_challenges (created_at desc) where is_active;

-- ============================================================
-- 4. The streak comes off the leaderboard's path
-- ============================================================
--
-- `promptarena_member_stats` (0029:599) computes `current_streak` in a LATERAL
-- that, for each member, re-scans that member's judged submissions and numbers
-- their distinct playing days. `promptarena_leaderboard` selects from that
-- view and does NOT select `current_streak` — deliberately, and 0029:723-727
-- explains at length why a streak must never appear on a public board.
--
-- The cost is paid anyway. The opt-in filter (`p.show_in_promptarena_ranking`)
-- is on `profiles`, on the far side of a join from the LATERAL, so the planner
-- cannot push it underneath — and even if it could, the LATERAL is in the view
-- the filter reads FROM. So the streak is computed for every member who has
-- ever submitted anything, including everyone who opted out, and then thrown
-- away. That is O(members × judged submissions) to render a board that needs
-- O(submissions).
--
-- The fix is a split, not a rewrite: the streak moves into its own internal
-- view that only `promptarena_my_stats` reads. The leaderboard's own text is
-- reproduced below character for character — its ranking, its tiebreak and its
-- column list are the privacy property of that view and this migration has no
-- business touching any of them.
--
-- ⚠ NOT MATERIALIZED, AND THAT IS THE POINT. A materialised view here would
-- add a refresh schedule, a staleness window and a "why does my rating not
-- update" bug, to save a scan of a table that has hundreds of rows. The
-- crossover for materialising this is somewhere around millions of
-- submissions. This platform is nowhere near it and should not pay the
-- complexity now.
--
-- "One definition of a rating" (0029:564-568) is preserved and slightly
-- strengthened: the `judged` CTE that both the rating and the streak were
-- computed from becomes a named internal view, so there is now one definition
-- of "a judged attempt" as well, and the change 0029 anticipates — "best
-- attempt per challenge" instead of every attempt — is still an edit in one
-- place.

drop view if exists public.promptarena_leaderboard;
drop view if exists public.promptarena_my_stats;
drop view if exists public.promptarena_member_stats;
drop view if exists public.promptarena_member_streaks;
drop view if exists public.promptarena_judged_attempts;

-- ---- What counts as a judged attempt, once ----------------------------
--
-- Internal. Never granted to any client role: it covers every member,
-- including those who have not opted into the ranking, and it carries the
-- per-challenge score, which is one of the things 0029 refuses to publish.
create view public.promptarena_judged_attempts
with (security_invoker = off) as
select
  s.user_id,
  s.challenge_id,
  s.score,
  -- Asia/Dubai, not UTC, and 0029:588-594 has the reasoning: UTC midnight is
  -- 4am here, so a member playing two evenings running would land on one UTC
  -- date and one playing at 2am would break their own streak.
  (s.judged_at at time zone 'Asia/Dubai')::date as played_on
from public.promptarena_submissions s
where s.judge_status = 'judged'
  and s.score is not null;

comment on view public.promptarena_judged_attempts is
  'The single definition of a judged PromptArena attempt. Internal: covers every member and carries per-challenge scores, so no client role may read it.';

revoke all on public.promptarena_judged_attempts from anon, authenticated;

-- ---- Per-member stats, with the streak taken out ----------------------
--
-- Identical to 0029's version in every column except `current_streak`, which
-- has moved. Anything reading `current_streak` from THIS view would now fail
-- loudly rather than silently — checked before writing this: the only reader
-- is `promptarena_my_stats`, and `lib/promptarena.js` reads it from there.
create view public.promptarena_member_stats
with (security_invoker = off) as
select
  j.user_id,
  round(avg(j.score)::numeric, 2)   as rating,
  count(distinct j.challenge_id)    as challenges_completed,
  count(*)                          as judged_attempts,
  max(j.score)                      as highest_score,
  min(j.score)                      as lowest_score,
  max(j.played_on)                  as last_played_on
from public.promptarena_judged_attempts j
group by j.user_id;

comment on view public.promptarena_member_stats is
  'The single definition of a PromptArena rating, derived from submissions. Internal: covers every member including those who have not opted into the ranking, so no client role may read it. The streak lives in promptarena_member_streaks — it is not on this view because the leaderboard reads this one and never wants it.';

revoke all on public.promptarena_member_stats from anon, authenticated;

-- ---- The streak, on its own ------------------------------------------
--
-- Same algorithm as 0029, moved rather than rewritten. The leading run of
-- consecutive days, and only the leading run: number the distinct days
-- newest-first and keep those where `day = anchor - (n - 1)`. Once a gap
-- appears the day falls behind the counter and can never catch up, because the
-- counter drops by exactly one per row and the days by at least one. The guard
-- on the anchor is what makes a stale streak zero instead of resurrecting a run
-- from last March; yesterday still counts, so a streak does not evaporate at
-- midnight while its owner is asleep.
--
-- Internal, like the two above. A streak says which days a person was at their
-- keyboard, which is the reason 0029 keeps it off the board.
--
-- ⚠ STILL A LATERAL, AND ON PURPOSE. The obvious tidier form — number every
-- member's days in one windowed CTE and look each member up in it — computes
-- the whole population's days whatever you ask for, which is the property this
-- section exists to remove. Correlated, the only caller (`promptarena_my_stats`,
-- which filters to `auth.uid()`) pushes that equality through the GROUP BY in
-- `anchors` and does one member's work.
create view public.promptarena_member_streaks
with (security_invoker = off) as
with anchors as (
  select j.user_id, max(j.played_on) as last_played_on
  from public.promptarena_judged_attempts j
  group by j.user_id
)
select
  a.user_id,
  coalesce(st.current_streak, 0) as current_streak
from anchors a
left join lateral (
  select count(*)::int as current_streak
  from (
    select d.played_on,
           row_number() over (order by d.played_on desc) as rn
    from (select distinct j.played_on
            from public.promptarena_judged_attempts j
           where j.user_id = a.user_id) d
  ) x
  where a.last_played_on >= (now() at time zone 'Asia/Dubai')::date - 1
    -- (rn - 1) cast explicitly: row_number() is bigint and `date - bigint` has
    -- no operator, so without the cast this fails to parse rather than
    -- misbehaving quietly.
    and x.played_on = a.last_played_on - (x.rn - 1)::int
) st on true;

comment on view public.promptarena_member_streaks is
  'Consecutive-day streak per member, in Asia/Dubai. Split out of promptarena_member_stats so the leaderboard does not compute it for members it will never show it to. Internal: no client role may read it.';

revoke all on public.promptarena_member_streaks from anon, authenticated;

-- ---- What a member sees about themselves ----------------------------
--
-- Unchanged in shape and in column list — `lib/promptarena.js` selects
-- `current_streak` and `show_in_ranking` from here and neither has moved. The
-- only difference is that the streak now arrives from its own view. Scoped
-- twice over, exactly as before: the predicate restricts it to the caller, and
-- `security_invoker = off` is safe only because its source views are
-- unreadable by clients, so the predicate is the boundary and is written
-- plainly rather than inherited.
create view public.promptarena_my_stats
with (security_invoker = off) as
select
  s.user_id,
  s.rating,
  s.challenges_completed,
  s.judged_attempts,
  s.highest_score,
  s.lowest_score,
  -- A member with judged attempts always has a streak row, because both views
  -- are grouped over the same source; the coalesce is for the ordering of the
  -- day-boundary guard returning nothing, not for a missing member.
  coalesce(st.current_streak, 0) as current_streak,
  s.last_played_on,
  -- Their own opt-in state, so the page can render the toggle without a second
  -- round trip to `profiles`. Their own row, so nothing is disclosed.
  coalesce(p.show_in_promptarena_ranking, false) as show_in_ranking
from public.promptarena_member_stats s
left join public.promptarena_member_streaks st on st.user_id = s.user_id
left join public.profiles p on p.user_id = s.user_id
where s.user_id = auth.uid()
  and auth.uid() is not null;

revoke all on public.promptarena_my_stats from anon, authenticated;
grant select on public.promptarena_my_stats to authenticated;

-- ---- The leaderboard, reproduced unchanged ---------------------------
--
-- ⚠ Re-created only because dropping `promptarena_member_stats` drops it. The
-- body below is 0029:739-776 verbatim. Read the ⚠ block at 0029:694-738 before
-- touching a character of it: the `rank()` is outside the CTE that carries the
-- opt-in filter, and that order is the entire privacy property of this view.
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
-- 5. data_field_stats — thirty table scans become one
-- ============================================================
--
-- 0033:642 loops over the field catalogue and runs `select count(*) from
-- <table> where <predicate>` once per column, plus one for the total. For
-- `profiles` that is 29 catalogued columns and for `marketing_contacts` 28, so
-- opening the data panel is 30 and 29 full sequential scans of the two largest
-- people tables, every time.
--
-- Nothing about that is necessary: every one of those counts is over the same
-- rows, so they are aggregates of one scan. `count(*) filter (where <pred>)`
-- says so directly, and the predicates are built by exactly the same `format()`
-- switch on `kind` as before — this is a change to how the counts are
-- assembled, not to what they mean.
--
-- The counts come back as a jsonb object keyed by column name rather than as a
-- positional array, so the mapping back onto the catalogue cannot silently
-- shift if the ORDER BY and the loop ever disagree.
--
-- `stable`, `security definer` and the staff check on the first executable
-- line are all unchanged. So is the signature, including the names of the
-- returned columns — `app/admin/data-admin.js` reads them by name.
create or replace function public.data_field_stats(p_table text)
returns table (
  column_name text,
  label text,
  kind text,
  editable boolean,
  importable boolean,
  member_authored boolean,
  visibility_control boolean,
  note text,
  populated bigint,
  total bigint
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $fn$
declare
  v_field record;
  v_pred text;
  v_parts text[] := '{}';
  v_counts jsonb;
  v_total bigint;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  if p_table not in ('marketing_contacts', 'profiles') then
    raise exception 'unknown table %', p_table;
  end if;

  -- "Populated" is not the same test for every type. An empty string is not a
  -- filled-in name, an empty array is not a list of skills, and `'{}'::jsonb`
  -- is not a set of links. Identical to the switch in 0033 — the only change
  -- is that the predicate is accumulated instead of executed.
  for v_field in
    select f.column_name, f.kind
      from public.data_admin_fields f
     where f.table_name = p_table
     order by f.sort_order, f.column_name
  loop
    v_pred := case v_field.kind
      when 'text[]' then format('coalesce(array_length(%I, 1), 0) > 0', v_field.column_name)
      when 'jsonb'  then format('%I is not null and %I <> ''{}''::jsonb and %I <> ''[]''::jsonb',
                                v_field.column_name, v_field.column_name, v_field.column_name)
      when 'int'    then format('%I is not null', v_field.column_name)
      when 'bool'   then format('%I is not null', v_field.column_name)
      when 'date'   then format('%I is not null', v_field.column_name)
      when 'timestamp' then format('%I is not null', v_field.column_name)
      else format('nullif(trim(coalesce(%I::text, '''')), '''') is not null', v_field.column_name)
    end;

    -- %L on the key, %I inside the predicate. The identifiers are catalogue
    -- data rather than literals known when this file was written, so every one
    -- of them goes through format() — same rule as 0033, and the reason the
    -- table name is checked against a hard allowlist above.
    v_parts := v_parts || format('%L, count(*) filter (where %s)',
                                 v_field.column_name, v_pred);
  end loop;

  -- One scan. `jsonb_build_object()` with no arguments is legal and returns
  -- `{}`, so a table with an empty catalogue returns rows-with-no-rows rather
  -- than a syntax error.
  --
  -- ⚠ THE ONE CEILING THIS INTRODUCES, SAID OUT LOUD BECAUSE IT WOULD BE A
  -- BAFFLING ERROR. `jsonb_build_object` takes key and value as separate
  -- arguments, so this call has twice as many arguments as there are catalogued
  -- columns, against Postgres's hard limit of 100 (FUNC_MAX_ARGS). Today that
  -- is 58 for `profiles` and 56 for `marketing_contacts`. At 51 catalogued
  -- columns for one table this raises "cannot pass more than 100 arguments to a
  -- function", and the fix is to build the counts as a `jsonb_object_agg` over a
  -- VALUES list rather than to go back to a scan per column.
  execute format('select jsonb_build_object(%s), count(*) from public.%I',
                 array_to_string(v_parts, ', '), p_table)
    into v_counts, v_total;

  -- Read back in the same order the predicates were built in, which is also
  -- the order 0033 returned and the order the panel renders.
  return query
    select f.column_name, f.label, f.kind, f.editable, f.importable,
           f.member_authored, f.visibility_control, f.note,
           coalesce((v_counts ->> f.column_name)::bigint, 0),
           v_total
      from public.data_admin_fields f
     where f.table_name = p_table
     order by f.sort_order, f.column_name;
end;
$fn$;

revoke all on function public.data_field_stats(text) from public, anon;
grant execute on function public.data_field_stats(text) to authenticated;

-- ============================================================
-- 6. admin_import_rows — the de-duplication is quadratic
-- ============================================================
--
-- 0033:1266 declares `v_seen text[]`, 0033:1351 tests membership with
-- `v_key = any (v_seen)` and 0033:1354 grows it with `v_seen := v_seen ||
-- v_key`. Both halves are linear in the number of rows already processed, so
-- the loop is O(n²) in comparisons AND in bytes copied: a plpgsql array is
-- immutable, so each concatenation allocates and copies the whole array again.
--
-- At the function's own advertised ceiling of 5,000 rows (0033:1286) that is
-- about 12.5 million text comparisons and, at a 36-character uuid key, on the
-- order of 375MB of memcpy inside a single statement — for a duplicate check.
--
-- Replaced with a temp table carrying a primary key, so the membership test
-- and the insert are one `insert ... on conflict do nothing` and the whole
-- thing is O(n log n) in time and O(n) in memory. `on commit drop` because the
-- scratch space belongs to the call, not to the session, and PostgREST gives
-- each RPC its own transaction.
--
-- ⚠ EVERY STATEMENT AGAINST THE TEMP TABLE GOES THROUGH `execute`, AND THAT IS
-- NOT STYLE. plpgsql caches the plans of static SQL, and a cached plan holding
-- the OID of a temp table that was dropped at the last commit is the classic
-- way this pattern fails on the second call in a session. `execute` re-plans
-- every time, which is the documented remedy and costs nothing here — the loop
-- body already runs a dynamic `execute format(...)` per column per row.
--
-- ⚠ `get diagnostics`, not `if found`. `execute` does not set FOUND; it does
-- set ROW_COUNT. Getting that wrong would make every row look like a
-- duplicate, or none of them.
--
-- Everything else in this function is 0033:1239-1574 reproduced unchanged. It
-- is reproduced in full because plpgsql has no way to patch a body in place,
-- not because anything else about it was found wanting.
create or replace function public.admin_import_rows(
  p_table text,
  p_rows jsonb,
  p_dry_run boolean default true,
  p_options jsonb default '{}'::jsonb,
  p_expected_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp, auth
as $fn$
declare
  v_row jsonb;
  v_i int := 0;
  v_key text;
  v_col text;
  v_field public.data_admin_fields%rowtype;
  v_plan jsonb := '[]'::jsonb;
  v_entry jsonb;
  v_changes jsonb;
  v_conflicts jsonb;
  v_reject text;
  v_bad text;
  v_keyed_by text;
  v_id_cell text;
  v_target_id uuid;
  -- ⚠ 0034: was `v_seen text[] := '{}'` and a `v_key = any (v_seen)` test. See
  -- the note above the function for why that was quadratic in both time and
  -- memory. The keys now live in a temp table; this holds the row count of the
  -- insert, which is how the duplicate is detected.
  v_seen_ins bigint;
  v_val jsonb;
  v_old text;
  v_new text;
  v_overwrite boolean := coalesce((p_options ->> 'overwrite_member_authored')::boolean, false);
  v_skip text[] := coalesce(
    (select array(select jsonb_array_elements_text(p_options -> 'skip_keys'))), '{}');
  v_hash text;
  v_counts jsonb;
  v_applied jsonb := '[]'::jsonb;
  v_patch jsonb;
  v_res jsonb;
  v_incomplete boolean;
  v_prof public.profiles%rowtype;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  if p_table not in ('marketing_contacts', 'profiles') then
    raise exception 'unknown table %', p_table;
  end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows must be an array'; end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'that is % rows; split the file — this refuses more than 5000 at once',
      jsonb_array_length(p_rows);
  end if;

  -- ---- The de-duplication scratch space ----
  --
  -- One row per key already accepted, with a primary key doing the membership
  -- test. `on commit drop` because it belongs to the call and PostgREST gives
  -- every RPC its own transaction; `if not exists` and the truncate because two
  -- calls in ONE transaction must not see each other's keys.
  --
  -- ⚠ Through `execute`, deliberately. plpgsql caches static SQL plans, and a
  -- cached plan holding the OID of a temp table that was dropped at the last
  -- commit is how this pattern breaks on the second call in a session.
  execute 'create temp table if not exists admin_import_seen (k text primary key) on commit drop';
  execute 'truncate table pg_temp.admin_import_seen';

  -- ---- Build the plan, row by row ----
  for v_row in select jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    v_reject := null;
    v_changes := '{}'::jsonb;
    v_conflicts := '{}'::jsonb;
    v_target_id := null;
    v_keyed_by := null;

    -- ---- The key ----
    if p_table = 'marketing_contacts' then
      v_id_cell := lower(nullif(trim(coalesce(v_row ->> 'id', '')), ''));

      if v_id_cell is not null then
        -- Keyed on id: the export → correct in Excel → re-import cycle. This
        -- is the path that can change somebody's email address, which is the
        -- whole Microsoft 365 job.
        v_keyed_by := 'id';
        v_key := v_id_cell;
        if v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          v_reject := 'id is not a uuid: ' || v_key;
        else
          select mc.id into v_target_id from public.marketing_contacts mc where mc.id = v_key::uuid;
          if v_target_id is null then
            v_reject := 'no contact has that id — it did not come from an export of this database';
          end if;
        end if;
      else
        v_keyed_by := 'email';
        v_key := lower(nullif(trim(coalesce(v_row ->> 'email', '')), ''));
        if v_key is null then
          v_reject := 'no id and no email address, so there is nothing to match this row on';
        elsif v_key !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
          v_reject := 'that is not an email address: ' || v_key;
        else
          select mc.id into v_target_id from public.marketing_contacts mc
           where lower(mc.email) = v_key;
        end if;
      end if;
    else
      v_keyed_by := 'user_id';
      v_key := lower(nullif(trim(coalesce(v_row ->> 'user_id', '')), ''));
      if v_key is null then
        -- ⚠ NOT A LIMITATION TO WORK AROUND. A profile row requires an
        -- `auth.users` row, so "create a member from a spreadsheet" means
        -- creating auth accounts for people who never asked for one. 0027
        -- considered exactly that and rejected it: an auth.users row is
        -- reachable by password-reset mail, so a stranger who guesses an
        -- address can make the club email a person who never signed up.
        v_reject := 'no user_id, and members cannot be created from a file — only a real signup creates an account';
      elsif v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_reject := 'user_id is not a uuid: ' || v_key;
      else
        select p.* into v_prof from public.profiles p where p.user_id = v_key::uuid;
        if found then v_target_id := v_prof.user_id;
        else v_reject := 'no member has that user_id';
        end if;
      end if;
    end if;

    -- One statement does both halves: the insert succeeds for a key not seen
    -- before and does nothing for a repeat, and ROW_COUNT says which happened.
    --
    -- ⚠ `get diagnostics`, not `if found`: EXECUTE changes the output of GET
    -- DIAGNOSTICS but does NOT set FOUND. Reading FOUND here would make every
    -- row look like a duplicate.
    --
    -- v_key is guaranteed non-null on every path that leaves v_reject null —
    -- each branch above sets a rejection when it cannot derive a key — so the
    -- primary key's NOT NULL is a backstop rather than a live case.
    if v_reject is null then
      execute 'insert into pg_temp.admin_import_seen (k) values ($1) on conflict (k) do nothing'
        using v_key;
      get diagnostics v_seen_ins = row_count;
      if v_seen_ins = 0 then
        v_reject := 'this row repeats a key already in the file; only the first one is applied';
      end if;
    end if;

    -- ---- Compare each supplied cell with what is there ----
    if v_reject is null then
      for v_col in select jsonb_object_keys(v_row) loop
        -- The key column never imports as data. `email` is a real, importable
        -- field when the row is keyed on `id`, and only then.
        if v_col = 'id' or v_col = 'user_id' then continue; end if;
        if v_col = 'email' and v_keyed_by <> 'id' then continue; end if;

        select * into v_field from public.data_admin_fields
         where table_name = p_table and column_name = v_col;

        if not found then
          -- An unrecognised column is skipped, not fatal: exports carry
          -- read-only columns (engagement counts, timestamps) and a file that
          -- came out of this system must be able to go back into it.
          continue;
        end if;
        if not v_field.importable then continue; end if;

        -- CONTINUE cannot be used to leave a block that has an exception
        -- handler, so the failure is carried out in a variable instead.
        v_bad := null;
        begin
          v_val := public.admin_coerce_value(v_field.kind, v_row ->> v_col);
        exception when others then
          v_bad := sqlerrm;
        end;
        if v_bad is not null then
          v_reject := coalesce(v_reject, '') || v_col || ': ' || v_bad || '. ';
          continue;
        end if;

        -- A blank cell means "leave this alone", never "erase it". An export
        -- that omits a column, or a row where somebody cleared a cell by
        -- accident, must not wipe a phone number.
        if v_val is null then continue; end if;

        if v_target_id is null then
          v_changes := v_changes || jsonb_build_object(v_col, jsonb_build_object('from', null, 'to', v_val));
          continue;
        end if;

        execute format('select %I::text from public.%I where %I = %L',
                       v_col, p_table,
                       case when p_table = 'profiles' then 'user_id' else 'id' end,
                       v_target_id)
          into v_old;

        v_new := case v_field.kind
          when 'text[]' then (select array(select jsonb_array_elements_text(v_val)))::text
          when 'jsonb'  then v_val::text
          else v_val #>> '{}'
        end;

        if v_old is not distinct from v_new then continue; end if;

        -- ⚠ THE RULE THAT KEEPS A SPREADSHEET FROM SPEAKING FOR A MEMBER.
        -- A member-authored field that ALREADY HAS SOMETHING IN IT is never
        -- overwritten silently. Filling a blank one is fine — that is exactly
        -- what `claim_prospect_for` (0027) does with its coalesce, and for the
        -- same reason: adding what somebody has not said is help, replacing
        -- what they have said is not.
        if v_field.member_authored and nullif(trim(coalesce(v_old, '')), '') is not null
           and v_old not in ('{}', '[]') then
          v_conflicts := v_conflicts || jsonb_build_object(v_col,
            jsonb_build_object('theirs', public.audit_clip(to_jsonb(v_old)),
                               'yours',  public.audit_clip(to_jsonb(v_new))));
          if v_overwrite then
            v_changes := v_changes || jsonb_build_object(v_col,
              jsonb_build_object('from', to_jsonb(v_old), 'to', v_val));
          end if;
          continue;
        end if;

        -- Consent, again. An import may record an unsubscribe; it may never
        -- undo one.
        if v_col in ('unsubscribed_at', 'bounced_at') then
          continue;  -- not importable at all; here as a second guard
        end if;

        v_changes := v_changes || jsonb_build_object(v_col,
          jsonb_build_object('from', public.audit_clip(to_jsonb(v_old)), 'to', v_val));
      end loop;
    end if;

    -- ---- The two checks that would otherwise only surface at commit ----
    --
    -- A dry run that says "update" and a commit that says "unique violation"
    -- is a dry run that did not do its job, and both of these are the likely
    -- failures rather than exotic ones. The address collision is what happens
    -- when the person already exists twice; the Connect gate is what happens
    -- when somebody ticks the visibility column down a whole spreadsheet.
    if v_reject is null and v_changes ? 'email' then
      if exists (
        select 1 from public.marketing_contacts mc
         where lower(mc.email) = lower(v_changes -> 'email' -> 'to' #>> '{}')
           and mc.id is distinct from v_target_id
      ) then
        v_reject := 'another contact record already uses that address — merge the two by hand first';
      end if;
    end if;

    if v_reject is null and p_table = 'profiles' and v_changes ? 'is_discoverable'
       and (v_changes -> 'is_discoverable' -> 'to')::text = 'true' then
      select not public.profile_is_complete(p) into v_incomplete
        from public.profiles p where p.user_id = v_target_id;
      if v_incomplete then
        v_reject := 'cannot be made visible in Connect: the profile needs a name, a picture, a bio or headline, and an interest';
      end if;
    end if;

    v_entry := jsonb_build_object(
      -- ⚠ `row`, not `line`, and the distinction is not pedantry. This counts
      -- DATA ROWS from 1, because that is what the operator is looking at in
      -- Excel once the header is frozen. The parser's `ragged` report counts
      -- FILE LINES, which is what you need to find an unterminated quote. They
      -- differ by the header, and by more than that once a quoted field
      -- contains a newline — so they are named differently rather than being
      -- one number that is wrong half the time.
      'row', v_i,
      'key', v_key,
      'keyed_by', v_keyed_by,
      'action', case
        when v_reject is not null then 'rejected'
        when v_key = any (v_skip) then 'skipped'
        when v_target_id is null then 'insert'
        when v_changes = '{}'::jsonb and v_conflicts = '{}'::jsonb then 'unchanged'
        when v_changes = '{}'::jsonb then 'conflict'
        else 'update'
      end,
      'changes', v_changes,
      'conflicts', v_conflicts,
      'reason', v_reject
    );
    v_plan := v_plan || jsonb_build_array(v_entry);
  end loop;

  -- The hash the confirm has to match. Over the plan, not over the file, so a
  -- row somebody else edited while the preview was on screen changes it too.
  v_hash := md5(v_plan::text || coalesce(p_options::text, '') || p_table);

  v_counts := (
    select jsonb_object_agg(action, n) from (
      select e ->> 'action' as action, count(*) as n
        from jsonb_array_elements(v_plan) e group by 1
    ) s
  );

  if p_dry_run then
    return jsonb_build_object(
      'dry_run', true, 'table', p_table, 'plan_hash', v_hash,
      'counts', coalesce(v_counts, '{}'::jsonb), 'plan', v_plan
    );
  end if;

  -- ---- Commit ----
  if p_expected_hash is null or p_expected_hash <> v_hash then
    raise exception
      'this is not the change you were shown — re-run the preview. (Either the file, the options, or one of the rows changed underneath it.)';
  end if;

  for v_entry in select jsonb_array_elements(v_plan) loop
    if v_entry ->> 'action' not in ('insert', 'update') then continue; end if;

    v_patch := (
      select jsonb_object_agg(k, case when jsonb_typeof(v -> 'to') = 'string'
                                      then v -> 'to' #>> '{}'
                                      when jsonb_typeof(v -> 'to') = 'array'
                                      then array_to_string(
                                             array(select jsonb_array_elements_text(v -> 'to')), ';')
                                      else (v -> 'to')::text end)
        from jsonb_each(v_entry -> 'changes') as e(k, v)
    );

    begin
      if p_table = 'marketing_contacts' then
        if v_entry ->> 'action' = 'insert' then
          v_res := public.admin_create_contact(
            coalesce(v_patch, '{}'::jsonb) || jsonb_build_object('email', v_entry ->> 'key'), 'import');
        else
          if v_entry ->> 'keyed_by' = 'id' then
            v_target_id := (v_entry ->> 'key')::uuid;
          else
            select mc.id into v_target_id from public.marketing_contacts mc
             where lower(mc.email) = (v_entry ->> 'key');
          end if;
          -- ⚠ This is the call that runs the retroactive Microsoft 365 link
          -- for every corrected address in the file, one row at a time,
          -- because `admin_update_contact` does it whenever `email` changes.
          -- A bulk `update ... set email` would not, and that is exactly the
          -- silent failure this whole feature exists to avoid.
          v_res := public.admin_update_contact(v_target_id, coalesce(v_patch, '{}'::jsonb), 'import');
        end if;
      else
        v_res := public.admin_update_profile((v_entry ->> 'key')::uuid,
                                             coalesce(v_patch, '{}'::jsonb), 'import');
      end if;
      v_applied := v_applied || jsonb_build_array(
        jsonb_build_object('row', v_entry -> 'row', 'key', v_entry -> 'key',
                           'action', v_entry -> 'action', 'ok', true));
    exception when others then
      -- One bad row must not take the other 2,199 with it. The per-row
      -- exception block is an implicit savepoint, so the failed row is rolled
      -- back and the rest continue.
      v_applied := v_applied || jsonb_build_array(
        jsonb_build_object('row', v_entry -> 'row', 'key', v_entry -> 'key',
                           'action', v_entry -> 'action', 'ok', false, 'error', sqlerrm));
    end;
  end loop;

  return jsonb_build_object(
    'dry_run', false, 'table', p_table, 'plan_hash', v_hash,
    'counts', coalesce(v_counts, '{}'::jsonb),
    'applied', v_applied,
    'failed', (select count(*) from jsonb_array_elements(v_applied) a
                where (a ->> 'ok')::boolean is not true)
  );
end;
$fn$;

revoke all on function public.admin_import_rows(text, jsonb, boolean, jsonb, text) from public, anon, authenticated;
grant execute on function public.admin_import_rows(text, jsonb, boolean, jsonb, text) to authenticated;

-- ============================================================
-- 7. avatars_due_refresh — stop redrawing people who left
-- ============================================================
--
-- 0018:115-122 selects every discoverable profile whose `avatar_cycle` is not
-- the current month. There is no activity condition of any kind, so a member
-- who completed a profile once, never came back, and never will is re-drawn
-- every month for the lifetime of the platform.
--
-- The arithmetic, which is why this is in a migration rather than a backlog
-- item: at roughly $0.179 an image that is about $2.15 per member per year,
-- charged unconditionally. At 10,000 members it is on the order of $21,500 a
-- year, and it is the largest projected cost line on the platform. An activity
-- filter removes most of it and no human being sees any difference, because
-- the people it excludes are by construction the ones not looking.
--
-- ⚠ PREVENTIVE, NOT A FIX FOR SOMETHING BURNING. No cron entry exists yet —
-- `refresh-avatars` documents the `cron.schedule` call in its header and
-- nobody has run it. This is here so the schedule can be installed without the
-- bill arriving with it.
--
-- WHICH SIGNALS, AND WHY THESE. Chosen from what the schema actually has;
-- there is no `last_active_at` on `profiles` and inventing one would need a
-- write on every page view.
--
--   * `auth.users.last_sign_in_at` within 6 months — the truest "still here",
--     maintained by GoTrue on every sign-in with no work on our side. Reading
--     `auth.users` is fine from this view for the same reason 0033's audit
--     trigger reads it: the view is `security_invoker = off` and runs as its
--     owner. LEFT JOIN, so a profile whose auth row is somehow missing is
--     judged on the other signals rather than silently dropped.
--     ⚠ This is the one line in this file that could fail to CREATE rather
--     than fail to work, and it would fail loudly: if whoever applies this
--     migration cannot read `auth.users`, the create raises a permission
--     error here. Apply as the owner. It is not a reason to drop the signal —
--     it is the only one of the three that measures presence rather than
--     participation.
--   * a registration in the last 12 months — someone who signs up for events
--     is present whether or not the session cookie survived.
--   * a PromptArena submission in the last 12 months — same argument, and it
--     is the other thing members actually come back for.
--   * `avatar_cycle is null` — never drawn at all. This keeps the batch job as
--     a safety net for a member `generate-avatar` never got to. A dormant
--     member matching only this clause is drawn ONCE and then stops matching,
--     which is the intended outcome rather than a leak in the filter.
--
-- Twelve months against six is deliberate: a sign-in is cheap evidence and a
-- stale one says little, whereas registering for an event or submitting a
-- prompt is a deliberate act and stays meaningful for longer.
--
-- The column list is unchanged — `refresh-avatars` selects `user_id,
-- full_name, interests, skills, industry` and orders on `avatar_refreshed_at`,
-- and both of those still have to be here.
create or replace view public.avatars_due_refresh
with (security_invoker = off) as
select p.user_id, p.full_name, p.interests, p.skills, p.industry,
       p.avatar_cycle, p.avatar_refreshed_at
from public.profiles p
left join auth.users u on u.id = p.user_id
where p.is_discoverable
  and coalesce(p.avatar_cycle, '') is distinct from to_char(now(), 'YYYY-MM')
  and (
    p.avatar_cycle is null
    or u.last_sign_in_at >= now() - interval '6 months'
    or exists (
      select 1 from public.event_registrations r
      where r.user_id = p.user_id
        and r.created_at >= now() - interval '12 months'
    )
    or exists (
      select 1 from public.promptarena_submissions s
      where s.user_id = p.user_id
        and s.submitted_at >= now() - interval '12 months'
    )
  )
order by p.avatar_refreshed_at nulls first;

comment on view public.avatars_due_refresh is
  'Who the monthly avatar job should redraw: discoverable members whose avatar '
  'is not from the current cycle AND who have shown up in the last 6-12 months, '
  'plus anyone who has never had one drawn at all. The activity clause is a cost '
  'control — without it a member who signed up once is redrawn every month for ever.';

revoke all on public.avatars_due_refresh from anon, authenticated;

-- ============================================================
-- 8. Two token ceilings below the code defaults — WITHDRAWN
-- ============================================================
--
-- ⚠ NOTHING IN THIS FILE TOUCHES `recommended_max_output_tokens`, AND THAT IS
-- A DECISION RATHER THAN AN OMISSION.
--
-- The audit was right about the symptom: 0031:274 and 0031:290 ship 1200 and
-- 2000 for `write-member-intro` and `write-contact-email`, below the
-- MAX_OUTPUT_TOKENS constants of 4000 and 7000 that those functions were
-- raised to, and a stored ceiling beats a code default in `loadAiConfig` — so
-- a staff member pressing Save on the panel's own proposed value would
-- reintroduce the truncate-and-retry loop.
--
-- It was wrong about the fix being missing. `0032_fix_ai_ceiling_recommendations.sql`
-- already does it, with its own derivation and its own verification block, and
-- it also handles a case this file would not have: somebody typing the old
-- value in by hand, which is not caught by a threshold test. 0032 is written
-- and committed but has never been merged into main, which is why reading main
-- makes 0031 look unfixed.
--
-- Two migrations updating the same two rows is a conflict and a race over
-- which `ceiling_note` survives, so this one stands down. Merge 0032.
--
-- ⚠ THE GENERAL LESSON, WHICH IS THE MORE USEFUL HALF. Several branches in
-- this repository were never merged, so "main does not contain a fix" is not
-- the same statement as "the fix was never written". Before writing a
-- migration to repair something, run
--   git log --all --oneline -- <path>
-- and look for the repair sitting on a branch. Checked for the other nine
-- items here: no other migration file exists on any ref beyond 0033 except
-- 0032, so nothing else in this file is a duplicate. (Note in passing that
-- there is no 0030 on any ref either — the number is simply skipped.)

-- ============================================================
-- 9. prospect_profiles — a way out, and a record of who put them there
-- ============================================================
--
-- 62 named real people currently have a published, AI-written biography on
-- this platform. None of them has an account — 0027 refuses to create one, and
-- that refusal is right.
--
-- What follows from it, and what nobody wrote down: `prospect_profiles` has
-- RLS enabled and ZERO policies (0027:128-129), and 0033:78-85 puts the table
-- out of scope for the staff data panel. Both decisions are defensible on
-- their own and together they leave the table with no interactive route in at
-- all. So:
--
--   * there is no way for staff to unpublish one profile without a SQL
--     session and the service key;
--   * there is no way at all for the person to object, other than creating the
--     account 0027 exists to avoid making them create;
--   * nothing records who published these, or when. `built_at` and
--     `built_model` say when a model wrote the text, not who decided to show
--     it.
--
-- This section adds the three missing pieces. It does NOT open the table to
-- clients: the grants stay revoked and no policy is added. The route in is two
-- `security definer` functions in the exact shape of the `admin_*` functions in
-- 0022 and 0033 — staff-gated on the first executable line, because a
-- `security definer` function bypasses the RLS that would otherwise stop it.
--
-- ⚠ WHAT THIS CANNOT DO. The publisher of the 62 existing rows is not
-- recoverable; nothing recorded it. The audit trigger below starts the record
-- from the moment it is applied and says nothing about what came before, and
-- pretending otherwise by backfilling a guess would be worse than the gap.

alter table public.prospect_profiles
  add column if not exists unpublished_at timestamptz,
  add column if not exists unpublished_by uuid references auth.users (id) on delete set null,
  add column if not exists unpublish_reason text,
  -- ⚠ The person's own position, recorded separately from the staff action
  -- that follows it. "Staff unpublished this" and "the person asked us to"
  -- are different facts and the second must survive the first being reversed.
  add column if not exists objected_at timestamptz,
  add column if not exists objection_note text;

comment on column public.prospect_profiles.objected_at is
  'Set when the person the row is about asks not to be published. Final: the trigger below forces is_published to false for as long as this is set, so a later rebuild cannot put them back.';
comment on column public.prospect_profiles.unpublished_at is
  'When the row was last taken down, by whom, and why. Distinct from objected_at: staff may unpublish a row for their own reasons without anybody having objected.';

-- An objection outlives whatever writes the table next. Without this, the
-- next `build-prospect-profile` run sets `is_published = true` again and the
-- person has to ask twice.
--
-- It forces the value rather than raising, and that is the less obvious
-- choice, so: this table is written in batches by a service-role importer, and
-- an exception here would abort the whole batch on account of one row that the
-- importer had no way to know about. Failing towards "not published" is the
-- safe direction — the failure mode of forcing is that somebody's profile
-- stays down, which is what they asked for. The NOTICE is so the run's log
-- says it happened.
create or replace function public.prospect_objection_is_final()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if new.objected_at is not null and new.is_published then
    raise notice 'prospect_profiles %: is_published forced to false — this person objected on %',
      new.id, new.objected_at;
    new.is_published := false;
  end if;
  return new;
end;
$fn$;

drop trigger if exists prospect_profiles_objection_is_final on public.prospect_profiles;
create trigger prospect_profiles_objection_is_final
  before insert or update on public.prospect_profiles
  for each row execute function public.prospect_objection_is_final();

-- ---- Take one down ----------------------------------------------------
create or replace function public.admin_unpublish_prospect(
  p_prospect_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp, auth
as $fn$
declare
  v_row public.prospect_profiles%rowtype;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;

  select * into v_row from public.prospect_profiles where id = p_prospect_id;
  if not found then raise exception 'no such prospect profile'; end if;

  -- So the audit row below can tell a panel action from a service-role write,
  -- the same way 0033's write functions do.
  perform set_config('sc.audit_source', 'admin_panel', true);

  update public.prospect_profiles
     set is_published = false,
         unpublished_at = now(),
         unpublished_by = auth.uid(),
         unpublish_reason = p_reason,
         updated_at = now()
   where id = p_prospect_id;

  return jsonb_build_object(
    'outcome', case when v_row.is_published then 'unpublished' else 'already_unpublished' end,
    'id', p_prospect_id
  );
end;
$fn$;

-- ---- Record that the person objected ---------------------------------
--
-- Staff-callable rather than self-service, and that is forced by the design
-- rather than chosen: the subject has no account and must not be given one, so
-- an objection arrives by email or in person and somebody records it. What the
-- function guarantees is that recording it is enough — the row comes down in
-- the same statement and the trigger above keeps it down.
create or replace function public.admin_record_prospect_objection(
  p_prospect_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp, auth
as $fn$
declare
  v_row public.prospect_profiles%rowtype;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;

  select * into v_row from public.prospect_profiles where id = p_prospect_id;
  if not found then raise exception 'no such prospect profile'; end if;

  perform set_config('sc.audit_source', 'admin_panel', true);

  update public.prospect_profiles
     set objected_at = coalesce(objected_at, now()),   -- the FIRST objection is the date that matters
         objection_note = coalesce(p_note, objection_note),
         is_published = false,
         unpublished_at = coalesce(unpublished_at, now()),
         unpublished_by = coalesce(unpublished_by, auth.uid()),
         unpublish_reason = coalesce(unpublish_reason, 'the person objected'),
         updated_at = now()
   where id = p_prospect_id;

  return jsonb_build_object(
    'outcome', case when v_row.objected_at is null then 'objection_recorded'
                    else 'already_objected' end,
    'id', p_prospect_id,
    'objected_at', coalesce(v_row.objected_at, now())
  );
end;
$fn$;

revoke all on function public.admin_unpublish_prospect(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_record_prospect_objection(uuid, text) from public, anon, authenticated;
revoke all on function public.prospect_objection_is_final() from public, anon, authenticated;

grant execute on function public.admin_unpublish_prospect(uuid, text) to authenticated;
grant execute on function public.admin_record_prospect_objection(uuid, text) to authenticated;

-- ---- And a record of what happens to this table from now on ----------
--
-- `audit_people_row` (0033:225) was written for exactly this: which column is
-- the key, which is the label and which are machine churn all arrive as
-- trigger arguments "so that adding a third table later is a `create trigger`
-- and nothing else". This is that third table, and it is the one where the
-- question "who decided to publish a biography of this named person" currently
-- has no answer at all.
--
-- Noise list is just `updated_at`. `built_at` and `built_model` change when a
-- profile is rebuilt, and that IS a decision worth a row — it is the moment
-- new text was put in front of a real person's name.
--
-- ⚠ This writes clipped copies of bios and email addresses into
-- `data_admin_audit`, which is staff-readable. That is the same trade 0033
-- already makes for `marketing_contacts`, whose audit rows carry personal
-- addresses and phone numbers, and it is the price of being able to answer
-- "what was published about me, and when".
drop trigger if exists prospect_profiles_audit on public.prospect_profiles;
create trigger prospect_profiles_audit
  after insert or update or delete on public.prospect_profiles
  for each row execute function public.audit_people_row(
    'id',
    'full_name',
    'updated_at'
  );

-- ============================================================
-- 10. (select public.is_staff()) — six policies
-- ============================================================
--
-- `is_staff()` is `security definer`, so Postgres will not inline it. In a
-- policy whose expression also contains a Var — `auth.uid() = user_id or
-- public.is_staff()` — the whole qual is row-dependent, so the function is
-- called once per row scanned. Wrapping it as `(select public.is_staff())`
-- makes it an uncorrelated subquery, which the planner runs once as an
-- InitPlan and then treats as a constant.
--
-- ⚠ HARMLESS TODAY, AND THAT IS THE ARGUMENT FOR DOING IT NOW RATHER THAN THE
-- ARGUMENT AGAINST. Every client query against these tables passes an explicit
-- user predicate, so the index does the work and few rows are scanned. The
-- trap is the first query that relies on RLS alone to scope its rows — a staff
-- report, an export, a `select * from event_registrations` — which would call
-- a security definer function once per row of the whole table and look like a
-- slow table rather than like a policy.
--
-- Policies cannot be altered in place, so each is dropped and recreated with
-- its original name and its original meaning. Nothing about who may see what
-- changes on any of these lines.

-- 0003:134
drop policy if exists "registrations: read own or staff" on public.event_registrations;
create policy "registrations: read own or staff" on public.event_registrations
  for select using (auth.uid() = user_id or (select public.is_staff()));

-- 0005:80
drop policy if exists "favourites: read own" on public.event_favourites;
create policy "favourites: read own" on public.event_favourites
  for select using (auth.uid() = user_id or (select public.is_staff()));

-- 0005:106
drop policy if exists "views: read own" on public.event_views;
create policy "views: read own" on public.event_views
  for select using (auth.uid() = user_id or (select public.is_staff()));

-- 0009:104
drop policy if exists "user licenses: read own or staff" on public.ms365_user_licenses;
create policy "user licenses: read own or staff" on public.ms365_user_licenses
  for select using (auth.uid() = user_id or (select public.is_staff()));

-- 0029:322 and 0029:340. ⚠ Both of these look like they have no Var and
-- therefore need nothing — a bare `public.is_staff()` is a qual with no Var,
-- which the planner evaluates once as a one-time filter. That reasoning is
-- wrong for the submissions pair and it is worth writing down why: multiple
-- PERMISSIVE policies for the same command are OR-ed together, so the combined
-- qual on `promptarena_submissions` is `auth.uid() = user_id or is_staff()`,
-- which DOES contain a Var, and the staff half is evaluated per row.
--
-- The challenges policy is a genuinely standalone qual and gains nothing
-- measurable. It is included so the two policies on the same feature do not
-- diverge in style, and 0029:307-320 already warns at length that this policy
-- is inert today — no grant backs it — which the rewrite does not change.
drop policy if exists "promptarena challenges: staff write" on public.promptarena_challenges;
create policy "promptarena challenges: staff write" on public.promptarena_challenges
  for all using ((select public.is_staff())) with check ((select public.is_staff()));

drop policy if exists "promptarena submissions: staff read" on public.promptarena_submissions;
create policy "promptarena submissions: staff read" on public.promptarena_submissions
  for select using ((select public.is_staff()));

-- Deliberately left alone, and named so the next reader knows it was a
-- decision: 0009:108, 0009:112-113 (the INSERT and UPDATE policies on
-- `ms365_user_licenses`), 0010's four `for all using (public.is_staff())`
-- policies, and the several standalone staff policies in 0003 and 0033. The
-- write policies are evaluated against the rows a single-row write actually
-- touches, and the standalone ones are one-time filters unless another
-- permissive policy for the same command puts a Var beside them. Changing them
-- would be churn in files four other people are working in.

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- ⚠ Nothing below has been run. This file has never touched a database. Every
-- "expect" is a prediction from reading the schema, and the point of the block
-- is to check the prediction, not to record a result.
--
-- ---- 1. member_activity, which is the one that matters ----
--
-- The cheap structural check first — the rule is in the view at all:
--   select pg_get_viewdef('public.member_activity'::regclass) ilike '%show_in_attendees%';
--   -- expect true. Before this migration it is FALSE, which is the bug.
--
-- The real proof needs two sessions, because the leak is a leak between
-- members. As the service role, find a subject and a reader:
--   select user_id from public.profiles
--    where not show_in_attendees
--      and exists (select 1 from public.event_registrations r where r.user_id = profiles.user_id)
--    limit 1;                                  -- the subject: opted out, has history
--   select count(*) from public.member_activity;  -- as owner: the full population
--
-- Then, signed in as ANY OTHER member (a real JWT, not `set role`, because
-- auth.uid() comes from the request claims):
--   select * from public.member_activity where user_id = '<the subject>';
--   -- expect ZERO rows. Before this migration it returns their whole history.
--
--   select count(*) from public.member_activity;
--   -- expect: the opted-in population, plus the caller's own row if they have
--   -- history. Compare with, as the service role:
--   --   select count(*) from (
--   --     select r.user_id from public.event_registrations r
--   --     join public.events e on e.id = r.event_id
--   --     join public.profiles p on p.user_id = r.user_id
--   --     where e.is_published and p.show_in_attendees
--   --     group by r.user_id) s;
--
-- And the caller still sees themselves, which is the regression this could
-- have introduced. As a member with `show_in_attendees = false` and at least
-- one registration for a published event:
--   select events_attended, top_topics from public.member_activity
--    where user_id = auth.uid();               -- expect their own row, not zero rows
--
-- Nobody signed out reaches it at all (expect ZERO rows):
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'member_activity' and grantee = 'anon';
--
-- ---- 2. The marketing grants, which fail silently when they fail ----
--
-- Expect EXACTLY three rows, all `authenticated`, all SELECT. Any INSERT,
-- UPDATE, DELETE or TRUNCATE in this result means the revoke did not take:
--   select table_name, grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_name in ('marketing_contacts','contact_engagements','contact_imports')
--      and grantee in ('anon','authenticated')
--    order by 1, 2, 3;
--
-- The behavioural half, signed in as a STAFF member. The first must fail with
-- `permission denied for table marketing_contacts`; the second must succeed:
--   update public.marketing_contacts set notes = 'x' where id = '<some id>';
--   select public.admin_update_contact('<some id>', jsonb_build_object('notes','x'));
--
-- And the guarantee that motivated it. As staff, on a contact who HAS
-- unsubscribed, this must raise 'an unsubscribe or a bounce cannot be cleared
-- from here' rather than succeeding:
--   select public.admin_update_contact('<id>', jsonb_build_object('unsubscribed_at', null));
--
-- Staff can still read what the pages read (expect rows, not an error):
--   select count(*) from public.marketing_contacts;
--   select count(*) from public.contact_engagements;
--
-- ---- 3. The indexes exist and are chosen ----
--
-- Expect two rows:
--   select indexname, indexdef from pg_indexes
--    where indexname in ('hackathon_participants_ms365_mailbox_idx',
--                        'promptarena_challenges_deck_idx');
--
-- Chosen, not merely present. On a small table Postgres will prefer a seq scan
-- and that is correct — force the question:
--   set enable_seqscan = off;
--   explain (analyze, buffers)
--     select * from public.hackathon_participants
--      where lower(ms365_mailbox) = lower('someone@example.com');
--   -- expect an Index Scan on hackathon_participants_ms365_mailbox_idx
--   explain (analyze, buffers)
--     select id from public.promptarena_challenges
--      where is_active order by created_at desc limit 200;
--   -- expect an Index Scan on promptarena_challenges_deck_idx, no Sort node
--   reset enable_seqscan;
--
-- The end-to-end one, which is the number that was actually wrong:
--   explain (analyze, buffers) select * from public.prospect_directory;
--   -- expect no sequential scan of hackathon_participants once per prospect
--
-- ---- 4. The streak is off the board's path ----
--
--   select pg_get_viewdef('public.promptarena_member_stats'::regclass) ilike '%streak%';
--   -- expect FALSE
--   select pg_get_viewdef('public.promptarena_my_stats'::regclass) ilike '%streak%';
--   -- expect TRUE
--
-- Nothing internal is readable by a client (expect ZERO rows):
--   select table_name, grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_name in ('promptarena_member_stats','promptarena_member_streaks',
--                         'promptarena_judged_attempts')
--      and grantee in ('anon','authenticated');
--
-- The leaderboard is unchanged in shape and still excludes the streak:
--   select column_name from information_schema.columns
--    where table_name = 'promptarena_leaderboard' order by ordinal_position;
--   -- expect exactly: rank, user_id, full_name, avatar_url, profile_user_id,
--   --                 rating, challenges_completed, highest_score
--
-- One definition of a rating, still (0029's check, and it must still pass):
--   select count(*) from public.promptarena_leaderboard l
--     join public.promptarena_member_stats s on s.user_id = l.user_id
--    where l.rating is distinct from s.rating;   -- expect 0
--
-- The member's own streak is unchanged by the move. Before applying, record
-- `select user_id, current_streak from public.promptarena_my_stats` for a
-- member with a live streak; after applying, it must be the same number.
--
-- And the plan no longer contains the per-member subplan:
--   explain (analyze, buffers) select * from public.promptarena_leaderboard;
--   -- expect NO SubPlan / nested loop over promptarena_submissions per member
--
-- ---- 5. data_field_stats: same answers, one scan ----
--
-- Behaviour-preserving is a claim about output, so compare output. Before
-- applying:
--   create temp table field_stats_before as select * from public.data_field_stats('profiles');
-- After applying (expect ZERO rows both ways):
--   select * from public.data_field_stats('profiles')
--   except select * from field_stats_before;
--   select * from field_stats_before
--   except select * from public.data_field_stats('profiles');
--
-- And the scan count, which is the point:
--   explain (analyze, buffers) select * from public.data_field_stats('profiles');
--   -- expect ONE scan of profiles in the nested plan, not one per column.
--   -- If EXPLAIN will not descend into the function, time it instead — it
--   -- should drop by roughly the number of catalogued columns.
--
-- Still staff-gated. As an ordinary member, expect 'not allowed':
--   select public.data_field_stats('profiles');
-- And the allowlist still holds, expect 'unknown table':
--   select public.data_field_stats('auth.users');
--
-- ---- 6. The importer still rejects duplicates, in O(n) ----
--
-- Correctness first. A three-row file with a repeated key — expect the second
-- occurrence 'rejected' with "this row repeats a key already in the file":
--   select jsonb_pretty(public.admin_import_rows('profiles', jsonb_build_array(
--     jsonb_build_object('user_id','<a real member uuid>','city','Dubai'),
--     jsonb_build_object('user_id','<the SAME uuid>','city','Cairo'),
--     jsonb_build_object('user_id','<another member uuid>','city','Doha')
--   ), true));
--
-- Called twice in one transaction, which is what the `execute` wrapping is
-- for. Both calls must succeed and the second must reject its own duplicate,
-- not inherit the first call's keys:
--   begin;
--     select public.admin_import_rows('profiles', '[]'::jsonb, true);
--     select public.admin_import_rows('profiles', '[]'::jsonb, true);
--   commit;
--
-- The temp table must not survive the call:
--   select count(*) from pg_tables where tablename = 'admin_import_seen';  -- expect 0
--
-- And the shape of the cost. Generate 5,000 rows of distinct fake uuids and
-- dry-run them; expect seconds, not minutes, and no memory spike:
--   explain (analyze) select public.admin_import_rows('profiles', (
--     select jsonb_agg(jsonb_build_object('user_id', gen_random_uuid()::text, 'city', 'X'))
--       from generate_series(1, 5000)), true);
--   -- every row will be 'rejected' as "no member has that user_id", which is
--   -- fine: the dedup runs before that check and is what is being measured.
--
-- ---- 7. The avatar job stops redrawing the dormant ----
--
-- Run BOTH before and after applying, as the service role, and write the two
-- numbers down:
--   select count(*) from public.avatars_due_refresh;
--
-- Who is now excluded, and a sanity check that they really are dormant:
--   select count(*) from public.profiles p
--    where p.is_discoverable
--      and coalesce(p.avatar_cycle,'') is distinct from to_char(now(),'YYYY-MM')
--      and p.user_id not in (select user_id from public.avatars_due_refresh);
--   -- then spot-check a handful:
--   select p.user_id, u.last_sign_in_at from public.profiles p
--     join auth.users u on u.id = p.user_id
--    where p.user_id not in (select user_id from public.avatars_due_refresh)
--    order by u.last_sign_in_at desc nulls last limit 10;
--   -- expect the most recent sign-in in that list to be over 6 months ago
--
-- Nobody who has never had an avatar drawn is excluded (expect 0):
--   select count(*) from public.profiles p
--    where p.is_discoverable and p.avatar_cycle is null
--      and p.user_id not in (select user_id from public.avatars_due_refresh);
--
-- The column list the Edge Function selects is intact (expect 7 rows):
--   select column_name from information_schema.columns
--    where table_name = 'avatars_due_refresh';
--
-- ---- 8. Nothing to verify here; 0032 owns it ----
--
-- This file writes nothing to `ai_services`. The check below is not a test of
-- 0034 — it is the reminder that the fix lives on an unmerged branch, and it
-- is the query that tells you whether that merge has happened yet:
--   select slug, recommended_max_output_tokens from public.ai_services
--    where slug in ('write-member-intro','write-contact-email');
--   -- 1200 / 2000 means 0032 has still not been applied. It should read
--   -- 4000 / 7000, matching MAX_OUTPUT_TOKENS in the two Edge Functions.
--
-- ---- 9. Prospect profiles: a route out, and a record ----
--
-- The table is still closed to clients (expect ZERO rows):
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'prospect_profiles' and grantee in ('anon','authenticated');
--   select count(*) from pg_policies where tablename = 'prospect_profiles';  -- expect 0
--
-- The gate. As an ordinary member, BOTH must raise 'not allowed':
--   select public.admin_unpublish_prospect('<a prospect id>');
--   select public.admin_record_prospect_objection('<a prospect id>', 'asked by email');
--
-- As staff, on a test row — never on one of the 62 real people unless that is
-- the actual job:
--   select public.admin_unpublish_prospect('<test id>', 'testing 0034');
--   select is_published, unpublished_at, unpublished_by, unpublish_reason
--     from public.prospect_profiles where id = '<test id>';
--   -- expect false, a timestamp, the staff user's id, and the reason
--
-- The objection is final. Record one, then try to put the row back — as the
-- service role, which is what the importer is:
--   select public.admin_record_prospect_objection('<test id>', 'asked by email');
--   update public.prospect_profiles set is_published = true where id = '<test id>';
--   select is_published, objected_at from public.prospect_profiles where id = '<test id>';
--   -- expect is_published STILL false, and a NOTICE in the log
--
-- The audit trigger fires (expect rows naming the columns you changed):
--   select occurred_at, actor_email, source, operation, changes
--     from public.data_admin_audit
--    where table_name = 'prospect_profiles'
--    order by occurred_at desc limit 5;
--
-- ---- 10. The policies are InitPlans now ----
--
-- Expect `(SELECT is_staff() AS is_staff)` in every one of the six quals:
--   select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) as using_expr
--     from pg_policy p join pg_class c on c.oid = p.polrelid
--    where p.polname in ('registrations: read own or staff',
--                        'favourites: read own',
--                        'views: read own',
--                        'user licenses: read own or staff',
--                        'promptarena challenges: staff write',
--                        'promptarena submissions: staff read')
--    order by 1, 2;
--
-- And that the meaning did not change, which matters more than the plan. As an
-- ordinary member with at least one registration and one favourite:
--   select count(*) from public.event_registrations;  -- expect only their own
--   select count(*) from public.event_favourites;     -- expect only their own
-- As staff, both must return the whole table.
--
-- The plan, on a query that relies on RLS alone to scope rows:
--   explain (analyze) select count(*) from public.event_registrations;
--   -- expect an InitPlan evaluating is_staff() once, not a per-row Filter
--
-- ---- The thing this file is about ----
--
-- Three of these were not merely missing — they were contradicted by a comment
-- in the same file, sitting a few lines away, asserting the control as though
-- it were there: §1 (0013 says `show_in_attendees` "governs here too"), §2
-- (0033 says an unsubscribe "cannot be cleared from here"), and §9 (0027 says
-- staff read prospect rows "through the service role or a SQL session", which
-- is true and is not a route anyone can use to take a profile down).
--
-- A comment cannot enforce anything. When adding to any of these, write the
-- query that proves it into the verification block BEFORE writing the sentence
-- that claims it — and if the query is one that cannot be run at the time of
-- writing, say so where the claim is, the way the top of this file does.
