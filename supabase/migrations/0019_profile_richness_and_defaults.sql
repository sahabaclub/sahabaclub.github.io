-- Sahaba Club — Connect on by default, richer profiles, controlled vocabularies
-- ------------------------------------------------------------
-- Supersedes the first draft of this file, which failed to apply. The reason
-- is worth recording, because the fix is a design change rather than a typo.
--
-- 0018 made the Connect gate an ERROR: try to become discoverable with an
-- incomplete profile and the trigger raises. That forced every caller into a
-- bad choice — refuse the write, or silently undo it. The backfill below
-- (`set is_discoverable = true where not is_discoverable`) hit exactly that:
-- old.is_discoverable is false for every row it touches by definition, so the
-- silent-settle branch could never apply and it raised on the first
-- incomplete profile. Five of six profiles are incomplete, so it always did.
--
-- The fix: stop treating visibility as something a member sets, and treat it
-- as something DERIVED. `is_discoverable` becomes intent — "list me" — and
-- the directory shows you only when intent and completeness are both true.
-- Nothing raises, nothing is silently reverted, and the page can honestly say
-- "you'll appear in Connect once you add a photo" instead of either failing
-- or lying. One rule, one place, no error path.

-- ============================================================
-- 0. Columns first — everything below depends on them
-- ============================================================

-- These were originally added further down, which is why the first two
-- attempts failed: the member_directory view in the next section selects
-- p.company, and section order is execution order. Columns before the things
-- that read them.
alter table public.profiles
  add column if not exists company text,
  add column if not exists position text,
  add column if not exists years_experience int
    check (years_experience is null or years_experience between 0 and 60),
  add column if not exists open_to text[] not null default '{}';

-- 0002 revoked table-wide UPDATE and hands privileges back per column, so a
-- new column starts unwritable. Every migration adding a member-editable
-- column to profiles needs a line like this — the single most repeated
-- mistake in this schema's history.
grant update (company, position, years_experience, open_to)
  on public.profiles to authenticated;

-- ============================================================
-- 1. Retire the gate trigger
-- ============================================================

drop trigger if exists profiles_connect_gate on public.profiles;
drop function if exists public.enforce_connect_gate();

-- `profile_is_complete(profiles)` from 0018 stays — it is now the shared
-- definition used by the directory, the feed trigger and the profile page's
-- "what's still missing" hint.

-- ============================================================
-- 2. Completeness decides visibility, not a trigger
-- ============================================================

-- DROP, not CREATE OR REPLACE. Replace can only append columns to an existing
-- view — it cannot reorder or rename them — and the four new columns belong in
-- the middle of this select list, next to the other identity fields. Replacing
-- in place fails with 42P16 ("cannot change name of view column"). Dropping
-- first also means the column order is ours to choose rather than inherited.
-- The grant is re-issued below because DROP takes the privileges with it.
drop view if exists public.member_directory;

create view public.member_directory
with (security_invoker = off) as
select
  p.user_id, p.full_name, p.headline, p.bio, p.avatar_url,
  p.city, p.country, p.experience_level, p.industry,
  p.company, p.position, p.years_experience, p.open_to,
  p.skills, p.interests, p.links, p.accepts_messages,
  p.created_at as member_since,
  (select count(*) from public.member_follows f where f.following_id = p.user_id) as followers,
  (select count(*) from public.member_follows f where f.follower_id  = p.user_id) as following
from public.profiles p
where p.is_discoverable                 -- they want to be listed
  and public.profile_is_complete(p);    -- and there is something to list

revoke all on public.member_directory from anon;
grant select on public.member_directory to authenticated;

-- The feed announcement gets the same treatment, so an incomplete profile
-- cannot produce a "joined the club" post with nothing in it.
create or replace function public.feed_on_member_visible()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.is_discoverable and public.profile_is_complete(new)
     and not exists (
       select 1 from public.feed_posts
       where subject_user_id = new.user_id
         and kind in ('member_joined', 'coach_joined')
     )
  then
    insert into public.feed_posts (kind, subject_user_id, title)
    values (
      case when new.role = 'coach' then 'coach_joined' else 'member_joined' end,
      new.user_id,
      coalesce(new.full_name, 'A new member') ||
        case when new.role = 'coach' then ' joined as a coach' else ' joined the club' end
    );
  end if;
  return null;
end;
$fn$;

-- ============================================================
-- 3. Connect on by default
-- ============================================================

-- Safe now: with no trigger to raise, this is a plain UPDATE. Incomplete
-- profiles simply do not surface in the directory until they are filled in.
--
-- Scope of this consent change: `profiles` holds people who signed up on
-- sahabaclub.ai. It does NOT include the ~926 rows in `marketing_contacts` —
-- those people gave an email to attend an event, never created an account,
-- and are untouched by anything here.
alter table public.profiles alter column is_discoverable set default true;
update public.profiles set is_discoverable = true where not is_discoverable;

-- ============================================================
-- 4. Richer profiles
-- ============================================================

alter table public.profiles
  add column if not exists company text,
  add column if not exists position text,
  add column if not exists years_experience int
    check (years_experience is null or years_experience between 0 and 60),
  add column if not exists open_to text[] not null default '{}';

-- 0002 revoked table-wide UPDATE and hands privileges back per column, so a
-- new column starts unwritable. Every migration adding a member-editable
-- column to profiles needs a line like this — it is the single most repeated
-- mistake in this schema's history.
grant update (company, position, years_experience, open_to)
  on public.profiles to authenticated;

-- ============================================================
-- 5. Controlled vocabularies
-- ============================================================

create table if not exists public.countries (
  code text primary key,
  name text not null,
  sort_order int not null default 100
);

alter table public.countries enable row level security;
drop policy if exists "countries: readable" on public.countries;
create policy "countries: readable" on public.countries
  for select using (auth.uid() is not null);
drop policy if exists "countries: staff write" on public.countries;
create policy "countries: staff write" on public.countries
  for all using (public.is_staff()) with check (public.is_staff());
revoke all on public.countries from anon;
grant select on public.countries to authenticated;

insert into public.countries (code, name, sort_order) values
  ('AE','United Arab Emirates',1), ('EG','Egypt',2), ('SA','Saudi Arabia',3),
  ('QA','Qatar',4), ('KW','Kuwait',5), ('BH','Bahrain',6), ('OM','Oman',7),
  ('JO','Jordan',8), ('LB','Lebanon',9), ('IQ','Iraq',10), ('SY','Syria',11),
  ('PS','Palestine',12), ('YE','Yemen',13), ('SD','Sudan',14), ('LY','Libya',15),
  ('TN','Tunisia',16), ('DZ','Algeria',17), ('MA','Morocco',18),
  ('TR','Turkey',20), ('PK','Pakistan',21), ('IN','India',22), ('BD','Bangladesh',23),
  ('NG','Nigeria',24), ('KE','Kenya',25), ('ZA','South Africa',26),
  ('GB','United Kingdom',30), ('US','United States',31), ('CA','Canada',32),
  ('DE','Germany',33), ('FR','France',34), ('NL','Netherlands',35),
  ('ES','Spain',36), ('IT','Italy',37), ('SE','Sweden',38),
  ('AU','Australia',40), ('SG','Singapore',41), ('MY','Malaysia',42),
  ('ID','Indonesia',43), ('PH','Philippines',44), ('CN','China',45), ('JP','Japan',46)
on conflict (code) do nothing;

-- Free text produced exactly the mess the table above exists to prevent.
update public.profiles set country = 'United Arab Emirates'
  where country is not null
    and lower(regexp_replace(country, '[^a-z]', '', 'gi')) in
        ('uae','unitedarabemirates','emirates','dubai','abudhabi','sharjah');
update public.profiles set country = 'Egypt'
  where country is not null
    and lower(regexp_replace(country, '[^a-z]', '', 'gi')) in
        ('egypt','eg','cairo','giza','alexandria');
update public.profiles set country = 'Saudi Arabia'
  where country is not null
    and lower(regexp_replace(country, '[^a-z]', '', 'gi')) in
        ('saudi','saudiarabia','ksa','riyadh','jeddah');

-- Skills and interests stay text[] — the recommender already scores against
-- them. What changes is the input: a tag picker instead of a comma box. This
-- table gives it something to suggest, so members converge on one spelling of
-- "Power Apps" rather than inventing five.
create table if not exists public.tag_suggestions (
  tag text primary key,
  kind text not null check (kind in ('skill','interest','both')),
  uses int not null default 0
);

alter table public.tag_suggestions enable row level security;
drop policy if exists "tags: readable" on public.tag_suggestions;
create policy "tags: readable" on public.tag_suggestions
  for select using (auth.uid() is not null);
drop policy if exists "tags: staff write" on public.tag_suggestions;
create policy "tags: staff write" on public.tag_suggestions
  for all using (public.is_staff()) with check (public.is_staff());
revoke all on public.tag_suggestions from anon;
grant select on public.tag_suggestions to authenticated;

insert into public.tag_suggestions (tag, kind) values
  ('AI','both'), ('Machine Learning','both'), ('Generative AI','both'), ('LLMs','both'),
  ('Copilot Studio','both'), ('Power Apps','both'), ('Power Automate','both'),
  ('Power BI','both'), ('Microsoft Fabric','both'), ('Azure','both'),
  ('Cloud','both'), ('DevOps','skill'), ('Cybersecurity','both'), ('Data Science','both'),
  ('Data Engineering','both'), ('Python','skill'), ('JavaScript','skill'), ('TypeScript','skill'),
  ('SQL','skill'), ('C#','skill'), ('React','skill'), ('Node.js','skill'),
  ('Coding','interest'), ('Startups','interest'), ('Entrepreneurship','interest'),
  ('Business','interest'), ('Product Management','both'), ('UX Design','both'),
  ('Hackathons','interest'), ('Public Speaking','both'), ('Teaching','both'),
  ('Mentoring','interest'), ('Robotics','both'), ('IoT','both'), ('Blockchain','both')
on conflict (tag) do nothing;

-- Seed from what members already chose, so the vocabulary reflects this club
-- and not only what was guessed above.
insert into public.tag_suggestions (tag, kind)
select distinct trim(t), 'both'
from public.profiles p, unnest(coalesce(p.skills, '{}') || coalesce(p.interests, '{}')) t
where trim(t) <> ''
on conflict (tag) do nothing;

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- The gate is gone (expect zero rows for both):
--   select tgname from pg_trigger where tgname = 'profiles_connect_gate';
--   select proname from pg_proc where proname = 'enforce_connect_gate';
--
-- Everyone is now opted in (expect 0 for the second):
--   select count(*) from public.profiles;
--   select count(*) from public.profiles where not is_discoverable;
--
-- But incomplete profiles are NOT listed. These two must differ by exactly
-- the number of incomplete profiles:
--   select count(*) from public.profiles where is_discoverable;
--   select count(*) from public.member_directory;
--
-- Default is on (expect 'true'):
--   select column_default from information_schema.columns
--    where table_name='profiles' and column_name='is_discoverable';
--
-- New columns member-writable (expect all four):
--   select column_name from information_schema.column_privileges
--    where table_name='profiles' and grantee='authenticated' and privilege_type='UPDATE'
--      and column_name in ('company','position','years_experience','open_to');
--
-- anon reaches neither lookup table (expect zero rows):
--   select table_name from information_schema.role_table_grants
--    where grantee='anon' and table_name in ('countries','tag_suggestions');
--
-- No country variants left (expect zero rows):
--   select distinct country from public.profiles
--    where country is not null and country not in (select name from public.countries);
--
-- Signup still works — as the service role this must SUCCEED, not raise:
--   insert into public.profiles (user_id) values ('<a fresh auth.users id>');
