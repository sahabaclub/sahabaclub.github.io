-- Sahaba Club — Phase 3: events in the database, and real admin access
-- ------------------------------------------------------------
-- Until now events lived in events-data.js, a file in the repo, which meant
-- adding one required committing code — and the only "admin panel" worked by
-- handing someone a GitHub token. A GitHub token can't be scoped to "events
-- only"; it grants write access to the whole site. That's unusable for a
-- hired manager, so events move here alongside members.

-- ============================================================
-- Roles
-- ============================================================

-- 'staff' is the role you give someone you've hired: they run events and read
-- the member list, but can't change roles, tiers or (later) payments.
alter type public.member_role add value if not exists 'staff' before 'admin';

-- ============================================================
-- Who is allowed to do what
-- ============================================================

-- These MUST be security definer. A policy on `profiles` that queries
-- `profiles` to find the caller's role re-triggers the same policy and
-- recurses until Postgres gives up with a 42P17. Running the lookup as the
-- function owner skips RLS inside the function and breaks the cycle.
--
-- `stable` lets the planner call it once per statement instead of per row.
create function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and role = 'admin'
  );
$$;

-- Staff-or-above. Used for anything to do with running the club day to day.
create function public.is_staff()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and role in ('staff', 'admin')
  );
$$;

-- ============================================================
-- Events
-- ============================================================

create table public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  country text,
  location text,
  event_date date not null,
  -- Free text, not a time column: these display as written, e.g.
  -- "6:00 PM – 8:00 PM" or "10:00 AM GST".
  time_label text,
  -- Also free text: "Free", "Paid — $28". Kept as-is from the old file so
  -- nothing changes visually on the public page.
  price_label text not null default 'Free',
  mode text not null default 'In-Person' check (mode in ('In-Person', 'Online')),
  tags text[] not null default '{}',
  register_link text,
  maps_link text,
  image_url text,
  brand text,
  description text,
  tier_required text not null default 'all' check (tier_required in ('all', 'premium')),
  capacity int,
  -- Lets staff draft an event without it appearing publicly.
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index events_date_idx on public.events (event_date);
create index events_published_idx on public.events (is_published, event_date);

create trigger events_set_updated_at before update on public.events
  for each row execute procedure public.set_updated_at();

alter table public.events enable row level security;

-- Anyone may read published events, signed in or not — the public events page
-- has to work for visitors.
--
-- Note this deliberately includes Premium events: the page shows them locked,
-- which is what advertises Premium in the first place. The lock is a UX
-- affordance, not a secret — a determined visitor could read the row. That
-- matches the old behaviour exactly (the whole file was public). If a genuinely
-- private event is ever needed, don't reach for a policy here: RLS is
-- row-level, so hiding just `register_link` needs a view or an Edge Function.
create policy "events: public reads published" on public.events
  for select using (is_published or public.is_staff());

create policy "events: staff insert" on public.events
  for insert with check (public.is_staff());
create policy "events: staff update" on public.events
  for update using (public.is_staff()) with check (public.is_staff());
create policy "events: staff delete" on public.events
  for delete using (public.is_staff());

-- ============================================================
-- Event registrations
-- ============================================================

create table public.event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 'attendee' is the default; the others are how a coach's track record gets
  -- built later without maintaining a separate list.
  role text not null default 'attendee' check (role in ('attendee', 'speaker', 'coach', 'judge')),
  status text not null default 'registered',
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);

create index event_registrations_event_idx on public.event_registrations (event_id);
create index event_registrations_user_idx on public.event_registrations (user_id);

alter table public.event_registrations enable row level security;

create policy "registrations: read own or staff" on public.event_registrations
  for select using (auth.uid() = user_id or public.is_staff());
create policy "registrations: member registers self" on public.event_registrations
  for insert with check (auth.uid() = user_id);
create policy "registrations: member cancels own" on public.event_registrations
  for delete using (auth.uid() = user_id or public.is_staff());

-- ============================================================
-- Admin visibility over members
-- ============================================================

-- The Phase 1 policies scoped every member to their own row, which is right
-- for members and useless for whoever runs the club. These add read access
-- for staff without touching what an ordinary member can see.
create policy "profiles: staff read all" on public.profiles
  for select using (public.is_staff());

create policy "subscriptions: staff read all" on public.subscriptions
  for select using (public.is_staff());

create policy "ms365_accounts: staff read all" on public.ms365_accounts
  for select using (public.is_staff());

-- Deliberately NOT added: any policy letting staff or admins *write* role or
-- tier. Migration 0002 revoked those columns from `authenticated`, and every
-- signed-in user — admins included — connects as `authenticated`. Column
-- privileges are per database role, so they can't be re-granted to admins
-- alone. Changing someone's tier or role therefore has to go through an Edge
-- Function using the service key, where the check happens in code we control.
-- That is the right place for it anyway.
