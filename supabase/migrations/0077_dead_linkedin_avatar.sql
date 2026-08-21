-- 0077 — clear an expired LinkedIn avatar URL
-- ============================================================
--
-- Ebeid Atef Ebeid's picture was a broken image on every card and on his
-- profile. Measured: the URL returns **HTTP 403**.
--
-- ⚠ THE CAUSE IS THE KIND OF URL, NOT THE PICTURE. It points at
-- media.licdn.com and carries LinkedIn's own signature and expiry:
--
--   ...?e=1787184000&v=beta&t=_sHy82Sr...
--
-- `e=1787184000` is 20 Aug 2026. It did not rot; it reached the date it was
-- always going to reach. Every LinkedIn display-photo URL does.
--
-- ⚠ THERE IS NOTHING TO RECOVER. The image cannot be fetched to copy into the
-- club's own storage — 403 is 403 — and 0015 purges the source photograph
-- after the first generation, so nothing else holds it either. Clearing the
-- column is the only honest option: the card falls back to the initial in a
-- circle, which is a true statement about what the club has, where a broken
-- image is a bug in the reader's eyes.
--
-- ⚠ ABDUL SHUKKOOR P.C HAS THE SAME KIND OF URL AND IS NOT TOUCHED HERE.
-- His expires at `e=1788998400` — 10 Sep 2026 — so it works today and will
-- break on its own in about three weeks. It is deliberately left alone: it is
-- currently showing his real photograph, and blanking a working picture three
-- weeks early to save a future migration is a bad trade for him. **The fix on
-- or before 10 Sep is to ask him to upload one, not to run this again.**
--
-- ⚠ THE REAL DEFECT IS UPSTREAM AND IS NOT FIXED HERE: whatever imported these
-- stored a third-party signed URL instead of copying the bytes into the club's
-- own storage, where the other 20 avatars live. Until that changes, every
-- imported LinkedIn photo is a dated bomb.

update public.profiles
set avatar_url = null,
    avatar_status = 'idle',
    updated_at = now()
where full_name = 'Ebeid Atef Ebeid'
  and avatar_url like '%licdn.com%';
