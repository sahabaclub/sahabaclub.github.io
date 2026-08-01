-- Sahaba Club — personalised outreach
-- ------------------------------------------------------------
-- A campaign is a brief ("invite them to the September AI bootcamp, mention
-- the Microsoft 365 licence") plus a segment. From those, one draft is
-- written per person, using that person's own history — the events they came
-- to, the city they registered from, whether they already hold a mailbox.
--
-- The drafts are rows in a table rather than one blob per campaign, because
-- each one is a different letter and each one has to be readable, editable
-- and approvable on its own before it goes anywhere. Nothing is sent that a
-- human has not seen.
--
-- Three states matter and they are deliberately separate:
--   generated  the model wrote it
--   approved   a person read it and said yes
--   sent       it left the building
-- No path skips the middle one.

-- ============================================================
-- The campaign
-- ============================================================

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,

  -- What we want to say, in the sender's own words. This is the instruction
  -- given to the model, not the email itself — the email is written per
  -- person from this plus their history.
  brief text not null default '',

  -- Anything that must appear verbatim and must not be paraphrased: a date,
  -- a venue, a registration link, a price. Kept apart from the brief so the
  -- function can hold the model to it.
  must_include text,

  tone text not null default 'warm'
    check (tone in ('warm', 'formal', 'brief', 'enthusiastic')),
  language text not null default 'en'
    check (language in ('en', 'ar', 'match')),   -- match = mirror the contact

  -- The audience, stored as the filter that produced it rather than a frozen
  -- list, so the same campaign can be re-run and the definition is auditable
  -- six months later. Recipients below are the resolved snapshot.
  segment jsonb not null default '{}'::jsonb,

  from_name text not null default 'Sahaba Club',
  from_email text not null default 'membership@sahabaclub.com',
  reply_to text,

  status text not null default 'draft'
    check (status in ('draft', 'generating', 'review', 'sending', 'sent', 'cancelled')),

  -- Counters kept by the trigger below, so the list screen does not run a
  -- count over every recipient row per campaign.
  recipient_count int not null default 0,
  generated_count int not null default 0,
  approved_count int not null default 0,
  sent_count int not null default 0,
  failed_count int not null default 0,

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  notes text
);

create index if not exists campaigns_status_idx on public.campaigns (status, created_at desc);

-- ============================================================
-- One letter per person
-- ============================================================

create table if not exists public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  contact_id uuid not null references public.marketing_contacts (id) on delete cascade,

  -- Copied at resolve time. If the contact row is later corrected or deleted
  -- we still know exactly what was sent and to where — which is the point of
  -- a send log.
  email text not null,
  full_name text,

  subject text,
  body_text text,

  -- What the model was actually told about this person. Kept because when a
  -- draft says something wrong, the only useful question is what it was
  -- working from.
  context_used jsonb not null default '{}'::jsonb,
  model text,
  generated_at timestamptz,

  -- Set when a human edits the draft. An edited draft must never be silently
  -- regenerated and overwritten.
  edited boolean not null default false,

  status text not null default 'pending'
    check (status in ('pending', 'generated', 'approved', 'sending', 'sent', 'failed', 'skipped')),
  error text,

  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  sent_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A person appears at most once in a campaign. Without this, a re-resolve
-- after adding a filter would mail the same people twice.
create unique index if not exists campaign_recipients_unique
  on public.campaign_recipients (campaign_id, contact_id);

create index if not exists campaign_recipients_campaign_idx
  on public.campaign_recipients (campaign_id, status);

create index if not exists campaign_recipients_contact_idx
  on public.campaign_recipients (contact_id);

-- ============================================================
-- Opt-out
-- ============================================================

-- Every marketing email needs a working unsubscribe, and it has to work
-- without signing in — the recipient is not a member and never will be.
--
-- A random token per contact, not the email address: an unsubscribe URL
-- travels through mail servers, gets forwarded and ends up in logs, and an
-- address in a query string is exactly the sort of leak that a token avoids.
-- It also means nobody can unsubscribe a third party by guessing.
alter table public.marketing_contacts
  add column if not exists unsubscribe_token uuid not null default gen_random_uuid();

create unique index if not exists marketing_contacts_unsub_token_key
  on public.marketing_contacts (unsubscribe_token);

-- The one thing anon is allowed to do with this table, and it neither reads
-- nor returns anything about the person. An unknown token returns false
-- rather than raising, so the page cannot be used to test whether a token
-- exists any more than it already reveals.
create or replace function public.unsubscribe_by_token(p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  hit uuid;
begin
  update public.marketing_contacts
  set unsubscribed_at = coalesce(unsubscribed_at, now()),
      updated_at = now()
  where unsubscribe_token = p_token
  returning id into hit;

  return hit is not null;
end;
$fn$;

revoke all on function public.unsubscribe_by_token(uuid) from public;
grant execute on function public.unsubscribe_by_token(uuid) to anon, authenticated;

-- ============================================================
-- Counters
-- ============================================================

create or replace function public.refresh_campaign_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  target uuid := coalesce(new.campaign_id, old.campaign_id);
begin
  update public.campaigns c
  set recipient_count = sub.total,
      generated_count = sub.generated,
      approved_count  = sub.approved,
      sent_count      = sub.sent,
      failed_count    = sub.failed,
      updated_at = now()
  from (
    select
      count(*)                                                          as total,
      count(*) filter (where status in ('generated', 'approved', 'sending', 'sent')) as generated,
      count(*) filter (where status in ('approved', 'sending', 'sent'))  as approved,
      count(*) filter (where status = 'sent')                            as sent,
      count(*) filter (where status = 'failed')                          as failed
    from public.campaign_recipients where campaign_id = target
  ) sub
  where c.id = target;
  return null;
end;
$fn$;

drop trigger if exists campaign_recipients_counts on public.campaign_recipients;
create trigger campaign_recipients_counts
  after insert or update or delete on public.campaign_recipients
  for each row execute function public.refresh_campaign_counts();

-- A successful send updates the contact, so the next campaign can see when
-- this person was last written to and avoid burying them.
create or replace function public.touch_contact_on_send()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.status = 'sent' and (old.status is distinct from 'sent') then
    update public.marketing_contacts
    set last_emailed_at = now(), updated_at = now()
    where id = new.contact_id;
  end if;
  return new;
end;
$fn$;

drop trigger if exists campaign_recipients_touch_contact on public.campaign_recipients;
create trigger campaign_recipients_touch_contact
  after update on public.campaign_recipients
  for each row execute function public.touch_contact_on_send();

-- ============================================================
-- Access
-- ============================================================

alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;

drop policy if exists "campaigns: staff only" on public.campaigns;
create policy "campaigns: staff only" on public.campaigns
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists "campaign recipients: staff only" on public.campaign_recipients;
create policy "campaign recipients: staff only" on public.campaign_recipients
  for all using (public.is_staff()) with check (public.is_staff());

-- Supabase grants anon and authenticated everything on every new table, so
-- "we never granted it" is not the same as "it is not granted". Revoke, then
-- grant back only what staff pages need through the authenticated role.
revoke all on public.campaigns from anon;
revoke all on public.campaign_recipients from anon;

-- Verification — run these after applying, do not assume:
--
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name in ('campaigns','campaign_recipients') and grantee = 'anon';
--     -- must return zero rows
--
--   select has_function_privilege('anon', 'public.unsubscribe_by_token(uuid)', 'execute');
--     -- must be true, this is the one deliberate exception
--
--   select count(*) from public.marketing_contacts where unsubscribe_token is null;
--     -- must be 0
