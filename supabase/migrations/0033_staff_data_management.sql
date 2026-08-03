-- Sahaba Club — staff control of the club's people data
-- ============================================================
--
-- Ahmed: "I want full control of my users data from the control panel. Not
-- only the members, but also the marketing data, so I need the control to add
-- or edit data based on my need. I want you to organize the data visibility
-- and have the ability to add data using excel import and export the current
-- data. Some cases of the current users of Microsoft 365 not mapped to the
-- personal email, I can do that manual by adding their personal email so when
-- they login they find the Microsoft 365 account linked."
--
-- ============================================================
-- ⚠ WHY THIS IS 0033 AND NOT 0032
-- ============================================================
--
-- 0031 is the highest migration that has been applied. 0032 is RESERVED: a
-- separate, in-flight piece of work moves the staff views that were created
-- by hand in the database into a numbered file, and it has claimed that
-- number. Taking 0032 here would give two different files the same number and
-- whichever applied second would look like the one that had "already run".
--
-- So this is 0033. If you are reading this because
-- `select * from supabase_migrations.schema_migrations` has a gap, the gap is
-- 0032 and it is on purpose. (0030 is a separate, older reservation — see
-- 0031's header for that one.)
--
-- ============================================================
-- What "organize the data visibility" is taken to mean here
-- ============================================================
--
-- It is the vaguest sentence in the request, so it is interpreted out loud
-- rather than guessed at, and the SMALLER reading is the one built:
--
--   Staff should be able to see WHICH FIELDS EXIST on a person's record, HOW
--   MANY of them are actually filled in, WHO is allowed to write each one, and
--   WHICH of them control what other members can see. Then they should be able
--   to choose which of those fields are on screen and which go into an export.
--
-- That is `public.data_admin_fields` below — one row per field, carrying its
-- label, its type, whether staff may edit it, whether an import may write it,
-- whether the MEMBER authored it, and whether it is a visibility switch. Plus
-- `public.data_field_stats()`, which counts how many rows have each field
-- populated.
--
-- It is deliberately NOT a per-field permission system — no "this staff member
-- may see phone numbers and that one may not". Every member of staff who can
-- reach this surface can already read every one of these tables through
-- PostgREST today, because the RLS policies on `marketing_contacts` and
-- `profiles` are `is_staff()` and nothing finer. Building a per-field UI on top
-- of a table-level grant would be decoration over a boundary that is not there,
-- and decoration over a security boundary is worse than no decoration: people
-- believe it. If per-field access is wanted later it is a grants-and-views
-- change in the database first, and a UI change second.
--
-- ============================================================
-- What is in scope, and what is deliberately not
-- ============================================================
--
-- IN — `public.marketing_contacts`. The heart of the request. It is the
--   "marketing data", and it is the table that carries `sahaba_mailbox`, so it
--   is where the Microsoft 365 mapping problem lives.
--
-- IN — `public.profiles`. "Not only the members" implies the members are the
--   baseline. `app/admin/members.html` can already read them and says out loud
--   that it cannot edit them; this closes that.
--
-- OUT (readable, never writable) — `public.ms365_accounts`. Shown beside a
--   member as context, and that is all. Two reasons. First, `mailbox` is a
--   pointer at a real object in a real Microsoft tenant; a spreadsheet that
--   mistypes one row silently points a member at somebody else's mailbox, and
--   there is no error anywhere to notice. Second, the operations staff
--   actually need on it already exist and are already gated —
--   `admin_set_ms365_expiry`, `admin_exempt_ms365_licence`,
--   `admin_forget_ms365_account` (0022) — behind `app/admin/licences.html`. A
--   second, blunter write path into the same table would only be a way to get
--   around the first one.
--
-- OUT — `public.prospect_profiles`. 0027's entire reason for existing is the
--   honesty rule: "`sources` records where every populated field came from,
--   per field. A field with no entry in `sources` should not have a value."
--   A CSV row carries no provenance. Importing into that table would put text
--   in front of a named person with nothing behind it, which is the one thing
--   0027 is built to prevent. Those rows are written by
--   `build-prospect-profile`, which records where each field came from, and
--   they should keep being written only by it.
--
-- OUT — `public.contact_engagements`. It already has an importer with its own
--   audit table (`contact_imports`, 0010) and its own natural grain
--   (contact × source file × type). A second importer writing the same rows
--   from a different shape of spreadsheet is how the same event ends up in the
--   history twice.
--
-- ============================================================
-- The guarantees this surface needs that the rest of the platform does not
-- ============================================================
--
-- Everything else built here limits who sees what. This deliberately hands
-- staff the lot, so it carries protections nothing else needs:
--
--   1. EVERY WRITE IS AUDITED — `data_admin_audit`, §1. Row, operation, each
--      changed field with its before and after, who, and when. By TRIGGER, not
--      by the write functions, so a write that goes round the panel is still
--      recorded.
--   2. EVERY EXPORT IS LOGGED — `data_export_log`, §2. Exporting 2,200 email
--      addresses is a data-egress event, not a page view. Staff hold no INSERT
--      on that table: only the `data-admin` Edge Function running as the
--      service role can write it, so the log cannot be skipped by the thing
--      being logged.
--   3. IMPORT IS DRY-RUN FIRST — `admin_import_rows`, §6, takes `p_dry_run`
--      and returns a plan. Committing requires passing back the hash of the
--      plan that was shown, so a confirm can only ever apply the thing the
--      operator actually read.
--   4. A MEMBER'S OWN WORDS ARE NEVER SILENTLY REPLACED — the
--      `member_authored` flag in §3, and the conflict rule in §6.
--   5. STAFF-ONLY, IN THE DATABASE. Every function here is `security definer`
--      and therefore bypasses RLS, so each one checks `public.is_staff()` on
--      its own first line — the point 0022, 0027 and 0031 all make. And
--      Supabase grants ALL on newly created objects to `anon` and
--      `authenticated`, so every object below is REVOKED before it is granted.
--   6. THE SERVICE-ROLE KEY NEVER REACHES THE BROWSER. The page holds the
--      publishable key like every other page. Import and export go through the
--      `data-admin` Edge Function, which does its reads and writes WITH THE
--      CALLER'S OWN JWT — so RLS, `is_staff()` and the audit trigger's
--      `auth.uid()` all behave exactly as they would from the browser — and
--      uses the service role for one single statement: the insert into
--      `data_export_log`.
--
-- ⚠ NO COLUMN IS ADDED TO `public.profiles` BY THIS MIGRATION, AND THEREFORE
-- NO `grant update` ON `profiles` IS ISSUED. This is the bug this project has
-- shipped most often (0002 → 0005 → 0017 → 0019 → 0022 → 0023 → 0026 → 0029),
-- so it is worth being explicit about why there is nothing to grant:
--
--   * Staff edit `profiles` through `public.admin_update_profile`, which is
--     `security definer` and runs as the owner. The column-level allowlist
--     applies to `authenticated`; it does not apply to the owner. The staff
--     path therefore needs NO grant at all.
--   * Widening the member allowlist to make the staff path work would be
--     exactly backwards: it would hand every member the ability to write
--     staff-only columns in order to let staff write them.
--
-- If a future change to this feature does add a column to `profiles`: it will
-- be staff-only, and it must NOT be granted to `authenticated`.

-- ============================================================
-- 1. The audit trail
-- ============================================================
--
-- With 2,200 people's contact details reachable from one screen, "who edited
-- this person's record" is a question that will be asked, and there is no way
-- to answer it after the fact unless it was recorded at the time.
--
-- ⚠ WHY A TRIGGER RATHER THAN A LINE INSIDE EACH WRITE FUNCTION. A function
-- that audits itself only audits what goes through it. The Supabase dashboard,
-- a psql session, `send-campaign` stamping `last_emailed_at`, and any Edge
-- Function running as the service role all write these tables and none of them
-- would appear. The question is "who changed this row", not "who changed this
-- row using the admin panel", so the recording belongs where the change lands.
--
-- The cost of that choice is noise, and it is handled by naming the columns
-- that are machine churn rather than somebody's decision — see the trigger
-- arguments at the end of this section.

create table if not exists public.data_admin_audit (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),

  -- `auth.uid()` at the moment of the write. NULL means the write did not come
  -- from a signed-in session: the service role, a dashboard query, or a psql
  -- console. That is not a gap in the record, it is the record — and it is why
  -- `source` below exists to say which.
  actor_id uuid references auth.users (id) on delete set null,

  -- Captured rather than joined. The account may later be deleted, and an
  -- audit row that says "somebody who no longer exists" is useless. The FK is
  -- `on delete set null` precisely so the row survives; these two columns are
  -- what is left of the actor when it does.
  actor_email text,
  actor_role text,

  -- Set by the admin functions in §5 and §6 via a transaction-local GUC, so a
  -- change made through the panel is distinguishable from one made by a bulk
  -- import and from one made by something else entirely.
  source text not null default 'other',

  table_name text not null,

  -- text, not uuid: `profiles` is keyed on `user_id` and `marketing_contacts`
  -- on `id`, and a single audit table that has to be joined differently per
  -- table is a table nobody queries.
  row_pk text not null,

  -- The person's name or address AS IT WAS at the time. A deleted row would
  -- otherwise be an audit entry about a uuid.
  row_label text,

  operation text not null check (operation in ('insert', 'update', 'delete')),

  -- {"column": {"from": <old>, "to": <new>}} for an update; the populated
  -- fields for an insert; the whole row for a delete. Values over 500
  -- characters are truncated with a marker — this is a record of WHAT changed,
  -- and a second full copy of every bio would double the size of the database
  -- for no extra answer.
  changes jsonb not null default '{}'::jsonb
);

comment on table public.data_admin_audit is
  'Append-only record of every write to the people tables. Written by trigger, '
  'so it catches writes that did not come through the admin panel. Staff may '
  'read it and nothing may modify it.';

create index if not exists data_admin_audit_row_idx
  on public.data_admin_audit (table_name, row_pk, occurred_at desc);
create index if not exists data_admin_audit_time_idx
  on public.data_admin_audit (occurred_at desc);
create index if not exists data_admin_audit_actor_idx
  on public.data_admin_audit (actor_id, occurred_at desc);

-- The trigger. One function for both tables; which columns are noise, which is
-- the primary key and which is the label all come in as arguments so that
-- adding a third table later is a `create trigger` and nothing else.
--
--   TG_ARGV[0]  primary key column
--   TG_ARGV[1]  label column (a name or an address, for reading later)
--   TG_ARGV[2]  comma-separated columns that do not, on their own, deserve a row
create or replace function public.audit_people_row()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp, auth
as $fn$
declare
  v_pk_col    text := TG_ARGV[0];
  v_label_col text := TG_ARGV[1];
  v_noise     text[] := string_to_array(coalesce(TG_ARGV[2], ''), ',');
  v_old       jsonb;
  v_new       jsonb;
  v_changes   jsonb := '{}'::jsonb;
  v_key       text;
  v_from      jsonb;
  v_to        jsonb;
  v_uid       uuid := auth.uid();
  v_email     text;
  v_role      text;
  v_row       jsonb;
begin
  v_old := case when TG_OP in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new := case when TG_OP in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row := coalesce(v_new, v_old);

  if TG_OP = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key = any (v_noise) then continue; end if;
      v_from := v_old -> v_key;
      v_to   := v_new -> v_key;
      if v_from is distinct from v_to then
        v_changes := v_changes || jsonb_build_object(
          v_key, jsonb_build_object('from', public.audit_clip(v_from),
                                    'to',   public.audit_clip(v_to)));
      end if;
    end loop;

    -- Every changed column was noise, or nothing changed at all. The commonest
    -- case by far is `refresh_contact_engagement_stats` (0010) re-stamping the
    -- denormalised counters on every contact whose engagement rows moved. A
    -- row per counter refresh would bury the edits this table exists to show.
    if v_changes = '{}'::jsonb then
      return null;
    end if;

  elsif TG_OP = 'INSERT' then
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key = any (v_noise) then continue; end if;
      v_to := v_new -> v_key;
      if v_to is not null and v_to <> 'null'::jsonb then
        v_changes := v_changes || jsonb_build_object(
          v_key, jsonb_build_object('from', null, 'to', public.audit_clip(v_to)));
      end if;
    end loop;

  else  -- DELETE
    for v_key in select jsonb_object_keys(v_old) loop
      v_to := v_old -> v_key;
      if v_to is not null and v_to <> 'null'::jsonb then
        v_changes := v_changes || jsonb_build_object(
          v_key, jsonb_build_object('from', public.audit_clip(v_to), 'to', null));
      end if;
    end loop;
  end if;

  if v_uid is not null then
    select u.email into v_email from auth.users u where u.id = v_uid;
    select p.role::text into v_role from public.profiles p where p.user_id = v_uid;
  end if;

  insert into public.data_admin_audit
    (actor_id, actor_email, actor_role, source, table_name,
     row_pk, row_label, operation, changes)
  values
    (v_uid, v_email, v_role,
     coalesce(nullif(current_setting('sc.audit_source', true), ''), 'other'),
     TG_TABLE_NAME,
     coalesce(v_row ->> v_pk_col, '(unknown)'),
     v_row ->> v_label_col,
     lower(TG_OP),
     v_changes);

  return null;
exception when others then
  -- ⚠ A DELIBERATE TRADE, AND THE LESS COMFORTABLE HALF OF IT SAID OUT LOUD.
  --
  -- This trigger sits on `profiles`, which every member writes when they save
  -- their own profile. Letting an audit failure abort that write would mean a
  -- fault in the audit table takes the member-facing profile page down. 0021
  -- makes the same call about linking at signup for the same reason: a person
  -- failing to get an audit row is an incident, a person failing to save their
  -- profile is a broken product.
  --
  -- The cost is that this audit is not fail-closed: a sustained fault would
  -- lose records silently, with only a warning in the Postgres log. The
  -- verification block at the end of this file has the query that notices —
  -- run it, do not assume.
  raise warning 'audit_people_row failed on %.%: %', TG_TABLE_NAME, TG_OP, sqlerrm;
  return null;
end;
$fn$;

-- Values are clipped rather than stored whole. A bio, a work history and an
-- avatar gallery are all in these tables and all of them would otherwise be
-- copied into the audit twice per edit.
create or replace function public.audit_clip(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = pg_temp
as $fn$
declare
  v text;
begin
  if p is null then return null; end if;
  if jsonb_typeof(p) in ('number', 'boolean', 'null') then return p; end if;

  v := case when jsonb_typeof(p) = 'string' then p #>> '{}' else p::text end;
  if length(v) <= 500 then return p; end if;

  return to_jsonb(left(v, 500) || '… [' || (length(v) - 500)::text || ' more characters]');
end;
$fn$;

drop trigger if exists marketing_contacts_audit on public.marketing_contacts;
create trigger marketing_contacts_audit
  after insert or update or delete on public.marketing_contacts
  for each row execute function public.audit_people_row(
    'id',
    'email',
    -- Machine churn, not decisions. `engagement_count`, `first_seen_at` and
    -- `last_seen_at` are maintained by 0010's trigger; `last_emailed_at` is
    -- stamped by `send-campaign` on every send; `updated_at` moves on every
    -- one of those. One literal on one line — adjacent string literals are
    -- concatenated by the lexer, which is legal and unreadable in a place
    -- where a silently mis-parsed argument would silently disable the filter.
    'updated_at,engagement_count,first_seen_at,last_seen_at,last_emailed_at'
  );

drop trigger if exists profiles_audit on public.profiles;
create trigger profiles_audit
  after insert or update or delete on public.profiles
  for each row execute function public.audit_people_row(
    'user_id',
    'full_name',
    -- The whole avatar family. `generate-avatar` and `refresh-avatars` write
    -- these several times per member per month as the service role, and 0026
    -- already keeps `avatar_gallery` as the member-readable history of exactly
    -- that. An audit row per drawing would make this table mostly pictures.
    'updated_at,avatar_url,avatar_status,avatar_error,avatar_attempts,avatar_prompt,avatar_gallery,avatar_cycle,avatar_theme,avatar_refreshed_at,avatar_is_generated,avatar_source,source_purged_at'
  );

-- Access. Read-only to staff and unreachable to everyone else. There is
-- deliberately NO policy for INSERT, UPDATE or DELETE for any role: the
-- trigger is `security definer` and writes as the owner, so it does not need
-- one, and an audit trail its subjects can edit is not an audit trail.
alter table public.data_admin_audit enable row level security;

drop policy if exists "audit: staff read" on public.data_admin_audit;
create policy "audit: staff read" on public.data_admin_audit
  for select using (public.is_staff());

-- Supabase grants ALL on a new table to anon and authenticated. Without this
-- revoke the before-and-after values of 2,200 people's contact details are
-- readable by anyone holding the publishable key.
revoke all on public.data_admin_audit from anon, authenticated;
grant select on public.data_admin_audit to authenticated;
revoke all on function public.audit_people_row() from public, anon, authenticated;
revoke all on function public.audit_clip(jsonb) from public, anon;

-- ============================================================
-- 2. The export log
-- ============================================================
--
-- 2,200 personal email addresses and 960 phone numbers leaving the platform in
-- one file is a data-egress event. It is recorded with enough detail to answer
-- the question that gets asked afterwards — who took what, how much of it, and
-- did it include the sensitive columns — without keeping a second copy of the
-- data itself.

create table if not exists public.data_export_log (
  id bigint generated always as identity primary key,
  exported_at timestamptz not null default now(),

  actor_id uuid references auth.users (id) on delete set null,
  actor_email text,
  actor_role text,

  dataset text not null,             -- 'marketing_contacts' | 'profiles'
  format text not null default 'csv',

  -- 'filtered' when the export was the list the operator was looking at,
  -- 'all' when they deliberately asked for the whole table. The panel defaults
  -- to 'filtered' and makes 'all' a separate, deliberate act.
  scope text not null check (scope in ('filtered', 'all')),

  -- The human description the panel showed above the button, so the log reads
  -- as "everyone with a mailbox and no personal email" rather than as a uuid
  -- list. Recorded as supplied by the caller — see the note in the Edge
  -- Function about what that does and does not prove.
  filter_label text,

  columns text[] not null default '{}',
  row_count int not null default 0,
  byte_count int,

  -- The two questions actually asked after an incident. Derived from the
  -- column list by the Edge Function rather than typed by the caller.
  includes_email boolean not null default false,
  includes_phone boolean not null default false
);

comment on table public.data_export_log is
  'One row per export of personal data. Written only by the data-admin Edge '
  'Function using the service role — staff hold no INSERT, so an export '
  'cannot be taken without a log entry.';

create index if not exists data_export_log_time_idx
  on public.data_export_log (exported_at desc);

alter table public.data_export_log enable row level security;

drop policy if exists "export log: staff read" on public.data_export_log;
create policy "export log: staff read" on public.data_export_log
  for select using (public.is_staff());

-- ⚠ SELECT AND NOTHING ELSE, AND THAT IS THE WHOLE CONTROL. If staff could
-- insert here, the honest thing to do would be to admit the log is advisory.
-- They cannot: the only writer is the service role inside `data-admin`, in the
-- same call that produces the bytes.
revoke all on public.data_export_log from anon, authenticated;
grant select on public.data_export_log to authenticated;

-- ============================================================
-- 3. The field catalogue — "organize the data visibility"
-- ============================================================
--
-- One row per field staff can see, edit, import or export, and the four
-- properties that actually matter about it. This one table is read by the edit
-- functions (`editable`), the importer (`importable` and `member_authored`),
-- the field-stats function (`kind`, to know what "populated" means for that
-- type) and the page (everything else). Adding a field to the panel is a
-- migration, on purpose: a field that appears in the UI because somebody added
-- a column is a field nobody decided to expose.

create table if not exists public.data_admin_fields (
  table_name text not null,
  column_name text not null,

  label text not null,
  kind text not null check (kind in
    ('text', 'longtext', 'email', 'phone', 'date', 'timestamp', 'int', 'bool', 'text[]', 'jsonb')),

  -- Staff may change it through `admin_update_contact` / `admin_update_profile`.
  editable boolean not null default true,

  -- A spreadsheet may write it. Strictly narrower than `editable`: some fields
  -- are safe to change one at a time with the row in front of you and not safe
  -- to change 2,200 at a time from a file.
  importable boolean not null default true,

  -- ⚠ THE MEMBER WROTE THIS, so an import must never silently replace it. See
  -- §6 for what the importer does with a conflict. This is the column behind
  -- "a member who wrote their own bio must not have it replaced by a
  -- spreadsheet".
  member_authored boolean not null default false,

  -- This field decides what other people see. Grouped separately in the panel,
  -- because "who can see me" is a different kind of question from "what is my
  -- phone number" and staff changing one should know which they are doing.
  visibility_control boolean not null default false,

  sort_order int not null default 100,
  note text,

  primary key (table_name, column_name)
);

comment on table public.data_admin_fields is
  'The admin panel field catalogue. What exists, what it is called, who may '
  'write it, and whether a spreadsheet may. The editable/importable flags are '
  'read by the write functions, not merely by the UI.';

-- ---- marketing_contacts -------------------------------------------------
--
-- Nothing here is member-authored: by definition these are people who have not
-- signed up, so nobody has ever written their own row. What has to be
-- protected instead is their CONSENT — see the `unsubscribed_at` and
-- `bounced_at` rules in §6, which are enforced in the importer rather than by
-- a flag here, because "may be set but never cleared" is not a boolean.
insert into public.data_admin_fields
  (table_name, column_name, label, kind, editable, importable, member_authored, visibility_control, sort_order, note)
values
  ('marketing_contacts', 'email', 'Personal email', 'email', true, true, false, false, 10,
   'The join key, and the field that decides whether this person can ever be matched to their Microsoft 365 account. Unique, case-insensitively.'),
  ('marketing_contacts', 'full_name', 'Full name', 'text', true, true, false, false, 20, null),
  ('marketing_contacts', 'first_name', 'First name', 'text', true, true, false, false, 21, null),
  ('marketing_contacts', 'last_name', 'Last name', 'text', true, true, false, false, 22, null),
  ('marketing_contacts', 'phone_raw', 'Phone (as supplied)', 'phone', true, true, false, false, 30,
   'Kept exactly as the source gave it. Leading zeros and + signs are meaningful — see the export notes about Excel.'),
  ('marketing_contacts', 'phone_e164', 'Phone (normalised)', 'phone', true, true, false, false, 31, null),
  ('marketing_contacts', 'country', 'Country', 'text', true, true, false, false, 40, null),
  ('marketing_contacts', 'city', 'City', 'text', true, true, false, false, 41, null),
  ('marketing_contacts', 'date_of_birth', 'Date of birth', 'date', true, true, false, false, 45, null),
  ('marketing_contacts', 'university_or_company', 'University or company', 'text', true, true, false, false, 50, null),
  ('marketing_contacts', 'occupation', 'Studying or working', 'text', true, true, false, false, 51, null),
  ('marketing_contacts', 'tech_experience', 'Tech experience', 'text', true, true, false, false, 52, null),
  ('marketing_contacts', 'linkedin_url', 'LinkedIn', 'text', true, true, false, false, 60, null),
  ('marketing_contacts', 'github_url', 'GitHub', 'text', true, true, false, false, 61, null),
  ('marketing_contacts', 'how_heard', 'How they heard about us', 'text[]', true, true, false, false, 65,
   'Semicolon-separated in a spreadsheet cell.'),
  ('marketing_contacts', 'sahaba_username', 'Sahaba username', 'text', true, true, false, false, 70, null),
  ('marketing_contacts', 'sahaba_mailbox', 'Microsoft 365 mailbox', 'text', true, true, false, false, 71,
   'The @sahabaclub.com address. Editing this does NOT touch the Microsoft tenant — it only changes who we think this mailbox belongs to.'),
  ('marketing_contacts', 'says_member', 'Says they are a member', 'bool', true, true, false, false, 75, null),
  ('marketing_contacts', 'email_valid', 'Address looks valid', 'bool', true, true, false, false, 80, null),
  ('marketing_contacts', 'is_test', 'Test or junk record', 'bool', true, true, false, true, 81,
   'Excluded from every send.'),
  ('marketing_contacts', 'unsubscribed_at', 'Unsubscribed', 'timestamp', true, false, false, true, 82,
   'Their decision, not ours. An import may set this but can never clear it — see migration 0033 §6.'),
  ('marketing_contacts', 'bounced_at', 'Hard bounced', 'timestamp', true, false, false, true, 83,
   'An import may set this but can never clear it. Retrying a dead address is what destroys a sending reputation.'),
  ('marketing_contacts', 'notes', 'Staff notes', 'longtext', true, true, false, false, 90, null),
  -- Present so the catalogue is the whole picture, but not writable anywhere.
  ('marketing_contacts', 'linked_user_id', 'Linked account', 'text', false, false, false, false, 95,
   'Set by the signup trigger, or by "Link now" on this page. Never by hand and never by an import.'),
  ('marketing_contacts', 'engagement_count', 'Engagements', 'int', false, false, false, false, 96,
   'Maintained by the engagement trigger in migration 0010.'),
  ('marketing_contacts', 'first_seen_at', 'First seen', 'timestamp', false, false, false, false, 97, null),
  ('marketing_contacts', 'last_seen_at', 'Last seen', 'timestamp', false, false, false, false, 98, null),
  ('marketing_contacts', 'last_emailed_at', 'Last emailed', 'timestamp', false, false, false, false, 99, null)
on conflict (table_name, column_name) do nothing;

-- ---- profiles -----------------------------------------------------------
--
-- ⚠ `member_authored` is true for exactly the columns `authenticated` holds an
-- UPDATE grant on — the allowlist built up across 0002, 0005, 0017, 0019, 0023
-- and 0029. That is not a coincidence and it is not a copy: those are the
-- columns a member can write, so those are the columns a member may have
-- written, so those are the columns a spreadsheet must not quietly replace.
-- The verification block at the end of this file checks the two lists still
-- agree, because they will drift the next time somebody adds a column.
insert into public.data_admin_fields
  (table_name, column_name, label, kind, editable, importable, member_authored, visibility_control, sort_order, note)
values
  ('profiles', 'full_name', 'Full name', 'text', true, true, true, false, 10, null),
  ('profiles', 'headline', 'Headline', 'text', true, true, true, false, 15, null),
  ('profiles', 'bio', 'Bio', 'longtext', true, true, true, false, 20,
   'Written by the member about themselves. The importer treats a non-empty bio as a conflict, never as something to overwrite.'),
  ('profiles', 'city', 'City', 'text', true, true, true, false, 30, null),
  ('profiles', 'country', 'Country', 'text', true, true, true, false, 31, null),
  ('profiles', 'industry', 'Industry', 'text', true, true, true, false, 35, null),
  ('profiles', 'company', 'Company', 'text', true, true, true, false, 36, null),
  ('profiles', 'position', 'Position', 'text', true, true, true, false, 37, null),
  ('profiles', 'years_experience', 'Years of experience', 'int', true, true, true, false, 38, null),
  ('profiles', 'experience_level', 'Experience level', 'text', true, true, true, false, 39, null),
  ('profiles', 'timezone', 'Timezone', 'text', true, true, true, false, 40, null),
  ('profiles', 'language', 'Language', 'text', true, true, true, false, 41, null),
  ('profiles', 'skills', 'Skills', 'text[]', true, true, true, false, 50, 'Semicolon-separated in a spreadsheet cell.'),
  ('profiles', 'interests', 'Interests', 'text[]', true, true, true, false, 51, 'Semicolon-separated in a spreadsheet cell.'),
  ('profiles', 'goals', 'Goals', 'text[]', true, true, true, false, 52, 'Semicolon-separated in a spreadsheet cell.'),
  ('profiles', 'open_to', 'Open to', 'text[]', true, true, true, false, 53, 'Semicolon-separated in a spreadsheet cell.'),
  ('profiles', 'links', 'Links', 'jsonb', true, false, true, false, 60,
   'Editable one row at a time as JSON. Not importable: a nested object does not survive a spreadsheet cell in any form worth debugging.'),
  ('profiles', 'work_history', 'Work history', 'jsonb', false, false, true, false, 61,
   'An ordered list of roles. Edited by the member on their own profile and filled from a CV on import; there is no honest flat-cell representation of it.'),
  ('profiles', 'newsletter_opt_in', 'Newsletter opt-in', 'bool', true, true, true, true, 70,
   'Their consent. Staff can correct it, but think about why you are correcting it.'),
  ('profiles', 'is_discoverable', 'Visible in Connect', 'bool', true, true, true, true, 71,
   'Turning this on requires a complete profile — a name, a picture, a bio or headline, and an interest (migration 0018). Rows that fail that are rejected, not silently ignored.'),
  ('profiles', 'accepts_messages', 'Accepts messages', 'bool', true, true, true, true, 72, null),
  ('profiles', 'show_in_attendees', 'Shown in event attendee lists', 'bool', true, true, true, true, 73, null),
  ('profiles', 'show_in_promptarena_ranking', 'Shown on the PromptArena leaderboard', 'bool', true, true, true, true, 74, null),
  -- Read-only, and each for a reason worth having in front of whoever asks
  -- why they cannot edit it.
  ('profiles', 'role', 'Role', 'text', false, false, false, false, 80,
   'Not editable here. Promoting an account is not a data-management operation and does not belong on the same screen as a phone number.'),
  ('profiles', 'blocked_at', 'Blocked', 'timestamp', false, false, false, false, 81,
   'Blocking is admin_block_member (migration 0022) — it also sets auth.users.banned_until, which is the part that actually stops a sign-in.'),
  -- ⚠ member_authored = TRUE even though nothing here can write it. The flag
  -- means "the member wrote this", not "the importer might touch it", and the
  -- two must not be conflated: the day somebody flips `importable` to true,
  -- the conflict rule has to already know whose words these are. A static
  -- check comparing this column against the member UPDATE allowlist caught
  -- both of these being false.
  ('profiles', 'avatar_url', 'Avatar', 'text', false, false, true, false, 85,
   'Chosen by the member from their own gallery. Never set from here.'),
  ('profiles', 'avatar_is_generated', 'Avatar is generated', 'bool', false, false, false, false, 86,
   'The platform''s evidence that no real photograph is stored (migration 0015). Writable only by the service role.'),
  ('profiles', 'onboarding_completed_at', 'Finished onboarding', 'timestamp', false, false, true, false, 90,
   'Stamped by the member''s own onboarding. Read-only here.'),
  ('profiles', 'created_at', 'Joined the site', 'timestamp', false, false, false, false, 95, null)
on conflict (table_name, column_name) do nothing;

alter table public.data_admin_fields enable row level security;

drop policy if exists "field catalogue: staff read" on public.data_admin_fields;
create policy "field catalogue: staff read" on public.data_admin_fields
  for select using (public.is_staff());

-- Read-only to staff too. Changing what a spreadsheet may write is a migration
-- and a review, not a click.
revoke all on public.data_admin_fields from anon, authenticated;
grant select on public.data_admin_fields to authenticated;

-- ============================================================
-- 4. Which fields are actually filled in
-- ============================================================
--
-- The other half of "which fields exist, which are populated". Dynamic SQL,
-- because the columns are data here rather than something known when this file
-- was written — so: a hard allowlist of tables, every identifier through
-- `%I`, and `is_staff()` on the first line.
--
-- "Populated" is not the same test for every type. An empty string is not a
-- filled-in name, an empty array is not a list of skills, and `'{}'::jsonb` is
-- not a set of links. That is what `kind` in the catalogue is for.
create or replace function public.data_field_stats(p_table text)
returns table (
  column_name text,
  label text,
  kind text,
  editable boolean,
  importable boolean,
  member_authored boolean,
  visibility_control boolean,
  note text,
  populated bigint,
  total bigint
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $fn$
declare
  v_field record;
  v_total bigint;
  v_pop bigint;
  v_pred text;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  if p_table not in ('marketing_contacts', 'profiles') then
    raise exception 'unknown table %', p_table;
  end if;

  execute format('select count(*) from public.%I', p_table) into v_total;

  for v_field in
    select f.column_name, f.label, f.kind, f.editable, f.importable,
           f.member_authored, f.visibility_control, f.note, f.sort_order
      from public.data_admin_fields f
     where f.table_name = p_table
     order by f.sort_order, f.column_name
  loop
    v_pred := case v_field.kind
      when 'text[]' then format('coalesce(array_length(%I, 1), 0) > 0', v_field.column_name)
      when 'jsonb'  then format('%I is not null and %I <> ''{}''::jsonb and %I <> ''[]''::jsonb',
                                v_field.column_name, v_field.column_name, v_field.column_name)
      when 'int'    then format('%I is not null', v_field.column_name)
      when 'bool'   then format('%I is not null', v_field.column_name)
      when 'date'   then format('%I is not null', v_field.column_name)
      when 'timestamp' then format('%I is not null', v_field.column_name)
      else format('nullif(trim(coalesce(%I::text, '''')), '''') is not null', v_field.column_name)
    end;

    execute format('select count(*) from public.%I where %s', p_table, v_pred) into v_pop;

    column_name := v_field.column_name;
    label := v_field.label;
    kind := v_field.kind;
    editable := v_field.editable;
    importable := v_field.importable;
    member_authored := v_field.member_authored;
    visibility_control := v_field.visibility_control;
    note := v_field.note;
    populated := v_pop;
    total := v_total;
    return next;
  end loop;
end;
$fn$;

revoke all on function public.data_field_stats(text) from public, anon;
grant execute on function public.data_field_stats(text) to authenticated;

-- ============================================================
-- 5. The Microsoft 365 mapping — the concrete thing Ahmed asked for
-- ============================================================
--
-- ⚠ READ 0010 AND 0021 BEFORE CHANGING ANYTHING IN THIS SECTION.
--
-- `public.link_contact_to_user(user_id, email)` (0010) matches a new signup
-- against `marketing_contacts` ON THE PERSONAL EMAIL ADDRESS. It is called
-- from `handle_new_user()` (0021, re-declared in 0027) — that is, ONCE, at the
-- moment the auth.users row is created, AND NEVER AGAIN.
--
-- Two consequences, and the second is the one that gets forgotten:
--
--   1. A contact who has a `sahaba_mailbox` but no usable personal email can
--      never be matched, however many times they sign in. Filling the address
--      in is enough for anyone who has NOT yet signed up: the trigger will do
--      the rest when they do.
--
--   2. For someone who HAS ALREADY SIGNED UP, the trigger has already run and
--      will not run again. Filling the address in does nothing at all unless
--      something re-runs the match. Without that, Ahmed types an address into
--      a box, presses save, and nothing whatsoever happens — which is
--      indistinguishable from the feature being broken.
--
-- `admin_update_contact` below closes (2) by calling `link_contact_to_user`
-- itself after any change to `email`. It calls THE REAL FUNCTION rather than
-- reimplementing the match, so the retroactive path and the signup path cannot
-- drift apart; if 0010's matching rule is ever changed, both change together.
--
-- ⚠ WHAT IT DELIBERATELY DOES NOT DO: it does not create the
-- `ms365_accounts` row on the member's behalf. That is 0021's decision, not a
-- gap here. `link_my_ms365_mailbox()` requires the member to say "yes, I know
-- the password" — and 0022 starts a three-month licence clock the moment they
-- do. Claiming a mailbox for somebody from an admin screen would consume a
-- licence and start that clock for a person who never asked, and would hand
-- them a mailbox they may not have the password to. What filling in the email
-- DOES achieve is that `my_ms365_match()` starts returning their mailbox — so
-- the next time they open the site they are offered it, with the reset request
-- as the alternative. The panel says exactly this, per row, rather than
-- claiming a link it has not made.

-- Every contact carrying a Microsoft 365 mailbox, with the two states that
-- decide what to do about it. `security_invoker = off` because it reads
-- `auth.users`, which `authenticated` cannot select — the same reason
-- `prospect_directory` (0027) and `member_directory` (0023) are — so
-- `is_staff()` is carried INSIDE the body. RLS does not apply to a view that
-- reads with the owner's rights, and a check that is not in the body is not
-- made.
drop view if exists public.contact_link_status;

create view public.contact_link_status
with (security_invoker = off) as
select
  c.id,
  c.full_name,
  c.email,
  c.sahaba_username,
  c.sahaba_mailbox,
  c.engagement_count,
  c.last_seen_at,
  c.linked_user_id,
  c.linked_at,
  c.unsubscribed_at,
  c.is_test,

  -- Is the address we hold one this person could actually sign in with?
  --
  -- `marketing_contacts.email` is NOT NULL with a unique index on lower(email),
  -- so "missing" in practice means an empty string or a placeholder rather than
  -- a NULL — and the case that matters just as much is an address that IS
  -- filled in but is the TENANT MAILBOX rather than a personal address. That
  -- person is matchable only if they sign in with their @sahabaclub.com
  -- address, which is exactly what they cannot do when they have lost the
  -- password. Both are 'needs a personal address'.
  case
    when nullif(trim(coalesce(c.email, '')), '') is null then 'missing'
    when c.sahaba_mailbox is not null
     and lower(trim(c.email)) = lower(trim(c.sahaba_mailbox)) then 'is_mailbox'
    when lower(trim(c.email)) like '%@sahabaclub.com' then 'is_mailbox'
    else 'personal'
  end as email_state,

  -- What would happen if the match were run right now.
  case
    when c.linked_user_id is not null then 'linked'
    when exists (
      select 1 from auth.users u
       where u.email_confirmed_at is not null
         and (lower(u.email) = lower(nullif(trim(coalesce(c.email, '')), ''))
           or lower(u.email) = lower(nullif(trim(coalesce(c.sahaba_mailbox, '')), '')))
    ) then 'account_exists'
    else 'no_account'
  end as link_state,

  -- Has this person already claimed a mailbox on the platform? If so there is
  -- nothing here to fix, whatever the address says.
  exists (
    select 1 from public.ms365_accounts a where a.user_id = c.linked_user_id
  ) as has_ms365_account
from public.marketing_contacts c
where public.is_staff();

comment on view public.contact_link_status is
  'Every marketing contact with the two states that decide the Microsoft 365 '
  'mapping: is the address we hold a personal one, and has this person already '
  'signed up. email_state <> ''personal'' with a sahaba_mailbox is the '
  'population that can never be linked until somebody fills the address in.';

revoke all on public.contact_link_status from anon, authenticated;
grant select on public.contact_link_status to authenticated;

-- Re-run the signup match for one contact, without changing anything about
-- them. This is the button for a contact whose personal email was always
-- correct but whose link never happened — a signup where 0021's guarded
-- `link_contact_to_user` call swallowed an error, or a row 0025's backfill did
-- not reach.
create or replace function public.admin_link_contact(p_contact_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp, auth
as $fn$
declare
  v_contact public.marketing_contacts%rowtype;
  v_uid uuid;
  v_addr text;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;

  select * into v_contact from public.marketing_contacts where id = p_contact_id;
  if not found then raise exception 'no such contact'; end if;

  if v_contact.linked_user_id is not null then
    return jsonb_build_object('outcome', 'already_linked', 'user_id', v_contact.linked_user_id);
  end if;

  -- ⚠ Only set the source if nothing has already set it. This function is
  -- called on its own from the panel AND from inside `admin_update_contact`,
  -- which may itself be running under an import. Overwriting the GUC here
  -- would label the audit row for the link 'admin_panel' in the middle of a
  -- 2,200-row spreadsheet run — the one context where knowing it came from a
  -- file is the whole point.
  perform set_config('sc.audit_source',
    coalesce(nullif(current_setting('sc.audit_source', true), ''), 'admin_panel'), true);

  -- Personal address first, tenant mailbox second — the same order and the
  -- same confirmed-address requirement 0021 uses. An unconfirmed address
  -- proves nothing about who is asking, and handing somebody another person's
  -- history because they typed their address into a signup form is the failure
  -- that check exists to prevent.
  for v_addr in
    select a from unnest(array[
      nullif(trim(coalesce(v_contact.email, '')), ''),
      nullif(trim(coalesce(v_contact.sahaba_mailbox, '')), '')
    ]) as a where a is not null
  loop
    select u.id into v_uid
      from auth.users u
     where lower(u.email) = lower(v_addr)
       and u.email_confirmed_at is not null
     limit 1;
    exit when v_uid is not null;
  end loop;

  if v_uid is null then
    return jsonb_build_object('outcome', 'no_account');
  end if;

  -- ⚠ ONE KNOWN EDGE, INHERITED DELIBERATELY. 0010's function has no
  -- `and id = p_contact_id` — it links EVERY unlinked contact matching the
  -- address. `email` is uniquely indexed so a personal-address match hits at
  -- most one row, but `sahaba_mailbox` is NOT unique, so if two contact
  -- records share a mailbox and the match fell through to it, both are linked
  -- to the same member.
  --
  -- That is exactly what the signup trigger already does today, and it is not
  -- fixed from here on purpose: narrowing it would make the retroactive path
  -- behave differently from the signup path, which is the one property this
  -- whole section is built to preserve. If it needs fixing it should be fixed
  -- in `link_contact_to_user` itself, in its own migration, so both callers
  -- change together. The verification block has the query that finds duplicate
  -- mailboxes.
  perform public.link_contact_to_user(v_uid, v_addr);

  select * into v_contact from public.marketing_contacts where id = p_contact_id;
  return jsonb_build_object(
    'outcome', case when v_contact.linked_user_id is not null then 'linked' else 'no_match' end,
    'user_id', v_contact.linked_user_id,
    'has_ms365_account', exists (select 1 from public.ms365_accounts a where a.user_id = v_uid)
  );
end;
$fn$;

-- ============================================================
-- 6. Writing: one row at a time, and a spreadsheet at a time
-- ============================================================

-- Shared helper: coerce one spreadsheet-or-form value into the type the column
-- wants, and say clearly when it cannot. Returns NULL for a blank cell, which
-- everywhere below means "leave this alone" rather than "set it to null" —
-- because a CSV round-trip that omits a column would otherwise erase it.
create or replace function public.admin_coerce_value(p_kind text, p_raw text)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $fn$
declare
  v text := nullif(trim(coalesce(p_raw, '')), '');
begin
  if v is null then return null; end if;

  -- Undo the Excel text-safety wrapper the exporter can add, ="0501234567",
  -- so a file that went out of this system and came back is unchanged. Done
  -- before anything else, and note what it also achieves: a cell that would
  -- otherwise begin with `=` cannot survive into the database as a formula.
  if v ~ '^="' and right(v, 1) = '"' then
    v := replace(substring(v from 3 for length(v) - 3), '""', '"');
    v := nullif(trim(v), '');
    if v is null then return null; end if;
  end if;

  case p_kind
    when 'bool' then
      if lower(v) in ('true', 't', 'yes', 'y', '1') then return to_jsonb(true); end if;
      if lower(v) in ('false', 'f', 'no', 'n', '0') then return to_jsonb(false); end if;
      raise exception 'not a yes/no value: %', v;
    when 'int' then
      if v !~ '^-?\d+$' then raise exception 'not a whole number: %', v; end if;
      return to_jsonb(v::int);
    when 'date' then
      -- ISO only, on purpose. Excel will happily hand back 03/08/2026 and
      -- there is no way to tell 3 August from 8 March; guessing would put a
      -- wrong date of birth on somebody's record with no error anywhere.
      if v !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'dates must be written as YYYY-MM-DD, got: %', v;
      end if;
      return to_jsonb(v::date);
    when 'timestamp' then
      return to_jsonb(v::timestamptz);
    when 'text[]' then
      return to_jsonb(array(
        select trim(x) from unnest(string_to_array(v, ';')) as x where trim(x) <> ''
      ));
    when 'jsonb' then
      return v::jsonb;
    when 'email' then
      if v !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
        raise exception 'not an email address: %', v;
      end if;
      return to_jsonb(lower(v));
    else
      return to_jsonb(v);
  end case;
end;
$fn$;

revoke all on function public.admin_coerce_value(text, text) from public, anon;

-- ---- One contact --------------------------------------------------------
--
-- `p_patch` is {column: value-as-text}. Text rather than typed JSON so that
-- this function and the importer share one coercion, one set of error
-- messages, and one place where "03/08/2026 is ambiguous" is decided.
create or replace function public.admin_update_contact(
  p_contact_id uuid,
  p_patch jsonb,
  p_source text default 'admin_panel'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp, auth
as $fn$
declare
  v_before public.marketing_contacts%rowtype;
  v_after  public.marketing_contacts%rowtype;
  v_key text;
  v_field public.data_admin_fields%rowtype;
  v_val jsonb;
  v_sets text[] := '{}';
  v_email_changed boolean := false;
  v_new_email text;
  v_clash uuid;
  v_link jsonb := null;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;

  select * into v_before from public.marketing_contacts where id = p_contact_id;
  if not found then raise exception 'no such contact'; end if;

  perform set_config('sc.audit_source',
    case when p_source in ('admin_panel', 'import') then p_source else 'other' end, true);

  for v_key in select jsonb_object_keys(p_patch) loop
    select * into v_field from public.data_admin_fields
     where table_name = 'marketing_contacts' and column_name = v_key;

    if not found then raise exception 'unknown field: %', v_key; end if;
    if not v_field.editable then raise exception '% is not editable here', v_field.label; end if;

    -- ⚠ A BLANK MEANS SOMETHING DIFFERENT HERE FROM IN AN IMPORT, DELIBERATELY.
    -- The panel sends only the fields whose value actually changed, so a blank
    -- arriving here is somebody who emptied a box on purpose, with the record
    -- in front of them, and it clears the column. In `admin_import_rows` a
    -- blank cell is ignored, because a spreadsheet that omits a column — or
    -- one where somebody nudged a cell — must not erase 2,200 phone numbers.
    -- One intent, two contexts, two different right answers.
    v_val := public.admin_coerce_value(v_field.kind, p_patch ->> v_key);

    -- ⚠ Consent is one-way. Clearing an unsubscribe or a bounce would put a
    -- person who opted out back on a send list, and the whole reason 0010
    -- records both from day one is that they must survive everything.
    if v_key in ('unsubscribed_at', 'bounced_at') and v_val is null
       and (case v_key when 'unsubscribed_at' then v_before.unsubscribed_at
                       else v_before.bounced_at end) is not null then
      raise exception 'an unsubscribe or a bounce cannot be cleared from here';
    end if;

    if v_key = 'email' then
      v_new_email := v_val #>> '{}';
      if v_new_email is null then raise exception 'a contact must keep an email address'; end if;
      if lower(v_new_email) is distinct from lower(coalesce(v_before.email, '')) then
        select id into v_clash from public.marketing_contacts
         where lower(email) = lower(v_new_email) and id <> p_contact_id;
        if v_clash is not null then
          -- Deliberately NOT merged. Two rows for one person is a judgement
          -- about which history is whose, and a function that guesses at it
          -- would silently discard somebody's engagement record.
          raise exception 'another contact record already uses % — merge the two by hand first', v_new_email
            using errcode = 'unique_violation';
        end if;
        v_email_changed := true;
      end if;
    end if;

    v_sets := v_sets || format('%I = %L', v_key,
      case v_field.kind
        when 'text[]' then (select array(select jsonb_array_elements_text(v_val)))::text
        when 'jsonb'  then v_val::text
        else v_val #>> '{}'
      end);
  end loop;

  if array_length(v_sets, 1) is null then
    return jsonb_build_object('outcome', 'no_change');
  end if;

  execute format('update public.marketing_contacts set %s, updated_at = now() where id = %L',
                 array_to_string(v_sets, ', '), p_contact_id);

  -- ⚠ THE RETROACTIVE LINK. See the long note at the top of §5 for why this is
  -- here and why it calls 0010's function rather than repeating its rule.
  if v_email_changed then
    v_link := public.admin_link_contact(p_contact_id);
  end if;

  select * into v_after from public.marketing_contacts where id = p_contact_id;

  return jsonb_build_object(
    'outcome', 'updated',
    'id', p_contact_id,
    'email_changed', v_email_changed,
    'link', v_link,
    -- What the member will actually experience, in words, so the panel is not
    -- left inventing an explanation.
    'ms365_note', case
      when not v_email_changed then null
      when v_after.sahaba_mailbox is null then null
      when (v_link ->> 'outcome') = 'linked' then
        'Their account is now linked, and the next time they open the site they will be offered ' ||
        v_after.sahaba_mailbox || ' to claim.'
      when (v_link ->> 'outcome') = 'already_linked' then
        'Already linked. If they have not yet claimed ' || v_after.sahaba_mailbox ||
        ', they will be offered it on their next visit.'
      else
        'Nobody has signed up with that address yet. When they do, the signup trigger will link them ' ||
        'and offer them ' || v_after.sahaba_mailbox || '.'
    end
  );
end;
$fn$;

-- ---- A new contact ------------------------------------------------------
create or replace function public.admin_create_contact(
  p_patch jsonb,
  p_source text default 'admin_panel'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp, auth
as $fn$
declare
  v_email text;
  v_id uuid;
  v_link jsonb;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;

  v_email := lower(nullif(trim(coalesce(p_patch ->> 'email', '')), ''));
  if v_email is null then raise exception 'a contact needs an email address'; end if;
  if exists (select 1 from public.marketing_contacts where lower(email) = v_email) then
    raise exception 'a contact with that address already exists' using errcode = 'unique_violation';
  end if;

  perform set_config('sc.audit_source',
    case when p_source in ('admin_panel', 'import') then p_source else 'other' end, true);

  insert into public.marketing_contacts (email) values (v_email) returning id into v_id;

  -- Everything else goes through the update path so there is exactly one place
  -- that decides what a field may contain. `email` is removed first because it
  -- has already been set and re-setting it would look like a change.
  if (p_patch - 'email') <> '{}'::jsonb then
    perform public.admin_update_contact(v_id, p_patch - 'email', p_source);
  end if;

  v_link := public.admin_link_contact(v_id);
  return jsonb_build_object('outcome', 'created', 'id', v_id, 'link', v_link);
end;
$fn$;

-- ---- One profile --------------------------------------------------------
--
-- ⚠ THIS IS A DIFFERENT PATH FROM A MEMBER EDITING THEIR OWN ROW, and that is
-- the point. It is `security definer` and runs as the owner, so 0002's
-- column-level allowlist — which constrains `authenticated` — does not apply
-- to it. No grant is added to `authenticated` anywhere in this migration, and
-- none is needed. Widening the member allowlist so that staff could write
-- these columns would give every member the same privilege, which is the exact
-- inversion this note exists to prevent.
create or replace function public.admin_update_profile(
  p_user_id uuid,
  p_patch jsonb,
  p_source text default 'admin_panel'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_key text;
  v_field public.data_admin_fields%rowtype;
  v_val jsonb;
  v_sets text[] := '{}';
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.profiles where user_id = p_user_id) then
    raise exception 'no such member';
  end if;

  perform set_config('sc.audit_source',
    case when p_source in ('admin_panel', 'import') then p_source else 'other' end, true);

  for v_key in select jsonb_object_keys(p_patch) loop
    select * into v_field from public.data_admin_fields
     where table_name = 'profiles' and column_name = v_key;

    if not found then raise exception 'unknown field: %', v_key; end if;
    if not v_field.editable then raise exception '% is not editable here', v_field.label; end if;

    v_val := public.admin_coerce_value(v_field.kind, p_patch ->> v_key);

    v_sets := v_sets || format('%I = %L', v_key,
      case v_field.kind
        when 'text[]' then (select array(select jsonb_array_elements_text(v_val)))::text
        when 'jsonb'  then v_val::text
        else v_val #>> '{}'
      end);
  end loop;

  if array_length(v_sets, 1) is null then
    return jsonb_build_object('outcome', 'no_change');
  end if;

  -- `enforce_connect_gate` (0018) fires here and will refuse to make an
  -- incomplete profile discoverable. That refusal is wanted: staff must not be
  -- able to put a half-empty card on the Connect wall from a spreadsheet.
  execute format('update public.profiles set %s, updated_at = now() where user_id = %L',
                 array_to_string(v_sets, ', '), p_user_id);

  return jsonb_build_object('outcome', 'updated', 'user_id', p_user_id);
end;
$fn$;

-- ---- A spreadsheet ------------------------------------------------------
--
-- ⚠ DRY RUN FIRST, ALWAYS. A bulk write into 2,200 people's personal data must
-- never be one click, so this function computes a plan and only applies it when
-- asked twice: once with `p_dry_run = true`, and again with the HASH of the
-- plan that was shown. If anything about the plan has changed in between — the
-- file, the options, or the rows themselves because somebody else edited one —
-- the hashes disagree and the commit is refused. A confirm can therefore only
-- ever apply the thing the operator actually read.
--
-- ⚠ WHAT THE DRY RUN IS, HONESTLY. It is a static prediction plus the two
-- checks that can be made without writing: the unique-address collision, and
-- `profile_is_complete` for any row turning on `is_discoverable`. It is NOT a
-- rehearsal inside a rolled-back transaction. That was the first design and it
-- does not work: the rollback that makes the rehearsal real also destroys the
-- plan it produced, and smuggling the plan out through an exception message
-- would put half a megabyte of JSON into an error string. So the commit
-- re-checks every row as it applies it and reports anything the database still
-- refused, and the panel shows the plan and the outcome side by side.
--
-- ⚠ WHICH COLUMN IS THE KEY, WHICH IS THE WHOLE REASON THE ROUND TRIP WORKS.
--
--   * `marketing_contacts` is keyed on `id` WHEN THE FILE HAS AN `id` COLUMN,
--     and on `email` otherwise.
--   * `profiles` is keyed on `user_id`, always.
--
-- That `id` case is not a convenience, it is the Microsoft 365 workflow. The
-- job is "this person's personal email is missing — type it in", and a file
-- keyed on the address CANNOT DO THAT: looking the row up by the address you
-- are about to give them finds nothing, so every corrected row would arrive as
-- a brand new duplicate contact and the mailbox would stay orphaned. Keyed on
-- `id`, the same export → edit in Excel → re-import cycle updates the person
-- who is already there, and each corrected address runs the retroactive link.
--
-- When the file is keyed on `email`, `email` is not importable — a key cannot
-- rename itself. That is why the exporter puts `id` in the file.
--
-- p_rows: [{ "<column>": "<cell as text>", ... }] — the parsed spreadsheet.
-- p_options:
--   overwrite_member_authored  bool, default false. See the conflict rule.
--   skip_keys                  [text], rows to leave alone entirely.
create or replace function public.admin_import_rows(
  p_table text,
  p_rows jsonb,
  p_dry_run boolean default true,
  p_options jsonb default '{}'::jsonb,
  p_expected_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp, auth
as $fn$
declare
  v_row jsonb;
  v_i int := 0;
  v_key text;
  v_col text;
  v_field public.data_admin_fields%rowtype;
  v_plan jsonb := '[]'::jsonb;
  v_entry jsonb;
  v_changes jsonb;
  v_conflicts jsonb;
  v_reject text;
  v_bad text;
  v_keyed_by text;
  v_id_cell text;
  v_target_id uuid;
  v_seen text[] := '{}';
  v_val jsonb;
  v_old text;
  v_new text;
  v_overwrite boolean := coalesce((p_options ->> 'overwrite_member_authored')::boolean, false);
  v_skip text[] := coalesce(
    (select array(select jsonb_array_elements_text(p_options -> 'skip_keys'))), '{}');
  v_hash text;
  v_counts jsonb;
  v_applied jsonb := '[]'::jsonb;
  v_patch jsonb;
  v_res jsonb;
  v_incomplete boolean;
  v_prof public.profiles%rowtype;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  if p_table not in ('marketing_contacts', 'profiles') then
    raise exception 'unknown table %', p_table;
  end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows must be an array'; end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'that is % rows; split the file — this refuses more than 5000 at once',
      jsonb_array_length(p_rows);
  end if;

  -- ---- Build the plan, row by row ----
  for v_row in select jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    v_reject := null;
    v_changes := '{}'::jsonb;
    v_conflicts := '{}'::jsonb;
    v_target_id := null;
    v_keyed_by := null;

    -- ---- The key ----
    if p_table = 'marketing_contacts' then
      v_id_cell := lower(nullif(trim(coalesce(v_row ->> 'id', '')), ''));

      if v_id_cell is not null then
        -- Keyed on id: the export → correct in Excel → re-import cycle. This
        -- is the path that can change somebody's email address, which is the
        -- whole Microsoft 365 job.
        v_keyed_by := 'id';
        v_key := v_id_cell;
        if v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          v_reject := 'id is not a uuid: ' || v_key;
        else
          select mc.id into v_target_id from public.marketing_contacts mc where mc.id = v_key::uuid;
          if v_target_id is null then
            v_reject := 'no contact has that id — it did not come from an export of this database';
          end if;
        end if;
      else
        v_keyed_by := 'email';
        v_key := lower(nullif(trim(coalesce(v_row ->> 'email', '')), ''));
        if v_key is null then
          v_reject := 'no id and no email address, so there is nothing to match this row on';
        elsif v_key !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
          v_reject := 'that is not an email address: ' || v_key;
        else
          select mc.id into v_target_id from public.marketing_contacts mc
           where lower(mc.email) = v_key;
        end if;
      end if;
    else
      v_keyed_by := 'user_id';
      v_key := lower(nullif(trim(coalesce(v_row ->> 'user_id', '')), ''));
      if v_key is null then
        -- ⚠ NOT A LIMITATION TO WORK AROUND. A profile row requires an
        -- `auth.users` row, so "create a member from a spreadsheet" means
        -- creating auth accounts for people who never asked for one. 0027
        -- considered exactly that and rejected it: an auth.users row is
        -- reachable by password-reset mail, so a stranger who guesses an
        -- address can make the club email a person who never signed up.
        v_reject := 'no user_id, and members cannot be created from a file — only a real signup creates an account';
      elsif v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_reject := 'user_id is not a uuid: ' || v_key;
      else
        select p.* into v_prof from public.profiles p where p.user_id = v_key::uuid;
        if found then v_target_id := v_prof.user_id;
        else v_reject := 'no member has that user_id';
        end if;
      end if;
    end if;

    if v_reject is null and v_key = any (v_seen) then
      v_reject := 'this row repeats a key already in the file; only the first one is applied';
    end if;
    if v_reject is null then v_seen := v_seen || v_key; end if;

    -- ---- Compare each supplied cell with what is there ----
    if v_reject is null then
      for v_col in select jsonb_object_keys(v_row) loop
        -- The key column never imports as data. `email` is a real, importable
        -- field when the row is keyed on `id`, and only then.
        if v_col = 'id' or v_col = 'user_id' then continue; end if;
        if v_col = 'email' and v_keyed_by <> 'id' then continue; end if;

        select * into v_field from public.data_admin_fields
         where table_name = p_table and column_name = v_col;

        if not found then
          -- An unrecognised column is skipped, not fatal: exports carry
          -- read-only columns (engagement counts, timestamps) and a file that
          -- came out of this system must be able to go back into it.
          continue;
        end if;
        if not v_field.importable then continue; end if;

        -- CONTINUE cannot be used to leave a block that has an exception
        -- handler, so the failure is carried out in a variable instead.
        v_bad := null;
        begin
          v_val := public.admin_coerce_value(v_field.kind, v_row ->> v_col);
        exception when others then
          v_bad := sqlerrm;
        end;
        if v_bad is not null then
          v_reject := coalesce(v_reject, '') || v_col || ': ' || v_bad || '. ';
          continue;
        end if;

        -- A blank cell means "leave this alone", never "erase it". An export
        -- that omits a column, or a row where somebody cleared a cell by
        -- accident, must not wipe a phone number.
        if v_val is null then continue; end if;

        if v_target_id is null then
          v_changes := v_changes || jsonb_build_object(v_col, jsonb_build_object('from', null, 'to', v_val));
          continue;
        end if;

        execute format('select %I::text from public.%I where %I = %L',
                       v_col, p_table,
                       case when p_table = 'profiles' then 'user_id' else 'id' end,
                       v_target_id)
          into v_old;

        v_new := case v_field.kind
          when 'text[]' then (select array(select jsonb_array_elements_text(v_val)))::text
          when 'jsonb'  then v_val::text
          else v_val #>> '{}'
        end;

        if v_old is not distinct from v_new then continue; end if;

        -- ⚠ THE RULE THAT KEEPS A SPREADSHEET FROM SPEAKING FOR A MEMBER.
        -- A member-authored field that ALREADY HAS SOMETHING IN IT is never
        -- overwritten silently. Filling a blank one is fine — that is exactly
        -- what `claim_prospect_for` (0027) does with its coalesce, and for the
        -- same reason: adding what somebody has not said is help, replacing
        -- what they have said is not.
        if v_field.member_authored and nullif(trim(coalesce(v_old, '')), '') is not null
           and v_old not in ('{}', '[]') then
          v_conflicts := v_conflicts || jsonb_build_object(v_col,
            jsonb_build_object('theirs', public.audit_clip(to_jsonb(v_old)),
                               'yours',  public.audit_clip(to_jsonb(v_new))));
          if v_overwrite then
            v_changes := v_changes || jsonb_build_object(v_col,
              jsonb_build_object('from', to_jsonb(v_old), 'to', v_val));
          end if;
          continue;
        end if;

        -- Consent, again. An import may record an unsubscribe; it may never
        -- undo one.
        if v_col in ('unsubscribed_at', 'bounced_at') then
          continue;  -- not importable at all; here as a second guard
        end if;

        v_changes := v_changes || jsonb_build_object(v_col,
          jsonb_build_object('from', public.audit_clip(to_jsonb(v_old)), 'to', v_val));
      end loop;
    end if;

    -- ---- The two checks that would otherwise only surface at commit ----
    --
    -- A dry run that says "update" and a commit that says "unique violation"
    -- is a dry run that did not do its job, and both of these are the likely
    -- failures rather than exotic ones. The address collision is what happens
    -- when the person already exists twice; the Connect gate is what happens
    -- when somebody ticks the visibility column down a whole spreadsheet.
    if v_reject is null and v_changes ? 'email' then
      if exists (
        select 1 from public.marketing_contacts mc
         where lower(mc.email) = lower(v_changes -> 'email' -> 'to' #>> '{}')
           and mc.id is distinct from v_target_id
      ) then
        v_reject := 'another contact record already uses that address — merge the two by hand first';
      end if;
    end if;

    if v_reject is null and p_table = 'profiles' and v_changes ? 'is_discoverable'
       and (v_changes -> 'is_discoverable' -> 'to')::text = 'true' then
      select not public.profile_is_complete(p) into v_incomplete
        from public.profiles p where p.user_id = v_target_id;
      if v_incomplete then
        v_reject := 'cannot be made visible in Connect: the profile needs a name, a picture, a bio or headline, and an interest';
      end if;
    end if;

    v_entry := jsonb_build_object(
      -- ⚠ `row`, not `line`, and the distinction is not pedantry. This counts
      -- DATA ROWS from 1, because that is what the operator is looking at in
      -- Excel once the header is frozen. The parser's `ragged` report counts
      -- FILE LINES, which is what you need to find an unterminated quote. They
      -- differ by the header, and by more than that once a quoted field
      -- contains a newline — so they are named differently rather than being
      -- one number that is wrong half the time.
      'row', v_i,
      'key', v_key,
      'keyed_by', v_keyed_by,
      'action', case
        when v_reject is not null then 'rejected'
        when v_key = any (v_skip) then 'skipped'
        when v_target_id is null then 'insert'
        when v_changes = '{}'::jsonb and v_conflicts = '{}'::jsonb then 'unchanged'
        when v_changes = '{}'::jsonb then 'conflict'
        else 'update'
      end,
      'changes', v_changes,
      'conflicts', v_conflicts,
      'reason', v_reject
    );
    v_plan := v_plan || jsonb_build_array(v_entry);
  end loop;

  -- The hash the confirm has to match. Over the plan, not over the file, so a
  -- row somebody else edited while the preview was on screen changes it too.
  v_hash := md5(v_plan::text || coalesce(p_options::text, '') || p_table);

  v_counts := (
    select jsonb_object_agg(action, n) from (
      select e ->> 'action' as action, count(*) as n
        from jsonb_array_elements(v_plan) e group by 1
    ) s
  );

  if p_dry_run then
    return jsonb_build_object(
      'dry_run', true, 'table', p_table, 'plan_hash', v_hash,
      'counts', coalesce(v_counts, '{}'::jsonb), 'plan', v_plan
    );
  end if;

  -- ---- Commit ----
  if p_expected_hash is null or p_expected_hash <> v_hash then
    raise exception
      'this is not the change you were shown — re-run the preview. (Either the file, the options, or one of the rows changed underneath it.)';
  end if;

  for v_entry in select jsonb_array_elements(v_plan) loop
    if v_entry ->> 'action' not in ('insert', 'update') then continue; end if;

    v_patch := (
      select jsonb_object_agg(k, case when jsonb_typeof(v -> 'to') = 'string'
                                      then v -> 'to' #>> '{}'
                                      when jsonb_typeof(v -> 'to') = 'array'
                                      then array_to_string(
                                             array(select jsonb_array_elements_text(v -> 'to')), ';')
                                      else (v -> 'to')::text end)
        from jsonb_each(v_entry -> 'changes') as e(k, v)
    );

    begin
      if p_table = 'marketing_contacts' then
        if v_entry ->> 'action' = 'insert' then
          v_res := public.admin_create_contact(
            coalesce(v_patch, '{}'::jsonb) || jsonb_build_object('email', v_entry ->> 'key'), 'import');
        else
          if v_entry ->> 'keyed_by' = 'id' then
            v_target_id := (v_entry ->> 'key')::uuid;
          else
            select mc.id into v_target_id from public.marketing_contacts mc
             where lower(mc.email) = (v_entry ->> 'key');
          end if;
          -- ⚠ This is the call that runs the retroactive Microsoft 365 link
          -- for every corrected address in the file, one row at a time,
          -- because `admin_update_contact` does it whenever `email` changes.
          -- A bulk `update ... set email` would not, and that is exactly the
          -- silent failure this whole feature exists to avoid.
          v_res := public.admin_update_contact(v_target_id, coalesce(v_patch, '{}'::jsonb), 'import');
        end if;
      else
        v_res := public.admin_update_profile((v_entry ->> 'key')::uuid,
                                             coalesce(v_patch, '{}'::jsonb), 'import');
      end if;
      v_applied := v_applied || jsonb_build_array(
        jsonb_build_object('row', v_entry -> 'row', 'key', v_entry -> 'key',
                           'action', v_entry -> 'action', 'ok', true));
    exception when others then
      -- One bad row must not take the other 2,199 with it. The per-row
      -- exception block is an implicit savepoint, so the failed row is rolled
      -- back and the rest continue.
      v_applied := v_applied || jsonb_build_array(
        jsonb_build_object('row', v_entry -> 'row', 'key', v_entry -> 'key',
                           'action', v_entry -> 'action', 'ok', false, 'error', sqlerrm));
    end;
  end loop;

  return jsonb_build_object(
    'dry_run', false, 'table', p_table, 'plan_hash', v_hash,
    'counts', coalesce(v_counts, '{}'::jsonb),
    'applied', v_applied,
    'failed', (select count(*) from jsonb_array_elements(v_applied) a
                where (a ->> 'ok')::boolean is not true)
  );
end;
$fn$;

-- ============================================================
-- 7. Access to the functions
-- ============================================================
--
-- The same shape 0022 uses: revoked from everything, then EXECUTE granted back
-- to `authenticated` because the admin page has to be able to call them at
-- all. The `is_staff()` check on the first line of each body is the real gate,
-- and a member who calls one gets 'not allowed' rather than silent success.

revoke all on function public.admin_link_contact(uuid) from public, anon, authenticated;
revoke all on function public.admin_update_contact(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.admin_create_contact(jsonb, text) from public, anon, authenticated;
revoke all on function public.admin_update_profile(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.admin_import_rows(text, jsonb, boolean, jsonb, text) from public, anon, authenticated;

grant execute on function public.admin_link_contact(uuid) to authenticated;
grant execute on function public.admin_update_contact(uuid, jsonb, text) to authenticated;
grant execute on function public.admin_create_contact(jsonb, text) to authenticated;
grant execute on function public.admin_update_profile(uuid, jsonb, text) to authenticated;
grant execute on function public.admin_import_rows(text, jsonb, boolean, jsonb, text) to authenticated;

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- ---- The grants, which are the part that fails silently ----
--
-- No client role may reach the audit trail or the export log except by SELECT
-- (expect exactly one row each, privilege_type = SELECT, grantee =
-- 'authenticated'):
--   select table_name, grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_name in ('data_admin_audit','data_export_log','data_admin_fields')
--      and grantee in ('anon','authenticated')
--    order by 1, 2, 3;
--
-- ⚠ Staff must NOT hold INSERT on the export log, or the log is advisory
-- rather than a control (expect ZERO rows):
--   select privilege_type from information_schema.role_table_grants
--    where table_name = 'data_export_log' and grantee = 'authenticated'
--      and privilege_type <> 'SELECT';
--
-- anon cannot see the link-status view (expect ZERO rows):
--   select grantee from information_schema.role_table_grants
--    where table_name = 'contact_link_status' and grantee = 'anon';
--
-- ⚠ THE MOST REPEATED BUG IN THIS PROJECT. This migration adds no column to
-- `profiles` and must therefore add no UPDATE grant. Run this before and after
-- applying and compare — the list must be IDENTICAL:
--   select column_name from information_schema.column_privileges
--    where table_schema='public' and table_name='profiles'
--      and grantee='authenticated' and privilege_type='UPDATE'
--    order by column_name;
--
-- And the table-wide grant must still be gone, or that list is decorative:
--   select privilege_type from information_schema.role_table_grants
--    where table_schema='public' and table_name='profiles'
--      and grantee='authenticated' and privilege_type='UPDATE';
--   -- expect ZERO rows
--
-- ⚠ `member_authored` must still match the member allowlist. These two lists
-- WILL drift the next time somebody adds a column to `profiles`; when they do,
-- a spreadsheet can silently overwrite something a member wrote. Expect ZERO
-- rows from both halves:
--   select column_name, 'writable by members but not flagged' as problem
--     from information_schema.column_privileges
--    where table_schema='public' and table_name='profiles'
--      and grantee='authenticated' and privilege_type='UPDATE'
--      and column_name in (select column_name from public.data_admin_fields
--                           where table_name='profiles')
--      and column_name not in (select column_name from public.data_admin_fields
--                               where table_name='profiles' and member_authored)
--   union all
--   select column_name, 'flagged but members cannot write it'
--     from public.data_admin_fields
--    where table_name='profiles' and member_authored
--      and column_name not in (
--          select column_name from information_schema.column_privileges
--           where table_schema='public' and table_name='profiles'
--             and grantee='authenticated' and privilege_type='UPDATE');
--
-- ---- The staff gate ----
--
-- Every one of these must raise 'not allowed' when run as a non-staff member,
-- and none of them may be reachable by anon at all:
--   set role authenticated;  -- with a member's JWT
--   select public.data_field_stats('profiles');
--   select public.admin_import_rows('profiles', '[]'::jsonb, true);
--   select public.admin_link_contact(gen_random_uuid());
--   select * from public.contact_link_status;   -- expect ZERO rows, not an error
--
-- ---- The audit actually writes ----
--
-- ⚠ The trigger swallows its own failures on purpose (see §1), so the only way
-- to know it is working is to look. Edit one contact and then:
--   select occurred_at, actor_email, source, operation, changes
--     from public.data_admin_audit
--    where table_name = 'marketing_contacts'
--    order by occurred_at desc limit 5;
--   -- expect a row whose `changes` names exactly the fields you changed
--
-- And it must NOT be full of machine churn. Send a campaign, or let the
-- engagement trigger fire, and check nothing was recorded for it:
--   select count(*) from public.data_admin_audit
--    where changes ?| array['engagement_count','last_emailed_at','avatar_url','avatar_gallery'];
--   -- expect 0
--
-- Nobody but the trigger may write it. As staff, both of these must fail:
--   insert into public.data_admin_audit (table_name,row_pk,operation) values ('x','y','insert');
--   delete from public.data_admin_audit;
--
-- ---- The Microsoft 365 population, which is the job ----
--
-- How many people this is actually about. Read the number; do not assume it:
--   select email_state, link_state, count(*)
--     from public.contact_link_status
--    where sahaba_mailbox is not null
--    group by 1, 2 order by 1, 2;
--
-- The ones who can never be linked until somebody types an address in:
--   select count(*) from public.contact_link_status
--    where sahaba_mailbox is not null and email_state <> 'personal';
--
-- The ones who HAVE signed up and were never linked — case (2) in §5, the one
-- that filling in a field does nothing about unless something re-runs the
-- match:
--   select count(*) from public.contact_link_status
--    where link_state = 'account_exists';
--
-- Mailboxes held by more than one contact record. See the note beside the
-- `link_contact_to_user` call for what happens to these — expect zero rows,
-- and if not, fix them by hand before using "Link now" on any of them:
--   select lower(sahaba_mailbox), count(*) from public.marketing_contacts
--    where sahaba_mailbox is not null group by 1 having count(*) > 1;
--
-- ⚠ END TO END, WHICH IS THE ONLY PROOF THAT COUNTS. Do this on a throwaway
-- account, not on a real person's row:
--   1. sign up with a test address and confirm it;
--   2. create a contact with a DIFFERENT address and a sahaba_mailbox, so the
--      signup trigger has already run and missed them;
--   3. select public.admin_update_contact('<contact id>',
--        jsonb_build_object('email', '<the test address>'));
--   4. the result must say outcome 'updated' and link.outcome 'linked';
--   5. select linked_user_id from public.marketing_contacts where id = '<id>';
--      -- expect the test user's id, NOT null. If it is null, the retroactive
--      -- link is not working and filling in an address does nothing.
--   6. as that member: select * from public.my_ms365_match();
--      -- expect one row naming the mailbox, source 'contact'. This is the
--      -- thing the member sees. `ms365_accounts` is deliberately still empty:
--      -- claiming the mailbox is their act, not ours (see §5).
--
-- ---- Import ----
--
-- The dry run must change nothing. Take a count, preview a file that would
-- update fifty rows, take the count again, and diff the audit:
--   select count(*) from public.data_admin_audit;   -- before and after
--   -- expect the same number
--
-- A commit with a stale hash must be refused rather than applied:
--   select public.admin_import_rows('marketing_contacts', '<rows>'::jsonb,
--                                   false, '{}'::jsonb, 'not-the-right-hash');
--   -- expect: 'this is not the change you were shown'
--
-- A member's own bio must survive a spreadsheet that disagrees with it. Import
-- a row whose bio differs from a member who has written one, WITHOUT
-- overwrite_member_authored:
--   -- expect that row's action = 'conflict', its `conflicts` naming bio, and
--   -- the bio in the database unchanged afterwards.
--
-- ---- Export ----
--
-- Every export leaves a trace, and staff cannot forge one:
--   select exported_at, actor_email, dataset, scope, row_count,
--          includes_email, includes_phone, filter_label
--     from public.data_export_log order by exported_at desc limit 10;
