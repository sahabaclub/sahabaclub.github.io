-- Sahaba Club — everyone who has ever engaged with the club
-- ------------------------------------------------------------
-- Twelve spreadsheets of event registrations, check-ins, votes and intern
-- applications: 1,588 rows that collapse to about 925 real people. This is
-- the audience for newsletters and for the personalised outreach, and it is
-- also how a Microsoft 365 mailbox gets connected back to a human being.
--
-- Two tables rather than one, because a person and an interaction are
-- different things. Flattening them would either lose the history or repeat
-- the person's details once per event — and the history is the whole point:
-- "you registered for EduHackAI-1 in Cairo, came to the demo day and voted
-- for Team 3" is a different email from anything a single flat row supports.
--
-- Everything here is personal data belonging to people who are NOT members
-- yet. Staff only, on every table, with anon revoked outright.

-- ============================================================
-- People
-- ============================================================

create table if not exists public.marketing_contacts (
  id uuid primary key default gen_random_uuid(),

  -- Lowercased and trimmed on the way in. The unique index below is what
  -- actually collapses the 42% duplication across the source files.
  email text not null,
  email_valid boolean not null default true,

  full_name text,
  first_name text,
  last_name text,

  -- Kept as supplied as well as normalised: the source formats vary wildly
  -- (101030040, 213777476984, 971504216499) and a bad normalisation should
  -- never destroy the only contact detail we hold.
  phone_raw text,
  phone_e164 text,

  country text,             -- normalised: Egypt / مصر / Cairo all become Egypt
  country_raw text,
  city text,
  date_of_birth date,

  linkedin_url text,
  github_url text,

  university_or_company text,
  occupation text,                       -- studying, working, both
  tech_experience text,

  -- Free-text from "How did you hear about...". An array because the answer
  -- differs per event and all of them are worth keeping.
  how_heard text[] not null default '{}',

  -- The bridge to Microsoft 365. "FREE Registration in Sahaba Club" carries a
  -- Sahaba Club username for all 331 of its rows, 329 of them alongside a
  -- personal email — which is how ~329 of the 520 mailboxes get a face.
  sahaba_username text,
  sahaba_mailbox text,

  says_member boolean,                   -- what they claimed on a form

  -- Filled in when this person registers on sahabaclub.ai. From that moment
  -- the club knows the whole history of someone it previously only had an
  -- email for.
  linked_user_id uuid references auth.users (id) on delete set null,
  linked_at timestamptz,

  -- Quality and consent.
  --
  -- These people handed over an address to attend an event, not to receive
  -- open-ended marketing. Unsubscribe is tracked from the first day rather
  -- than retrofitted, and a hard bounce is recorded so the same dead address
  -- is not retried — bounces are what destroy a sender reputation, and the
  -- DKIM/SPF setup is only worth having if it is protected.
  is_test boolean not null default false,
  unsubscribed_at timestamptz,
  bounced_at timestamptz,
  last_emailed_at timestamptz,

  -- Denormalised so the admin list can sort by "most engaged" without a
  -- count(*) over the engagement table on every page load.
  engagement_count int not null default 0,
  first_seen_at timestamptz,
  last_seen_at timestamptz,

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists marketing_contacts_email_key
  on public.marketing_contacts (lower(email));

create index if not exists marketing_contacts_engagement_idx
  on public.marketing_contacts (engagement_count desc);

create index if not exists marketing_contacts_mailbox_idx
  on public.marketing_contacts (lower(sahaba_mailbox));

create index if not exists marketing_contacts_linked_idx
  on public.marketing_contacts (linked_user_id);

-- Mailable = a valid address, not a test row, not unsubscribed, not bounced.
-- Defined once here so no future query re-invents it and quietly emails
-- someone who opted out.
create index if not exists marketing_contacts_mailable_idx
  on public.marketing_contacts (lower(email))
  where email_valid and not is_test and unsubscribed_at is null and bounced_at is null;

-- ============================================================
-- Interactions
-- ============================================================

create table if not exists public.contact_engagements (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.marketing_contacts (id) on delete cascade,

  source_file text not null,
  event_name text,
  engagement_type text not null default 'other'
    check (engagement_type in ('registration', 'checkin', 'voting', 'application', 'other')),

  occurred_at timestamptz,

  -- Whatever that particular form asked and this table has no column for:
  -- voting scores, intern application answers, attendance preferences.
  details jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

create index if not exists contact_engagements_contact_idx
  on public.contact_engagements (contact_id);
create index if not exists contact_engagements_event_idx
  on public.contact_engagements (event_name);

-- Re-importing a corrected spreadsheet must update, not duplicate. One row
-- per person per file per interaction type is the natural grain.
create unique index if not exists contact_engagements_unique
  on public.contact_engagements (contact_id, source_file, engagement_type);

-- ============================================================
-- Import audit
-- ============================================================

create table if not exists public.contact_imports (
  id uuid primary key default gen_random_uuid(),
  source_file text not null,
  event_name text,
  engagement_type text,
  rows_read int not null default 0,
  contacts_created int not null default 0,
  contacts_updated int not null default 0,
  engagements_added int not null default 0,
  rows_skipped int not null default 0,
  skip_reasons jsonb not null default '{}'::jsonb,
  imported_by uuid references auth.users (id) on delete set null,
  imported_at timestamptz not null default now(),
  notes text
);

-- ============================================================
-- Access
-- ============================================================

alter table public.marketing_contacts enable row level security;
alter table public.contact_engagements enable row level security;
alter table public.contact_imports enable row level security;

-- Staff only, all three. A member has no business reading the personal
-- details of 900 people who never joined.
drop policy if exists "contacts: staff only" on public.marketing_contacts;
create policy "contacts: staff only" on public.marketing_contacts
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists "engagements: staff only" on public.contact_engagements;
create policy "engagements: staff only" on public.contact_engagements
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists "imports: staff only" on public.contact_imports;
create policy "imports: staff only" on public.contact_imports
  for all using (public.is_staff()) with check (public.is_staff());

-- Supabase grants anon and authenticated everything on new tables. RLS would
-- stop a read anyway, but there is no reason for the grant to exist at all on
-- tables holding other people's phone numbers and dates of birth.
revoke all on public.marketing_contacts from anon;
revoke all on public.contact_engagements from anon;
revoke all on public.contact_imports from anon;

-- ============================================================
-- Keeping the counters honest
-- ============================================================

-- engagement_count and the seen dates exist for sorting and segmentation, so
-- they have to be maintained where the writes happen rather than by whoever
-- remembers to update them.
create or replace function public.refresh_contact_engagement_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target uuid := coalesce(new.contact_id, old.contact_id);
begin
  update public.marketing_contacts c
  set engagement_count = sub.n,
      first_seen_at = sub.first_at,
      last_seen_at = sub.last_at,
      updated_at = now()
  from (
    select count(*) as n, min(occurred_at) as first_at, max(occurred_at) as last_at
    from public.contact_engagements where contact_id = target
  ) sub
  where c.id = target;
  return null;
end;
$fn$;

drop trigger if exists contact_engagements_stats on public.contact_engagements;
create trigger contact_engagements_stats
  after insert or update or delete on public.contact_engagements
  for each row execute function public.refresh_contact_engagement_stats();

-- ============================================================
-- Connecting a contact to a member when they sign up
-- ============================================================

-- Someone who attended three events and then registers on sahabaclub.ai
-- should not become a stranger. Matching happens on email, and on the
-- @sahabaclub.com mailbox, which is why sahaba_mailbox is stored.
create or replace function public.link_contact_to_user(p_user_id uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  hit uuid;
begin
  update public.marketing_contacts
  set linked_user_id = p_user_id, linked_at = now(), updated_at = now()
  where linked_user_id is null
    and (lower(email) = lower(p_email) or lower(sahaba_mailbox) = lower(p_email))
  returning id into hit;
  return hit;
end;
$fn$;

revoke all on function public.link_contact_to_user(uuid, text) from public, anon, authenticated;

-- Verification:
--
--   select count(*) from public.marketing_contacts;                    -- ~925
--   select count(*) from public.contact_engagements;                   -- ~1460
--   select engagement_count, count(*) from public.marketing_contacts
--     group by 1 order by 1 desc;                                      -- the warm tail
--   select count(*) from public.marketing_contacts
--     where sahaba_mailbox is not null;                                -- ~329
