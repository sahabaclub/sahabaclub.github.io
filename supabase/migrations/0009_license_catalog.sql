-- Sahaba Club — the licence catalogue, and what each member chose
-- ------------------------------------------------------------
-- Members pick which Microsoft services they want when they join, and can
-- change their mind later. Two tables:
--
--   ms365_license_catalog   what the club offers, editable from the admin
--                           panel so a new Microsoft SKU doesn't need a
--                           code change
--   ms365_user_licenses     what each member asked for, and what actually
--                           happened when we tried to assign it
--
-- Keeping "what they want" and "what Microsoft did" in separate columns
-- matters: an assignment can fail (seats exhausted, Graph error) and the
-- member's choice should survive that so a retry knows what to aim for.

-- ============================================================
-- Catalogue
-- ============================================================

create table if not exists public.ms365_license_catalog (
  id uuid primary key default gen_random_uuid(),

  -- Microsoft's own identifiers. sku_id is filled in from Graph's
  -- /subscribedSkus once the app registration exists; until then the
  -- catalogue is still usable for display and the assignment step no-ops.
  sku_id uuid,
  sku_part_number text,

  -- What members see. Deliberately not the Microsoft SKU name: "Office 365
  -- A1 for students" is an education SKU name that would confuse a member
  -- and is not how the club describes the benefit.
  public_name text not null,
  blurb text,

  -- The mailbox licence. Cannot be switched off while a member has an
  -- @sahabaclub.com account, because it is the thing carrying the mailbox.
  is_required boolean not null default false,

  -- Viral trials expire on Microsoft's schedule, not ours. The UI says so
  -- rather than implying the club controls the date, which would generate
  -- support questions we cannot answer.
  is_trial boolean not null default false,

  -- Scarce SKUs. A1 for faculty is capped at 50 seats for this tenant, so
  -- the admin panel warns before spending one.
  seats_total int,
  warn_below int,

  offered_at_signup boolean not null default true,
  staff_only boolean not null default false,
  sort_order int not null default 100,
  is_active boolean not null default true,

  created_at timestamptz not null default now()
);

alter table public.ms365_license_catalog enable row level security;

-- Any signed-in member can read the menu; only staff can change it.
drop policy if exists "catalog: members read" on public.ms365_license_catalog;
create policy "catalog: members read" on public.ms365_license_catalog
  for select using (auth.uid() is not null);

drop policy if exists "catalog: staff write" on public.ms365_license_catalog;
create policy "catalog: staff write" on public.ms365_license_catalog
  for all using (public.is_staff()) with check (public.is_staff());

revoke all on public.ms365_license_catalog from anon;

-- ============================================================
-- What each member chose
-- ============================================================

create table if not exists public.ms365_user_licenses (
  user_id uuid not null references auth.users (id) on delete cascade,
  catalog_id uuid not null references public.ms365_license_catalog (id) on delete cascade,

  -- The member's choice. Theirs to set.
  wanted boolean not null default true,

  -- What Microsoft actually did. Ours to set, via the service role only.
  state text not null default 'pending'
    check (state in ('pending', 'assigned', 'removed', 'failed')),
  last_error text,
  assigned_at timestamptz,
  removed_at timestamptz,
  updated_at timestamptz not null default now(),

  primary key (user_id, catalog_id)
);

create index if not exists ms365_user_licenses_user_idx
  on public.ms365_user_licenses (user_id);

-- Pending work for the provisioning job: everything the member wants that
-- Microsoft has not confirmed yet.
create index if not exists ms365_user_licenses_pending_idx
  on public.ms365_user_licenses (state) where state in ('pending', 'failed');

alter table public.ms365_user_licenses enable row level security;

drop policy if exists "user licenses: read own or staff" on public.ms365_user_licenses;
create policy "user licenses: read own or staff" on public.ms365_user_licenses
  for select using (auth.uid() = user_id or public.is_staff());

drop policy if exists "user licenses: choose own" on public.ms365_user_licenses;
create policy "user licenses: choose own" on public.ms365_user_licenses
  for insert with check (auth.uid() = user_id or public.is_staff());

drop policy if exists "user licenses: change own" on public.ms365_user_licenses;
create policy "user licenses: change own" on public.ms365_user_licenses
  for update using (auth.uid() = user_id or public.is_staff())
  with check (auth.uid() = user_id or public.is_staff());

drop policy if exists "user licenses: staff delete" on public.ms365_user_licenses;
create policy "user licenses: staff delete" on public.ms365_user_licenses
  for delete using (public.is_staff());

-- A member may say what they want. They may not tell us Microsoft said yes —
-- that claim only ever comes from the provisioning function running as the
-- service role, which bypasses these grants entirely.
--
-- Same lesson as profiles in 0002: Supabase hands out a table-wide UPDATE by
-- default, so the revoke has to come first or the column list means nothing.
revoke update on public.ms365_user_licenses from authenticated, anon;
grant update (wanted, updated_at) on public.ms365_user_licenses to authenticated;
revoke all on public.ms365_user_licenses from anon;

-- ============================================================
-- Seed the current menu
-- ============================================================

-- sku_id is left null on purpose: the real GUIDs come from Graph
-- /subscribedSkus, and inventing them here would be worse than an empty
-- column the provisioning step knows to skip.
insert into public.ms365_license_catalog
  (public_name, blurb, sku_part_number, is_required, is_trial, offered_at_signup, staff_only, sort_order, seats_total, warn_below)
values
  ('Microsoft 365 Cloud Licenses',
   'Your @sahabaclub.com mailbox, Word, Excel, PowerPoint and Teams on the web, plus 1 TB of OneDrive storage.',
   'STANDARDWOFFPACK_STUDENT', true, false, true, false, 10, 30500, 500),

  ('Microsoft Copilot Studio',
   'Build and publish your own AI agents. Trial licence — Microsoft sets the expiry date, not the club.',
   'CCIBOTS_PRIVPREV_VIRAL', false, true, true, false, 20, null, null),

  ('Microsoft Fabric',
   'Data engineering, analytics and reporting in one place. Free tier.',
   'POWER_BI_STANDARD', false, false, true, false, 30, null, null),

  ('Microsoft Power Apps Plan 2',
   'Build business apps without writing code. Trial licence — Microsoft sets the expiry date.',
   'POWERAPPS_VIRAL', false, true, true, false, 40, null, null),

  ('Microsoft Power Apps for Developers',
   'A full developer environment for building and testing Power Platform apps.',
   'POWERAPPS_DEV', false, false, true, false, 50, null, null),

  ('Microsoft Power Pages for Makers',
   'Build external-facing websites on the Power Platform. Trial licence — Microsoft sets the expiry date.',
   'POWERPAGES_VTRIAL_FOR_MAKERS', false, true, true, false, 60, null, null),

  -- Not offered at signup. 50 seats exist for the whole tenant and 16 are
  -- already spent, so this is granted by hand, to coaches and staff.
  ('Microsoft 365 Faculty',
   'The staff and coach licence. Limited seats — granted by the club, not self-selected.',
   'STANDARDWOFFPACK_FACULTY', false, false, false, true, 70, 50, 10)
on conflict do nothing;

-- Verification:
--
--   select public_name, is_required, is_trial, offered_at_signup, staff_only
--   from public.ms365_license_catalog order by sort_order;
--
--   -- expect zero rows: members must not be able to claim an assignment
--   select column_name from information_schema.column_privileges
--   where table_schema = 'public' and table_name = 'ms365_user_licenses'
--     and privilege_type = 'UPDATE' and grantee = 'authenticated'
--     and column_name in ('state', 'assigned_at', 'last_error');
