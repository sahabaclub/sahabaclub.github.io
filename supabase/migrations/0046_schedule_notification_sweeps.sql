-- 0046 — actually run the sweeps
-- ============================================================
--
-- 0045 created three reminder sweeps and scheduled none of them. That is the
-- state `send-license-reminders` has been in since the day it was written: it
-- documents its own `cron.schedule` call in its header, and **it has never
-- once been invoked**. Writing a job is not scheduling it, and this project
-- has now proved that twice.
--
-- ⚠ REQUIRES pg_cron, which is a dashboard click: Supabase → Database →
-- Extensions → pg_cron. Nothing here can enable it. Section 4 checks and
-- raises a notice rather than failing the migration, so applying this without
-- the extension leaves you with the runner and the log and no schedule —
-- which is a recoverable state, unlike a half-applied migration.
--
-- ============================================================
-- Why ONE job every 15 minutes, and not three jobs on their own clocks
-- ============================================================
--
-- The obvious design is a daily job at 08:00 for the licence and renewal
-- sweeps and a quarter-hourly one for events. It is rejected on purpose.
--
-- Every sweep in 0045 is idempotent BY DEDUPE KEY — not by bookkeeping, not by
-- a "last run" column, but by a unique index that absorbs the second write. So
-- running the daily ones 96 times a day costs 95 scans that write nothing, on
-- tables with a few hundred rows. That is the entire cost.
--
-- What it buys is that "the daily job did not run today" stops being a failure
-- mode. A daily job that misses its window has missed a day; a quarter-hourly
-- one that misses a window catches up fifteen minutes later and nobody
-- notices. Given that this project's entire history with schedulers is that
-- they were never invoked at all, resilience is worth more than 95 cheap
-- scans.
--
-- ⚠ It also means: DO NOT make a sweep non-idempotent. The moment one of them
-- sends something without a dedupe key, this schedule mails it 96 times.

-- ============================================================
-- 1. Track what has been emailed
-- ============================================================
--
-- The in-app notification and its email copy are two deliveries of one fact,
-- and they need separate records or a retry re-mails everybody. `read_at`
-- cannot serve: a member who never opens the site has read nothing, and that
-- is exactly the member the email exists for.

alter table public.notifications
  add column if not exists emailed_at timestamptz;

comment on column public.notifications.emailed_at is
  'When the email copy of this notification was accepted for delivery. Null '
  'means not sent — either not eligible, not yet, or it failed. Only the '
  'critical kinds are ever emailed; see the channel list in notification_kinds.';

-- Finding the backlog must not scan the whole table. Partial, because the
-- overwhelming majority of rows are never emailed at all.
create index if not exists notifications_email_pending_idx
  on public.notifications (created_at)
  where emailed_at is null;

-- ============================================================
-- 2. A record that the sweeps ran
-- ============================================================
--
-- pg_cron keeps `cron.job_run_details`, and this does not replace it — it
-- answers a different question. job_run_details says "the SQL statement
-- succeeded". This says "the sweeps ran and here is what they did", in a table
-- an Edge Function can read without cron privileges, which is what makes the
-- watchdog possible at all.
--
-- ⚠ A silent scheduler failure is the thing to design against here. It does
-- not throw, it does not appear anywhere, and the first sign is a member
-- asking why nobody warned them their mailbox was about to expire. A row
-- landing here every fifteen minutes is the heartbeat; its ABSENCE is the
-- alarm, and absence is only detectable if something is looking.

create table if not exists public.notification_sweep_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  -- Per-sweep counts, so "it ran but wrote nothing" is distinguishable from
  -- "it ran and wrote nothing because there was nothing to write".
  ms365_written int not null default 0,
  renewal_written int not null default 0,
  event_written int not null default 0,
  ok boolean not null default true,
  detail text
);

create index if not exists notification_sweep_runs_recent_idx
  on public.notification_sweep_runs (ran_at desc);

alter table public.notification_sweep_runs enable row level security;

-- Staff can see whether the club's reminders are running. Members have no
-- business with it and anon has nothing at all.
drop policy if exists "sweep runs: staff read" on public.notification_sweep_runs;
create policy "sweep runs: staff read" on public.notification_sweep_runs
  for select using (public.is_staff());

revoke all on public.notification_sweep_runs from anon, authenticated;
grant select on public.notification_sweep_runs to authenticated;

-- ============================================================
-- 3. The runner
-- ============================================================
--
-- One entry point for cron, so the schedule has one thing to call and the log
-- has one row per pass.
--
-- ⚠ It catches its own exceptions ON PURPOSE. An uncaught error inside a
-- pg_cron job is recorded in cron.job_run_details and nowhere a human looks —
-- and worse, one failing sweep would abort the other two, so a problem with
-- event reminders would silently stop licence warnings. Catching per sweep
-- means a broken one is isolated, recorded with its message, and the others
-- still run.

create or replace function public.run_notification_sweeps()
returns public.notification_sweep_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ms365 int := 0;
  v_renewal int := 0;
  v_event int := 0;
  v_ok boolean := true;
  v_detail text := null;
  v_row public.notification_sweep_runs;
begin
  begin
    v_ms365 := public.sweep_ms365_expiry_reminders();
  exception when others then
    v_ok := false;
    v_detail := coalesce(v_detail || ' | ', '') || 'ms365: ' || sqlerrm;
  end;

  begin
    v_renewal := public.sweep_premium_renewal_reminders();
  exception when others then
    v_ok := false;
    v_detail := coalesce(v_detail || ' | ', '') || 'renewal: ' || sqlerrm;
  end;

  begin
    v_event := public.sweep_event_reminders();
  exception when others then
    v_ok := false;
    v_detail := coalesce(v_detail || ' | ', '') || 'event: ' || sqlerrm;
  end;

  insert into public.notification_sweep_runs
    (ms365_written, renewal_written, event_written, ok, detail)
  values (v_ms365, v_renewal, v_event, v_ok, v_detail)
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.run_notification_sweeps() from public, anon, authenticated;

-- Keep the log from growing without limit. Called by the same schedule, so
-- there is no second thing to remember to run. 30 days is enough to see a
-- pattern and short enough that the table stays trivial.
create or replace function public.prune_notification_sweep_runs()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with deleted as (
    delete from public.notification_sweep_runs
     where ran_at < now() - interval '30 days'
    returning 1
  )
  select count(*)::int into v_count from deleted;
  return v_count;
end;
$$;

revoke execute on function public.prune_notification_sweep_runs() from public, anon, authenticated;

-- ============================================================
-- 4. The health answer
-- ============================================================
--
-- One row, always. `security_invoker = on` for the same reason as
-- `my_notification_counts` in 0044: the RLS on the underlying table already
-- expresses who may see this, so the view cannot leak by having a predicate
-- removed from it later.
--
-- ⚠ `minutes_since_last_run` is null when the table is EMPTY, and null is the
-- worst state, not the best — it means the schedule has never run at all.
-- Anything reading this must treat null as stale rather than as "no problem
-- reported". The watchdog does; see .github/workflows/sweep-watchdog.yml.

drop view if exists public.notification_sweep_health;
create view public.notification_sweep_health
with (security_invoker = on) as
  select
    (select max(ran_at) from public.notification_sweep_runs) as last_run_at,
    (select round(extract(epoch from (now() - max(ran_at))) / 60)::int
       from public.notification_sweep_runs) as minutes_since_last_run,
    (select ok from public.notification_sweep_runs order by ran_at desc limit 1) as last_run_ok,
    (select detail from public.notification_sweep_runs order by ran_at desc limit 1) as last_run_detail,
    (select count(*)::int from public.notification_sweep_runs
      where ran_at > now() - interval '24 hours') as runs_last_24h;

revoke all on public.notification_sweep_health from anon, authenticated;
grant select on public.notification_sweep_health to authenticated;

-- ============================================================
-- 5. The schedule
-- ============================================================
--
-- ⚠ NOTHING BELOW RUNS IF pg_cron IS NOT INSTALLED. The guard raises a notice
-- and leaves everything else in this migration in place, so applying it
-- without the extension is recoverable: enable pg_cron, then re-run just this
-- section.
--
-- ⚠ NO SECRET IS INVOLVED, and that is deliberate. The three sweeps are plain
-- SQL functions, so cron calls them directly. It does NOT need pg_net, does
-- NOT need the service-role key, and therefore does not put a key in
-- `cron.job`, where it would sit in plaintext for anyone with SQL access. The
-- email half is the part that needs an HTTP call, and it is deliberately not
-- scheduled here — see section 6.
--
-- `cron.schedule` with an existing job name UPDATES that job, so re-running
-- this is safe and does not stack duplicate schedules.

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice '============================================================';
    raise notice 'pg_cron is NOT installed — the sweeps are NOT scheduled.';
    raise notice 'Enable it at Supabase - Database - Extensions - pg_cron,';
    raise notice 'then re-run section 5 of this migration on its own.';
    raise notice 'Everything else in 0046 has been applied.';
    raise notice '============================================================';
    return;
  end if;

  perform cron.schedule(
    'notification-sweeps',
    '*/15 * * * *',
    $job$select public.run_notification_sweeps()$job$
  );

  perform cron.schedule(
    'notification-sweep-prune',
    '30 4 * * *',
    $job$select public.prune_notification_sweep_runs()$job$
  );

  raise notice 'Scheduled: notification-sweeps every 15 minutes, prune daily at 04:30 UTC.';
end;
$$;

-- ============================================================
-- 6. What is deliberately NOT scheduled
-- ============================================================
--
-- **`send-license-reminders` must NOT be scheduled as it stands.** It is a
-- real, deployed function that has never been invoked, and scheduling it now
-- would be a mistake for two independent reasons:
--
--   1. **It uses different thresholds.** 30 / 14 / 7 / 1, against the
--      30 / 10 / 3 / 1 Ahmed asked for and 0045 implements. Both running would
--      warn a member at 14 and 7 days by email with nothing in the app, and at
--      10 and 3 days in the app with no email. Two systems disagreeing about
--      when to warn somebody is worse than either alone.
--   2. **It knows nothing about `notification_optouts`.** It predates the
--      preference system entirely, so it would email members who have switched
--      those emails off — breaking the control this whole feature was built to
--      give them, on the one channel where breaking it is most visible.
--
-- The email copy of a critical notification therefore belongs to a sender that
-- reads `notifications` and honours `should_notify(user, kind, 'email')`. That
-- function is NOT in this migration and is not deployed. Until it exists,
-- reminders are IN-APP ONLY — the badge and the dashboard list work, and no
-- email is sent. That is a smaller gap than two systems contradicting each
-- other, and it is stated here rather than left to be discovered.
--
-- When that sender is built it needs pg_net and a credential, and the
-- credential must NOT be pasted into `cron.schedule` — `cron.job` stores the
-- statement in plaintext. Use Supabase Vault and read it at call time.

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. The runner works and logs. Run it BY HAND first — expect one row back,
--    and a second call to write a second row with zeroes (the dedupe keys from
--    the first call absorb everything):
--
--   select * from public.run_notification_sweeps();
--   select * from public.run_notification_sweeps();
--   select * from public.notification_sweep_runs order by ran_at desc limit 2;
--
-- 2. ⚠ THE ONE THAT MATTERS. Is it actually scheduled? Creating a job and
--    scheduling it are different things, and this project has shipped the
--    first while believing the second twice. Expect two rows, active = true:
--
--   select jobname, schedule, active, command from cron.job
--    where jobname in ('notification-sweeps', 'notification-sweep-prune');
--
-- 3. ⚠ AND DID IT RUN? A schedule that exists is still not a schedule that
--    fires. Come back at least 15 minutes after applying — expect the newest
--    row to be under 15 minutes old and status 'succeeded':
--
--   select status, return_message, start_time
--     from cron.job_run_details
--    where jobid in (select jobid from cron.job where jobname = 'notification-sweeps')
--    order by start_time desc limit 5;
--
--   select last_run_at, minutes_since_last_run, last_run_ok, runs_last_24h
--     from public.notification_sweep_health;
--
-- 4. The health view is not readable by anon (expect zero rows):
--
--   select grantee, privilege_type from information_schema.table_privileges
--    where table_schema = 'public'
--      and table_name in ('notification_sweep_health', 'notification_sweep_runs')
--      and grantee = 'anon';
--
-- 5. The runner is not callable from a browser (expect zero rows):
--
--   select routine_name, grantee from information_schema.routine_privileges
--    where routine_schema = 'public'
--      and routine_name in ('run_notification_sweeps', 'prune_notification_sweep_runs')
--      and grantee in ('anon', 'authenticated', 'PUBLIC');
--
-- 6. ⚠ AS AN ORDINARY MEMBER — the health view and the run log must both
--    return nothing, because both are staff-only:
--
--   select * from public.notification_sweep_health;   -- expect 1 row of NULLs or 0 rows
--   select count(*) from public.notification_sweep_runs;  -- expect 0
--
-- 7. A broken sweep must not stop the others. Temporarily break one and
--    confirm the other two still write, and that `ok` is false with the error
--    in `detail`:
--
--   -- (only in a scratch environment — do not do this on production)
