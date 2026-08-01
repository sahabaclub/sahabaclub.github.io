-- Sahaba Club — a public profile worth reading
-- ------------------------------------------------------------
-- Three things the member profile could not show.
--
-- 1. Work history. `company` and `position` hold only the current job, so a
--    profile could say "Principal Architect at Vodafone" and nothing about the
--    twelve years before it. A CV is mostly that history, and it was being
--    thrown away on import.
--
-- 2. Hackathon involvement. 0020 records who organised, coached and competed
--    in every EduHackAI round, but none of it reached a profile — so somebody
--    who ran the programme four times looked like any other new member.
--
-- 3. "Member since" was the sahabaclub.ai signup date, which for people who
--    have been in the tenant for years reads as though they turned up
--    yesterday. It should be the date their Microsoft 365 account was created.

-- ============================================================
-- Work history
-- ============================================================

-- jsonb rather than a child table: it is always read and written whole, as
-- one block belonging to one profile, and never queried across members. A
-- table would add a join and a policy for no benefit.
--
-- Shape (validated in the app, not here — a CHECK on jsonb structure would
-- reject a perfectly good import over a field order nobody sees):
--   [{ "company": "...", "position": "...", "start": "2021-03",
--      "end": "2024-08" | null, "is_current": bool, "summary": "..." }]
alter table public.profiles
  add column if not exists work_history jsonb not null default '[]'::jsonb;

comment on column public.profiles.work_history is
  'Ordered newest-first. Member-editable, and filled from a CV on import.';

-- ⚠ THE MOST REPEATED BUG IN THIS PROJECT. `profiles` uses an explicit
-- column-level UPDATE allowlist (0002 → 0005 → 0017 → 0019 → 0022). A member
-- edits their own work history, so it MUST be granted here — a column-level
-- REVOKE is a no-op where the grant was never made, so forgetting this does
-- not fail loudly, it just silently refuses every save.
grant update (work_history) on public.profiles to authenticated;

-- ============================================================
-- The directory
-- ============================================================

-- Replacing in place fails with 42P16 once the column list changes, and DROP
-- takes the privileges with it — hence the re-grant at the end.
drop view if exists public.member_directory;

create view public.member_directory
with (security_invoker = off) as
select
  p.user_id, p.full_name, p.headline, p.bio, p.avatar_url,
  p.city, p.country, p.experience_level, p.industry,
  p.company, p.position, p.years_experience, p.open_to,
  p.skills, p.interests, p.links, p.accepts_messages,
  p.work_history,

  -- Their history with the club starts when the club gave them an account,
  -- not when this website was built. Falls back to the profile row for
  -- members who have no mailbox yet.
  coalesce(m.created_at, p.created_at) as member_since,
  p.created_at as joined_site_at,

  -- What they did in EduHackAI, newest round first. Reads
  -- hackathon_participants, which `authenticated` deliberately cannot select
  -- from — this view is security_invoker = off precisely so the column list
  -- stays the privacy boundary. No email, no mailbox, no university: only
  -- what they did and which team they did it with.
  coalesce((
    select jsonb_agg(jsonb_build_object(
             'slug',      h.slug,
             'name',      h.name,
             'round',     h.round_number,
             'starts_on', h.starts_on,
             'is_mentor', hp.is_mentor,
             'is_judge',  hp.is_judge,
             'role',      hp.role_in_team,
             'team',      t.name,
             'rank',      t.rank,
             'is_winner', coalesce(t.is_winner, false)
           ) order by h.round_number desc)
    from public.hackathon_participants hp
    join public.hackathons h on h.id = hp.hackathon_id
    left join public.hackathon_teams t on t.id = hp.team_id
    where hp.user_id = p.user_id
      and h.status <> 'draft'
  ), '[]'::jsonb) as hackathons,

  (select count(*) from public.member_follows f where f.following_id = p.user_id) as followers,
  (select count(*) from public.member_follows f where f.follower_id  = p.user_id) as following
from public.profiles p
left join public.ms365_accounts m on m.user_id = p.user_id
where p.is_discoverable
  and public.profile_is_complete(p);

-- Supabase grants ALL on a new view to anon and authenticated by default, so
-- revoke before granting rather than assuming a clean slate.
revoke all on public.member_directory from anon, authenticated;
grant select on public.member_directory to authenticated;

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- The work_history grant exists (this is the bug that keeps recurring):
--   select privilege_type from information_schema.column_privileges
--    where table_name='profiles' and column_name='work_history'
--      and grantee='authenticated';
--   -- expect one row: UPDATE
--
-- anon still cannot read the directory (expect zero rows):
--   select table_name from information_schema.role_table_grants
--    where table_name='member_directory' and grantee='anon';
--
-- No contact details leaked through the hackathon aggregate — the view's
-- column list is the boundary, so check what it actually exposes:
--   select column_name from information_schema.columns
--    where table_name='member_directory';
--   -- expect NO email, ms365_mailbox or university_or_company
--
-- Ahmed's own row should now show four EduHackAI rounds and a member_since
-- taken from his mailbox rather than his signup:
--   select full_name, member_since, joined_site_at,
--          jsonb_array_length(hackathons) as rounds
--     from public.member_directory;
