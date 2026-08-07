-- 0059 — stop anonymous visitors enumerating the buckets
-- ============================================================
--
-- Found in the 7 Aug audit, by asking as `anon` rather than by reading policy:
--
--   POST /storage/v1/object/list/avatars   -> 11 objects
--   POST /storage/v1/object/list/event-images -> every file
--
-- and the folder names in `avatars` ARE user ids — confirmed against a known
-- account. Listing inside a folder worked too, returning file names, sizes,
-- mime types and timestamps.
--
-- So a stranger with no session could enumerate member user ids and download
-- every profile photograph. A member who set `is_discoverable = false` had
-- opted out of the directory and their picture was still enumerable.
--
-- ⚠ Bounded, and worth stating so the severity is not overread: every
-- member-facing view is refused to anon — member_directory, member_cards,
-- member_activity, hackathon_roster, prospect_directory and the PromptArena
-- views all answer 42501. So this was ids and faces, never names or emails.
-- It matters because any future endpoint that leaks id -> name would turn it
-- into a join.
--
-- ============================================================
-- Why the policies existed, and why removing anon costs nothing
-- ============================================================
--
-- 0007 and 0016 each wrote:
--
--   create policy "… public read" on storage.objects
--     for select using (bucket_id = '…');
--
-- No role is named, so it applies to PUBLIC — anon included. The intent was
-- "these images are public", which is right. The mechanism was unnecessary:
-- both buckets are marked public, and Supabase serves
-- `/storage/v1/object/public/<bucket>/<path>` WITHOUT consulting RLS at all.
--
-- Verified before changing anything, with no apikey and no Authorization
-- header on the request:
--
--   /object/public/event-images/…/eventSquare-….jpg  -> 200 image/jpeg 262569
--   /object/public/avatars/…/fallback.svg            -> 200 image/svg+xml
--
-- Every image on the site is referenced that way — `getPublicUrl()` builds
-- exactly that path, and it is what `events.image_url` contains. So the SELECT
-- policy was never what made images visible. Its only practical effect was
-- granting the LIST capability to anyone who asked.
--
-- ============================================================
-- Scoped to `authenticated` rather than dropped
-- ============================================================
--
-- Dropping them outright is defensible and probably harmless. It is not
-- provably harmless: `remove()` and `upload()` go through the storage API
-- rather than the public path, and whether either consults SELECT internally
-- is an implementation detail of a service this project does not control.
--
-- Restricting to `authenticated` closes the finding — an anonymous stranger
-- can no longer enumerate anything — while leaving every signed-in code path
-- exactly as it was. A signed-in member can still list, which is a much
-- smaller matter than the open door and can be tightened later with evidence
-- rather than guesswork.
--
-- Nothing in the client calls `.list()`. Checked: the only storage calls in
-- lib/ and app/ are getPublicUrl, upload and remove.

drop policy if exists "event images: public read" on storage.objects;
create policy "event images: public read" on storage.objects
  for select to authenticated
  using (bucket_id = 'event-images');

drop policy if exists "avatars: public read" on storage.objects;
create policy "avatars: public read" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars');

-- ============================================================
-- Verify — and the first two must be run WITHOUT a session
-- ============================================================
--
-- 1. Listing is refused to anon. This is the finding:
--
--      curl -s -X POST \
--        "https://sobxhcsgtimtiqtvqbag.supabase.co/storage/v1/object/list/avatars" \
--        -H "apikey: <publishable>" -H "Authorization: Bearer <publishable>" \
--        -H "Content-Type: application/json" -d '{"prefix":"","limit":5}'
--
--    Expect an error, NOT an array. Same for event-images.
--
-- 2. ⚠ Images still load for a signed-out visitor. This is the check that says
--    whether this migration broke the public site, and it must be run with no
--    apikey and no Authorization header at all:
--
--      curl -sI "https://sobxhcsgtimtiqtvqbag.supabase.co/storage/v1/object/public/event-images/<known path>"
--
--    Expect 200. A 400 or 403 here means public bucket serving is NOT
--    bypassing RLS the way it was measured to, and this migration must be
--    reverted immediately by putting `to public` back.
--
-- 3. In a browser, signed out: open events.html and confirm the event pictures
--    render. The API check above is the mechanism; this is the thing anybody
--    would actually notice.
