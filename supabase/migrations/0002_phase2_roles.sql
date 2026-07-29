-- Sahaba Club — Phase 2: member roles
-- ------------------------------------------------------------
-- Phase 1 had no notion of roles because nothing needed one. The
-- newsletter does: someone has to be allowed to send to every member,
-- and that can't be every member.
--
-- 'coach' is here now rather than in Phase 3 so the column doesn't need
-- altering again when coach profiles land — the value is simply unused
-- until then.

create type public.member_role as enum ('member', 'coach', 'admin');

alter table public.profiles
  add column role public.member_role not null default 'member';

-- The Phase 1 "profiles: update own" policy is row-level and therefore
-- column-blind: it would happily let a signed-in member send
-- `update profiles set role = 'admin' where user_id = <themselves>`.
-- RLS can't express "every column except this one", so the restriction
-- has to be a privilege instead.
--
-- The obvious move — `revoke update (role) ... from authenticated` — is a
-- SILENT NO-OP here, and this was caught only by querying
-- information_schema after running it. Supabase grants `authenticated` a
-- TABLE-level UPDATE on new tables, and a table-level grant covers every
-- column; a column-level revoke cannot carve an exception out of it. The
-- statement succeeds, changes nothing, and the hole stays open.
--
-- So: drop the blanket grant, then grant back only the columns a member
-- is allowed to touch. Anything added to `profiles` later is locked by
-- default and has to be added here deliberately.
--
-- Service-role callers (Edge Functions) and the Supabase dashboard bypass
-- all of this, which is how an admin gets promoted — see SETUP.md.
revoke update on public.profiles from authenticated, anon;
revoke update on public.subscriptions from authenticated, anon;

-- Exactly the fields app/onboarding.html and app/profile.html write.
-- role, user_id, created_at and updated_at are deliberately absent.
grant update (
  full_name,
  bio,
  goals,
  skills,
  interests,
  experience_level,
  industry,
  timezone,
  language,
  profile_source,
  newsletter_opt_in,
  onboarding_completed_at
) on public.profiles to authenticated;

-- subscriptions gets nothing back: tier is set by billing, never by the
-- member. There's no RLS update policy on it either — belt and braces.

-- Verify after running, on any new environment. Both must hold:
--
--   -- must return ZERO rows
--   select grantee, table_name, column_name
--   from information_schema.column_privileges
--   where privilege_type = 'UPDATE'
--     and grantee in ('anon','authenticated')
--     and ((table_name = 'profiles' and column_name = 'role')
--       or (table_name = 'subscriptions' and column_name in ('tier','status','renews_at')));
--
--   -- must return the 12 columns granted above, and not `role`
--   select column_name from information_schema.column_privileges
--   where privilege_type = 'UPDATE' and grantee = 'authenticated'
--     and table_name = 'profiles' order by column_name;
