-- Sahaba Club — Connect, ordered by what you already share
-- ------------------------------------------------------------
-- Ahmed: "organize the sort of users in connect based on the relation between
-- these people, so I see first the people related to me — we were a team in a
-- hackathon, or even we participated together, or same interest, whatever
-- makes us relate."
--
-- So Connect stops being "everyone, newest first" and becomes "the people you
-- already have something with, first". Members and prospects are ranked
-- together in one list: a former teammate who has not signed up yet is exactly
-- the person that request is about, and pushing them below every stranger who
-- happens to hold an account would defeat the whole point.
--
-- ============================================================
-- The security problem, which is the whole difficulty here
-- ============================================================
--
-- `member_directory` (0023) and `prospect_directory` (0027) are both
-- `security_invoker = off`. They have to be: they aggregate
-- `hackathon_participants`, and `authenticated` holds no SELECT on that table
-- at all. Their column lists are the privacy boundary, and this migration must
-- not become the hole in it.
--
-- Three rules follow, and every one of them is load-bearing.
--
-- **1. The viewer is resolved from `auth.uid()`, never from an argument.**
-- There is no `connect_relevance(p_user_id uuid)` in this file and there must
-- never be one. A ranking function that takes a user id is an oracle for "who
-- was on a team with whom": call it once per member id and you have
-- reconstructed the team rosters of people who never agreed to publish them.
-- 0021 and 0027 make the same argument at length about their own functions.
-- This object goes further than an argument-less function — it is a *view*, so
-- there is no argument to pass in the first place.
--
-- **2. This view reads `hackathon_participants` with RLS bypassed.**
-- `security_invoker = off` means the owner's rights apply, and the owner is
-- the table owner, so the `participants: read own` policy from 0020 does NOT
-- protect anything here. The `hp.user_id = auth.uid()` predicate in `my_part`
-- below is the only thing standing between one member and every member's
-- hackathon history. Do not relax it, do not parameterise it, and do not add a
-- second read of that table anywhere in this file. Note also that a NULL
-- `auth.uid()` (anon, or a definer context with no JWT) matches no rows, so
-- the failure mode is "nobody is related to anybody", never "everybody sees
-- everything".
--
-- **3. Everything known about the *other* person comes out of the two
-- directory views, never out of a base table.** The candidate set below is
-- literally `select from member_directory union all select from
-- prospect_directory`. That is not a convenience: it makes it structurally
-- impossible for the ranking to consider a fact the reader could not already
-- have selected for themselves. Draft rounds, undiscoverable members,
-- unpublished or already-claimed prospects, emails, mailboxes and
-- `university_or_company` are all excluded before this file sees them, because
-- the source views excluded them. If a future edit reaches past these two
-- views into `profiles` or `hackathon_participants` for the *target*, that
-- invariant is gone and this comment is a lie.
--
-- ============================================================
-- Does the exposed number leak? The reasoning, not the assertion
-- ============================================================
--
-- A score is itself a leak if it is legible enough to invert. If "same team"
-- were worth 100 and nothing else scored a round number, then a 100 would tell
-- the reader "we were teammates" — a fact the directory had not told them.
-- Worse, an *additive* score is separable: 143 factors into 100 + 40 + 3, and
-- the reader recovers each signal individually, including how many skills
-- overlapped. That is a side channel with a number on it.
--
-- Two decisions between us and that.
--
-- **No score. A band.** What ships is a single small integer, 1..8, which is
-- the ordinal of the *strongest* relationship found and nothing else. It is
-- not additive, so it cannot be decomposed. It carries no counts: "one shared
-- skill" and "nine shared skills" are both a 4, and a teammate who also shares
-- a country and an employer is a 1 with no trace of the rest. Strictly less
-- information than an ordering, since it is an ordering with the ties made
-- explicit.
--
-- **Every band is already derivable by the reader.** This is the part that
-- actually settles it, and it is worth being precise rather than reassuring.
-- Band 1 and 2 read `hackathons` — but `member_directory.hackathons` and
-- `prospect_directory.hackathons` publish each person's rounds, teams and
-- coaching flags to any `authenticated` reader already, and 0020's
-- `hackathon_roster` publishes team rosters to *anon*. Bands 4, 5 and 6 read
-- `skills`, `interests`, `industry`, `company` and `country`, all of which are
-- columns of the same two views. The viewer's own side comes from the viewer's
-- own rows, which they can read directly (`my_hackathon_history`, and the
-- `participants: read own` policy). So a client with these two views and a
-- loop could compute every band on this page for itself. The band is a
-- re-presentation of published facts, not a disclosure of hidden ones — which
-- is the property that makes it safe, and it is a property of *what the
-- ranking is allowed to read*, not of how the number is shaped.
--
-- The honest residual: the band is a convenience. It makes a relationship
-- cheap to notice where before it was merely possible to compute. That is the
-- feature Ahmed asked for. It is defensible only for as long as rule 3 holds,
-- which is why rule 3 is stated in capitals up there and checked at the bottom.

-- ============================================================
-- The ranked directory
-- ============================================================

-- Replacing in place fails with 42P16 the moment the column list changes, and
-- DROP takes the privileges with it — hence the re-grant at the end.
drop view if exists public.connect_directory;

create view public.connect_directory
with (security_invoker = off) as

with me as (
  select auth.uid() as uid
),

-- ---- The viewer's own half -------------------------------------------
--
-- One row per round the viewer took part in. `staffed` folds mentor and judge
-- together: for the purpose of "how do we relate", both mean *you were running
-- the round rather than competing in it*, and the profile page already tells
-- the two apart where it matters.
--
-- ⚠ `hp.user_id = auth.uid()` is the security boundary. See rule 2 above.
my_part as (
  select
    nullif(btrim(h.slug), '')                          as slug,
    nullif(lower(btrim(t.name)), '')                   as team_key,
    (hp.is_mentor or hp.is_judge)                      as staffed
  from public.hackathon_participants hp
  join public.hackathons h  on h.id = hp.hackathon_id
  left join public.hackathon_teams t on t.id = hp.team_id
  cross join me
  where hp.user_id = me.uid
    and me.uid is not null
    and h.status <> 'draft'      -- the same filter both directories apply
),

-- Collapsed into arrays so the per-candidate work below is a membership test
-- rather than a join. Aggregates with no GROUP BY always yield exactly one
-- row, including for a viewer with no hackathon history at all — which is the
-- common case and must not turn the whole view into zero rows.
--
-- Team names are scoped by round on purpose. They come from user-entered
-- SharePoint lists, and a name like "Team 1" exists in more than one round —
-- matching on the bare name would announce a teammate the viewer never met.
my_sets as (
  select
    coalesce(array_agg(distinct slug || '|' || team_key)
               filter (where slug is not null and team_key is not null and not staffed),
             '{}'::text[]) as my_team_keys,
    coalesce(array_agg(distinct slug) filter (where slug is not null and not staffed),
             '{}'::text[]) as my_competed_rounds,
    coalesce(array_agg(distinct slug) filter (where slug is not null and staffed),
             '{}'::text[]) as my_staffed_rounds,
    coalesce(array_agg(distinct slug) filter (where slug is not null),
             '{}'::text[]) as my_all_rounds
  from my_part
),

-- The viewer's own profile row, and only ever their own. Primary-keyed on
-- user_id, so this is at most one row and cannot multiply the candidate list.
my_profile as (
  select p.skills, p.interests, p.industry, p.company, p.country
  from public.profiles p
  cross join me
  where p.user_id = me.uid
),

-- ---- The people being ranked -----------------------------------------
--
-- Both directories, one shape. See rule 3: nothing else may be read about the
-- people in this list.
candidates as (
  select
    'member'::text        as kind,
    d.user_id             as member_user_id,
    null::uuid            as prospect_id,
    true                  as is_member,
    d.full_name, d.headline, d.avatar_url,
    d.city, d.country, d.experience_level,
    d.industry, d.company, d.position, d.years_experience,
    d.skills, d.interests, d.links,
    d.accepts_messages,
    d.member_since        as listed_since,
    d.followers, d.following,
    d.hackathons
  from public.member_directory d

  union all

  select
    'prospect'::text,
    null::uuid,
    p.id,
    false,
    p.full_name, p.headline, p.avatar_url,
    p.city, p.country, null::text,
    p.industry, p.company, p.position, p.years_experience,
    p.skills, p.interests, p.links,
    -- Not null, and not true: a prospect has no `user_id`, so there is nobody
    -- for a message to be delivered to. Any existing code path that checks
    -- `accepts_messages` before offering a Message button therefore does the
    -- right thing here without knowing prospects exist.
    false,
    -- They have no membership date because they are not members. This is the
    -- date the club built the profile, and it is used only as a stable
    -- tiebreak inside a band.
    p.created_at,
    0::bigint, 0::bigint,
    p.hackathons
  from public.prospect_directory p
)

select
  c.kind,
  c.member_user_id,
  c.prospect_id,
  c.is_member,
  c.full_name, c.headline, c.avatar_url,
  c.city, c.country, c.experience_level,
  c.industry, c.company, c.position, c.years_experience,
  c.skills, c.interests, c.links,
  c.accepts_messages,
  c.listed_since,
  c.followers, c.following,

  -- The last tiebreak, and it is not cosmetic. Connect pages the list with
  -- OFFSET/LIMIT, and every one of the 87 prospect rows carries the same
  -- `created_at` because one import made them all in one go. Ordering on
  -- (relevance, listed_since) alone therefore leaves hundreds of rows tied,
  -- and Postgres is free to return tied rows in a different order for each
  -- page — which silently shows some people twice and hides others entirely.
  -- Both source ids are uuids and no row has both, so this is unique across
  -- the union. It publishes nothing new: it is one of two columns already
  -- immediately above it.
  coalesce(c.member_user_id, c.prospect_id) as sort_id,

  -- The band. Strongest relationship found, and nothing else — no points, no
  -- counts, no per-signal breakdown. See the note above on why it is a band
  -- and not a score.
  --
  --   1  same team in a round
  --   2  competed in the same round, different teams
  --   3  one of you was coaching or judging a round the other was in
  --   4  shared skills or interests
  --   5  same industry or same employer
  --   6  same country
  --   7  no signal — a member
  --   8  no signal — has not joined yet
  --
  -- 7 before 8 is the one piece of product judgement in this list. Every
  -- prospect row was created by the same import on the same day, so with a
  -- date tiebreak alone 87 people who are not here would sit above every
  -- member for a reader who shares nothing with any of them. A stranger who
  -- has actually joined is the more useful stranger. It changes nothing above
  -- band 7: a prospect teammate is still a 1, ahead of every member who is not.
  (case
     -- You, in your own directory. Comparing the viewer to themselves ranks
     -- them as their own closest connection, which is true and useless.
     -- connect.html still needs the row — it is how the page knows whether the
     -- reader is listed — so it stays, unranked.
     when c.member_user_id is not null and c.member_user_id = me.uid then 7

     when rel.same_team  then 1
     when rel.same_round then 2
     when rel.staff_link then 3
     when ov.shared_tags then 4

     when nullif(lower(btrim(c.industry)), '') is not null
      and nullif(lower(btrim(c.industry)), '') = nullif(lower(btrim(mp.industry)), '') then 5
     when nullif(lower(btrim(c.company)), '') is not null
      and nullif(lower(btrim(c.company)), '') = nullif(lower(btrim(mp.company)), '')  then 5

     when nullif(lower(btrim(c.country)), '') is not null
      and nullif(lower(btrim(c.country)), '') = nullif(lower(btrim(mp.country)), '')  then 6

     when c.is_member then 7
     else 8
   end)::int as relevance

from candidates c
cross join me
cross join my_sets s
left join my_profile mp on true

-- What the *candidate* did, read only from the `hackathons` aggregate their
-- own directory row already publishes. Written defensively throughout: the
-- aggregate is jsonb, so nothing here assumes an array, an object per entry,
-- or a boolean in any given field. `-> 'is_mentor' = 'true'::jsonb` rather
-- than a `::boolean` cast because a cast failure is an error for the whole
-- query, and one malformed row must not take Connect down for everyone.
left join lateral (
  select
    coalesce(bool_or(
      not e.staffed
      and e.team_key is not null
      and (e.slug || '|' || e.team_key) = any (s.my_team_keys)
    ), false) as same_team,

    coalesce(bool_or(
      not e.staffed and e.slug = any (s.my_competed_rounds)
    ), false) as same_round,

    -- Either direction, and the both-of-you-were-running-it case: two coaches
    -- from the same round are related by it just as plainly as two competitors.
    coalesce(bool_or(
      e.slug = any (s.my_all_rounds)
      and (e.staffed or e.slug = any (s.my_staffed_rounds))
    ), false) as staff_link
  from (
    select
      nullif(btrim(x.entry ->> 'slug'), '')        as slug,
      nullif(lower(btrim(x.entry ->> 'team')), '') as team_key,
      coalesce(x.entry -> 'is_mentor' = 'true'::jsonb, false)
        or coalesce(x.entry -> 'is_judge' = 'true'::jsonb, false) as staffed
    from jsonb_array_elements(
           case when jsonb_typeof(c.hackathons) = 'array'
                then c.hackathons else '[]'::jsonb end
         ) as x(entry)
    where jsonb_typeof(x.entry) = 'object'
  ) e
) rel on true

-- Skills and interests together, case- and space-insensitively. Deliberately
-- a plain existence test: how *many* tags two people share is a count, and a
-- count is the kind of legible detail the band exists not to publish.
left join lateral (
  select exists (
    select 1
    from unnest(coalesce(c.skills, '{}'::text[]) || coalesce(c.interests, '{}'::text[])) as theirs(v)
    join unnest(coalesce(mp.skills, '{}'::text[]) || coalesce(mp.interests, '{}'::text[])) as mine(v)
      on lower(btrim(theirs.v)) = lower(btrim(mine.v))
    where nullif(btrim(theirs.v), '') is not null
  ) as shared_tags
) ov on true;

comment on view public.connect_directory is
  'Members and unclaimed prospects in one list, ranked 1..8 by how the signed-in reader relates to each. Viewer comes from auth.uid(); there is no argument and there must never be one. Everything read about another person comes from member_directory or prospect_directory, so the ranking can never consider a fact the reader could not already select.';

-- Supabase grants ALL on a newly created view to anon and authenticated by
-- default. Without this revoke the whole thing ships world-readable, and a
-- view is the worst place for that to happen because `security_invoker = off`
-- means anon would be reading it with the owner's rights.
revoke all on public.connect_directory from anon, authenticated;
grant select on public.connect_directory to authenticated;

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- anon cannot reach the new view (expect zero rows):
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'connect_directory' and grantee = 'anon';
--
-- authenticated has SELECT and nothing else (expect exactly one row, SELECT):
--   select privilege_type from information_schema.role_table_grants
--    where table_name = 'connect_directory' and grantee = 'authenticated';
--
-- ⚠ There is no ranking function taking a user id. This must return zero rows
-- — if it ever returns one, the oracle described at the top of this file has
-- been built:
--   select p.proname, pg_get_function_identity_arguments(p.oid)
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname ~ 'connect.*(relevance|rank)|relevance.*connect'
--      and pg_get_function_identity_arguments(p.oid) <> '';
--
-- The view resolves the viewer itself. Both must appear in the definition —
-- auth.uid() present, and no parameter of any kind (a view cannot take one):
--   select pg_get_viewdef('public.connect_directory'::regclass) ilike '%auth.uid()%';
--   -- expect true
--
-- ⚠ Rule 3: nothing about another person is read outside the two directory
-- views. Check the dependency list rather than trusting the SQL above — this
-- is the invariant the whole leak argument rests on. `hackathon_participants`
-- SHOULD appear (it is the viewer's own half, rule 2) but `profiles` should
-- appear only via the viewer's own row, and `hackathon_teams`/`hackathons`
-- only via that same half:
--   select distinct cl.relname
--     from pg_depend d
--     join pg_rewrite r on r.oid = d.objid
--     join pg_class cl on cl.oid = d.refobjid
--    where r.ev_class = 'public.connect_directory'::regclass
--      and cl.relkind in ('r','v');
--   -- expect: member_directory, prospect_directory, profiles,
--   --         hackathon_participants, hackathons, hackathon_teams
--   -- anything else is a widening of the privacy boundary
--
-- The column list did not widen. No contact details, no provenance, no
-- mailbox reached the ranked view (expect zero rows):
--   select column_name from information_schema.columns
--    where table_name = 'connect_directory'
--      and column_name in ('email','ms365_mailbox','sources','university_or_company','bio');
--
-- The paging key really is unique, or Connect will show some people twice and
-- drop others as the reader scrolls (expect true):
--   select count(*) = count(distinct sort_id) from public.connect_directory;
--
-- The bands actually populate. As Ahmed (four EduHackAI rounds) this should
-- show rows in bands 1..3; as a brand-new member it should be all 7s and 8s:
--   select relevance, count(*) from public.connect_directory group by 1 order by 1;
--
-- Prospects rank alongside members rather than after them — this is the point
-- of the feature, so prove it rather than reading it. As Ahmed, expect at
-- least one `prospect` row at a band below 7:
--   select kind, relevance, full_name from public.connect_directory
--    where relevance <= 3 order by relevance, kind;
--
-- ⚠ It really is per-viewer. The same query as two different members must not
-- return the same bands. Run this in two sessions with different JWTs — if the
-- results match, auth.uid() is not resolving and everyone is seeing band 7/8:
--   select kind, relevance, full_name from public.connect_directory order by 3;
--
-- A viewer with no hackathon history and no profile row still gets the whole
-- directory (the aggregates in `my_sets` yield one row of empty arrays, and
-- `my_profile` is left-joined) — expect the same count as the two directories
-- added together, never zero:
--   select (select count(*) from public.connect_directory)
--        = (select count(*) from public.member_directory)
--        + (select count(*) from public.prospect_directory);
--   -- expect true
