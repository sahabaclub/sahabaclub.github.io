-- Sahaba Club — Phase 1 schema
-- ------------------------------------------------------------
-- Accounts, profiles, membership tier, and Microsoft 365 mailboxes.
-- Coach profiles, bookings, payments, and events registration come in
-- later migrations as those phases start (see the architecture plan).
--
-- auth.users already holds the login identity (email/phone, provider) —
-- everything here is only the Sahaba-specific fields layered on top of it.

create extension if not exists "pgcrypto";

create type public.membership_tier as enum ('standard', 'premium');
create type public.ms365_status as enum ('provisioning', 'active', 'grace_unlicensed', 'deactivated', 'deleted');
create type public.signup_method as enum ('google', 'microsoft', 'phone');
create type public.profile_source as enum ('linkedin_pdf', 'cv', 'manual', 'mixed');

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  bio text,
  goals text[] not null default '{}',
  skills text[] not null default '{}',
  interests text[] not null default '{}',
  experience_level text,
  industry text,
  timezone text,
  language text,
  profile_source public.profile_source,
  newsletter_opt_in boolean not null default true,
  signup_method public.signup_method,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tier public.membership_tier not null default 'standard',
  status text not null default 'active',
  renews_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ms365_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  mailbox text not null unique,
  status public.ms365_status not null default 'provisioning',
  pre_existing boolean not null default false,
  license_expires_at date,
  grace_ends_at date,
  credential_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- New signups get an empty profile + Standard subscription automatically,
-- so the rest of the app can always assume both rows exist once someone
-- is logged in — no "does this user have a profile yet" branching.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id) values (new.id);
  insert into public.subscriptions (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Row Level Security: a member can only ever read or edit their own
-- rows. Edge Functions using the service-role key (provision-ms365,
-- ms365-lifecycle, etc.) bypass RLS entirely — that's how the
-- automation reaches every account without needing a policy for it.
alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.ms365_accounts enable row level security;

create policy "profiles: read own" on public.profiles
  for select using (auth.uid() = user_id);
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = user_id);

create policy "subscriptions: read own" on public.subscriptions
  for select using (auth.uid() = user_id);

create policy "ms365_accounts: read own" on public.ms365_accounts
  for select using (auth.uid() = user_id);

-- updated_at housekeeping, so nothing has to remember to set it by hand.
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute procedure public.set_updated_at();
create trigger subscriptions_set_updated_at before update on public.subscriptions
  for each row execute procedure public.set_updated_at();
create trigger ms365_accounts_set_updated_at before update on public.ms365_accounts
  for each row execute procedure public.set_updated_at();
