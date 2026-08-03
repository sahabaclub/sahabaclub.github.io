-- Sahaba Club — the panel was recommending two ceilings that truncate
-- ------------------------------------------------------------
--
-- 0031 seeded `recommended_max_output_tokens` for eight services. Two of them
-- were sized the way `build-prospect-profile` was sized before it failed 42.9%
-- of its live calls: against the visible answer alone.
--
--   write-member-intro    1200  "generous for the visible answer"
--   write-contact-email   2000  "three or four short paragraphs"
--
-- Both readings are correct about the prose and wrong about the budget. On the
-- gpt-5 family `max_output_tokens` on the Responses API bounds reasoning
-- tokens, visible output tokens and non-visible formatting tokens TOGETHER, and
-- it can be exhausted before a single visible character is produced. 0031's own
-- comment at that column says exactly this. The two rows above did not follow
-- it.
--
-- The functions have since re-derived their code defaults from the bounded
-- visible payload plus a low-effort reasoning allowance. The arithmetic is
-- written out above the constants in each file and is not repeated here:
--
--   write-member-intro    850 visible + 3,150 reasoning = 4,000  (retry 12,000)
--   write-contact-email  3,100 visible + 3,900 reasoning = 7,000  (retry 21,000)
--
-- ⚠ WHY THIS IS A MIGRATION AND NOT A NOTE ON A TICKET
--
-- `max_output_tokens_editable` is true for both, so the number in this column
-- is not decorative — it is the only thing standing between a staff member and
-- a ceiling that truncates. Two mechanisms read it:
--
--   * The panel (`app/admin/ai-admin.js`, `ceilingNote`) warns loudly BELOW
--     this value. With 1200 seeded, a staff member could type 1200 into the
--     intro writer — a ceiling that is guaranteed to spend itself on reasoning
--     on gpt-5 — and be told nothing at all, because 1200 is not below 1200.
--     The warning was pointing at the wrong side of the line.
--   * §5's trigger (`ai_service_versions_validate`) COPIES this value into a
--     saved version when the panel sends no ceiling of its own. So the stale
--     number is not only un-warned-against, it is what gets written down.
--
-- Both are live in production, which is where 0031 is applied. Editing 0031 in
-- place does not reach them.
--
-- ⚠ WHY 0031's SEED IS ALSO EDITED, WHICH IS NOT WHAT 0024 DID FOR 0013
--
-- 0024 left 0013's broken policy in the file and replaced it here, and that is
-- the right convention for DDL. This case is different in one way that matters:
-- 0031's seed ends in `on conflict (slug) do update set … =
-- excluded.recommended_max_output_tokens, … = excluded.ceiling_note`. It is
-- deliberately re-runnable, and SETUP.md tells whoever sets up an environment
-- to run these files by hand in the SQL editor. Left alone, 0031 would be a
-- loaded gun: re-applying it — to pick up a `parts_shape` change, to rebuild a
-- staging database, for any reason at all — would silently put 1200 and 2000
-- back and undo this file.
--
-- So the two files now carry the SAME values and the SAME notes, and the order
-- they are applied in stops mattering. This migration is what moves production;
-- the edit to 0031 is what stops production drifting back.
--
-- ⚠ WHAT THIS DOES NOT TOUCH
--
-- Nothing in `ai_service_versions`. A ceiling a staff member typed and
-- activated is their decision, recorded in an append-only history, and a
-- migration that quietly rewrites it would break the one property the history
-- is for — that what was live on the 14th is still readable on the 20th. If a
-- version was activated at the old recommendation (or inherited it from the
-- trigger), it is still running at that number and the notice at the bottom of
-- this file names it. Fixing one is a panel action, with a reason attached, and
-- a test run that will show the truncation if it is still too low.

update public.ai_services set
  recommended_max_output_tokens = 4000,
  ceiling_note =
    'Derived, not picked: ~850 visible tokens (INTRO_MAX_CHARS of 1,200 characters, plus the vibe tag and the JSON around them, divided by the Arabic token multiplier) plus a ~3,150 reasoning allowance. On the gpt-5 family this ceiling is SHARED with the model''s own reasoning tokens and can be spent before the first visible character — which is what the old value of 1200 did, generous as it looked for two or three sentences. Effort is capped low. The retry ceiling scales with this one.'
where slug = 'write-member-intro';

update public.ai_services set
  recommended_max_output_tokens = 7000,
  ceiling_note =
    'Derived, not picked: ~3,100 visible tokens (the subject, body and note caps — 200, 4,000 and 300 characters — divided by the Arabic token multiplier, because the campaign language is a dropdown staff can set to Arabic) plus a ~3,900 reasoning allowance. On the gpt-5 family this ceiling is SHARED with the model''s own reasoning tokens and can be spent before the first visible character — which is what the old value of 2000 did, generous as it looked for three or four short paragraphs. Effort is capped low. The retry ceiling scales with this one.'
where slug = 'write-contact-email';

-- ---- What is already saved at the old numbers ---------------------------
--
-- Read-only. Prints, it does not fix — see "what this does not touch" above.
-- An active version below the new recommendation is a real thing running in
-- production today, and the person applying this migration is the right person
-- to know that before they close the tab.

do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select v.service_slug, v.version, v.max_output_tokens, s.recommended_max_output_tokens
      from public.ai_service_versions v
      join public.ai_services s on s.slug = v.service_slug
     where v.is_active
       and v.service_slug in ('write-member-intro', 'write-contact-email')
       and v.max_output_tokens is not null
       and v.max_output_tokens < s.recommended_max_output_tokens
     order by v.service_slug
  loop
    n := n + 1;
    raise notice
      'ACTIVE VERSION BELOW THE NEW RECOMMENDATION: % v% is live at max_output_tokens=%, recommended is now %. It is not changed by this migration. Raise it under Admin → AI services, where the test run will show a truncation if it is still too low.',
      r.service_slug, r.version, r.max_output_tokens, r.recommended_max_output_tokens;
  end loop;

  if n = 0 then
    raise notice 'No active version of write-member-intro or write-contact-email sits below its new recommendation; both services are on their code defaults or already above.';
  end if;
end $$;
