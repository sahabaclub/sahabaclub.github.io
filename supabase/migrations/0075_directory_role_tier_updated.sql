-- 0075 — member_directory gains role, tier and profile_updated_at
-- ============================================================
--
-- Three things the Connect page and the profile page now need and the view did
-- not carry:
--
--   role                 → the badge: Founder / Staff / Coach / Member
--   tier                 → blue for standard, gold for premium
--   profile_updated_at   → the "Last updated" sort, which is now the default
--
-- ⚠ CREATE OR REPLACE VIEW CAN ONLY APPEND COLUMNS. The existing list has to
-- come back byte-identical and in the same order or Postgres refuses the
-- replace outright. The three new ones are at the end for that reason and not
-- because that is where they read best.
--
-- ⚠ WHAT THIS PUBLISHES, deliberately. `role` and `tier` become readable by
-- every signed-in member. That is the point — the badge is meant to be seen —
-- but it means a member can now tell who is staff and who is on which plan.
-- Ahmed asked for exactly that (19 Aug). It is a disclosure, so it is written
-- down rather than left to be discovered.
--
-- ⚠ THE SUBSCRIPTIONS JOIN MUST NOT MULTIPLY ROWS. Measured before writing
-- this: 46 rows, 46 distinct user_ids, so one row per member today. Nothing in
-- the schema ENFORCES that, so this takes the highest tier per user rather
-- than trusting it — a second row would otherwise silently duplicate someone
-- in the directory, which looks like a data bug a long way from its cause.
--
-- ⚠ security_invoker stays OFF, as it was. The view runs as its owner, so RLS
-- on `profiles` does not apply and the WHERE clause at the bottom is the only
-- thing standing between this and every profile in the table. Do not remove
-- `p.is_discoverable AND profile_is_complete(p.*)` while editing.

create or replace view public.member_directory as
 SELECT p.user_id,
    p.full_name,
    p.headline,
    p.bio,
    p.avatar_url,
    p.city,
    p.country,
    p.experience_level,
    p.industry,
    p.company,
    p."position",
    p.years_experience,
    p.open_to,
    p.skills,
    p.interests,
    p.links,
    p.accepts_messages,
    p.work_history,
    COALESCE(m.created_at, p.created_at) AS member_since,
    p.created_at AS joined_site_at,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('slug', h.slug, 'name', h.name, 'round', h.round_number, 'starts_on', h.starts_on, 'is_mentor', hp.is_mentor, 'is_judge', hp.is_judge, 'role', hp.role_in_team, 'team', t.name, 'rank', t.rank, 'is_winner', COALESCE(t.is_winner, false)) ORDER BY h.round_number DESC) AS jsonb_agg
           FROM hackathon_participants hp
             JOIN hackathons h ON h.id = hp.hackathon_id
             LEFT JOIN hackathon_teams t ON t.id = hp.team_id
          WHERE hp.user_id = p.user_id AND h.status <> 'draft'::text), '[]'::jsonb) AS hackathons,
    ( SELECT count(*) AS count
           FROM member_follows f
          WHERE f.following_id = p.user_id) AS followers,
    ( SELECT count(*) AS count
           FROM member_follows f
          WHERE f.follower_id = p.user_id) AS following,
    -- ---- new in 0075 ----
    p.role,
    -- Scalar subquery, not a join: it cannot add a row no matter how many
    -- subscription rows a member accumulates. 'premium' sorts after
    -- 'standard', so max() is the higher tier.
    COALESCE(( SELECT max(s.tier::text)
           FROM subscriptions s
          WHERE s.user_id = p.user_id AND s.status = 'active'), 'standard') AS tier,
    p.updated_at AS profile_updated_at
   FROM profiles p
     LEFT JOIN ms365_accounts m ON m.user_id = p.user_id
  WHERE p.is_discoverable AND profile_is_complete(p.*);

-- ⚠ RE-ASSERTED, NOT ASSUMED. Supabase grants generously on new objects and
-- this project has been caught by it before: revoke first, then grant exactly
-- what is wanted. `anon` must never reach this — the directory is for signed-in
-- members. CREATE OR REPLACE does preserve grants, so this is belt and braces,
-- and belt and braces is the correct amount for a view over every profile.
revoke all on public.member_directory from public;
revoke all on public.member_directory from anon;
grant select on public.member_directory to authenticated;

comment on view public.member_directory is
  'Discoverable, complete member profiles for Connect. security_invoker is OFF: '
  'the WHERE clause is the only guard. role and tier are deliberately readable '
  'by any signed-in member so the profile badge can be rendered (0075).';
