// Build migration 0043 from the never-recorded 0030 proposal file.
//
// The four views were applied to production straight from
// tools/promptarena-dashboard/0030_promptarena_admin_views.proposed.sql and
// never written into supabase/migrations. This lifts them out VERBATIM rather
// than retyping them, because a transcription error in a view that guards 152
// people's contact details is exactly the kind of mistake this whole exercise
// exists to stop.
//
// One deliberate edit: promptarena_outreach_candidates gets the
// `where public.is_staff()` the proposal file forgot.
import { readFileSync, writeFileSync } from "node:fs";

const SRC = "tools/promptarena-dashboard/0030_promptarena_admin_views.proposed.sql";
const src = readFileSync(SRC, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";

const VIEWS = [
  "promptarena_legacy_submission_validity",
  "promptarena_legacy_player_directory",
  "promptarena_outreach_candidates",
  "promptarena_challenge_calibration_staff",
];

// Each block runs from `create or replace view public.<name>` to the last
// `grant select ... to authenticated;` that follows it.
function block(name) {
  const start = src.indexOf(`create or replace view public.${name}`);
  if (start === -1) throw new Error(`view not found: ${name}`);
  const grant = src.indexOf(`grant select on public.${name} to authenticated;`, start);
  if (grant === -1) throw new Error(`grant not found: ${name}`);
  const end = src.indexOf("\n", grant) + 1;
  return src.slice(start, end);
}

let out = [];
for (const name of VIEWS) {
  let b = block(name);
  const guarded = /where\s+public\.is_staff\(\)\s*;/.test(b);

  if (!guarded) {
    if (name !== "promptarena_outreach_candidates") {
      throw new Error(`unexpected: ${name} has no guard and is not the known one`);
    }
    // The view body ends `... left join public.marketing_contacts mc on ...;`
    // Turn that terminating semicolon into the missing predicate.
    const bodyEnd = b.indexOf("\ncomment on view");
    if (bodyEnd === -1) throw new Error("could not find end of outreach body");
    const body = b.slice(0, bodyEnd);
    const rest = b.slice(bodyEnd);
    const lastSemi = body.lastIndexOf(";");
    if (lastSemi === -1) throw new Error("no terminating semicolon in outreach body");
    b = body.slice(0, lastSemi) +
      `${eol}${eol}-- ⚠ ADDED IN 0043. The proposal file this view came from omitted it, while` +
      `${eol}-- its own verification section named this exact view in the check that must` +
      `${eol}-- return zero rows for an ordinary member. Without it, every signed-in member` +
      `${eol}-- could read the email and mobile of 152 people.` +
      `${eol}where public.is_staff()` +
      body.slice(lastSemi) + rest;
  }
  out.push({ name, sql: b, wasGuarded: guarded });
}

const header = `-- 0043 — record the four PromptArena staff views that existed in no migration
-- ============================================================
--
-- These four views have been live since 2 Aug and were never in
-- supabase/migrations. They were applied straight from
-- tools/promptarena-dashboard/0030_promptarena_admin_views.proposed.sql, which
-- is why \`schema_migrations\` has not described this database for three days and
-- why a rebuild from migrations alone would not have reproduced it.
--
-- That gap had a cost. A source-only security audit on 5 Aug enumerated every
-- table, view, grant and policy in this repo and could not see these four at
-- all; the only reason the leak below surfaced is that the Supabase advisor
-- named the view. Recording them is what closes that blind spot permanently.
--
-- ⚠ THE LEAK, and it is worth reading how it happened.
--
-- \`promptarena_outreach_candidates\` selects email, contact_email and mobile for
-- 152 legacy PromptArena players. Three of its four sibling views end in
-- \`where public.is_staff()\`. It did not — and it was granted to
-- \`authenticated\`, so any signed-in member could read those people's contact
-- details. 0042 revoked the grant as an emergency stop; this migration restores
-- the view WITH the predicate and re-grants, so the admin page works again.
--
-- The proposal file was not careless about this. It says, in its own words:
--
--     "⚠ THE ONE THAT MATTERS. Signed in as an ordinary member, every one of
--      these must return ZERO rows. If any returns a row, the is_staff()
--      predicate has been dropped from that view and 152 people's contact
--      details are readable by anyone with a free account:
--        select count(*) from public.promptarena_outreach_candidates;"
--
-- The check that would have caught this was written down, named the right view,
-- and was never run — it needs a real member session, and nobody had one. The
-- lesson is not "write better checks". It is that a check nobody executes is
-- documentation, and this project has now been bitten by that twice.
--
-- Everything below is lifted VERBATIM from the proposal file by
-- tools/record-0030-views.mjs, except the one predicate marked "ADDED IN 0043".
-- Nothing was retyped.

`;

const verify = `
-- ============================================================
-- Verification
-- ============================================================
--
-- 1. All four carry the predicate now (expect 4 rows, all true):
--
--   select c.relname, pg_get_viewdef(c.oid) ilike '%is_staff%' as guarded
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind = 'v'
--      and c.relname in (${VIEWS.map((v) => `'${v}'`).join(",\n--                        ")});
--
-- 2. anon reaches none of them (expect zero rows):
--
--   select table_name, privilege_type from information_schema.role_table_grants
--    where grantee = 'anon' and table_name like 'promptarena_%';
--
-- 3. ⚠ THE ONE THAT MATTERS, and the one nobody ran last time. Signed in as an
--    ORDINARY MEMBER — not staff — every one of these must return 0:
--
--   select count(*) from public.promptarena_legacy_player_directory;
--   select count(*) from public.promptarena_outreach_candidates;
--   select count(*) from public.promptarena_challenge_calibration_staff;
--   select count(*) from public.promptarena_legacy_submission_validity;
--
--    A non-zero answer means the predicate is gone again. Until somebody has
--    actually run this as a member, treat these views as unverified.
--
-- 4. From outside, as a signed-in member, this must be refused:
--
--   GET /rest/v1/promptarena_outreach_candidates?select=email,mobile&limit=1
`;

const body = out.map((o) =>
  `-- ------------------------------------------------------------------${eol}` +
  `-- ${o.name}${o.wasGuarded ? "" : "   ⚠ GUARD ADDED HERE"}${eol}` +
  `-- ------------------------------------------------------------------${eol}${eol}` +
  o.sql
).join(eol);

writeFileSync(
  "supabase/migrations/0043_record_promptarena_staff_views.sql",
  header.replace(/\n/g, eol) + body + verify.replace(/\n/g, eol),
  "utf8",
);

out.forEach((o) => console.log(`  ${o.name.padEnd(42)} ${o.wasGuarded ? "guard present" : "GUARD ADDED"}  ${o.sql.length} bytes`));
console.log("\nwrote supabase/migrations/0043_record_promptarena_staff_views.sql");
