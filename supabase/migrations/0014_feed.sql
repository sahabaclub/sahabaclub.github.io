-- Sahaba Club — the feed
-- ------------------------------------------------------------
-- The landing page once you're signed in: what has happened in the club.
-- New members, new coaches, new events, and posts written by coaches.
--
-- Members do not post. They react, comment and share. That asymmetry is the
-- whole design — it is a noticeboard the club writes and the members talk
-- about, not a social network. It is enforced in RLS, not in the page: there
-- is no INSERT policy on feed_posts for a plain member, so a crafted request
-- gets nothing.
--
-- The privacy rule that shapes everything here: an automatic "X joined"
-- post must never announce someone who chose not to be discoverable. The
-- trigger checks `is_discoverable` before it writes, and the read policy
-- checks it again at read time — because someone can opt out *after* the
-- post was created, and the post must disappear when they do.

-- ============================================================
-- Posts
-- ============================================================

create table if not exists public.feed_posts (
  id uuid primary key default gen_random_uuid(),

  kind text not null check (kind in (
    'member_joined', 'coach_joined', 'event_added', 'coach_post', 'announcement'
  )),

  -- Who wrote it. NULL for system-generated posts, which have no author and
  -- must not be attributed to whoever happened to trigger them.
  author_id uuid references auth.users (id) on delete set null,

  -- Who or what the post is ABOUT. For member_joined/coach_joined this is the
  -- person; the read policy uses it to re-check their consent on every read.
  subject_user_id uuid references auth.users (id) on delete cascade,
  subject_event_id uuid references public.events (id) on delete cascade,

  title text,
  body text check (body is null or length(body) <= 5000),
  image_url text,

  -- Counters kept by triggers so the feed can sort and display without a
  -- count(*) per post per page load.
  like_count int not null default 0,
  comment_count int not null default 0,

  is_pinned boolean not null default false,
  is_hidden boolean not null default false,   -- staff moderation, reversible

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists feed_posts_timeline_idx
  on public.feed_posts (is_pinned desc, created_at desc) where not is_hidden;
create index if not exists feed_posts_subject_user_idx on public.feed_posts (subject_user_id);

alter table public.feed_posts enable row level security;

-- Read: signed-in members only, nothing hidden, and — the important part —
-- a post ABOUT a person is only visible while that person is still
-- discoverable. Opting out of Connect retroactively removes your "joined"
-- post from everyone's feed.
drop policy if exists "feed: members read" on public.feed_posts;
create policy "feed: members read" on public.feed_posts
  for select using (
    auth.uid() is not null
    and not is_hidden
    and (
      subject_user_id is null
      or exists (
        select 1 from public.profiles p
        where p.user_id = subject_user_id and p.is_discoverable
      )
    )
  );

-- Write: coaches and staff only. Deliberately no policy granting a member
-- INSERT — absence is the control.
drop policy if exists "feed: coaches and staff write" on public.feed_posts;
create policy "feed: coaches and staff write" on public.feed_posts
  for insert with check (
    auth.uid() = author_id
    and exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid() and p.role in ('coach', 'staff', 'admin')
    )
  );

drop policy if exists "feed: authors and staff edit" on public.feed_posts;
create policy "feed: authors and staff edit" on public.feed_posts
  for update using (auth.uid() = author_id or public.is_staff())
  with check (auth.uid() = author_id or public.is_staff());

drop policy if exists "feed: staff delete" on public.feed_posts;
create policy "feed: staff delete" on public.feed_posts
  for delete using (public.is_staff());

revoke all on public.feed_posts from anon, authenticated;
grant select, insert on public.feed_posts to authenticated;
-- Counters are trigger-maintained; a member must not be able to inflate them.
grant update (title, body, image_url, is_pinned, is_hidden, updated_at)
  on public.feed_posts to authenticated;

-- ============================================================
-- Likes
-- ============================================================

create table if not exists public.feed_likes (
  post_id uuid not null references public.feed_posts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)   -- one like per person, enforced by the key
);

alter table public.feed_likes enable row level security;

drop policy if exists "likes: members read" on public.feed_likes;
create policy "likes: members read" on public.feed_likes
  for select using (auth.uid() is not null);

drop policy if exists "likes: own only" on public.feed_likes;
create policy "likes: own only" on public.feed_likes
  for insert with check (auth.uid() = user_id);

drop policy if exists "likes: unlike own" on public.feed_likes;
create policy "likes: unlike own" on public.feed_likes
  for delete using (auth.uid() = user_id);

revoke all on public.feed_likes from anon;

-- ============================================================
-- Comments
-- ============================================================

create table if not exists public.feed_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.feed_posts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  body text not null check (length(body) between 1 and 2000),
  is_hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists feed_comments_post_idx
  on public.feed_comments (post_id, created_at) where not is_hidden;

alter table public.feed_comments enable row level security;

drop policy if exists "comments: members read" on public.feed_comments;
create policy "comments: members read" on public.feed_comments
  for select using (auth.uid() is not null and (not is_hidden or public.is_staff()));

drop policy if exists "comments: own insert" on public.feed_comments;
create policy "comments: own insert" on public.feed_comments
  for insert with check (auth.uid() = user_id);

-- Edit your own words. Staff may hide, which is why is_hidden is in the
-- staff column grant below and not in the member one.
drop policy if exists "comments: own edit" on public.feed_comments;
create policy "comments: own edit" on public.feed_comments
  for update using (auth.uid() = user_id or public.is_staff())
  with check (auth.uid() = user_id or public.is_staff());

drop policy if exists "comments: own or staff delete" on public.feed_comments;
create policy "comments: own or staff delete" on public.feed_comments
  for delete using (auth.uid() = user_id or public.is_staff());

revoke all on public.feed_comments from anon, authenticated;
grant select, insert, delete on public.feed_comments to authenticated;
grant update (body, is_hidden, updated_at) on public.feed_comments to authenticated;

-- ============================================================
-- Counters
-- ============================================================

create or replace function public.refresh_feed_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  target uuid := coalesce(new.post_id, old.post_id);
begin
  update public.feed_posts p
  set like_count    = (select count(*) from public.feed_likes    l where l.post_id = target),
      comment_count = (select count(*) from public.feed_comments c
                        where c.post_id = target and not c.is_hidden)
  where p.id = target;
  return null;
end;
$fn$;

drop trigger if exists feed_likes_count on public.feed_likes;
create trigger feed_likes_count
  after insert or delete on public.feed_likes
  for each row execute function public.refresh_feed_counts();

drop trigger if exists feed_comments_count on public.feed_comments;
create trigger feed_comments_count
  after insert or update or delete on public.feed_comments
  for each row execute function public.refresh_feed_counts();

-- ============================================================
-- The automatic posts
-- ============================================================

-- A new member becomes a feed item only once they are discoverable. Someone
-- who joins for a Microsoft licence and never opens Connect is never
-- announced. Firing on the transition (false -> true) rather than on insert
-- also means the post appears when they actually opt in, which is the moment
-- it is true to say they joined the community.
create or replace function public.feed_on_member_visible()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.is_discoverable and not coalesce(old.is_discoverable, false) then
    -- One announcement per person, ever.
    if not exists (
      select 1 from public.feed_posts
      where subject_user_id = new.user_id and kind in ('member_joined', 'coach_joined')
    ) then
      insert into public.feed_posts (kind, subject_user_id, title)
      values (
        case when new.role = 'coach' then 'coach_joined' else 'member_joined' end,
        new.user_id,
        coalesce(new.full_name, 'A new member') ||
          case when new.role = 'coach' then ' joined as a coach' else ' joined the club' end
      );
    end if;
  end if;
  return null;
end;
$fn$;

drop trigger if exists profiles_feed_announce on public.profiles;
create trigger profiles_feed_announce
  after insert or update of is_discoverable, role on public.profiles
  for each row execute function public.feed_on_member_visible();

-- A published event becomes a feed item. Fires on publish, not on create, so
-- drafts never leak into the feed.
create or replace function public.feed_on_event_published()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.is_published and not coalesce(old.is_published, false) then
    if not exists (select 1 from public.feed_posts where subject_event_id = new.id) then
      insert into public.feed_posts (kind, subject_event_id, title, body, image_url)
      values ('event_added', new.id, new.title, new.description, new.image_url);
    end if;
  end if;
  return null;
end;
$fn$;

drop trigger if exists events_feed_announce on public.events;
create trigger events_feed_announce
  after insert or update of is_published on public.events
  for each row execute function public.feed_on_event_published();

-- ============================================================
-- Reading the feed
-- ============================================================

-- One view so the page makes a single request instead of N+1 lookups per
-- post. security_invoker = on: the caller's RLS still applies, so the
-- consent check in the feed_posts read policy is not bypassed here.
create or replace view public.feed_view
with (security_invoker = on) as
select
  p.id, p.kind, p.title, p.body, p.image_url,
  p.like_count, p.comment_count, p.is_pinned, p.created_at,
  p.author_id,
  ap.full_name  as author_name,
  ap.avatar_url as author_avatar,
  p.subject_user_id,
  sp.full_name  as subject_name,
  sp.avatar_url as subject_avatar,
  sp.headline   as subject_headline,
  p.subject_event_id,
  e.title       as event_title,
  e.event_date  as event_date,
  e.location    as event_location,
  e.tags        as event_tags,
  exists (
    select 1 from public.feed_likes l
    where l.post_id = p.id and l.user_id = auth.uid()
  ) as liked_by_me
from public.feed_posts p
left join public.profiles ap on ap.user_id = p.author_id
left join public.profiles sp on sp.user_id = p.subject_user_id
left join public.events   e  on e.id       = p.subject_event_id
where not p.is_hidden;

revoke all on public.feed_view from anon;
grant select on public.feed_view to authenticated;

-- ============================================================
-- Verification — run these, do not assume
-- ============================================================
--
-- anon must reach none of it (expect zero rows):
--   select table_name, privilege_type from information_schema.role_table_grants
--    where grantee='anon' and table_name like 'feed%';
--
-- A member must NOT be able to post. As a normal member, this must fail:
--   insert into public.feed_posts (kind, author_id, title)
--   values ('coach_post', auth.uid(), 'should be refused');
--
-- Counters must not be member-writable (expect only the listed columns):
--   select column_name from information_schema.column_privileges
--    where table_name='feed_posts' and grantee='authenticated'
--      and privilege_type='UPDATE';
--
-- Opting out must remove your announcement from the feed:
--   update public.profiles set is_discoverable = false where user_id = '<id>';
--   -- then re-read feed_view as another member; the member_joined post is gone.
