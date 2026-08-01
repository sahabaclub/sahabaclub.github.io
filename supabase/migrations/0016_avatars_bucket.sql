-- Sahaba Club — storage for generated avatars
-- ------------------------------------------------------------
-- Where generate-avatar puts the picture it made. Nothing a member uploaded
-- is ever stored here: the source photo lives in the function's memory for
-- the length of one request and is gone when it returns (see 0015 and the
-- `source_purged_at` receipt). Everything in this bucket is generated art.
--
-- That is also why public read is safe here in a way it would not be for a
-- bucket of photographs. Avatars appear on the feed, in the directory, and on
-- member cards, all of which are read by every signed-in member — and the
-- images are drawings, not pictures of anyone.

-- Layout is `<user_id>/<uuid>.png`, with `<user_id>/fallback.svg` for the
-- themed fallback. The first path segment is what the write policies below
-- check, so the prefix is load-bearing, not tidiness.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  2097152,                                      -- 2 MB; a 1024x1024 PNG is well under
  -- SVG is here for the deterministic fallback tile, which has to be drawn
  -- rather than rendered because the Edge runtime has no rasteriser. It is
  -- written only by the function, never accepted from a client, and Supabase
  -- serves storage from its own hostname — so a stored SVG cannot script
  -- against the app's origin.
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
on conflict (id) do nothing;

-- Policies on storage.objects are separate from the bucket's `public` flag:
-- the flag governs the public CDN URL, these govern the API. Both are needed.
--
-- generate-avatar writes with the service role and bypasses all of this.
-- These exist for the member's own browser, which acts as the signed-in user.

drop policy if exists "avatars: public read" on storage.objects;
create policy "avatars: public read" on storage.objects
  for select using (bucket_id = 'avatars');

-- A member may write only inside their own folder. Without the foldername
-- check this is a bucket any signed-in member can overwrite anyone's avatar
-- in — including replacing a generated avatar with a real photograph of
-- somebody else, which is the exact thing this whole design exists to stop.
drop policy if exists "avatars: own folder insert" on storage.objects;
create policy "avatars: own folder insert" on storage.objects
  for insert with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars: own folder update" on storage.objects;
create policy "avatars: own folder update" on storage.objects
  for update using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Delete is own-folder or staff: a member can clear their own avatar, and
-- staff need to be able to remove something inappropriate without waiting for
-- the member to do it.
drop policy if exists "avatars: own folder or staff delete" on storage.objects;
create policy "avatars: own folder or staff delete" on storage.objects
  for delete using (
    bucket_id = 'avatars'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_staff())
  );

-- Verification (expect: one bucket row with public = true, and four policies):
--
--   select id, public, file_size_limit, allowed_mime_types
--     from storage.buckets where id = 'avatars';
--
--   select policyname from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and policyname like 'avatars%'
--    order by policyname;
--
-- As a signed-in member, this must fail — writing outside your own folder:
--   insert into storage.objects (bucket_id, name) values ('avatars', 'someone-else/x.png');
--
-- And the pairing that matters most, from 0015 — still expect 0:
--   select count(*) from public.profiles
--    where avatar_is_generated and source_purged_at is null;
