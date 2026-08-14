-- 0067 — the reminder names the EVENT's time zone, not the club's
-- ============================================================
--
-- Ahmed, 14 Aug, asking how the time zones actually fit together — and the
-- question exposed this.
--
-- 0065 rendered the reminder time in `Asia/Dubai` and labelled it "Dubai time".
-- That was right when it was written: no event carried a zone of its own, so
-- the club's zone was the only honest thing to name. 0066 changed the ground
-- underneath it — every event now has `time_zone`, and 31 upcoming events are
-- spread across Africa/Cairo, Asia/Dubai and Asia/Riyadh.
--
-- So for a Cairo event starting 19:00 local, the member was about to be told:
--
--     "Starts at 8:00 PM Dubai time"
--
-- while the event page, the organiser's page and the Meetup listing all say
-- **7:00 PM**. Not false — it is the same instant, correctly converted — but the
-- member has no reason to know that, and the one number they can check it
-- against disagrees. A reminder that appears to contradict the event page is a
-- reminder that gets distrusted.
--
--     "Starts at 7:00 PM Cairo time"
--
-- ============================================================
-- ⚠ WHAT THIS DOES **NOT** CHANGE — the timing
-- ============================================================
--
-- `starts_at` is a `timestamptz`: an INSTANT. Two hours before an instant is the
-- same moment everywhere on Earth, so the send time was never affected by any
-- time zone and still is not. This migration changes six words in one sentence.
--
-- ⚠ AND IT DOES NOT NEED THE MEMBER'S ZONE, which is just as well because the
-- platform does not store one — there is no such column on `profiles`. The
-- reminder is deliberately expressed in the EVENT's local time, which is the
-- number printed on the poster, in the listing, and on our own event page.
-- Rendering it per member would mean four members seeing four different numbers,
-- none of which matches the venue.

create or replace function public.sweep_event_reminders()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total int := 0;
  v_zone  text;
  v_label text;
  r record;
begin
  -- Window unchanged from 0065: wider than the lead time on purpose, so a
  -- missed or delayed run still catches the event on the next pass rather than
  -- dropping the reminder in silence. The sweep runs every 15 minutes (0046)
  -- and `(user_id, dedupe_key)` makes every pass after the first a no-op.
  for r in
    select reg.user_id,
           e.id as event_id,
           e.slug,
           e.title,
           e.starts_at,
           e.location,
           e.mode,
           e.time_zone
      from public.event_registrations reg
      join public.events e on e.id = reg.event_id
     where e.is_published
       and e.starts_at is not null
       and e.starts_at > now()
       and e.starts_at <= now() + interval '2 hours 15 minutes'
       and reg.status = 'registered'
  loop
    -- ⚠ FALLS BACK TO THE CLUB'S ZONE RATHER THAN TO UTC. `time_zone` is NOT
    -- NULL with a default, so this should be unreachable — but `to_char` on a
    -- timestamptz with a null zone would silently render the SESSION zone,
    -- which under pg_cron is UTC, and a UTC clock time carrying a city's name
    -- is the exact failure 0065 was written to stop.
    v_zone := coalesce(nullif(r.time_zone, ''), 'Asia/Dubai');

    -- "Africa/Cairo" -> "Cairo time"; "America/New_York" -> "New York time";
    -- "UTC" -> "UTC". The city is what a member recognises; the Area/ prefix is
    -- database bookkeeping and means nothing in a sentence.
    v_label := case
                 when v_zone = 'UTC' then 'UTC'
                 else replace(split_part(v_zone, '/', -1), '_', ' ') || ' time'
               end;

    if public.emit_notification(
         p_user_id    => r.user_id,
         p_kind       => 'event_starting_soon',
         p_title      => r.title || ' starts in about two hours',
         p_body       => 'Starts at '
                         || to_char(r.starts_at at time zone v_zone, 'FMHH12:MI AM')
                         || ' ' || v_label
                         || coalesce(' · ' || nullif(r.location, ''),
                                     coalesce(' · ' || nullif(r.mode, ''), ''))
                         || '.',
         p_href       => '/event.html?e=' || r.slug,
         p_actor_id   => null,
         p_subject_id => r.event_id,
         -- ⚠ STILL UNCHANGED, now across three migrations. Anybody already
         -- reminded about this event must not be reminded again because the
         -- wording moved. This is the third time that has mattered.
         p_dedupe_key => 'event-soon:' || r.event_id::text
       ) is not null
    then
      v_total := v_total + 1;
    end if;
  end loop;

  return v_total;
end;
$$;

revoke execute on function public.sweep_event_reminders() from public, anon, authenticated;

comment on function public.sweep_event_reminders is
  'Emits event_starting_soon about two hours ahead, for members whose '
  'registration status is `registered`. Renders the time in the EVENT''s own '
  'time zone (0067), skips any event without starts_at, and is called every 15 '
  'minutes by the notification-sweeps job (0046).';

-- ============================================================
-- Verification
-- ============================================================
--
-- 1. THE ONE THAT MATTERS — what each pending reminder will actually say.
--    Every row's clock time must match what the event page shows:
--
--   select e.title,
--          to_char(e.starts_at at time zone e.time_zone, 'FMHH12:MI AM')
--            || ' ' || replace(split_part(e.time_zone, '/', -1), '_', ' ') || ' time'
--            as reads_as,
--          e.time_zone, e.starts_at
--     from public.events e
--     join public.event_registrations reg
--       on reg.event_id = e.id and reg.status = 'registered'
--    where e.is_published and e.starts_at > now()
--    group by e.title, e.starts_at, e.time_zone
--    order by e.starts_at;
--
-- 2. The label builder against the zones actually in use (expect Cairo time,
--    Dubai time, Riyadh time — never "Africa/Cairo time" and never "UTC time"):
--
--   select distinct time_zone,
--          case when time_zone = 'UTC' then 'UTC'
--               else replace(split_part(time_zone, '/', -1), '_', ' ') || ' time' end as label
--     from public.events where starts_at is not null order by 1;
--
-- 3. Nothing about the TIMING moved. Same rows, same instants, as before:
--
--   select count(*) as would_fire_now
--     from public.event_registrations reg
--     join public.events e on e.id = reg.event_id
--    where e.is_published and e.starts_at is not null
--      and e.starts_at > now() and e.starts_at <= now() + interval '2 hours 15 minutes'
--      and reg.status = 'registered';
--
-- 4. Still not callable from a browser (expect zero rows):
--
--   select routine_name, grantee from information_schema.routine_privileges
--    where routine_schema = 'public' and routine_name = 'sweep_event_reminders'
--      and grantee in ('anon','authenticated','PUBLIC');
