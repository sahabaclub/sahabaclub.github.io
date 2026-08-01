-- Sahaba Club — EduHackAI
-- ------------------------------------------------------------
-- Four rounds have already happened. Their participants are Microsoft 365
-- accounts in the sahabaclub.com tenant; almost none of them have signed up
-- on sahabaclub.ai yet. That single fact drives the whole design:
--
--   A person's hackathon history has to exist BEFORE they have an account,
--   and attach itself to them the moment they create one.
--
-- So `hackathon_participants` keys on email, carries a nullable `user_id`,
-- and gets linked on signup — the same shape that already works for
-- `marketing_contacts`. Nothing here waits for anyone to join.
--
-- Round 5 runs on the platform: joining, forming teams, and being recommended
-- teammates. Those are the same tables, with `status = 'open'`.

-- ============================================================
-- Rounds
-- ============================================================

create table if not exists public.hackathons (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,                    -- 'eduhackai-1' … 'eduhackai-5'
  round_number int not null,
  name text not null,
  tagline text,
  description text,

  status text not null default 'draft'
    check (status in ('draft','announced','open','in_progress','judging','completed','cancelled')),

  starts_on date,
  ends_on date,
  registration_closes_on date,

  location text,
  mode text check (mode is null or mode in ('in-person','online','hybrid')),
  partner text,                                 -- university / sponsor
  cover_image_url text,
  source_url text,                              -- the SharePoint site it came from

  -- Round 5 team rules. Null on historical rounds, where they no longer mean
  -- anything and inventing values would misrepresent what happened.
  team_min_size int,
  team_max_size int,
  allows_solo boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hackathons_round_idx on public.hackathons (round_number desc);

-- ============================================================
-- Teams
-- ============================================================

create table if not exists public.hackathon_teams (
  id uuid primary key default gen_random_uuid(),
  hackathon_id uuid not null references public.hackathons (id) on delete cascade,
  name text not null,
  tagline text,

  project_title text,
  project_summary text,
  project_url text,
  demo_url text,
  repo_url text,
  image_url text,

  -- Judging outcome. `rank` is the placing; `award` is the label as the round
  -- actually used it ("Best Use of AI"), because rounds did not all use the
  -- same categories and flattening them would lose the truth.
  rank int,
  award text,
  is_winner boolean not null default false,
  score numeric(6,2),

  -- Round 5: a team can be open to new members and discoverable by the
  -- matcher. Historical teams are closed by definition.
  is_recruiting boolean not null default false,
  looking_for text[] not null default '{}',     -- skills the team still needs

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (hackathon_id, name)
);

create index if not exists hackathon_teams_event_idx on public.hackathon_teams (hackathon_id);
create index if not exists hackathon_teams_winner_idx on public.hackathon_teams (hackathon_id, is_winner) where is_winner;

-- ============================================================
-- Participants
-- ============================================================

create table if not exists public.hackathon_participants (
  id uuid primary key default gen_random_uuid(),
  hackathon_id uuid not null references public.hackathons (id) on delete cascade,
  team_id uuid references public.hackathon_teams (id) on delete set null,

  -- The identity we actually have for historical rounds: a tenant mailbox.
  -- full_name is stored rather than joined because these people have no
  -- profile row yet, and their name is the only thing that makes a team
  -- roster readable today.
  email text,
  full_name text,
  ms365_mailbox text,

  -- Filled when they sign up on sahabaclub.ai. Until then, null.
  user_id uuid references auth.users (id) on delete set null,
  linked_at timestamptz,

  role_in_team text,                            -- 'Developer', 'Designer', 'Lead'
  is_mentor boolean not null default false,
  is_judge boolean not null default false,

  university_or_company text,
  created_at timestamptz not null default now()
);

-- One row per person per round. Email is the natural key while user_id is
-- still null, so it is what the constraint uses.
create unique index if not exists hackathon_participants_unique
  on public.hackathon_participants (hackathon_id, lower(email))
  where email is not null;

create index if not exists hackathon_participants_user_idx on public.hackathon_participants (user_id);
create index if not exists hackathon_participants_team_idx on public.hackathon_participants (team_id);
create index if not exists hackathon_participants_email_idx on public.hackathon_participants (lower(email));

-- ============================================================
-- Linking history to a new account
-- ============================================================

-- Called on signup. Matches on the personal email OR the tenant mailbox,
-- because a participant may sign up with either. Returns how many rounds were
-- attached so the welcome screen can say "we found your 2 EduHackAI rounds".
create or replace function public.link_hackathon_history(p_user_id uuid, p_email text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  n int;
begin
  update public.hackathon_participants
  set user_id = p_user_id, linked_at = now()
  where user_id is null
    and (lower(email) = lower(p_email) or lower(ms365_mailbox) = lower(p_email));
  get diagnostics n = row_count;
  return n;
end;
$fn$;

revoke all on function public.link_hackathon_history(uuid, text) from public, anon, authenticated;

-- ============================================================
-- Access
-- ============================================================

alter table public.hackathons enable row level security;
alter table public.hackathon_teams enable row level security;
alter table public.hackathon_participants enable row level security;

-- Rounds and teams are the public record of the programme — this is what the
-- hackathons page shows, and it should be readable without an account, the
-- same way events are. Drafts stay hidden.
drop policy if exists "hackathons: public read" on public.hackathons;
create policy "hackathons: public read" on public.hackathons
  for select using (status <> 'draft');

drop policy if exists "hackathons: staff write" on public.hackathons;
create policy "hackathons: staff write" on public.hackathons
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists "teams: public read" on public.hackathon_teams;
create policy "teams: public read" on public.hackathon_teams
  for select using (
    exists (select 1 from public.hackathons h
             where h.id = hackathon_id and h.status <> 'draft')
  );

drop policy if exists "teams: staff write" on public.hackathon_teams;
create policy "teams: staff write" on public.hackathon_teams
  for all using (public.is_staff()) with check (public.is_staff());

-- Participants are PEOPLE, so they are not public. A team roster of names is
-- fine for members to see — it is what makes the page worth reading — but the
-- email and mailbox columns are not, which is why the public view below
-- exists and why `authenticated` never gets SELECT on this table directly.
drop policy if exists "participants: staff only" on public.hackathon_participants;
create policy "participants: staff only" on public.hackathon_participants
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists "participants: read own" on public.hackathon_participants;
create policy "participants: read own" on public.hackathon_participants
  for select using (auth.uid() = user_id);

revoke all on public.hackathon_participants from anon, authenticated;
revoke all on public.hackathons from anon;
revoke all on public.hackathon_teams from anon;
grant select on public.hackathons to anon, authenticated;
grant select on public.hackathon_teams to anon, authenticated;

-- ============================================================
-- The public roster — names without contact details
-- ============================================================

-- security_invoker = off so this can read the participants table without
-- `authenticated` holding SELECT on it. The column list IS the privacy
-- boundary: no email, no mailbox, no university. Avatar and link only appear
-- once someone has actually joined and made themselves discoverable.
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
  case when pr.is_discoverable then pr.headline end as headline
from public.hackathon_participants p
left join public.profiles pr on pr.user_id = p.user_id
where exists (
  select 1 from public.hackathons h
  where h.id = p.hackathon_id and h.status <> 'draft'
);

revoke all on public.hackathon_roster from anon;
grant select on public.hackathon_roster to anon, authenticated;

-- What a member sees on their own profile: the rounds they took part in.
create or replace view public.my_hackathon_history
with (security_invoker = on) as
select
  h.slug, h.name, h.round_number, h.starts_on, h.ends_on, h.cover_image_url,
  t.name as team_name, t.project_title, t.project_summary,
  t.rank, t.award, t.is_winner,
  p.role_in_team, p.is_mentor, p.is_judge
from public.hackathon_participants p
join public.hackathons h on h.id = p.hackathon_id
left join public.hackathon_teams t on t.id = p.team_id
where p.user_id = auth.uid()
order by h.round_number desc;

revoke all on public.my_hackathon_history from anon;
grant select on public.my_hackathon_history to authenticated;

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- anon may read rounds/teams/roster but NOT participants (expect the first
-- three to work and the fourth to be denied):
--   select count(*) from public.hackathons;
--   select count(*) from public.hackathon_teams;
--   select count(*) from public.hackathon_roster;
--   select count(*) from public.hackathon_participants;   -- must fail for anon
--
-- No contact details in the public roster (expect zero rows):
--   select column_name from information_schema.columns
--    where table_name = 'hackathon_roster'
--      and column_name in ('email','ms365_mailbox','university_or_company');
--
-- Drafts are invisible (expect zero rows as anon):
--   select slug from public.hackathons where status = 'draft';
--
-- Linking is idempotent — running it twice must return 0 the second time:
--   select public.link_hackathon_history('<user id>', '<email>');
