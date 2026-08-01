-- Sahaba Club — hardening pass before the doors open
-- ------------------------------------------------------------
-- Found by probing the live API as an anonymous caller holding nothing but
-- the publishable key that ships in the page source. Everything below was
-- *already* blocked by RLS — no data was exposed and no write succeeded. But
-- two things were only one layer deep, and one bad policy edit is all it
-- would take.
--
-- What the probe actually found:
--
--   anon could not read      member_cards, event_favourites, event_views,
--                            marketing_contacts, contact_engagements,
--                            contact_imports, ms365_license_catalog,
--                            ms365_user_licenses   (42501 — no grant at all)
--
--   anon read 0 rows from    profiles, ms365_accounts, event_registrations,
--                            subscriptions          (grant exists, RLS empty)
--
--   anon PATCH returned 204  on events, profiles, event_registrations,
--                            subscriptions, ms365_accounts
--                            (0 rows affected — RLS held, but the UPDATE
--                             privilege is genuinely granted)
--
-- The tables from 0006, 0010 and 0011 were already in the strong form because
-- those migrations revoke first. The tables from 0001–0005 predate that habit
-- and still carry Supabase's default "grant everything to anon".

-- ============================================================
-- Take away what anon was never meant to have
-- ============================================================

-- The only thing a logged-out visitor legitimately does is read the events
-- list. Confirmed by reading the public pages: index, events, membership and
-- podcast touch `events` and nothing else. event_favourites, event_views,
-- event_registrations and member_cards are only ever touched by a signed-in
-- member, so `authenticated` keeps its grants and anon keeps none.
revoke insert, update, delete, truncate on public.events from anon;

-- Not read by any public page, and nothing about a member should be legible
-- to a stranger even if a policy is later loosened by accident.
revoke all on public.profiles from anon;
revoke all on public.ms365_accounts from anon;
revoke all on public.event_registrations from anon;
revoke all on public.subscriptions from anon;

-- Belt and braces on the ones RLS is already handling, so a future
-- "for all using (true)" typo cannot turn into a write.
revoke insert, update, delete, truncate on public.event_favourites from anon;
revoke insert, update, delete, truncate on public.event_views from anon;
revoke insert, update, delete, truncate on public.member_cards from anon;

-- ============================================================
-- Pin search_path on the two functions that lack it
-- ============================================================

-- Supabase's security advisor flags any function without a fixed
-- search_path. For a SECURITY DEFINER function it is a genuine escalation
-- route: the caller controls search_path, so an unqualified name can be made
-- to resolve to a table they created. Neither of these is SECURITY DEFINER,
-- so the risk here is low — but the lint is right, it costs nothing to fix,
-- and "low risk" is not a reason to ship a known warning.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

create or replace function public.ms365_days_left(
  p_plan public.ms365_plan,
  p_expires date
)
returns int
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select case
    when p_plan <> 'trial' then null
    when p_expires is null then null
    else (p_expires - current_date)
  end;
$fn$;

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- Expect zero rows: anon must hold no privilege on these at all.
--
--   select table_name, privilege_type
--   from information_schema.role_table_grants
--   where grantee = 'anon' and table_schema = 'public'
--     and table_name in ('profiles','ms365_accounts','event_registrations',
--                        'subscriptions','marketing_contacts',
--                        'contact_engagements','contact_imports',
--                        'campaigns','campaign_recipients')
--   order by table_name;
--
-- Expect exactly one row, SELECT on events:
--
--   select table_name, privilege_type
--   from information_schema.role_table_grants
--   where grantee = 'anon' and table_schema = 'public' and table_name = 'events';
--
-- Expect zero rows: every function should now pin its search_path.
--
--   select p.proname
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proconfig is null
--     and p.prokind = 'f';
--
-- And re-run the anonymous probe afterwards. The events page must still
-- load 37 events for a logged-out visitor; if it does not, this migration
-- took away too much.
