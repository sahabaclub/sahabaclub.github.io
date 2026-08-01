-- Sahaba Club — share tracking, generated avatars, and a better welcome
-- ------------------------------------------------------------
-- Three changes:
--   1. Shares become data, so "what gets shared" is answerable.
--   2. Avatars become generated art, and the real photo is destroyed.
--   3. The welcome post fires when a profile is worth reading, not at signup.

-- ============================================================
-- 1. Shares
-- ============================================================

create table if not exists public.feed_shares (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.feed_posts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Where it went. 'copy_link' is the honest default: we know they took the
  -- link, not that they posted it anywhere.
  channel text not null default 'copy_link'
    check (channel in ('copy_link','whatsapp','linkedin','x','facebook','telegram','email','other')),
  created_at timestamptz not null default now()
);

create index if not exists feed_shares_post_idx on public.feed_shares (post_id);
create index if not exists feed_shares_time_idx on public.feed_shares (created_at desc);

alter table public.feed_posts add column if not exists share_count int not null default 0;

alter table public.feed_shares enable row level security;

-- A member records their own shares and can see the totals through the post.
-- They cannot read the per-person share log — who shared what is not
-- something one member should be able to profile another with.
drop policy if exists "shares: own insert" on public.feed_shares;
create policy "shares: own insert" on public.feed_shares
  for insert with check (auth.uid() = user_id);

drop policy if exists "shares: own or staff read" on public.feed_shares;
create policy "shares: own or staff read" on public.feed_shares
  for select using (auth.uid() = user_id or public.is_staff());

revoke all on public.feed_shares from anon, authenticated;
grant select, insert on public.feed_shares to authenticated;

create or replace function public.refresh_share_count()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $fn$
begin
  update public.feed_posts
  set share_count = (select count(*) from public.feed_shares s where s.post_id = new.post_id)
  where id = new.post_id;
  return null;
end;
$fn$;

drop trigger if exists feed_shares_count on public.feed_shares;
create trigger feed_shares_count after insert on public.feed_shares
  for each row execute function public.refresh_share_count();

-- What actually travels. Staff-only.
create or replace view public.feed_share_stats
with (security_invoker = on) as
select p.id as post_id, p.kind, p.title,
       p.share_count, p.like_count, p.comment_count,
       count(s.id) filter (where s.channel <> 'copy_link') as offsite_shares,
       mode() within group (order by s.channel) as top_channel,
       max(s.created_at) as last_shared_at
from public.feed_posts p
left join public.feed_shares s on s.post_id = p.id
group by p.id;

revoke all on public.feed_share_stats from anon, authenticated;
grant select on public.feed_share_stats to authenticated;  -- RLS on base tables still applies

-- ============================================================
-- 2. Generated avatars
-- ============================================================

-- The rule is "no real photographs on the platform". That is a privacy
-- property as much as an aesthetic one, and it only holds if the uploaded
-- source is destroyed after generation. `source_purged_at` is the receipt
-- that it was; a row with a generated avatar and a null purge timestamp is a
-- bug worth alerting on.
alter table public.profiles
  add column if not exists avatar_is_generated boolean not null default false,
  add column if not exists avatar_source text
    check (avatar_source is null or avatar_source in ('upload','google','microsoft','linkedin','fallback')),
  add column if not exists avatar_attempts int not null default 0,
  add column if not exists avatar_prompt text,
  add column if not exists source_purged_at timestamptz;

-- Three tries, then a themed fallback. Enforced here so a client loop cannot
-- run up an image-generation bill.
alter table public.profiles
  drop constraint if exists avatar_attempts_capped;
alter table public.profiles
  add constraint avatar_attempts_capped check (avatar_attempts between 0 and 3);

-- Only the generating function (service role) sets these. A member choosing
-- their own avatar_url is fine; a member claiming "generated" is not, because
-- that flag is what tells us no real photo is on the platform.
-- No REVOKE here, deliberately. A column-level REVOKE only removes a
-- privilege that was actually granted; these columns never were, so the
-- statement would succeed, change nothing, and leave a line that reads like a
-- control while doing no work — and the verification query below would then
-- pass for the wrong reason.
--
-- The real protection is 0002's design: the table-wide UPDATE on profiles is
-- revoked and privileges are handed back as an explicit column allowlist
-- (extended by 0005 and 0017). A new column starts unwritable. Keeping these
-- three off that allowlist IS the control, and the check below asserts it.

-- ============================================================
-- 3. Announce when the profile is worth reading
-- ============================================================

-- Previously this fired on the discoverable toggle. A post saying "someone
-- joined" with no photo and no bio is not engaging and not worth a slot on
-- the wall. Now it waits until there is something to introduce: a name, an
-- avatar, and either a bio or a headline.
--
-- Consent is still required. Filling in a profile is not the same as
-- agreeing to be announced to the whole club, so is_discoverable still
-- gates it — the profile form asks, with the consequence spelled out.
create or replace function public.feed_on_member_visible()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  complete boolean;
begin
  complete :=
        new.is_discoverable
    and coalesce(nullif(trim(new.full_name), ''), null) is not null
    and coalesce(nullif(trim(new.avatar_url), ''), null) is not null
    and (
         coalesce(nullif(trim(new.bio), ''), null) is not null
      or coalesce(nullif(trim(new.headline), ''), null) is not null
    );

  if complete and not exists (
      select 1 from public.feed_posts
      where subject_user_id = new.user_id
        and kind in ('member_joined', 'coach_joined')
  ) then
    -- Title only. The body is written afterwards by the AI introduction
    -- function, which reads this row and updates the post — so a failed or
    -- slow generation still leaves a valid post rather than nothing.
    insert into public.feed_posts (kind, subject_user_id, title)
    values (
      case when new.role = 'coach' then 'coach_joined' else 'member_joined' end,
      new.user_id,
      coalesce(new.full_name, 'A new member') ||
        case when new.role = 'coach' then ' joined as a coach' else ' joined the club' end
    );
  end if;
  return null;
end;
$fn$;

drop trigger if exists profiles_feed_announce on public.profiles;
create trigger profiles_feed_announce
  after insert or update of is_discoverable, role, full_name, avatar_url, bio, headline
  on public.profiles
  for each row execute function public.feed_on_member_visible();

-- ============================================================
-- Verification
-- ============================================================
--
--   select table_name, privilege_type from information_schema.role_table_grants
--    where grantee='anon' and table_name in ('feed_shares','feed_share_stats');
--     -- expect zero rows
--
--   select column_name from information_schema.column_privileges
--    where table_name='profiles' and grantee='authenticated'
--      and privilege_type='UPDATE'
--      and column_name in ('avatar_is_generated','avatar_attempts','source_purged_at');
--     -- expect zero rows: members must not be able to claim a generated avatar
--
--   select count(*) from public.profiles
--    where avatar_is_generated and source_purged_at is null;
--     -- expect 0. Anything else means a real photo was kept. Alert on this.
