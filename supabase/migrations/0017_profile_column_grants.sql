-- Sahaba Club — let members write the columns Connect added
-- ------------------------------------------------------------
-- 0002 revoked the table-wide UPDATE on public.profiles from `authenticated`
-- and hands the privilege back one column at a time — deliberately, so a
-- member can never write a column nobody thought about. 0005 extended that
-- list with avatar_url and show_in_attendees.
--
-- 0013 then added is_discoverable, accepts_messages, headline, city, country
-- and links, and did not extend the list. Adding a column is not the same as
-- letting anyone set it, so those six arrived unwritable.
--
-- The failure is silent, which is what makes it worth a migration of its own.
-- PostgREST returns success and zero rows changed, so `app/profile.html`
-- appears to save, the "Show me in Connect" switch springs back off, and the
-- member sees no error. Worse, the member_joined feed post is triggered by
-- is_discoverable becoming true — so a permission gap on one column silently
-- switches off the entire welcome-post pipeline downstream.
--
-- Kept as a separate migration rather than an edit to 0013: once a migration
-- may have run anywhere, editing it means that environment never receives the
-- fix. Append-only is the only version that converges.

grant update (
  is_discoverable,    -- the Connect opt-in; the whole feature hangs off it
  accepts_messages,   -- "let members message me"
  headline,
  city,
  country,
  links               -- {linkedin, github, site}
) on public.profiles to authenticated;

-- Deliberately NOT granted here, and they must stay ungranted:
--
--   avatar_is_generated, avatar_attempts, source_purged_at   (0015)
--
-- Those three are the platform's evidence that no real photograph is stored.
-- A member who could set avatar_is_generated could claim a generated avatar
-- while keeping a real photo; a member who could set avatar_attempts could
-- reset the counter and generate images without limit. They are written only
-- by generate-avatar running as the service role.

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- Expect exactly the six columns above, plus the ones from 0002 and 0005:
--
--   select column_name
--   from information_schema.column_privileges
--   where table_schema = 'public'
--     and table_name = 'profiles'
--     and grantee = 'authenticated'
--     and privilege_type = 'UPDATE'
--   order by column_name;
--
-- Expect ZERO rows — a member must never be able to claim a generated avatar
-- or reset their attempt count:
--
--   select column_name
--   from information_schema.column_privileges
--   where table_schema = 'public'
--     and table_name = 'profiles'
--     and grantee = 'authenticated'
--     and privilege_type = 'UPDATE'
--     and column_name in ('avatar_is_generated', 'avatar_attempts', 'source_purged_at');
--
-- Expect ZERO rows — the table-wide grant from 0002 must still be revoked, or
-- the column list above is decorative:
--
--   select privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name = 'profiles'
--     and grantee = 'authenticated'
--     and privilege_type = 'UPDATE';
--
-- End-to-end, as a signed-in member: toggling "Show me in Connect" on must
-- change one row, and a member_joined post must then exist for that user
-- (assuming their name, avatar and bio/headline are filled in).
