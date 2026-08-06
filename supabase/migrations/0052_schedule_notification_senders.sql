-- 0052 — actually call the two senders
-- ============================================================
--
-- `send-push` (0047) and `send-notification-emails` (0051) are both written,
-- and nothing invokes either. That is the precise shape of the
-- `send-license-reminders` failure this project has already made twice: a job
-- that exists, documents its own cron call, and has never once run.
--
-- Unlike the three sweeps in 0046 — plain SQL functions cron can call
-- directly — these are HTTP endpoints. That needs `pg_net`, and it needs a
-- credential.
--
-- ============================================================
-- ⚠ THE CREDENTIAL IS NOT IN THIS FILE, AND MUST NOT BE
-- ============================================================
--
-- `cron.schedule` stores its command as PLAINTEXT in `cron.job`, readable by
-- any SQL session. Pasting the service-role key into a schedule would publish
-- total database authority to everyone who can open the SQL editor, and it
-- would sit there being copied forward by every future migration that touched
-- the job.
--
-- So the key lives in Supabase Vault and is read at call time. **Ahmed creates
-- that secret himself** — this file never sees the value, and neither does
-- anybody reading this repository:
--
--   select vault.create_secret(
--     '<the service_role key>',
--     'service_role_key',
--     'Used by pg_cron to call the notification senders (0052)'
--   );
--
-- ⚠ Run that ONCE, in the SQL editor, and do not commit it anywhere.
-- ⚠ If the key is ever rotated, update the Vault secret — the schedules below
--    read it by name and keep working.
--
-- Section 3 checks the secret exists and REFUSES to schedule without it,
-- rather than creating jobs that would fail with an auth error every five
-- minutes into a log nobody reads.

-- ============================================================
-- 1. Where the senders live
-- ============================================================

create or replace function public.functions_base_url()
returns text
language sql
immutable
as $$
  select 'https://sobxhcsgtimtiqtvqbag.supabase.co/functions/v1';
$$;

comment on function public.functions_base_url is
  'The Edge Function origin, in one place so a project ref change is one edit.';

-- ============================================================
-- 2. One entry point per sender
-- ============================================================
--
-- A function rather than an inline `net.http_post` in the schedule, for two
-- reasons: the key is fetched INSIDE the function so it never appears in
-- `cron.job`, and the call can be run by hand for testing without recreating
-- the schedule.
--
-- ⚠ `security definer` and revoked from every client role. This posts with the
-- service-role key; anything that could call it could make the club send mail.

create or replace function public.invoke_notification_sender(p_function text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text;
  v_request_id bigint;
begin
  -- Only the two senders. A free-text function name here would turn this into
  -- a way to call ANY Edge Function with the service-role key attached.
  if p_function not in ('send-push', 'send-notification-emails') then
    raise exception 'invoke_notification_sender: % is not a schedulable sender', p_function;
  end if;

  select decrypted_secret into v_key
    from vault.decrypted_secrets
   where name = 'service_role_key'
   limit 1;

  if v_key is null then
    raise exception 'invoke_notification_sender: no vault secret named service_role_key'
      using hint = 'See the header of 0052 — create it once with vault.create_secret().';
  end if;

  select net.http_post(
    url     := public.functions_base_url() || '/' || p_function,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := '{}'::jsonb,
    -- pg_net is fire-and-forget: this returns a request id immediately and the
    -- response lands in net._http_response later. A long timeout here would
    -- not make the call more reliable, it would only hold a worker.
    timeout_milliseconds := 30000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke execute on function public.invoke_notification_sender(text) from public, anon, authenticated;
revoke execute on function public.functions_base_url() from public, anon, authenticated;

-- ============================================================
-- 3. The schedules
-- ============================================================
--
-- ⚠ Guarded on the Vault secret existing. Scheduling without it would create
-- two jobs that fail every five minutes for a reason nobody would see —
-- exactly the silent-failure pattern this whole feature keeps designing
-- against.
--
-- Every five minutes for both. The sweeps in 0046 create notifications every
-- fifteen, so five keeps the gap between "the club decided to tell you" and
-- "you were told" under a couple of minutes — which matters most for the
-- event reminder, whose entire purpose is to arrive an hour before. Both
-- queues are normally empty and return immediately.

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net is not installed — senders NOT scheduled.';
    return;
  end if;

  if not exists (select 1 from vault.decrypted_secrets where name = 'service_role_key') then
    raise notice '============================================================';
    raise notice 'No vault secret named service_role_key — senders NOT scheduled.';
    raise notice 'Create it once (see the header of 0052), then re-run section 3.';
    raise notice 'Until then push and email are written but never invoked.';
    raise notice '============================================================';
    return;
  end if;

  perform cron.schedule(
    'notification-push',
    '*/5 * * * *',
    $job$select public.invoke_notification_sender('send-push')$job$
  );

  perform cron.schedule(
    'notification-emails',
    '*/5 * * * *',
    $job$select public.invoke_notification_sender('send-notification-emails')$job$
  );

  raise notice 'Scheduled: notification-push and notification-emails, every 5 minutes.';
end;
$$;

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. Is the secret there at all? Everything else depends on it (expect 1 row,
--    and NEVER select the decrypted value into a shared screen):
--
--   select name, created_at from vault.secrets where name = 'service_role_key';
--
-- 2. Both jobs registered (expect 2 rows, active = true):
--
--   select jobname, schedule, active from cron.job
--    where jobname in ('notification-push', 'notification-emails');
--
-- 3. ⚠ THE KEY IS NOT IN THE SCHEDULE. This is the check that proves the
--    Vault indirection actually worked — expect the commands to contain
--    'invoke_notification_sender' and NO key material:
--
--   select jobname, command from cron.job
--    where jobname in ('notification-push', 'notification-emails');
--
-- 4. ⚠ AND DID IT FIRE? A registered job is not a running job. Wait 5+
--    minutes, then read what pg_net actually got back:
--
--   select id, status_code, left(content, 200) as body, created
--     from net._http_response order by created desc limit 5;
--
--    A 200 with {"ok":true,...} is success. A 403 means the Vault secret is
--    not the service-role key. A 500 naming a function means the grants in
--    0047/0051 were not applied.
--
-- 5. Call one by hand first, before trusting the schedule — this is the
--    cheapest way to find a wrong key:
--
--   select public.invoke_notification_sender('send-push');
--   -- then, a few seconds later, check net._http_response as in 4.
--
-- 6. Nothing but the two senders can be invoked (must RAISE):
--
--   select public.invoke_notification_sender('send-campaign');
--
-- 7. No client role can invoke anything (expect zero rows):
--
--   select routine_name, grantee from information_schema.routine_privileges
--    where routine_schema = 'public'
--      and routine_name in ('invoke_notification_sender', 'functions_base_url')
--      and grantee in ('anon', 'authenticated', 'PUBLIC');
