-- Sahaba Club — a profile for someone who has not joined yet
-- ------------------------------------------------------------
-- 150 people competed, coached or judged an EduHackAI round. Two of them have
-- an account on sahabaclub.ai. The other 148 exist in this database only as a
-- row in `hackathon_participants` — a name, a mailbox and a team.
--
-- Ahmed wants to show each of them the profile the club has already built for
-- them, as an invitation: *this is your history with us, come and claim it*.
-- That requires somewhere to keep a profile for a person who has no account.
--
-- ============================================================
-- Why this is not just a row in `profiles`
-- ============================================================
--
-- `profiles.user_id` is a foreign key to `auth.users`. Putting these people in
-- `profiles` therefore means creating 148 auth accounts for people who never
-- asked for one. That was considered and rejected, deliberately:
--
--   * an auth.users row is reachable by password-reset mail, so a stranger
--     who guesses the address can make us email a person who never signed up;
--   * every count of "members" silently becomes wrong, including the licence
--     and billing screens;
--   * it is undone only by deleting real accounts, which is exactly the class
--     of operation this project has hard rules against.
--
-- So a prospect profile is its own object with its own lifecycle. It is
-- **claimed**, not converted: when the person eventually signs up and links,
-- their prospect row is copied into their real profile and retired. Nothing is
-- created on their behalf before they say yes.
--
-- ============================================================
-- The honesty rule, which is a schema decision here and not a style note
-- ============================================================
--
-- These profiles are written by an AI from harvested material and then shown
-- to the person they describe. Anything invented is a false claim made to
-- someone's face. So:
--
--   * `sources` records where every populated field came from, per field. A
--     field with no entry in `sources` should not have a value.
--   * a person with no LinkedIn and nothing self-submitted gets **no row at
--     all** — that is Ahmed's rule, and it is enforced by the importer rather
--     than here, because "has something worth publishing" is a judgement about
--     content that a CHECK constraint cannot make honestly.
--   * `is_published` defaults to false. A row exists before anyone has decided
--     it is fit to show.

-- ============================================================
-- The table
-- ============================================================

create table if not exists public.prospect_profiles (
  id uuid primary key default gen_random_uuid(),

  -- The join key. Every one of the 150 participants carries an
  -- @sahabaclub.com mailbox taken from the round's own Members list, so this
  -- is the one identifier that exists for all of them. Unique because two
  -- prospect rows for one mailbox would produce two profiles for one person.
  ms365_mailbox text not null unique,

  -- Their own address, where the source recorded one. Needed because someone
  -- may sign up with Gmail rather than their mailbox — `link_my_prospect_profile`
  -- below matches on either, the same way 0021's linking does.
  email text,

  full_name text not null,

  -- The profile proper. Deliberately the same shape and the same names as the
  -- corresponding columns on `profiles`, so the claim path below is a copy
  -- rather than a translation, and so a reader comparing the two can see at a
  -- glance that nothing extra is being collected here.
  headline text,
  bio text,
  avatar_url text,
  city text,
  country text,
  industry text,
  company text,
  position text,
  years_experience int check (years_experience is null or years_experience between 0 and 70),
  skills text[] not null default '{}',
  interests text[] not null default '{}',
  links jsonb not null default '{}'::jsonb,        -- {linkedin, github, site}
  work_history jsonb not null default '[]'::jsonb, -- same shape as 0023

  -- Provenance. `{"bio": "linkedin:in/example", "skills": "sharepoint:EduHackAI_3/Members.Skills"}`
  -- One entry per populated field. This is what makes the claim "we did not
  -- invent anything" checkable a year from now instead of merely asserted.
  sources jsonb not null default '{}'::jsonb,

  built_at timestamptz,
  built_model text,          -- which model wrote it, for when one turns out to embellish

  -- Visibility is off until someone decides the row is worth showing.
  is_published boolean not null default false,

  -- Claimed, not converted. Set when the person signs up and links; the row is
  -- kept afterwards as the record of what was shown to them before they joined.
  claimed_by uuid references auth.users (id) on delete set null,
  claimed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.prospect_profiles is
  'A profile for a hackathon participant who has not signed up. No auth account exists for these people. Claimed into public.profiles when they join.';
comment on column public.prospect_profiles.sources is
  'Per-field provenance. A populated field with no entry here is a bug: it means something was written that nobody can trace to a source.';

create index if not exists prospect_profiles_email_idx
  on public.prospect_profiles (lower(email)) where email is not null;
create index if not exists prospect_profiles_unclaimed_idx
  on public.prospect_profiles (is_published) where claimed_by is null;

-- ============================================================
-- RLS: nothing reaches a client through the table itself
-- ============================================================
--
-- The table holds personal email addresses and tenant mailboxes. No client
-- role gets a policy on it at all — the only route to this data is the view
-- below, whose column list is the privacy boundary. Staff read it through the
-- service role or a SQL session.
--
-- Supabase grants ALL on a newly created table to anon and authenticated, so
-- the revoke is not defensive tidiness — without it this table is world
-- readable the moment it exists.
alter table public.prospect_profiles enable row level security;
revoke all on public.prospect_profiles from anon, authenticated;

-- ============================================================
-- The view Connect actually reads
-- ============================================================
--
-- `security_invoker = off` for the same reason `member_directory` is: it
-- aggregates `hackathon_participants`, which `authenticated` deliberately
-- cannot select, and the column list is what keeps that safe.
--
-- What is NOT here, and must never be added: `email`, `ms365_mailbox`,
-- `sources`. The first two are contact details for people who never agreed to
-- be contactable, and `sources` would republish a LinkedIn URL as evidence
-- even where the person did not list one publicly on the club's terms.
drop view if exists public.prospect_directory;

create view public.prospect_directory
with (security_invoker = off) as
select
  p.id,
  p.full_name, p.headline, p.bio, p.avatar_url,
  p.city, p.country, p.industry,
  p.company, p.position, p.years_experience,
  p.skills, p.interests, p.links, p.work_history,

  -- Same aggregate shape as `member_directory.hackathons` in 0023, so the
  -- Connect and profile renderers can treat a prospect and a member
  -- identically instead of branching on which kind of row they have. Joined on
  -- the mailbox, because a prospect has no user_id by definition.
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
    where lower(hp.ms365_mailbox) = lower(p.ms365_mailbox)
      and h.status <> 'draft'
  ), '[]'::jsonb) as hackathons,

  -- The flag the UI needs to tell the truth about what this row is. A prospect
  -- must never be rendered as though they are a member who is ignoring you.
  false as is_member,
  p.created_at
from public.prospect_profiles p
where p.is_published
  and p.claimed_by is null;   -- once claimed, they appear as a real member instead

revoke all on public.prospect_directory from anon, authenticated;
grant select on public.prospect_directory to authenticated;

-- ============================================================
-- Claiming
-- ============================================================
--
-- There are two callers with genuinely different authority, and collapsing
-- them into one function is a trap worth naming.
--
--   * The **signup trigger** runs inside `handle_new_user()` (0021), where
--     there is no JWT and `auth.uid()` is therefore NULL. A claim function
--     that reads `auth.uid()` does not fail there — it silently returns
--     without claiming anything, which is the worst possible failure mode.
--     So the trigger path needs the user id passed in.
--   * The **client** calls it as an RPC, where taking a parameter would make
--     it an enumeration oracle: anyone could ask "does this address have a
--     Sahaba profile waiting, and what does it say about them" for every
--     address they cared to guess. 0021 spells this out at length for its
--     three functions and the same reasoning applies exactly.
--
-- Hence: one internal implementation that takes an id and is revoked from
-- every client role, and one argument-less wrapper that is the only thing
-- `authenticated` may execute. **Do not grant execute on the internal one,
-- and do not add a parameter to the wrapper.**
create or replace function public.claim_prospect_for(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_row   public.prospect_profiles%rowtype;
  v_uid   uuid := p_user_id;
begin
  if v_uid is null then
    return null;
  end if;

  -- Confirmed only. Supabase creates the auth.users row before the address is
  -- verified, so without this check somebody could sign up as a person they
  -- are not and be handed that person's prepared profile.
  --
  -- This does mean the signup-trigger call is usually a no-op for email
  -- signups, because confirmation has not happened yet at that moment. That is
  -- intended, not an oversight — the wrapper below is called again from the
  -- client once the member is signed in and confirmed, and claiming is
  -- idempotent because it filters on `claimed_by is null`.
  select lower(u.email) into v_email
    from auth.users u
   where u.id = v_uid
     and u.email_confirmed_at is not null;

  if v_email is null then
    return null;
  end if;

  select * into v_row
    from public.prospect_profiles
   where claimed_by is null
     and (lower(ms365_mailbox) = v_email or lower(email) = v_email)
   limit 1;

  if not found then
    return null;
  end if;

  -- Copy into the real profile, but **only into fields the member has left
  -- empty**. A returning member who has already written their own bio must
  -- never have it overwritten by one an AI wrote about them. coalesce on the
  -- profile value first is the whole of that rule.
  update public.profiles p
     set headline        = coalesce(nullif(p.headline, ''), v_row.headline),
         bio             = coalesce(nullif(p.bio, ''), v_row.bio),
         city            = coalesce(nullif(p.city, ''), v_row.city),
         country         = coalesce(nullif(p.country, ''), v_row.country),
         industry        = coalesce(nullif(p.industry, ''), v_row.industry),
         company         = coalesce(nullif(p.company, ''), v_row.company),
         position        = coalesce(nullif(p.position, ''), v_row.position),
         years_experience = coalesce(p.years_experience, v_row.years_experience),
         skills          = case when coalesce(array_length(p.skills, 1), 0) = 0
                                then v_row.skills else p.skills end,
         interests       = case when coalesce(array_length(p.interests, 1), 0) = 0
                                then v_row.interests else p.interests end,
         links           = case when p.links = '{}'::jsonb then v_row.links else p.links end,
         work_history    = case when p.work_history = '[]'::jsonb
                                then v_row.work_history else p.work_history end,
         updated_at      = now()
   where p.user_id = v_uid;

  -- Deliberately NOT copied: `avatar_url`. The prospect avatar was drawn from
  -- a Microsoft 365 photo the person never uploaded to us. Once they have an
  -- account they choose their own picture, through the generator, on their own
  -- three-tries-a-month allowance.
  --
  -- Also deliberately NOT set: `is_discoverable`. It stays false until the
  -- member completes onboarding, which means **they see and approve everything
  -- above before any of it appears in Connect under their name.** That is the
  -- consent step, and it is load-bearing — without it the first time a person
  -- sees an AI-written biography of themselves is when another member reads it.

  update public.prospect_profiles
     set claimed_by = v_uid, claimed_at = now(), updated_at = now()
   where id = v_row.id;

  return v_row.id;
end;
$$;

-- The internal one is reachable by nobody except the trigger and the wrapper,
-- both of which are `security definer` and run as the owner. Granting execute
-- on this to `authenticated` would hand out the enumeration oracle the
-- argument-less wrapper exists to prevent.
revoke all on function public.claim_prospect_for(uuid) from public, anon, authenticated;

-- The client-facing wrapper. Takes no arguments, on purpose. See above.
create or replace function public.claim_my_prospect_profile()
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.claim_prospect_for(auth.uid());
$$;

-- security definer plus a wide-open EXECUTE is how a helper becomes a hole.
revoke all on function public.claim_my_prospect_profile() from public, anon;
grant execute on function public.claim_my_prospect_profile() to authenticated;

-- ============================================================
-- Wiring it into signup
-- ============================================================
--
-- 0021 rewrote `handle_new_user()` to call `link_contact_to_user` and
-- `link_hackathon_history`. This is the third such call, and it is appended
-- here rather than by editing 0021 because 0021 has already been applied in
-- production — an applied migration is a historical record and editing it
-- would make the file disagree with the database.
--
-- Guarded the same way 0021 guards its calls, and for the same reason: a
-- person failing to get their prepared profile is a support ticket, a person
-- failing to get an account is a lost member. Linking must never abort a
-- signup.
--
-- ⚠ This re-declares the whole function body, so it must stay in step with
-- 0021's version. If 0021's `handle_new_user` is ever changed again, this
-- block has to be updated too, or applying 0027 will quietly revert it.
-- Everything above the `claim_prospect_for` block is 0021's body **verbatim**,
-- copied rather than reconstructed. Reconstructing it from memory dropped the
-- `subscriptions` insert and got all three helper signatures wrong, which
-- would have shipped as "new members silently have no subscription row".
-- If you touch this, diff it against 0021 first.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  v_name := nullif(trim(coalesce(
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    concat_ws(' ',
      new.raw_user_meta_data ->> 'given_name',
      new.raw_user_meta_data ->> 'family_name')
  )), '');

  insert into public.profiles (user_id, full_name) values (new.id, v_name);
  insert into public.subscriptions (user_id) values (new.id);

  -- Linking must never be able to abort a signup. A person failing to get
  -- their history attached is a support ticket; a person failing to get an
  -- account is a lost member.
  begin
    perform public.link_contact_to_user(new.id, new.email);
  exception when others then
    raise warning 'link_contact_to_user failed for %: %', new.id, sqlerrm;
  end;

  if to_regclass('public.hackathon_participants') is not null then
    begin
      perform public.link_hackathon_history(new.id, new.email);
    exception when others then
      raise warning 'link_hackathon_history failed for %: %', new.id, sqlerrm;
    end;
  end if;

  -- New in 0027. Same guard, same reasoning.
  begin
    perform public.claim_prospect_for(new.id);
  exception when others then
    raise warning 'claim_prospect_for failed for %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- The table is unreachable by a client role (expect zero rows):
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'prospect_profiles' and grantee in ('anon','authenticated');
--
-- anon cannot read the directory either (expect zero rows):
--   select grantee from information_schema.role_table_grants
--    where table_name = 'prospect_directory' and grantee = 'anon';
--
-- The view leaks no contact details — the column list IS the boundary, so
-- check what it actually exposes rather than trusting the definition above:
--   select column_name from information_schema.columns
--    where table_name = 'prospect_directory';
--   -- expect NO email, ms365_mailbox or sources
--
-- The claim function takes no arguments (the enumeration-oracle guard, the
-- same property 0021 checks for its three functions):
--   select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'claim_my_prospect_profile';
--   -- expect exactly one row, args = '' (empty), prosecdef = true
--
-- Nothing is published by accident — a fresh import should be all false until
-- somebody reviews it:
--   select is_published, count(*) from public.prospect_profiles group by 1;
--
-- Every populated bio is traceable. This must return zero rows; if it does
-- not, something was written that nobody can attribute to a source:
--   select id, full_name from public.prospect_profiles
--    where bio is not null and bio <> '' and not (sources ? 'bio');
--
-- ⚠ This migration re-declares `handle_new_user`, so check it did not lose
-- anything 0021 put there. All four must appear in the body:
--   select prosrc from pg_proc where proname = 'handle_new_user';
--   -- expect: insert into public.subscriptions, link_contact_to_user,
--   --         link_hackathon_history, claim_prospect_for
--
-- And prove it end to end rather than by reading — create a throwaway signup
-- and confirm it still gets a subscription row, which is the specific thing a
-- careless rewrite of that function drops:
--   select count(*) from public.subscriptions s
--     join auth.users u on u.id = s.user_id
--    where u.created_at > now() - interval '5 minutes';
