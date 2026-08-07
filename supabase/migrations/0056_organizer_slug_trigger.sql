-- 0056 — fill organizers.slug in the database, the way events already does
-- ============================================================
--
-- `organizers.slug` is `not null unique` with no default and no trigger, so
-- every caller has to know the slug rule and apply it. Today exactly one does:
-- `app/admin/organizers.js` carries its own `slugify()` in JavaScript.
--
-- That was survivable while one screen wrote organizers. Ahmed asked for a
-- second — "in event editing or adding we should have control to add new
-- organizer if not exist" — and the choice was to copy the rule into a second
-- file or move it into the database. This project spent this morning fixing
-- four client role checks and eleven Edge Function role checks that were all
-- the same literal copied into sixteen places. Copying a rule is how that
-- starts.
--
-- `events` already resolves this correctly: `events_set_slug` (0048) fills the
-- slug on insert when the caller leaves it blank, so no client needs the rule.
-- This does the same for organizers, reusing the SAME `public.slugify()` that
-- 0048 defined, so a slug made here is identical to a slug made there.
--
-- ⚠ A caller that DOES supply a slug keeps it. `app/admin/organizers.js` has a
-- slug field that staff can type into deliberately, and 0048 wrote down why:
-- "a slug is a PROMISE" — once shared, it should not move. This trigger only
-- fills a blank.

-- ============================================================
-- 1. A free slug, with a numeric suffix if the stem is taken
-- ============================================================
--
-- The name is unique, but two DIFFERENT names can slugify to the same string —
-- "AI Collective" and "AI-Collective" both give `ai-collective`. Without the
-- suffix loop the second insert fails on the unique index with a message that
-- names neither organizer. Mirrors `next_event_slug` (0048).

create or replace function public.next_organizer_slug(p_name text)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_stem text;
  v_slug text;
  v_n int := 1;
begin
  v_stem := coalesce(public.slugify(p_name), 'organizer');
  if v_stem = '' then
    v_stem := 'organizer';
  end if;

  v_slug := v_stem;
  while exists (select 1 from public.organizers where slug = v_slug) loop
    v_n := v_n + 1;
    v_slug := v_stem || '-' || v_n::text;
  end loop;

  return v_slug;
end;
$$;

comment on function public.next_organizer_slug is
  'A slug for an organizer name that is not already taken. Suffixes -2, -3 … '
  'because two different names can slugify to the same stem.';

-- ============================================================
-- 2. Fill it on insert, and only when blank
-- ============================================================

create or replace function public.organizers_set_slug()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.slug is null or trim(new.slug) = '' then
    new.slug := public.next_organizer_slug(new.name);
  end if;
  return new;
end;
$$;

drop trigger if exists organizers_slug_trg on public.organizers;
create trigger organizers_slug_trg
  before insert on public.organizers
  for each row execute function public.organizers_set_slug();

-- ============================================================
-- Verify
-- ============================================================
--
-- 1. A blank slug is filled, and a supplied one is respected:
--
--   begin;
--     insert into public.organizers (name, category) values ('Zz Test Org', 'Community');
--     insert into public.organizers (name, slug, category)
--       values ('Zz Test Org Two', 'kept-exactly', 'Community');
--     select name, slug from public.organizers where name like 'Zz Test Org%';
--     -- expect: zz-test-org  and  kept-exactly
--   rollback;
--
-- 2. Collision suffixing works — two names, one stem:
--
--   begin;
--     insert into public.organizers (name, category) values ('Zz Collide', 'Community');
--     insert into public.organizers (name, category) values ('Zz  Collide!', 'Community');
--     select name, slug from public.organizers where name ilike 'Zz%Collide%';
--     -- expect: zz-collide  and  zz-collide-2
--   rollback;
--
-- 3. ⚠ The real check: add an organizer from the event form in app/admin, as a
--    signed-in session. 0055 exists because a grant query passing is not the
--    same as a write succeeding.
