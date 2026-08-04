-- Sahaba Club — the three profile field limits, made real
-- ============================================================================
--
-- NOT APPLIED. This file has never been run against any database. Nothing in it
-- was written from a query — there was no database access while writing it —
-- so every number this file assumes about the CURRENT contents of `profiles`
-- and `prospect_profiles` is unknown, and §5's report queries are what turn
-- that into fact. Run them BEFORE §4. They are read-only.
--
--     bio         900 characters
--     skills       50 entries
--     interests    10 entries
--
-- Where they come from: the profile-page spec, §5. It requires each of the
-- three to be enforced in three places — the database, the save path and the
-- form — and is explicit that a `maxlength` attribute alone is not enforcement,
-- because the save path is a PostgREST UPDATE on `profiles` that anything
-- holding a member's token can call without ever loading the page. This file is
-- the layer that cannot be walked around. The other two are in
-- `lib/profile-form.js` (`FIELD_LIMITS`, `limitProblems`, `createTagPicker`'s
-- `max`) and `app/profile.html` (`maxlength`, the counter, the pre-save check).
--
-- ----------------------------------------------------------------------------
-- The whole difficulty is the rows that are ALREADY over
-- ----------------------------------------------------------------------------
--
-- ⚠ THE SPEC IS EMPHATIC: NOTHING MAY BE SILENTLY TRUNCATED. An over-length bio
-- ⚠ is a member's own words about themselves. Cutting it to fit is not data
-- ⚠ cleaning, it is deleting the part of their profile they spent longest on,
-- ⚠ irreversibly, without telling them.
--
-- So the first thing to be clear about is what a plain, ordinary CHECK would
-- actually do here, because it is NOT truncation and the difference decides the
-- design:
--
--   `alter table … add constraint … check (…)` takes an ACCESS EXCLUSIVE lock,
--   scans the whole table, and if ONE row is over the line the statement RAISES
--   23514 and rolls back. It never edits a row. It cannot: a CHECK has no
--   opinion about how to make a value fit, only about whether it does.
--
-- That means the risk of a plain CHECK is not data loss — it is a migration
-- that fails on apply, in an environment where the failure is confusing, at
-- which point somebody "fixes" it with the one line this file exists to prevent:
--
--   ⚠⚠ update public.profiles set bio = substring(bio from 1 for 900);
--   ⚠⚠ DO NOT DO THIS. NOT HERE, NOT IN psql, NOT "just to get the migration
--   ⚠⚠ through". It is unrecoverable — the old text is not kept anywhere — and
--   ⚠⚠ it lands on precisely the members who wrote the most. There is NO
--   ⚠⚠ statement anywhere in this file that writes to `bio`, `skills` or
--   ⚠⚠ `interests`, and that is the single most important property it has.
--
-- ----------------------------------------------------------------------------
-- Why NOT VALID, and what it does and does not buy
-- ----------------------------------------------------------------------------
--
-- Every constraint below is added `NOT VALID`. That is a staged approach, and
-- the stages are worth spelling out because "NOT VALID" reads like "switched
-- off" and is nothing of the kind:
--
--   NOW (this file)      The constraint EXISTS and is ENFORCED on every INSERT
--                        and every UPDATE from the moment it is added. What
--                        `NOT VALID` skips is only the one-off scan of rows
--                        that are already there. So: no full-table scan, no
--                        ACCESS EXCLUSIVE lock held for the length of one, the
--                        migration cannot fail because of legacy data, and
--                        nothing over the line is touched. New writes are
--                        capped from this second onwards.
--
--   THEN (§5, by hand)   The owner runs the report and sees exactly which rows
--                        are over and by how much. Nobody is guessing.
--
--   THEN (the members)   Those members open their own profile, see their own
--                        full text with a line asking them to shorten it, and
--                        shorten it themselves. `app/profile.html` is built for
--                        this: the textarea is loaded WHOLE regardless of
--                        `maxlength`, the counter reads "1,240 characters — 340
--                        over the 900 allowed. Nothing has been cut", and the
--                        save is refused with the same sentence until it fits.
--
--   ONLY THEN (§6)       `validate constraint`, which scans and turns the
--                        constraint into a full guarantee. It is left commented
--                        out on purpose. Running it before the rows are down is
--                        harmless — it simply fails, changing nothing — but it
--                        is a deliberate act, not a side effect of deploying.
--
-- ⚠ The one consequence to understand before applying this. A CHECK is
-- ⚠ evaluated against the WHOLE new row, so a member whose bio is 1,240
-- ⚠ characters is refused when they save ANY field — their city, a switch,
-- ⚠ anything — until the bio comes down. That is a real cost and it is the
-- ⚠ price of not truncating. It is also why `saveErrorMessage()` in
-- ⚠ `lib/profile-form.js` now matches these constraint names by hand: without
-- ⚠ it the member reads `new row for relation "profiles" violates check
-- ⚠ constraint "profiles_bio_length"` and has no idea what to do. With it they
-- ⚠ read which field, which number, and that nothing was shortened.

-- ============================================================
-- 1. profiles — the member's own row
-- ============================================================

-- `char_length()`, not `length()` or `octet_length()`: characters, which is
-- what a member means by "900 characters" and what `bioLength()` in
-- profile-form.js counts (Array.from, i.e. code points — JavaScript's own
-- `.length` counts UTF-16 units and would disagree with this constraint by one
-- per emoji, in the direction of the form rejecting text the database would
-- have accepted).
--
-- `bio is null or …`: a NULL bio is the normal state of a new profile and must
-- stay savable. A CHECK returning NULL passes anyway, so this is belt and
-- braces, written out because it is the thing a reader should not have to work
-- out.

alter table public.profiles
  drop constraint if exists profiles_bio_length;
alter table public.profiles
  add constraint profiles_bio_length
  check (bio is null or char_length(bio) <= 900)
  not valid;

-- `skills` and `interests` are `text[] not null default '{}'` (0001), so the
-- null branch is unreachable today; `coalesce` keeps it correct anyway rather
-- than resting on a NOT NULL three migrations away that a later file could drop.

alter table public.profiles
  drop constraint if exists profiles_skills_count;
alter table public.profiles
  add constraint profiles_skills_count
  check (coalesce(cardinality(skills), 0) <= 50)
  not valid;

alter table public.profiles
  drop constraint if exists profiles_interests_count;
alter table public.profiles
  add constraint profiles_interests_count
  check (coalesce(cardinality(interests), 0) <= 10)
  not valid;

comment on constraint profiles_bio_length on public.profiles is
  'Spec §5.1. Added NOT VALID: existing longer bios are the member''s own words '
  'and are never truncated — they are reported by §5 and shortened by their '
  'owner on app/profile.html. Validate only once the report is empty.';
comment on constraint profiles_skills_count on public.profiles is
  'Spec §5.2. NOT VALID for the same reason as profiles_bio_length.';
comment on constraint profiles_interests_count on public.profiles is
  'Spec §5.3. NOT VALID for the same reason as profiles_bio_length.';

-- ⚠ There is deliberately NO `#f-goals-input` / `goals` constraint here.
-- ⚠ "What you're hoping to get out of Sahaba Club" has no limit in the brief.
-- ⚠ The spec flags that as an open question (§10 decision 5) rather than
-- ⚠ assuming one, and a cap invented in a migration is far harder to take back
-- ⚠ than one added later. `createTagPicker` is passed no `max` for it either,
-- ⚠ so the two layers agree about what has not been decided.

-- ============================================================
-- 2. prospect_profiles — the bios nobody wrote about themselves
-- ============================================================
--
-- Spec §5.1: the 900-character cap "applies to AI-composed prospect bios too".
-- 0027's `prospect_profiles` deliberately mirrors `profiles` column for column,
-- and a cap that held on one and not the other would break at the moment it
-- matters most — `link_my_prospect_profile` copies the row across when the
-- person signs up, so an uncapped prospect bio becomes an uncapped member bio
-- the day they join.
--
-- ⚠⚠ READ THIS BEFORE APPLYING §2.
-- ⚠⚠
-- ⚠⚠ `supabase/functions/build-prospect-profile/index.ts` HAS NO ABSOLUTE BIO
-- ⚠⚠ CAP. Its only length rule is RELATIVE to the source note (index.ts ~1346):
-- ⚠⚠
-- ⚠⚠     const budget = Math.round(m.noteText.length * 1.25) + 24;
-- ⚠⚠     if (b.length > budget) { …dropped as invented… }
-- ⚠⚠
-- ⚠⚠ Solve for 900: any `noteText` of 701 characters or more yields a budget
-- ⚠⚠ above 900, so from that length upwards the function can legitimately
-- ⚠⚠ accept — and write — a bio longer than this constraint allows. It would
-- ⚠⚠ then fail with 23514 and lose the whole profile build for that person.
-- ⚠⚠
-- ⚠⚠ That is a NEW failure mode, not a fixed one, and the fix belongs in the
-- ⚠⚠ function, not here — one line:
-- ⚠⚠
-- ⚠⚠     const budget = Math.min(900, Math.round(m.noteText.length * 1.25) + 24);
-- ⚠⚠
-- ⚠⚠ How likely is it today? The function's own notes put the median harvested
-- ⚠⚠ headline at 31 characters, and `noteText` is those headlines joined with
-- ⚠⚠ ' — ' across a person's rounds, so 701 is far out in the tail. Unlikely is
-- ⚠⚠ not impossible, and it costs one line to make it impossible. Apply §2
-- ⚠⚠ together with that change, or accept the tail risk knowingly.

alter table public.prospect_profiles
  drop constraint if exists prospect_bio_length;
alter table public.prospect_profiles
  add constraint prospect_bio_length
  check (bio is null or char_length(bio) <= 900)
  not valid;

alter table public.prospect_profiles
  drop constraint if exists prospect_skills_count;
alter table public.prospect_profiles
  add constraint prospect_skills_count
  check (coalesce(cardinality(skills), 0) <= 50)
  not valid;

alter table public.prospect_profiles
  drop constraint if exists prospect_interests_count;
alter table public.prospect_profiles
  add constraint prospect_interests_count
  check (coalesce(cardinality(interests), 0) <= 10)
  not valid;

-- Named `prospect_*` rather than `prospect_profiles_*` on purpose:
-- `saveErrorMessage()` in lib/profile-form.js turns a SQLSTATE into a sentence
-- for the MEMBER by matching `profiles_(bio|skills|interests)_(length|count)`
-- in the error text, and `prospect_profiles_bio_length` contains that pattern
-- as a substring. No member-facing path writes to `prospect_profiles` — it is
-- service-role only (0027) — so the collision could never actually be seen.
-- It is avoided anyway, because "could never happen" is a claim with a poor
-- record and the cost of avoiding it is a shorter name.
comment on constraint prospect_bio_length on public.prospect_profiles is
  'Spec §5.1, the AI-composed half. NOT VALID. ⚠ build-prospect-profile has no '
  'absolute bio cap — its budget is noteText*1.25+24, which exceeds 900 for any '
  'note of 701 characters or more. Cap it there before trusting this.';

-- ============================================================
-- 3. Grants — nothing to do, said out loud
-- ============================================================
--
-- ⚠ THE MOST REPEATED BUG IN THIS PROJECT is adding something to `profiles` and
-- forgetting the column grant (0002 → 0005 → 0017 → 0019 → 0022 → 0023 → 0026
-- → 0029 all carry a note about it). So, explicitly:
--
-- THIS FILE ADDS NO COLUMN AND NEEDS NO GRANT. `bio`, `skills` and `interests`
-- have been in the `grant update` allowlist since 0002 and are unchanged. A
-- CHECK constraint is not a privilege — it does not appear in
-- `information_schema.column_privileges` and cannot be granted or revoked. If a
-- save starts failing after this file is applied, it is 23514 (the value is out
-- of range) and NOT 42501 (the column is not granted); `saveErrorMessage()`
-- tells those two apart and says so in different words.
--
-- Nothing here touches `member_directory`, `prospect_directory`,
-- `connect_directory` or any other view, so no view needs re-granting either —
-- which is worth stating because Supabase auto-grants ALL on newly created
-- objects, and the safest view migration is the one that creates no view.

-- ============================================================
-- 4. Verification — run every block. Read-only unless marked.
-- ============================================================
--
-- ---- 4a. The constraints exist, and are NOT VALID ----
--
-- select conrelid::regclass as tbl, conname, convalidated, pg_get_constraintdef(oid)
--   from pg_constraint
--  where conname in ('profiles_bio_length','profiles_skills_count','profiles_interests_count',
--                    'prospect_bio_length','prospect_skills_count','prospect_interests_count')
--  order by tbl, conname;
--   -- expect SIX rows, convalidated = false on all six.
--   -- convalidated = true on any of them means somebody validated it; check §5
--   -- came back empty first, because a validated constraint that passed is good
--   -- news and a validated constraint over silently-shortened rows is not.

-- ============================================================
-- 5. THE REPORT — who is over the line, and by how much
-- ============================================================
--
-- This is the minimum the spec asks for: a way for the owner to SEE the
-- affected rows rather than discover them through a member's complaint.
--
-- ⚠ NOTE FOR WHOEVER RUNS THESE. Select the LENGTH, never the TEXT. This
-- ⚠ repository is public. A bio pasted into a commit, an issue or a chat
-- ⚠ message is a real person's words about themselves published somewhere they
-- ⚠ did not agree to. `user_id` and a count are enough to act on; the content
-- ⚠ is not needed by anyone except its author, who can already see it.
--
-- ---- 5a. The one-line answer: is there anything to do at all? ----
--
-- select
--   count(*) filter (where char_length(bio) > 900)              as bios_over_900,
--   count(*) filter (where cardinality(skills) > 50)            as skill_lists_over_50,
--   count(*) filter (where cardinality(interests) > 10)         as interest_lists_over_10,
--   count(*)                                                    as profiles_total
--   from public.profiles;
--   -- all three zero → §6 can be run today and the limits become absolute.
--
-- ---- 5b. Which rows, and how far over ----
--
-- select user_id,
--        char_length(bio)                as bio_chars,
--        char_length(bio) - 900          as bio_over,
--        cardinality(skills)             as skills,
--        greatest(cardinality(skills) - 50, 0)     as skills_over,
--        cardinality(interests)          as interests,
--        greatest(cardinality(interests) - 10, 0)  as interests_over,
--        is_discoverable
--   from public.profiles
--  where char_length(bio) > 900
--     or cardinality(skills) > 50
--     or cardinality(interests) > 10
--  order by greatest(coalesce(char_length(bio),0) - 900, 0) desc;
--   -- Each of these is a person to ask, not a row to edit. `is_discoverable`
--   -- is there because a listed profile is the one other members are reading.
--
-- ---- 5c. The same for prospects, where there is no owner to ask ----
--
-- select id, full_name is not null as has_name,
--        char_length(bio) as bio_chars, char_length(bio) - 900 as bio_over,
--        cardinality(skills) as skills, cardinality(interests) as interests,
--        is_published, built_model, built_at
--   from public.prospect_profiles
--  where char_length(bio) > 900
--     or cardinality(skills) > 50
--     or cardinality(interests) > 10
--  order by bio_over desc nulls last;
--   -- ⚠ A prospect cannot be asked to shorten their own bio: they have no
--   -- account, and 0027 is explicit that these rows exist to be shown to
--   -- people who have not joined. If any row comes back here, the decision is
--   -- the owner's and it is an editorial one — re-run build-prospect-profile
--   -- against a capped budget so the bio is REWRITTEN from the same source
--   -- note, or unpublish the row. Do not hand-trim it: `sources` records where
--   -- every field came from, and a hand-cut bio no longer matches its
--   -- provenance, which is the one property that whole table was built for.
--
-- ---- 5d. How far over is "far"? ----
--
-- select width_bucket(char_length(bio), 900, 3000, 6) as bucket,
--        count(*), min(char_length(bio)), max(char_length(bio))
--   from public.profiles where char_length(bio) > 900 group by 1 order by 1;
--   -- One member 30 characters over is a message. Twenty members 800 over
--   -- means the limit itself is worth taking back to Zoka before it ships.

-- ============================================================
-- 6. VALIDATE — deliberately not run by this file
-- ============================================================
--
-- ⚠ NOT AUTOMATIC. Run these ONLY when §5a returns zeroes. Until then they
-- ⚠ fail, harmlessly, changing nothing — a failed VALIDATE leaves the
-- ⚠ constraint exactly as it was. It never edits a row.
-- ⚠
-- ⚠ THIS IS NOT A LICENCE TO MAKE §5a RETURN ZEROES WITH AN UPDATE. The way it
-- ⚠ reaches zero is members shortening their own bios. See the top of this file.
-- ⚠
-- ⚠ VALIDATE takes SHARE UPDATE EXCLUSIVE, not ACCESS EXCLUSIVE: it scans the
-- ⚠ table but does not block reads or writes, so it is safe to run live.
--
-- alter table public.profiles          validate constraint profiles_bio_length;
-- alter table public.profiles          validate constraint profiles_skills_count;
-- alter table public.profiles          validate constraint profiles_interests_count;
-- alter table public.prospect_profiles validate constraint prospect_bio_length;
-- alter table public.prospect_profiles validate constraint prospect_skills_count;
-- alter table public.prospect_profiles validate constraint prospect_interests_count;
--
-- Then re-run §4a: convalidated should be true on all six.

-- ============================================================
-- 7. Behaviour tests — these WRITE. Run on a scratch row only.
-- ============================================================
--
-- Every one of these is against a row you created for the purpose. Do not
-- point them at a real member. Substitute a real `user_id` from a test account
-- for :uid.
--
-- ---- at the limit is ALLOWED ----
-- update public.profiles set bio = repeat('x', 900) where user_id = :uid;
--   -- expect UPDATE 1
-- update public.profiles set skills = (select array_agg('s'||g) from generate_series(1,50) g)
--  where user_id = :uid;                    -- expect UPDATE 1
-- update public.profiles set interests = (select array_agg('i'||g) from generate_series(1,10) g)
--  where user_id = :uid;                    -- expect UPDATE 1
--
-- ---- one over is REFUSED ----
-- update public.profiles set bio = repeat('x', 901) where user_id = :uid;
--   -- expect ERROR 23514, constraint "profiles_bio_length"
-- update public.profiles set skills = (select array_agg('s'||g) from generate_series(1,51) g)
--  where user_id = :uid;                    -- expect ERROR 23514 profiles_skills_count
-- update public.profiles set interests = (select array_agg('i'||g) from generate_series(1,11) g)
--  where user_id = :uid;                    -- expect ERROR 23514 profiles_interests_count
--
-- ---- empty and NULL are ALLOWED ----
-- update public.profiles set bio = null, skills = '{}', interests = '{}' where user_id = :uid;
--   -- expect UPDATE 1
--
-- ---- a bio that is already over blocks an UNRELATED field ----
-- This is the consequence flagged at the top of the file, demonstrated rather
-- than described. It is why the form checks first and says it in English.
--
-- set session role postgres;                          -- bypass the CHECK? NO —
--   -- a superuser is NOT exempt from a CHECK constraint. There is no role that
--   -- can write an over-length bio while this exists, which is the point of it
--   -- being here rather than only in JavaScript. To stage this case you have to
--   -- create the row before adding the constraint, or drop it, write, re-add.
--
-- ---- the count is characters, not bytes ----
-- select char_length(repeat('é', 900)), octet_length(repeat('é', 900));
--   -- expect 900 and 1800. The constraint uses the first, so a bio in Arabic
--   -- gets the same 900 characters as one in English. `octet_length` would
--   -- have given Arabic and Russian members roughly half the room, silently.
