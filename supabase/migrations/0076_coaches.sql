-- 0076 — the first four coaches
-- ============================================================
--
-- Ahmed, 19 Aug 2026: Ebeid Atef Ebeid, Samir Daoudi, Ahmed Badawy and
-- Emad Adel are coaches.
--
-- ⚠ COACH IS NOT STAFF, AND THAT IS THE WHOLE REASON THIS IS SAFE.
-- `is_staff()` is `role in ('staff', 'admin', 'global_admin')` — checked with
-- pg_get_functiondef before writing this, not assumed from the enum. Promoting
-- somebody to coach therefore grants no admin section, no member emails, and
-- no access to the staff-only views. It changes a badge and nothing else.
--
-- If a future migration ever adds 'coach' to is_staff(), it is granting four
-- people the admin panel as a side effect of a label. Do not.
--
-- ⚠ MATCHED ON EXACT full_name, and each one verified to hit exactly one row
-- first. Names in this table are member-authored: there is an "Ebeid Atef
-- Ebeid" and Ahmed wrote "Atif", which is the same person and a different
-- string. Matching on a LIKE pattern would have been the kind of convenience
-- that eventually promotes a stranger who happens to share a surname.
--
-- The count assertion at the bottom is not decoration. An UPDATE that matches
-- nothing succeeds silently, and a migration that reports success having
-- changed no rows is the failure mode this file is most likely to have.

do $$
declare
  wanted text[] := array[
    'Ebeid Atef Ebeid',
    'Samir Daoudi',
    'Ahmed Badawy',
    'Emad Adel'
  ];
  touched int;
begin
  update public.profiles
  set role = 'coach', updated_at = now()
  where full_name = any(wanted)
    and role = 'member';   -- never demote staff or an admin by accident

  get diagnostics touched = row_count;

  if touched <> 4 then
    raise exception
      'expected to promote 4 members to coach, updated % — check the names against profiles.full_name before re-running',
      touched;
  end if;
end $$;
