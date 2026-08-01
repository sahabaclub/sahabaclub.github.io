-- Sahaba Club — linking a new signup to the person we already knew
-- ------------------------------------------------------------
-- Requires 0020 for the hackathon source, but degrades without it: every
-- reference to hackathon_participants is guarded by to_regclass, so this
-- migration applies and works whether or not 0020 has run.
--
-- The problem this solves: most people who already have an
-- @sahabaclub.com mailbox will sign up on sahabaclub.ai with something
-- else — Gmail, LinkedIn, a personal address, or a *different* Microsoft
-- account. Their history and their mailbox are then two strangers.
--
-- We already hold the join. `marketing_contacts` carries a personal email
-- alongside `sahaba_mailbox` for ~329 people, and (with 0020) every one of
-- the 150 hackathon participants carries both. So the member never has to
-- tell us their mailbox — we tell them.
--
-- THE SECURITY PROPERTY, and the reason every function here takes no
-- arguments: the lookup key is always `auth.uid()`'s own confirmed email,
-- read server-side. A function that accepted an email would be an
-- enumeration oracle — anyone could ask "does bob@gmail.com have a Sahaba
-- mailbox, and what is it?" for every address they own or guess. Taking no
-- input makes that impossible rather than merely discouraged. Do not add a
-- parameter to any of these three functions.
--
-- The confirmation check matters just as much. Supabase creates the
-- auth.users row before the address is verified, so without it someone
-- could sign up as a person they are not and be handed that person's
-- mailbox.

-- ============================================================
-- Attach history the moment an account is created
-- ============================================================

-- Both link functions have existed since 0010 and 0020 and have never had
-- a single caller — no trigger, no Edge Function, no client code — which
-- is why every marketing contact still has linked_user_id = null. They are
-- security definer and revoked from every client role, so the trigger is
-- the correct place to call them from.
--
-- full_name is also copied out of the OAuth provider's metadata here. It
-- used to be written only at onboarding *step 2*, while provision-ms365
-- reads it at *step 1* — so displayName fell back to the email address and
-- every generated mailbox looked like ahmedrazeknhgmailcom@sahabaclub.com.
-- Populating it at creation fixes that ordering bug at the root.
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

  return new;
end;
$$;

-- ============================================================
-- Password-reset requests
-- ============================================================

-- When a member recognises their mailbox but has lost the password, the
-- reset is done BY A HUMAN, deliberately. provision-ms365's `reset` branch
-- resets whatever mailbox it is handed, with no proof of ownership, and
-- mails the new password to whoever asked — so this flow does not call it.
-- It records a request and emails Ahmed instead.
--
-- The row is the durable part. The email is a convenience on top: if the
-- notifying Edge Function is not deployed, or Resend is down, the request
-- is still here and still shows up in admin. Nothing is lost to a failed
-- send.
create table if not exists public.ms365_reset_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- Captured at request time rather than joined at read time. These people
  -- may later edit their profile or unsubscribe, and Ahmed needs to see
  -- what was true when they asked — this is the evidence for a manual
  -- password reset on a real mailbox.
  mailbox text not null,
  personal_email text not null,
  full_name text,
  phone text,
  member_since timestamptz,
  contact_source text,

  status text not null default 'pending'
    check (status in ('pending', 'emailed', 'done', 'rejected')),
  notified_at timestamptz,
  handled_at timestamptz,
  handled_by uuid references auth.users (id) on delete set null,
  notes text,

  created_at timestamptz not null default now()
);

create index if not exists ms365_reset_requests_status_idx
  on public.ms365_reset_requests (status, created_at desc);

-- One open request per person. Asking twice should not produce two jobs
-- for Ahmed; it should be the same job.
create unique index if not exists ms365_reset_requests_one_open
  on public.ms365_reset_requests (user_id)
  where status in ('pending', 'emailed');

-- ============================================================
-- Who am I, and do we already know your mailbox?
-- ============================================================

-- Returns at most one row. `mailbox` is the thing the member is shown, so
-- everything about this function is written to make sure it can only ever
-- be *their* mailbox.
create or replace function public.my_ms365_match()
returns table (
  mailbox text,
  source text,
  already_linked boolean,
  display_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_confirmed timestamptz;
  v_mailbox text;
  v_source text;
  v_name text;
begin
  if v_uid is null then
    return;
  end if;

  select u.email, u.email_confirmed_at into v_email, v_confirmed
  from auth.users u where u.id = v_uid;

  -- An unconfirmed address proves nothing about who is asking.
  if v_email is null or v_confirmed is null then
    return;
  end if;

  -- Already linked: report it rather than offering to link again.
  select a.mailbox into v_mailbox from public.ms365_accounts a where a.user_id = v_uid;
  if v_mailbox is not null then
    return query select v_mailbox, 'linked'::text, true, null::text;
    return;
  end if;

  -- Source 1: the marketing contact list, the largest join we hold.
  select c.sahaba_mailbox, c.full_name into v_mailbox, v_name
  from public.marketing_contacts c
  where lower(c.email) = lower(v_email)
    and c.sahaba_mailbox is not null
    and length(trim(c.sahaba_mailbox)) > 0
  order by c.updated_at desc nulls last
  limit 1;

  if v_mailbox is not null then
    v_source := 'contact';
  elsif to_regclass('public.hackathon_participants') is not null then
    -- Source 2: hackathon rounds. Matches the personal email only — never
    -- ms365_mailbox, because matching a tenant mailbox against a *personal*
    -- login would hand the account to whoever registered that address.
    execute $q$
      select p.ms365_mailbox, p.full_name
      from public.hackathon_participants p
      where lower(p.email) = lower($1)
        and p.ms365_mailbox is not null
        and length(trim(p.ms365_mailbox)) > 0
      limit 1
    $q$ into v_mailbox, v_name using v_email;
    if v_mailbox is not null then
      v_source := 'hackathon';
    end if;
  end if;

  if v_mailbox is null then
    return;
  end if;

  -- A mailbox already claimed by a different member is not offered. That
  -- is a genuine collision needing a human, not something to resolve by
  -- guessing.
  if exists (select 1 from public.ms365_accounts a
              where lower(a.mailbox) = lower(v_mailbox) and a.user_id <> v_uid) then
    return;
  end if;

  return query select v_mailbox, v_source, false, v_name;
end;
$fn$;

-- ============================================================
-- "Yes, I know the password" — link the two accounts
-- ============================================================

-- Takes no mailbox: it re-runs the match and links whatever that returns,
-- so the client cannot substitute a different address between the two
-- calls. pre_existing is what distinguishes a reclaimed mailbox from one
-- provision-ms365 created.
create or replace function public.link_my_ms365_mailbox()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_mailbox text;
  v_linked boolean;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  select m.mailbox, m.already_linked into v_mailbox, v_linked
  from public.my_ms365_match() m;

  if v_mailbox is null then
    raise exception 'no Microsoft 365 account is on record for your email address';
  end if;
  if v_linked then
    return v_mailbox;
  end if;

  insert into public.ms365_accounts (user_id, mailbox, status, pre_existing)
  values (v_uid, v_mailbox, 'active', true)
  on conflict (user_id) do update
    set mailbox = excluded.mailbox,
        pre_existing = true,
        updated_at = now();

  return v_mailbox;
end;
$fn$;

-- ============================================================
-- "No, please reset it" — raise a request for Ahmed
-- ============================================================

-- Gathers the context Ahmed asked for so the email is actionable on its
-- own: who this is, how to reach them, how long they have been around and
-- where they came from.
create or replace function public.request_ms365_password_reset()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_mailbox text;
  v_name text;
  v_phone text;
  v_since timestamptz;
  v_source text;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  select m.mailbox into v_mailbox from public.my_ms365_match() m;
  if v_mailbox is null then
    raise exception 'no Microsoft 365 account is on record for your email address';
  end if;

  select u.email, u.phone into v_email, v_phone from auth.users u where u.id = v_uid;

  -- Contact details, best available. The marketing contact row is richer
  -- than the fresh profile for exactly the people this flow is for.
  select coalesce(c.full_name, p.full_name),
         coalesce(nullif(c.phone_e164, ''), nullif(c.phone_raw, ''), v_phone),
         c.first_seen_at,
         nullif(array_to_string(c.how_heard, ', '), '')
    into v_name, v_phone, v_since, v_source
  from public.profiles p
  left join public.marketing_contacts c on lower(c.email) = lower(v_email)
  where p.user_id = v_uid;

  -- Fall back to the strongest evidence of where they came from: the file
  -- and event that first brought them into the list.
  if v_source is null then
    select nullif(concat_ws(' — ', e.event_name, e.source_file), '')
      into v_source
    from public.contact_engagements e
    join public.marketing_contacts c on c.id = e.contact_id
    where lower(c.email) = lower(v_email)
    order by e.occurred_at asc nulls last
    limit 1;
  end if;

  insert into public.ms365_reset_requests
    (user_id, mailbox, personal_email, full_name, phone, member_since, contact_source)
  values
    (v_uid, v_mailbox, v_email, v_name, v_phone, v_since, v_source)
  on conflict (user_id) where status in ('pending', 'emailed')
  do update set mailbox = excluded.mailbox
  returning id into v_id;

  return v_id;
end;
$fn$;

-- ============================================================
-- Access
-- ============================================================

alter table public.ms365_reset_requests enable row level security;

-- These rows are a member's own support ticket, and a queue for staff.
-- Nobody inserts directly — the function above is the only writer, which
-- is what stops someone raising a request for a mailbox that is not theirs.
drop policy if exists "reset requests: staff" on public.ms365_reset_requests;
create policy "reset requests: staff" on public.ms365_reset_requests
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists "reset requests: read own" on public.ms365_reset_requests;
create policy "reset requests: read own" on public.ms365_reset_requests
  for select using (auth.uid() = user_id);

-- Supabase grants ALL on new tables to anon and authenticated by default,
-- so revoke before granting rather than assuming a clean slate.
revoke all on public.ms365_reset_requests from anon, authenticated;
grant select on public.ms365_reset_requests to authenticated;

revoke all on function public.my_ms365_match() from public, anon;
revoke all on function public.link_my_ms365_mailbox() from public, anon;
revoke all on function public.request_ms365_password_reset() from public, anon;
grant execute on function public.my_ms365_match() to authenticated;
grant execute on function public.link_my_ms365_mailbox() to authenticated;
grant execute on function public.request_ms365_password_reset() to authenticated;

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- The functions must be argument-less. If any of these returns a row with
-- parameters, the enumeration oracle is back:
--   select p.proname, pg_get_function_arguments(p.oid)
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('my_ms365_match','link_my_ms365_mailbox',
--                        'request_ms365_password_reset');
--   -- expect three rows, each with an EMPTY argument list
--
-- anon must not be able to reach any of them (expect permission denied):
--   set role anon; select public.my_ms365_match();
--
-- How many people this actually helps:
--   select count(*) from public.marketing_contacts
--    where sahaba_mailbox is not null and email is not null;   -- ~329
--
-- Linking on signup now happens — after the next real signup, this should
-- stop being 0:
--   select count(*) from public.marketing_contacts where linked_user_id is not null;
--
-- No open request may exist twice for one person (expect zero rows):
--   select user_id, count(*) from public.ms365_reset_requests
--    where status in ('pending','emailed') group by 1 having count(*) > 1;
