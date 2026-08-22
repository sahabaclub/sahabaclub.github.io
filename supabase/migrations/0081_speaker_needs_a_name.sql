-- 0081 — a speaker who cannot be named is not a credit
-- ============================================================
--
-- Found while verifying 0080 against real data, 22 Aug 2026. Two ways the
-- speaker feature could publish something useless, both of them quiet:
--
-- ⚠ 1. FIVE PROFILES TODAY HAVE A BLANK full_name. Staff could pick one of
-- them in the admin panel — the picker showed them as "(no name)" — and the
-- public event page would then credit the session to a card reading "Member".
-- That is not a speaker credit, it is a placeholder on a public page, and
-- nothing anywhere said so.
--
-- ⚠ 2. THE VIEW INNER-JOINED profiles. One auth account today has no profile
-- row at all. Record them as a speaker and the row exists in the table but the
-- view drops it, so the event page shows FEWER speakers than were entered and
-- the admin panel shows them fine. A disagreement between what staff saved and
-- what the public sees, with no error on either side.
--
-- Both are the same failure: a plausible-looking result that is wrong. The
-- left join below fixes (2) by letting the row surface with a null name
-- instead of vanishing, is_linkable fixes the link, and the picker plus
-- tools/check-event-speakers.mjs stop (1) from being entered in the first
-- place.

create or replace view public.event_speakers_public as
  select
    s.event_id,
    s.user_id,
    s.slot,
    nullif(btrim(p.full_name), '') as full_name,
    p.avatar_url,
    p.headline,
    -- ⚠ A NAMELESS SPEAKER IS NEVER LINKABLE, whatever their settings say.
    -- Sending a reader to a profile that cannot even say whose it is wastes
    -- the click. The name check is first because it is the one that decides
    -- whether there is anything to visit at all.
    (nullif(btrim(p.full_name), '') is not null
     and p.is_discoverable
     and public.profile_is_complete(p.*)) as is_linkable
  from public.event_speakers s
  left join public.profiles p on p.user_id = s.user_id;

revoke all on public.event_speakers_public from public, anon, authenticated;
grant select on public.event_speakers_public to anon, authenticated;

comment on view public.event_speakers_public is
  'Speaker name, picture and headline for the event and profile pages. '
  'Readable by anyone: event pages are public. Exposes four fields and no '
  'contact details. LEFT join, so a speaker whose profile row is missing '
  'surfaces with a null name rather than disappearing from the event. '
  'full_name is null rather than blank, so callers cannot mistake an empty '
  'string for a name. is_linkable is false for anyone unnamed, undiscoverable '
  'or incomplete — they are still NAMED where a name exists, because they did '
  'speak. 0080, amended 0081.';
