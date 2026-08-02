-- Sahaba Club — the avatar builder stops making people wait, and keeps its work
-- ------------------------------------------------------------
-- generate-avatar used to hold the member's HTTP request open for the entire
-- OpenAI image call. That is tens of seconds on a good day, and a test run has
-- already been killed for going past a 45-second limit. A member watching a
-- spinner that long assumes the page has hung, and the only thing they can do
-- about it — press the button again — is the thing that makes it worse.
--
-- So the function now answers 202 the moment the attempt is reserved and does
-- the drawing in the background. That trade needs somewhere to put the answer,
-- because the connection the answer used to travel down has gone: hence
-- `avatar_status` and `avatar_error`. The member's page polls their own
-- profile row, which it already reads, rather than this needing a second
-- endpoint to ask "is it done yet".
--
-- And once three tries produce three genuinely different pictures (the variant
-- rota in _shared/avatar-art.ts), throwing the first two away is a waste of
-- money the club has already spent: `avatar_gallery` keeps them, and
-- select_avatar_from_gallery lets a member go back to one.
--
-- ⚠ The three columns below are NOT member-editable, and there is no
-- `grant update` for them anywhere in this file. That omission is DELIBERATE.
-- See the long note under the grants section before "fixing" it.

-- ============================================================
-- 1. What the drawing is doing right now
-- ============================================================

-- 'idle'       nothing has been asked for (the default, and every existing row)
-- 'queued'     accepted, not yet started
-- 'generating' the image call is in flight
-- 'ready'      there is a finished avatar_url to show
-- 'failed'     it did not work, and avatar_error says why in a sentence
--
-- 'queued' is in the CHECK but nothing writes it today: generate-avatar starts
-- the work in the same instance that took the request, so an accepted attempt
-- is already generating. It is here because the natural next step — a real
-- queue, if image calls ever need retrying or rate-limiting across members —
-- would otherwise need a migration to add one word to a constraint, and a
-- client written against a status set that gains a value later is a client
-- that breaks later. Better to have the page handle it from the start.
alter table public.profiles
  add column if not exists avatar_status text not null default 'idle',
  add column if not exists avatar_error text,
  -- Newest-first array of past drawings:
  --   [{ "url": "...", "prompt": "...", "theme": "...",
  --      "variant": 0, "cycle": "2026-08", "created_at": "..." }]
  --
  -- jsonb rather than a child table, on the same reasoning as work_history in
  -- 0023: it is always read and written whole, as one block belonging to one
  -- profile, and never queried across members. Capped at twelve entries by the
  -- function that writes it — a column read on every profile load must not
  -- grow without limit.
  add column if not exists avatar_gallery jsonb not null default '[]'::jsonb;

-- A CHECK rather than an enum: adding a value to an enum is a type change that
-- cannot be done inside a transaction on older Postgres, and this list will
-- move again.
alter table public.profiles
  drop constraint if exists avatar_status_known;
alter table public.profiles
  add constraint avatar_status_known
  check (avatar_status in ('idle','queued','generating','ready','failed'));

comment on column public.profiles.avatar_status is
  'Written only by generate-avatar (service role). The member polls this after '
  'a 202 to find out whether their drawing landed.';

comment on column public.profiles.avatar_error is
  'A sentence written for the member, not a stack trace — it is shown to them.';

comment on column public.profiles.avatar_gallery is
  'Newest-first, capped at 12 by generate-avatar. Read-only to the member; '
  'they change avatar_url through select_avatar_from_gallery().';

-- ============================================================
-- 2. Grants — the omission here is the point
-- ============================================================

-- ⚠ THE MOST REPEATED BUG IN THIS PROJECT is adding a member-editable column
-- to `profiles` and forgetting the `grant update`. The table uses an explicit
-- column-level UPDATE allowlist (0002 → 0005 → 0017 → 0019 → 0022 → 0023), a
-- column-level REVOKE is a no-op where the grant was never made, and the
-- failure is silent: PostgREST returns success and zero rows changed.
--
-- Which is exactly why this note exists. THESE THREE COLUMNS ARE DELIBERATELY
-- NOT GRANTED, and the next person to read this file should not "fix" it.
--
--   avatar_status   a member who could write it could set 'ready' on an avatar
--                   nobody generated — forging the outcome of a run the club
--                   paid for, and defeating the attempt cap that the status is
--                   there to make visible.
--   avatar_error    it is the club's account of what went wrong, shown to the
--                   member as ours. If they can write it, it is not ours.
--   avatar_gallery  this is the load-bearing one. select_avatar_from_gallery()
--                   below will set avatar_url to any URL that appears in the
--                   caller's own gallery, and that is only safe because the
--                   gallery can be written by nothing but the Edge Function.
--                   A member who could append to it could put any URL on the
--                   internet in there and then "select" it onto their profile
--                   — which is how the no-real-photographs promise would end.
--
-- There is no REVOKE either, for the reason 0015 and 0018 both spell out: a
-- column-level REVOKE only removes a privilege that was actually granted, so
-- writing one here would change nothing while looking like a control, and the
-- verification query below would then pass for the wrong reason. The real
-- protection is 0002's design — the table-wide UPDATE is revoked and privileges
-- are handed back as an explicit allowlist, so a new column starts unwritable.
-- Keeping these three off that list IS the control. The check at the end
-- asserts it, and that assertion is what makes the function below safe.

-- ============================================================
-- 3. Putting an older drawing back
-- ============================================================

-- The member picks one of their past avatars. They cannot do this with a plain
-- UPDATE of avatar_url, even though 0005 grants them that column, because the
-- point is not "set avatar_url" — they can already do that — it is "set it to
-- something we drew, and prove it". The proof lives in the gallery, and the
-- gallery is not theirs to write, so the check has to happen somewhere they
-- cannot reach: here.
--
-- The caller is resolved from auth.uid() and NEVER from an argument. This is
-- security definer, so it bypasses RLS entirely; a p_user_id parameter would
-- make it a function for setting other people's avatars. Same contract as
-- link_my_ms365_mailbox() in 0021 and 0022, for the same reason.
create or replace function public.select_avatar_from_gallery(p_url text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_found boolean;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  -- "in THAT CALLER'S OWN gallery". The user_id predicate is doing as much
  -- work as the url one: without it this would accept any URL that any member
  -- had ever been given, which is a slower way of accepting anything.
  select exists (
    select 1
    from public.profiles p,
         lateral jsonb_array_elements(coalesce(p.avatar_gallery, '[]'::jsonb)) as entry
    where p.user_id = v_uid
      and entry->>'url' = p_url
  ) into v_found;

  if not v_found then
    -- Deliberately the same message whether the gallery is empty, the URL was
    -- never ours, or it belongs to somebody else. A caller probing this should
    -- not learn which.
    raise exception 'that image is not in your avatar gallery';
  end if;

  -- avatar_url only. Nothing else moves: the picture was already generated,
  -- already stamped with its source and its purge receipt, and already counted
  -- against the month's allowance when it was drawn. Re-selecting it is not a
  -- new generation and must not look like one — in particular it must not
  -- touch avatar_refreshed_at or avatar_cycle, or a member could keep
  -- themselves out of the monthly refresh by clicking through their own
  -- gallery.
  update public.profiles
     set avatar_url = p_url,
         updated_at = now()
   where user_id = v_uid;

  return p_url;
end;
$fn$;

comment on function public.select_avatar_from_gallery(text) is
  'Sets your own avatar_url to one of your own past generated avatars. '
  'security definer because the gallery it checks against is a column members '
  'cannot write — which is what makes the check worth anything. The caller '
  'comes from auth.uid(), never from an argument.';

revoke all on function public.select_avatar_from_gallery(text) from public, anon;
grant execute on function public.select_avatar_from_gallery(text) to authenticated;

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- The three columns exist, with the right defaults (expect three rows;
-- avatar_status defaults to 'idle' and avatar_gallery to '[]'::jsonb):
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='profiles'
--      and column_name in ('avatar_status','avatar_error','avatar_gallery');
--
-- The status list is enforced — this must RAISE, not succeed:
--   update public.profiles set avatar_status = 'nearly' where user_id = auth.uid();
--
-- ⚠ THE IMPORTANT ONE. `authenticated` must have NO update grant on any of the
-- three (expect ZERO rows). This is the opposite of the usual check in this
-- project, and it is not an oversight — see the long note in section 2:
--   select column_name from information_schema.column_privileges
--    where table_schema='public' and table_name='profiles'
--      and grantee='authenticated' and privilege_type='UPDATE'
--      and column_name in ('avatar_status','avatar_error','avatar_gallery');
--
-- And the table-wide grant must still be revoked, or that allowlist is
-- decorative (expect ZERO rows):
--   select privilege_type from information_schema.role_table_grants
--    where table_schema='public' and table_name='profiles'
--      and grantee='authenticated' and privilege_type='UPDATE';
--
-- The function exists and is security definer (expect one row, prosecdef = t):
--   select p.proname, p.prosecdef, pg_get_function_identity_arguments(p.oid)
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='public' and p.proname='select_avatar_from_gallery';
--
-- anon cannot execute it (expect zero rows):
--   select grantee, privilege_type from information_schema.role_routine_grants
--    where routine_schema='public' and routine_name='select_avatar_from_gallery'
--      and grantee in ('anon','public');
--
-- End-to-end, signed in as a member who has generated at least one avatar.
-- The first must return the URL and change their profile; the second must
-- RAISE, and is the whole reason the gallery is ungranted:
--   select public.select_avatar_from_gallery(
--     (select entry->>'url' from public.profiles p,
--             lateral jsonb_array_elements(p.avatar_gallery) entry
--       where p.user_id = auth.uid() limit 1));
--   select public.select_avatar_from_gallery('https://example.com/not-ours.png');
--
-- And the silent failure the ungranted columns are supposed to produce — a
-- member trying to write them directly must change ZERO rows:
--   update public.profiles set avatar_status = 'ready'
--    where user_id = auth.uid() returning user_id;
