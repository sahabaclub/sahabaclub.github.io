// check-staff-view-exposure — the check migration 0043 asked for and nobody ran.
//
// ⚠ WHY THIS EXISTS. Three public views select from auth.users and carry
// personal email addresses: contact_link_status, staff_member_details and
// promptarena_legacy_player_directory. All three are granted SELECT to
// `authenticated`, and all three are security_invoker=off, which means they run
// as their owner and RLS on the underlying tables DOES NOT APPLY.
//
// So the trailing `WHERE is_staff()` inside each view body is the ONLY thing
// standing between 152 people's email and mobile numbers and every logged-in
// member. 0043 says so in its own comment. Delete that predicate while editing
// a view and nothing else stops the data.
//
// Supabase's linter flagged this on 17 Aug 2026 as `auth_users_exposed`. It was
// a true positive about the SHAPE and a false positive about the IMPACT — but
// the shape is one edit away from being the impact, which is why this runs.
//
// What it asserts:
//   1. anon is REFUSED (42501) by every one of the three, over the real API.
//   2. The migration that defines each view still ends with `where public.is_staff();`
//
// (1) is the one that matters and needs no secret: the publishable key is
// public by design. If it ever returns 200, personal data is on the open
// internet and this fails loudly.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "sb_publishable_uYzve3z4wfLF_-9fTH67Og_PJ6EhHm4";
const API = "https://sobxhcsgtimtiqtvqbag.supabase.co/rest/v1";

const VIEWS = ["contact_link_status", "staff_member_details", "promptarena_legacy_player_directory"];

let failed = 0;
const fail = (m) => { console.error("  FAIL  " + m); failed++; };
const ok = (m) => console.log("  ok    " + m);

// ── 1. anon must be refused, over the real API ────────────────────────────
for (const v of VIEWS) {
  let status, body = "";
  try {
    const r = await fetch(`${API}/${v}?select=*&limit=1`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    status = r.status;
    body = await r.text();
  } catch (e) {
    // A network failure is not a pass. Treat it as unknown and fail: an
    // unverified check is the thing this file exists to prevent.
    fail(`${v}: could not reach the API (${String(e).slice(0, 60)}) — treat as UNVERIFIED`);
    continue;
  }
  if (status === 200) {
    fail(`${v}: ANON GOT 200. Personal data is publicly readable RIGHT NOW.`);
  } else if (status === 401 || status === 403 || body.includes("42501")) {
    ok(`${v}: anon refused (${status})`);
  } else {
    fail(`${v}: unexpected status ${status} — expected a refusal, got ${body.slice(0, 80)}`);
  }
}

// ── 2. the predicate must still be the last thing in the definition ───────
const files = readdirSync(join(ROOT, "supabase", "migrations")).filter((f) => f.endsWith(".sql"));
for (const v of VIEWS) {
  // The LAST migration that defines the view is the one in force.
  let def = null;
  for (const f of files.sort()) {
    // ⚠ CRLF, AND IT ALREADY BIT THIS FILE ONCE. Migrations in this repo have
    // MIXED line endings per file: 0033, 0043 and 0058 are all CRLF, so the
    // CREATE VIEW line ends with a carriage return before the newline. A needle
    // built with a bare "\n" matches NOTHING there — and a checker that matches
    // nothing reports success. That is the exact failure this file exists to
    // prevent, so the endings are normalised before anything is searched.
    const sql = readFileSync(join(ROOT, "supabase", "migrations", f), "utf8")
      .split("\r\n").join("\n");
    const needles = [`create view public.${v} `, `create view public.${v}
`,
                     `create or replace view public.${v} `, `create or replace view public.${v}
`];
    let start = -1;
    for (const nd of needles) { const i = sql.toLowerCase().indexOf(nd.toLowerCase()); if (i !== -1) { start = i; break; } }
    const m = start === -1 ? null : [sql.slice(start, sql.indexOf(";", start) + 1)];
    if (m) def = { file: f, body: m[0] };
  }
  if (!def) { fail(`${v}: no CREATE VIEW found in any migration`); continue; }
  // Strip trailing whitespace/comments and check the tail.
  const tail = def.body.replace(/\s+/g, " ").trim().slice(-40).toLowerCase();
  if (/where\s+public\.is_staff\(\)\s*;$/.test(tail) || /where\s+is_staff\(\)\s*;$/.test(tail)) {
    ok(`${v}: guarded by is_staff() in ${def.file}`);
  } else {
    fail(`${v}: the trailing is_staff() predicate is GONE from ${def.file} — tail reads "…${tail}"`);
  }
}

if (failed) {
  console.error(`\n  ${failed} problem(s). These views carry real people's email and mobile.`);
  process.exit(1);
}
console.log("\n  staff-only views are not exposed to anon, and still carry their guard.");
