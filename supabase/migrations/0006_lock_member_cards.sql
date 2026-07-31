-- Sahaba Club — close the default-privilege hole left open by 0005
-- ------------------------------------------------------------
-- 0005 has since been corrected at source, so on a fresh project this file is
-- a no-op. It exists because the live database had already run the original
-- 0005, and needed repairing in place.
--
-- What went wrong: Supabase grants `anon` and `authenticated` ALL privileges
-- on every new object in `public`, via ALTER DEFAULT PRIVILEGES. 0005 granted
-- SELECT on member_cards to `authenticated` and said in a comment that anon
-- was "deliberately not granted" — but never revoked anything, and absence of
-- a grant is not absence of a privilege. anon held SELECT, INSERT, UPDATE and
-- DELETE.
--
-- Why it mattered: member_cards is a simple, single-table, auto-updatable view
-- declared with security_invoker = off. It executes with its owner's rights,
-- which means RLS on profiles does not apply to it at all. The grants were the
-- entire access control. Anyone holding the publishable key — which is public
-- by design — could have read every member's name and photo, and written
-- through the view into profiles.
--
-- Same family of mistake as the column REVOKE in 0002: assuming a privilege is
-- absent rather than querying for it. Verify with information_schema, always.
revoke all on public.member_cards from anon, authenticated;
grant select on public.member_cards to authenticated;

-- Defence in depth. RLS already stops anon on these two — every policy tests
-- auth.uid(), which is null for an anonymous caller, so they fail closed — but
-- the grant has no reason to exist either.
revoke all on public.event_favourites from anon;
revoke all on public.event_views from anon;

-- Verification (expect: member_cards -> authenticated:SELECT plus postgres
-- only; the anon query -> zero rows):
--
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'member_cards'
--   order by grantee, privilege_type;
--
--   select table_name, grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name in ('member_cards', 'event_favourites', 'event_views')
--     and grantee = 'anon';
