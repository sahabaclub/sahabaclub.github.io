-- 0054 — per-section admin permissions, and the Operations Manager role
-- ============================================================
--
-- ⚠ RUN 0053 FIRST, AS A SEPARATE STATEMENT. It adds the enum labels this file
-- uses, and Postgres refuses to use a new enum value in the transaction that
-- created it.
--
-- Ahmed's ask: Ghadir Kamal Aldesouky joins as Operations Manager with access
-- to Events, Organizers, EduHackAI Interest, Marketing Contacts and Campaigns
-- — and nothing else.
--
-- ============================================================
-- ⚠ WHY SHE IS NOT "STAFF", AND WHY THAT IS THE ENTIRE POINT
-- ============================================================
--
-- `is_staff()` is a single universal gate. It is referenced 134 times across
-- 26 migrations, and every table behind app/admin is protected by it and
-- nothing finer. So a person who satisfies is_staff() can read and write:
-- every member profile, the Data panel's 2,200 marketing contacts with their
-- emails and mobile numbers, PromptArena's legacy player directory, the AI
-- service prompts, and the notification broadcaster.
--
-- Giving Ghadir `staff` and hiding the menu items she should not see would be
-- a LIE THE PAGE TELLS. The nav is a convenience; the tables would still
-- answer her, and a URL typed by hand — or any REST call with her own session
-- token — would reach all of it. This project has written "the gate is in the
-- database, not the page" into four files; this is the migration where that
-- sentence has to be true or abandoned.
--
-- So `operations_manager` satisfies is_staff() NOWHERE. Access is granted by
-- ADDITIVE policies on exactly five areas. Nothing existing is modified, so
-- Ahmed's access cannot regress as a side effect — RLS policies are permissive
-- and OR together, which is what makes "add, never edit" safe here.

-- ============================================================
-- 1. What can be granted
-- ============================================================
--
-- A catalogue rather than a hardcoded list, so a future role needs data and
-- not a code change. The keys match the admin page filenames, which is what
-- lets lib/admin-guard.js filter the nav and each page assert its own section
-- without a second mapping to keep in step.

create table if not exists public.admin_sections (
  key text primary key,
  label text not null,
  sort_order int not null default 100
);

insert into public.admin_sections (key, label, sort_order) values
  ('overview',    'Overview',            10),
  ('members',     'Members',             20),
  ('events',      'Events',              30),
  ('organizers',  'Organizers',          35),
  ('interest',    'EduHackAI interest',  40),
  ('licences',    'Microsoft 365',       50),
  ('contacts',    'Marketing contacts',  60),
  ('campaigns',   'Campaigns',           70),
  ('notify',      'Notifications',       80),
  ('data',        'Data',                90),
  ('promptarena', 'PromptArena',        100),
  ('ai',          'AI services',        110),
  ('newsletter',  'Newsletter',         120)
on conflict (key) do update set label = excluded.label, sort_order = excluded.sort_order;

-- ============================================================
-- 2. Who gets what
-- ============================================================
--
-- ⚠ `role` is TEXT here, not member_role, and deliberately. A migration cannot
-- use an enum label in the same transaction that added it (see 0053), and a
-- text column sidesteps that entirely — `has_admin_section` casts
-- profiles.role to text to compare. The foreign key on `section` is what stops
-- a typo becoming a silently-ungranted permission.

create table if not exists public.role_permissions (
  role text not null,
  section text not null references public.admin_sections (key) on delete cascade,
  primary key (role, section)
);

-- Operations Manager: exactly the five Ahmed named. Nothing here reaches
-- member profiles, the Data panel, PromptArena, AI services or the
-- notification broadcaster.
insert into public.role_permissions (role, section) values
  ('operations_manager', 'events'),
  ('operations_manager', 'organizers'),
  ('operations_manager', 'interest'),
  ('operations_manager', 'contacts'),
  ('operations_manager', 'campaigns')
on conflict do nothing;

-- ⚠ `global_admin` and `admin` get NO rows here, on purpose. They are answered
-- by the `is_staff()` short-circuit in has_admin_section() below. Listing every
-- section against them would mean a section added later is silently ungranted
-- to the administrator until somebody remembers to add a row — which is
-- exactly the kind of quiet omission this schema should not depend on.

alter table public.admin_sections enable row level security;
alter table public.role_permissions enable row level security;

-- Readable by any signed-in member: it is a catalogue of section names, and
-- the nav needs it. It grants nothing — the policies in §4 do.
drop policy if exists "admin sections: readable" on public.admin_sections;
create policy "admin sections: readable" on public.admin_sections
  for select using (auth.uid() is not null);

drop policy if exists "role permissions: readable" on public.role_permissions;
create policy "role permissions: readable" on public.role_permissions
  for select using (auth.uid() is not null);

-- ⚠ Writable by nobody through the API. Changing who may reach the Data panel
-- must be a migration or a SQL session, not a request — there is no admin
-- screen for this and there should not be one until somebody has thought
-- about privilege escalation.
revoke all on public.admin_sections from anon, authenticated;
revoke all on public.role_permissions from anon, authenticated;
grant select on public.admin_sections to authenticated;
grant select on public.role_permissions to authenticated;

-- ============================================================
-- 3. The gate
-- ============================================================

create or replace function public.has_admin_section(p_section text)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    -- A full administrator has every section, including ones added after this
    -- migration was written.
    public.is_staff()
    or exists (
      select 1
        from public.profiles p
        join public.role_permissions rp on rp.role = p.role::text
       where p.user_id = auth.uid()
         and rp.section = p_section
    );
$$;

comment on function public.has_admin_section is
  'Per-section admin permission. is_staff() short-circuits it for full '
  'administrators; everyone else is answered from role_permissions.';

-- What the signed-in person may reach, for the nav. Answers only about the
-- caller, so it is safe to grant to `authenticated`.
create or replace function public.my_admin_sections()
returns setof text
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select s.key
    from public.admin_sections s
   where public.has_admin_section(s.key)
   order by s.sort_order;
$$;

revoke execute on function public.has_admin_section(text) from public, anon;
revoke execute on function public.my_admin_sections() from public, anon;
grant execute on function public.has_admin_section(text) to authenticated;
grant execute on function public.my_admin_sections() to authenticated;

-- `global_admin` must be staff. Replacing is_staff() rather than adding a new
-- function, because 134 policy references already call this one — a parallel
-- function would mean two answers to the same question, and the day they
-- disagreed would be a very bad day.
create or replace function public.is_staff()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid()
      and role in ('staff', 'admin', 'global_admin')
  );
$$;

-- ============================================================
-- 4. Her five areas — ADDITIVE policies, nothing existing touched
-- ============================================================

-- ---- Events ----
drop policy if exists "events: section insert" on public.events;
create policy "events: section insert" on public.events
  for insert with check (public.has_admin_section('events'));
drop policy if exists "events: section update" on public.events;
create policy "events: section update" on public.events
  for update using (public.has_admin_section('events')) with check (public.has_admin_section('events'));
drop policy if exists "events: section delete" on public.events;
create policy "events: section delete" on public.events
  for delete using (public.has_admin_section('events'));
-- Reading published events is already public (0003); drafts need the section.
drop policy if exists "events: section read drafts" on public.events;
create policy "events: section read drafts" on public.events
  for select using (public.has_admin_section('events'));

-- ---- Organizers ----
drop policy if exists "organizers: section write" on public.organizers;
create policy "organizers: section write" on public.organizers
  for all using (public.has_admin_section('organizers'))
  with check (public.has_admin_section('organizers'));

-- Either section, because the link is edited from BOTH screens: the events
-- editor assigns organizers to an event, and the organizers screen is where
-- they come from.
drop policy if exists "event organizers: section write" on public.event_organizers;
create policy "event organizers: section write" on public.event_organizers
  for all using (public.has_admin_section('events') or public.has_admin_section('organizers'))
  with check (public.has_admin_section('events') or public.has_admin_section('organizers'));

-- ---- EduHackAI interest ---- (read-only by design; 0036's page never writes)
drop policy if exists "hackathon interest: section read" on public.hackathon_interest;
create policy "hackathon interest: section read" on public.hackathon_interest
  for select using (public.has_admin_section('interest'));

-- ---- Marketing contacts ----
drop policy if exists "marketing contacts: section rw" on public.marketing_contacts;
create policy "marketing contacts: section rw" on public.marketing_contacts
  for all using (public.has_admin_section('contacts'))
  with check (public.has_admin_section('contacts'));

-- ---- Campaigns ----
drop policy if exists "campaigns: section rw" on public.campaigns;
create policy "campaigns: section rw" on public.campaigns
  for all using (public.has_admin_section('campaigns'))
  with check (public.has_admin_section('campaigns'));

drop policy if exists "campaign recipients: section rw" on public.campaign_recipients;
create policy "campaign recipients: section rw" on public.campaign_recipients
  for all using (public.has_admin_section('campaigns'))
  with check (public.has_admin_section('campaigns'));

-- ---- Event images ----
--
-- ⚠ Easy to miss and immediately visible if missed: the events editor uploads
-- artwork, and the bucket policy from 0007 is is_staff()-only. Without this
-- she can create an event and not give it a picture.
drop policy if exists "event images: section insert" on storage.objects;
create policy "event images: section insert" on storage.objects
  for insert with check (bucket_id = 'event-images' and public.has_admin_section('events'));

drop policy if exists "event images: section update" on storage.objects;
create policy "event images: section update" on storage.objects
  for update using (bucket_id = 'event-images' and public.has_admin_section('events'));

-- ============================================================
-- 5. Ghadir's account
-- ============================================================
--
-- ⚠ NOBODY CAN CREATE HER AUTH ACCOUNT FROM HERE, and it should not be
-- possible: it would mean setting a password on somebody else's behalf. She
-- signs up herself, with either of her addresses, and this pre-authorises the
-- role so nothing has to be remembered afterwards.
--
-- Matching on a CONFIRMED email is the security property. Supabase confirms an
-- address before the account is usable, so only the person holding that inbox
-- can claim the invite.

create table if not exists public.admin_invites (
  email text primary key check (email = lower(trim(email))),
  role text not null,
  full_name text,
  note text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by uuid references auth.users (id) on delete set null
);

alter table public.admin_invites enable row level security;

-- ⚠ Staff-only READ and no client write at all. An invite row is a statement
-- that a named address will become privileged; a member who could read it
-- learns who to phish, and one who could write it grants themselves the Data
-- panel.
drop policy if exists "admin invites: staff read" on public.admin_invites;
create policy "admin invites: staff read" on public.admin_invites
  for select using (public.is_staff());

revoke all on public.admin_invites from anon, authenticated;
grant select on public.admin_invites to authenticated;

insert into public.admin_invites (email, role, full_name, note) values
  ('redacted@example.invalid', 'operations_manager', 'Ghadir Kamal Aldesouky',
   'Personal address — the one she will most likely sign up with.'),
  ('ghadir@sahabaclub.com',      'operations_manager', 'Ghadir Kamal Aldesouky',
   'Club mailbox. Listed so either route claims the same role.')
on conflict (email) do update set
  role = excluded.role,
  full_name = excluded.full_name;

-- ---- Applied at signup -----------------------------------------------------
--
-- ⚠ Wrapped so it can NEVER abort a signup, exactly like the three helpers
-- already in this trigger. The existing comment says it best: "A person
-- failing to get their history attached is a support ticket; a person failing
-- to get an account is a lost member." A failure to apply a role is a support
-- ticket too.

create or replace function public.claim_admin_invite(p_user_id uuid, p_email text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
begin
  if p_email is null then return false; end if;

  select role into v_role
    from public.admin_invites
   where email = lower(trim(p_email))
     and claimed_at is null;

  if v_role is null then return false; end if;

  -- Only roles that exist. A typo in an invite must not be able to write a
  -- meaningless role onto a profile.
  if v_role not in ('operations_manager', 'staff') then
    raise warning 'claim_admin_invite: refusing unknown role %', v_role;
    return false;
  end if;

  update public.profiles set role = v_role::public.member_role where user_id = p_user_id;
  update public.admin_invites
     set claimed_at = now(), claimed_by = p_user_id
   where email = lower(trim(p_email));

  return true;
end;
$$;

revoke execute on function public.claim_admin_invite(uuid, text) from public, anon, authenticated;

-- ⚠ `admin` and `global_admin` are NOT claimable by invite, by omission above.
-- An email-matched invite that could mint a full administrator would make a
-- compromised inbox a total compromise of the club. Those two are assigned by
-- hand, in a SQL session, by somebody who already has them.

-- ---- Wiring it into signup -------------------------------------------------
--
-- ⚠ REPRODUCED IN FULL from 0027, with ONE block added. `create or replace`
-- replaces the whole body, so anything omitted here would be silently deleted
-- from the signup path — the profile row, the subscription row, contact
-- linking, hackathon history, prospect claiming. All five are below unchanged;
-- the new block is the last one before `return new`.
--
-- The guard around it is not decoration. Three helpers here already carry the
-- same `begin/exception` wrapper for the reason 0027 wrote down: "A person
-- failing to get their history attached is a support ticket; a person failing
-- to get an account is a lost member." A failure to apply a role is a support
-- ticket too — Ghadir signing up and arriving as an ordinary member is
-- recoverable with one UPDATE; Ghadir being unable to sign up at all is not.

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

  -- New in 0054. Same guard, same reasoning.
  begin
    perform public.claim_admin_invite(new.id, new.email);
  exception when others then
    raise warning 'claim_admin_invite failed for %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

-- ============================================================
-- 6. Ahmed
-- ============================================================
--
-- `admin` keeps working — is_staff() above still admits it — so this is a
-- relabelling, not a privilege change. Done as an UPDATE over the existing
-- administrators rather than a hardcoded user id.
--
-- ⚠⚠ DEPLOY THE CLIENT BEFORE RUNNING THIS LINE. It locked Ahmed out of his
-- own dashboard for real, on 6 Aug, and the lesson is worth more than the
-- line: **the database and the browser are deployed separately, and a value
-- the client does not recognise is a lockout.**
--
-- lib/admin-guard.js used to test `role === 'admin' || role === 'staff'`. The
-- moment this UPDATE ran, the live JS stopped recognising the only
-- administrator — and GitHub Pages was mid-deploy on an older commit, so the
-- fix was ten-plus minutes away. Rolling the label back was instant and cost
-- nothing, because 'admin' already grants everything: is_staff() admits both
-- and has_admin_section() short-circuits on it. The relabel is COSMETIC.
--
-- So it is left commented out. Run it by hand, as a one-liner, once
-- www.sahabaclub.ai/lib/admin-guard.js contains the string 'global_admin':
--
--   update public.profiles set role = 'global_admin' where role = 'admin';
--
-- Check first, do not assume the deploy landed:
--   curl -s https://www.sahabaclub.ai/lib/admin-guard.js | grep -c global_admin
--
-- ⚠ Nothing else in this migration depends on it. Ghadir's role, the section
-- permissions and every policy above work exactly the same with Ahmed as
-- 'admin'.

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. Ahmed is a global admin and still passes is_staff() (expect 1, true):
--
--   select count(*) from public.profiles where role = 'global_admin';
--   -- then, SIGNED IN AS AHMED:
--   select public.is_staff();                          -- expect true
--   select public.has_admin_section('data');           -- expect true
--   select count(*) from public.my_admin_sections();   -- expect 13
--
-- 2. The invite is waiting and unclaimed (expect 2 rows, claimed_at null):
--
--   select email, role, claimed_at from public.admin_invites;
--
-- 3. ⚠ THE CHECKS THAT MATTER, AND THEY NEED GHADIR'S OWN SESSION. Everything
--    above can be true while the thing that matters is false. Once she has
--    signed up, SIGNED IN AS HER:
--
--   select public.is_staff();                          -- expect FALSE
--   select array_agg(s) from public.my_admin_sections() s;
--      -- expect exactly: events, organizers, interest, contacts, campaigns
--
--    She can do her job:
--   insert into public.events (title, event_date) values ('Ops probe', '2030-01-01');
--   select count(*) from public.organizers;
--   select count(*) from public.hackathon_interest;
--   select count(*) from public.marketing_contacts;
--   select count(*) from public.campaigns;
--   delete from public.events where title = 'Ops probe';
--
--    ⚠ And she cannot do anybody else's. EVERY ONE of these must return zero
--    rows or raise — a non-zero answer means the section model is decorative:
--   select count(*) from public.profiles;              -- expect 1 (her own)
--   select count(*) from public.ms365_accounts;        -- expect 0
--   select count(*) from public.notification_broadcasts;  -- expect 0
--   select count(*) from public.promptarena_outreach_candidates;  -- expect 0
--   select public.staff_send_notification(null, 'system_message', 'nope');  -- expect: staff only
--
-- 4. She can upload event artwork (the policy that is easiest to forget):
--
--   -- as Ghadir, from the admin events editor: add an image to an event.
--   -- A failure here is the storage policy in §4, not the form.
--
-- 5. No role gained a section by accident (expect only the five ops rows):
--
--   select role, string_agg(section, ', ' order by section)
--     from public.role_permissions group by role;
