-- Sahaba Club — is migration 0033 fully applied?
-- ============================================================================
--
-- Why this exists. The Data panel reads `data_field_stats` successfully and
-- fails to read `contact_link_status`. Those are defined 117 lines apart in the
-- same migration, which is the signature of a migration applied PARTWAY —
-- pasted into the dashboard in chunks, with one chunk erroring and the rest
-- never run. If that is what happened, the objects defined after the view are
-- missing too, and they are the ones that WRITE: every save, every link and
-- every import on that page goes through them.
--
-- Read-only. Run the whole thing; it reports and changes nothing.

-- ---------------------------------------------------------------------------
-- 1. Which of 0033's objects actually exist, in the order the file creates
--    them. The first `MISSING` is where the migration stopped.
-- ---------------------------------------------------------------------------
with expected(seq, kind, name) as (values
  ( 1, 'table',    'data_admin_audit'),
  ( 2, 'function', 'audit_people_row'),
  ( 3, 'function', 'audit_clip'),
  ( 4, 'trigger',  'marketing_contacts_audit'),
  ( 5, 'trigger',  'profiles_audit'),
  ( 6, 'table',    'data_export_log'),
  ( 7, 'table',    'data_admin_fields'),
  ( 8, 'function', 'data_field_stats'),
  ( 9, 'view',     'contact_link_status'),
  (10, 'function', 'admin_link_contact'),
  (11, 'function', 'admin_coerce_value'),
  (12, 'function', 'admin_update_contact'),
  (13, 'function', 'admin_create_contact'),
  (14, 'function', 'admin_update_profile'),
  (15, 'function', 'admin_import_rows')
)
select e.seq, e.kind, e.name,
       case when (
         (e.kind = 'table'    and exists (select 1 from information_schema.tables
                                           where table_schema='public' and table_name=e.name
                                             and table_type='BASE TABLE'))
      or (e.kind = 'view'     and exists (select 1 from information_schema.views
                                           where table_schema='public' and table_name=e.name))
      or (e.kind = 'function' and exists (select 1 from pg_proc p
                                            join pg_namespace n on n.oid=p.pronamespace
                                           where n.nspname='public' and p.proname=e.name))
      or (e.kind = 'trigger'  and exists (select 1 from pg_trigger
                                           where tgname=e.name and not tgisinternal))
       ) then 'present' else '*** MISSING ***' end as state
  from expected e
 order by e.seq;

-- ---------------------------------------------------------------------------
-- 2. If the view IS present, why would it return nothing? It is
--    `where public.is_staff()` over the whole contact table, so it returns
--    everything or nothing. Run this as YOURSELF from the app, not as the SQL
--    editor's superuser — the SQL editor does not carry your JWT, so
--    `auth.uid()` is null here and `is_staff()` will read false even when your
--    session is fine. Compare the two numbers instead.
-- ---------------------------------------------------------------------------
select (select count(*) from public.marketing_contacts)            as contacts_total,
       (select count(*) from public.marketing_contacts
         where coalesce(sahaba_mailbox,'') <> '')                  as with_a_mailbox,
       (select count(*) from public.profiles where role in ('staff','admin')) as staff_accounts;

-- ---------------------------------------------------------------------------
-- 3. Grants. Supabase auto-grants ALL on a newly created object, and 0033
--    revokes then re-grants SELECT. If the revoke ran and the grant did not,
--    the view exists and is unreadable — which looks identical from the app.
-- ---------------------------------------------------------------------------
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public'
   and table_name = 'contact_link_status'
 order by grantee, privilege_type;
-- Expect: authenticated / SELECT. Nothing for anon.

-- ---------------------------------------------------------------------------
-- 4. PostgREST keeps a schema cache. A view created after the last reload is
--    invisible over the REST API even though it exists in the database, and the
--    error says the relation could not be found — indistinguishable from never
--    having been created. If §1 says the view is present and §3 shows the
--    SELECT grant, this is the remaining explanation.
--
--    The reload is safe and instant:
--
--        notify pgrst, 'reload schema';
-- ---------------------------------------------------------------------------
