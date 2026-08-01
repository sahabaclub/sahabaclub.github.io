-- Sahaba Club — storage for event artwork
-- ------------------------------------------------------------
-- Event images currently come from wherever the source site hosts them, which
-- means a card silently loses its picture the day that site reorganises. This
-- bucket gives every imported event a copy we control, whether the artwork was
-- taken from the source page or generated for it.

-- Public read is the point: these appear on the public events page, so they
-- have to load without a session. Nothing private ever goes in this bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'event-images',
  'event-images',
  true,
  5242880,                                      -- 5 MB is generous for a card image
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;

-- Policies on storage.objects are separate from the bucket's `public` flag:
-- the flag governs the public CDN URL, these govern the API. Both are needed.
--
-- The import function writes with the service role and so bypasses all of
-- this. These exist for the admin screen, which acts as the signed-in user.

drop policy if exists "event images: public read" on storage.objects;
create policy "event images: public read" on storage.objects
  for select using (bucket_id = 'event-images');

-- Writes are staff-only. Note this is is_staff(), not "any signed-in member" —
-- an open bucket that any member could write to is a free image host with the
-- club's name on it.
drop policy if exists "event images: staff insert" on storage.objects;
create policy "event images: staff insert" on storage.objects
  for insert with check (bucket_id = 'event-images' and public.is_staff());

drop policy if exists "event images: staff update" on storage.objects;
create policy "event images: staff update" on storage.objects
  for update using (bucket_id = 'event-images' and public.is_staff());

drop policy if exists "event images: staff delete" on storage.objects;
create policy "event images: staff delete" on storage.objects
  for delete using (bucket_id = 'event-images' and public.is_staff());

-- Verification (expect: one bucket row with public = true, and four policies):
--
--   select id, public, file_size_limit from storage.buckets where id = 'event-images';
--
--   select policyname from pg_policies
--   where schemaname = 'storage' and tablename = 'objects'
--     and policyname like 'event images%'
--   order by policyname;
