-- 0079 — what language an event is run in
-- ============================================================
--
-- Ahmed, 22 Aug 2026: an event is English or Arabic, it should be shown as key
-- information, and the Events Hub should filter on it.
--
-- ⚠ NULLABLE, AND THAT IS THE POINT. "English or Arabic" is a binary for the
-- events the club runs; it is not a fact anybody has established about the 110
-- imported conferences from other organisers. A NOT NULL DEFAULT 'English'
-- would have been one line and would have asserted a language for every one of
-- them. NULL means "nobody has said", which is true and which the UI can show
-- as nothing rather than as a wrong badge.
--
-- ⚠ NO 'Both'. Not asked for, and a third value changes what the filter means:
-- somebody choosing Arabic would then have to decide whether bilingual events
-- belong in that list. If a genuinely bilingual event turns up, that is the
-- moment to decide it — with the event in front of you.

alter table public.events
  add column if not exists language text;

alter table public.events drop constraint if exists events_language_ok;
alter table public.events add constraint events_language_ok
  check (language is null or language in ('English', 'Arabic'));

-- ============================================================
-- Backfill — only where there are grounds
-- ============================================================
--
-- ⚠ ARABIC IS DETECTED, NOT ASSUMED: the title or the description contains
-- characters in the Arabic block. Measured AFTER running it — **6** published
-- events match, all six of them Hub events. Four have Arabic in the title and
-- are unmistakable; two more were caught by the description alone, which is
-- why the test is an OR and not just the title:
--   "ابدأ تعلم الذكاء الاصطناعي بسهولة"
--   "الذكاء الصناعي في خدمتك"
--   "AI on Cloud - الذكاء الاصطناعي في الحوسبة السحابية"
--   "Azure Migration Best Practices | بالعربي"
--
-- ⚠ The range is the Arabic block U+0600–U+06FF. It does NOT match Arabic
-- presentation forms or Persian-only letters; a title using those would be
-- missed and would need setting by hand, which is the safe direction to fail.
update public.events
set language = 'Arabic'
where language is null
  and (title ~ '[؀-ۿ]' or coalesce(description, '') ~ '[؀-ۿ]');

-- ⚠ English is filled in ONLY for Events Hub events — ours and our partners' —
-- and only where Arabic was not detected. Those are 21 events the club ran and
-- can speak for. Everything else is left NULL on purpose: an imported
-- conference in Riyadh may well be run in Arabic, and marking it English
-- because nobody looked would put a false badge on somebody else's event.
update public.events e
set language = 'English'
where e.language is null
  and exists (
    select 1
    from public.event_organizers eo
    join public.organizers o on o.id = eo.organizer_id
    where eo.event_id = e.id
      and (o.slug = 'sahaba-club' or o.is_partner)
  );

comment on column public.events.language is
  'English or Arabic, or NULL when nobody has said. Shown as key information '
  'on the event page and filtered in the Events Hub. Backfilled in 0079: '
  'Arabic detected from Arabic-block characters, English filled in for Hub '
  'events only — never for other organisers'' imported events.';
