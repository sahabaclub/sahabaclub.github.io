-- 0063 — the record of what was posted to LinkedIn, and when
-- ============================================================
--
-- Ahmed, 11 Aug 2026: post the day's events to the Sahaba Club LinkedIn page,
-- once a day, automatically.
--
-- ---- Why a table and not just a cron job -----------------------------
--
-- ⚠ A DAILY JOB THAT POSTS TO A PUBLIC PAGE HAS TO BE ABLE TO SAY "I ALREADY
-- DID THAT". Everything else here follows from it. pg_cron will happily fire
-- twice if a run is slow and the schedule overlaps, `net.http_post` retries are
-- not something this project controls, and a person pressing the button by hand
-- to test it is the most likely double-post of all. Without a record, every one
-- of those puts the same three events on the company page a second time, in
-- public, where the club's members and the organisers of those events can see
-- it. There is no unsend.
--
-- So the day itself is the key: `post_date` is UNIQUE. The function claims the
-- day BEFORE it calls LinkedIn, and a second run collides on the constraint
-- instead of posting. This is the same claim-then-send shape `send-campaign`
-- uses for exactly the same reason, and 0011's note on that is worth reading if
-- this is ever changed.
--
-- ⚠ A row is written even when there is NOTHING to post. A day with no events
-- is a decision the job made, not an absence of a job, and the difference
-- matters when somebody asks "why was there no post on Sunday". `status`
-- carries which it was.

create table if not exists public.linkedin_daily_posts (
  -- One row per calendar day, in the club's own timezone. See the function's
  -- header for why that is Asia/Dubai and not UTC.
  post_date date primary key,

  -- 'skipped_empty' nothing was on that day, nothing was posted
  -- 'dry_run'      composed and shown, deliberately not sent
  -- 'claimed'      the day was taken and the API call is in flight
  -- 'posted'       LinkedIn accepted it
  -- 'failed'       LinkedIn refused it, or we could not reach LinkedIn
  status text not null default 'claimed'
    check (status in ('skipped_empty', 'dry_run', 'claimed', 'posted', 'failed')),

  -- What went out, kept verbatim. ⚠ Not regenerated for display later: the
  -- events table changes, and "what did we actually say on the 12th" must not
  -- quietly become "what would we say about the 12th today".
  body text,

  -- Which events it was about, by slug, so a human can reconstruct the day
  -- without parsing the body.
  event_slugs text[] not null default '{}',
  event_count integer not null default 0,

  -- LinkedIn's identifier for the post, when there is one. This is what makes
  -- a post findable and, if it ever comes to it, deletable.
  post_urn text,

  -- The provider's raw refusal. Kept whole rather than tidied, for the same
  -- reason `callImage` keeps it: the sentence a human needs is usually in
  -- there, and a summary loses it.
  error text,

  claimed_at timestamptz not null default now(),
  posted_at timestamptz
);

comment on table public.linkedin_daily_posts is
  'One row per day the LinkedIn events job ran. post_date is unique so a '
  'repeat run cannot post the same day twice; the row is claimed before the '
  'API call, not after it.';

-- ============================================================
-- Access
-- ============================================================
--
-- Nobody but staff has any business reading this, and nothing outside the
-- function has any business writing it. 0033's pattern: revoke the lot, grant
-- SELECT back to `authenticated`, and let RLS narrow that to staff. The
-- function runs as the service role and is unaffected by both.
--
-- ⚠ Supabase grants ALL on a new table to anon and authenticated by default,
-- so this revokes before granting rather than assuming a clean slate.
alter table public.linkedin_daily_posts enable row level security;
revoke all on public.linkedin_daily_posts from anon, authenticated;
grant select on public.linkedin_daily_posts to authenticated;

drop policy if exists "linkedin posts: staff read" on public.linkedin_daily_posts;
create policy "linkedin posts: staff read" on public.linkedin_daily_posts
  for select using (public.is_staff());

-- ============================================================
-- Verification
-- ============================================================
--
--   1. The table exists and is refused to a member. Run as a non-staff
--      session; expect zero rows rather than an error, which is what an RLS
--      refusal on a granted table looks like.
--
--        select count(*) from public.linkedin_daily_posts;   -- staff: n, member: 0
--
--   2. The day really is unique. This must raise 23505, and if it does not,
--      the whole double-post argument above is void:
--
--        insert into public.linkedin_daily_posts (post_date) values (current_date);
--        insert into public.linkedin_daily_posts (post_date) values (current_date);
--        -- expect: duplicate key value violates unique constraint
--        delete from public.linkedin_daily_posts where post_date = current_date;
--
--   3. anon is refused outright, not merely empty:
--
--        set local role anon;
--        select * from public.linkedin_daily_posts;   -- expect: permission denied
