-- 0065 — the event reminder moves to two hours, and gets its own email
-- ============================================================
--
-- Ahmed, 13 Aug: a member who confirmed they are going should get an EMAIL
-- reminder two hours before the event, sent from events@sahabaclub.com.
--
-- Almost all of this already existed and none of it needed inventing:
--
--   * 0045 `sweep_event_reminders()` already selects `status = 'registered'`
--     registrations against events with a real `starts_at`.
--   * 0046 already runs that sweep every 15 minutes inside `notification-sweeps`.
--   * 0044 already gives `event_starting_soon` the `email` channel, so
--     0051's `email_queue()` already picks it up.
--   * 0052 already schedules `send-notification-emails` to drain that queue.
--
-- So this migration changes THREE things and builds no new pipeline: the lead
-- time, the words, and where the link points. The sender address is an Edge
-- Function concern and lives in send-transactional-email.
--
-- ============================================================
-- ⚠⚠ READ THIS BEFORE BELIEVING ANY OF IT WORKS
-- ============================================================
--
-- **`events.starts_at` IS NULL FOR EVERY UPCOMING EVENT.** Measured against the
-- live database on 13 Aug 2026: 39 published events dated today or later, and
-- 0 of them have a start instant. Nothing in the product writes this column —
-- not `app/admin/events.html`, not the `import-event` AI importer. Only
-- `event.html` reads it.
--
-- 0045 chose to SKIP an event with no `starts_at` rather than guess a time
-- zone, and that decision is correct and is kept. The consequence is that this
-- reminder, correct in every other respect, will send **exactly zero emails**
-- until somebody fills that column in — and it will do so silently, which is
-- the failure shape this project has hit repeatedly.
--
-- `tools/check-event-reminders.mjs` exists so that silence is loud: it asks the
-- live database how many upcoming events have a start time and FAILS while the
-- answer is none. Do not delete it to make CI green.
--
-- ✅ **0066 FIXES THE "NOTHING WRITES IT" HALF**, applied straight after this
-- one: staff get a Starts at + Time zone pair on the admin form, the AI
-- importer extracts both, and a trigger derives `starts_at` from them. What
-- 0066 deliberately does NOT do is backfill the 39 events that already exist —
-- see the note below on why parsing `time_label` is not safe — so the count
-- above only falls as somebody opens those events and fills the time in.
--
-- ⚠ AND `time_label` CANNOT SAFELY BE PARSED INTO IT. The labels are free text
-- ("7:00 PM - 9:00 PM", "8:00 AM onwards", "11:00 AM - 7:15 PM", and one null)
-- and the events are NOT all in one country — the upcoming list includes Cairo
-- as well as the UAE. Reading "7:00 PM" as Dubai time makes an Egyptian event's
-- reminder two hours wrong, which is worse than no reminder: it is the club
-- telling a member the wrong hour in the club's own voice. A backfill needs a
-- per-event time zone, and that is a decision plus a column, not a script.

-- ============================================================
-- 1. The kind now says two hours
-- ============================================================
--
-- The label is what a member sees in Settings beside the on/off switch, so it
-- has to match what actually arrives. It read "An event starts in an hour".
--
-- ⚠ `default_channels` is deliberately NOT touched. `event_starting_soon`
-- already carries {inapp,email} from 0044 and re-asserting it here would make
-- this migration look like the place that grants email, which is exactly the
-- accident 0051's verification query hunts for.

update public.notification_kinds
   set label       = 'An event starts in two hours',
       description = 'Sent two hours before an event you said you are going to. '
                     'Goes to your inbox as well as the app.'
 where kind = 'event_starting_soon';

-- ============================================================
-- 2. The sweep: two hours, the event''s own page, and a real local time
-- ============================================================

create or replace function public.sweep_event_reminders()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total int := 0;
  r record;
begin
  -- ⚠ THE WINDOW IS WIDER THAN THE LEAD TIME, AND THAT IS THE DESIGN.
  --
  -- The sweep runs every 15 minutes (0046), so an event is seen in several
  -- consecutive passes and the `(user_id, dedupe_key)` unique index makes all
  -- but the first a no-op. The width is the tolerance: a single missed or
  -- delayed run still catches the event on the next pass instead of dropping
  -- the reminder in silence. A narrow window on an exact schedule is how
  -- reminders quietly stop arriving.
  --
  -- So "two hours before" means the first pass that sees it — between 2h00 and
  -- 2h15 before the start, and later if a run was missed. It is a reminder,
  -- not an alarm clock, and arriving at 1h50 is a better outcome than not
  -- arriving at all.
  --
  -- ⚠ An event added LESS than two hours before it starts also matches, and is
  -- reminded about immediately. That is deliberate: the member confirmed they
  -- were going, and a late reminder still beats none.
  for r in
    select reg.user_id,
           e.id as event_id,
           e.slug,
           e.title,
           e.starts_at,
           e.location,
           e.mode
      from public.event_registrations reg
      join public.events e on e.id = reg.event_id
     where e.is_published
       -- ⚠ Skipped, not guessed. An event with no starts_at gets no reminder.
       -- See the header: today that is EVERY upcoming event.
       and e.starts_at is not null
       and e.starts_at > now()
       and e.starts_at <= now() + interval '2 hours 15 minutes'
       -- The whole point: only somebody who said they are going.
       and reg.status = 'registered'
  loop
    if public.emit_notification(
         p_user_id    => r.user_id,
         p_kind       => 'event_starting_soon',
         p_title      => r.title || ' starts in about two hours',
         -- ⚠ RENDERED IN Asia/Dubai AND SAID SO. `to_char()` on a timestamptz
         -- formats in the SESSION time zone, which for pg_cron is UTC — the
         -- previous version printed a UTC clock time with no zone on it, so a
         -- 7pm Dubai event read "15:00". Naming the zone is not decoration: it
         -- is the difference between a time a member can act on and one that
         -- is simply wrong for most of them. The club's own zone is the
         -- honest choice while events carry no time zone of their own.
         p_body       => 'Starts at '
                         || to_char(r.starts_at at time zone 'Asia/Dubai', 'FMHH12:MI AM')
                         || ' Dubai time'
                         || coalesce(' · ' || nullif(r.location, ''),
                                     coalesce(' · ' || nullif(r.mode, ''), ''))
                         || '.',
         -- The event''s OWN page, not the list. A reminder that lands somebody
         -- on a directory of 39 events and asks them to find theirs is a
         -- reminder that wasted the click. ⚠ 0044 constrains href to a single
         -- leading slash and the email template re-checks it; `slug` is
         -- generated by 0056's trigger, so it is URL-safe by construction.
         p_href       => '/event.html?e=' || r.slug,
         p_actor_id   => null,
         p_subject_id => r.event_id,
         -- ⚠ UNCHANGED FROM 0045 ON PURPOSE. Anybody already reminded about
         -- this event under the old one-hour rule must not be reminded a
         -- second time because the wording moved.
         p_dedupe_key => 'event-soon:' || r.event_id::text
       ) is not null
    then
      v_total := v_total + 1;
    end if;
  end loop;

  return v_total;
end;
$$;

-- Unchanged from 0045, restated because `create or replace` does not reset
-- grants and a future reader should not have to go and check.
revoke execute on function public.sweep_event_reminders() from public, anon, authenticated;

comment on function public.sweep_event_reminders is
  'Emits event_starting_soon about two hours ahead, for members whose '
  'registration status is `registered`. Skips any event without starts_at. '
  'Called every 15 minutes by the notification-sweeps job (0046).';

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. ⚠ THE ONE THAT DECIDES WHETHER THIS FEATURE EXISTS AT ALL. Expect
--    `without_start_time` to be 0 before believing any reminder will send.
--    On 13 Aug it was 39 of 39:
--
--   select count(*) filter (where starts_at is not null) as with_start_time,
--          count(*) filter (where starts_at is null)     as without_start_time
--     from public.events
--    where is_published and event_date >= current_date;
--
-- 2. The label a member reads matches what now arrives (expect two hours):
--
--   select kind, label, default_channels from public.notification_kinds
--    where kind = 'event_starting_soon';
--
-- 3. `email` is still on the kind — this migration must not have changed it
--    (expect the same list 0051's check expects, including event_starting_soon):
--
--   select kind, default_channels from public.notification_kinds
--    where 'email' = any (default_channels) order by kind;
--
-- 4. Still not callable from a browser (expect zero rows):
--
--   select routine_name, grantee from information_schema.routine_privileges
--    where routine_schema = 'public' and routine_name = 'sweep_event_reminders'
--      and grantee in ('anon','authenticated','PUBLIC');
--
-- 5. A DRY REHEARSAL that writes nothing — what the sweep WOULD pick up if the
--    start times were filled in. Run it before and after any backfill:
--
--   select e.title, e.starts_at, count(*) as would_be_reminded
--     from public.event_registrations reg
--     join public.events e on e.id = reg.event_id
--    where e.is_published and e.starts_at is not null
--      and e.starts_at > now() and e.starts_at <= now() + interval '2 hours 15 minutes'
--      and reg.status = 'registered'
--    group by e.title, e.starts_at;
--
-- 6. After the first real send, that the email actually left (expect
--    emailed_at set within a few minutes of created_at):
--
--   select created_at, emailed_at, read_at, title
--     from public.notifications
--    where kind = 'event_starting_soon'
--    order by created_at desc limit 20;
