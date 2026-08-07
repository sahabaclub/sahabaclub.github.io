// Look at the database the way a signed-out visitor does.
//
//   node tools/check-anon-access.mjs
//
// Exits 0 when everything is as it should be, 1 otherwise. No arguments, no
// setup: it uses the PUBLISHABLE key, which is public by design and already in
// the repository — the same key every visitor's browser holds.
//
// ============================================================
// Why this exists
// ============================================================
//
// On 7 Aug 2026 every signed-out visitor lost the ability to open any event.
// A member told Ahmed; Ahmed told us. The database had been answering
//
//   {"code":"42501","message":"permission denied for function has_admin_section"}
//
// to anonymous reads of `events` since migration 0054, four hours earlier.
//
// Two bugs the same day had the same shape: that one, and a Register button on
// the event page that was open to everybody because the page never checked for
// a session. Both were invisible from Ahmed's signed-in session, and every
// check that had been run was from Ahmed's signed-in session.
//
// So this file does the one thing none of the others did: it asks as `anon`.
//
// ============================================================
// What it checks, and why the two lists are not symmetrical
// ============================================================
//
// PUBLIC — the site is broken for visitors if these are unreadable.
// PRIVATE — real people are exposed if these ARE readable.
//
// A failure in the first list is an outage; a failure in the second is an
// incident. They are reported differently on purpose.
//
// ⚠ THE MOST IMPORTANT DISTINCTION IN THIS FILE: a table that should be public
// but answers "permission denied for FUNCTION …" is BROKEN, not secure. It
// looks like a lock and it is a crash — a policy called something the caller
// cannot execute, so the query aborted before a single row was considered.
// That is precisely what nobody noticed for four hours, so it gets its own
// verdict rather than being folded into "denied".

const PROJECT = "sobxhcsgtimtiqtvqbag";
const API = `https://${PROJECT}.supabase.co/rest/v1`;

// Public by design: this is the key the site ships to every browser. It is in
// HANDOFF.md and in lib/supabase-client.js. Overridable for a clone.
const KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable_uYzve3z4wfLF_-9fTH67Og_PJ6EhHm4";

// Reading these is what the public site does on every page load.
const PUBLIC = [
  { table: "events", why: "the events list and every shared event link" },
  { table: "organizers", why: "the organizer filter and the Events Hub" },
  { table: "event_organizers", why: "which events are ours" },
  { table: "podcast_episodes", why: "the podcast page" },
];

// Reading any of these anonymously would expose people who never signed up
// here, or let a stranger act as staff.
const PRIVATE = [
  { table: "profiles", why: "every member's name, country and role" },
  { table: "marketing_contacts", why: "2,200 personal emails and mobile numbers" },
  { table: "campaigns", why: "unsent campaign drafts" },
  { table: "notifications", why: "members' own notifications" },
  { table: "push_subscriptions", why: "push endpoints — a capability, not a contact detail" },
  { table: "admin_invites", why: "who is being made an administrator" },
  { table: "role_permissions", why: "the admin permission map" },
];

// Rows that exist but must never reach an anonymous reader.
const HIDDEN_ROWS = [
  {
    label: "unpublished events",
    query: "events?is_published=eq.false&select=id",
    why: "drafts are staff-only until published",
  },
];

async function ask(path) {
  const res = await fetch(`${API}/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

// One place that decides what an answer MEANS, so the two lists and the
// self-tests cannot disagree about it.
function classify({ status, body }) {
  if (Array.isArray(body)) return { verdict: "readable", rows: body.length };
  const code = body && body.code;
  const message = (body && body.message) || "";
  if (code === "42501" && /permission denied for function/i.test(message)) {
    return { verdict: "broken-by-function", message };
  }
  if (code === "42501") return { verdict: "denied", message };
  if (code === "PGRST205") return { verdict: "missing", message };
  return { verdict: "error", message: message || `HTTP ${status}` };
}

// ---- self-tests -----------------------------------------------------------
// Both directions, before any network call. A classifier that called
// everything "denied" would pass a security check by failing at its job, and
// this repo has shipped exactly that mistake once before (the badge-contrast
// checker), so the positive controls are not optional.
function selfTest() {
  const cases = [
    [{ status: 200, body: [] }, "readable"],
    [{ status: 200, body: [{ id: 1 }] }, "readable"],
    [{ status: 403, body: { code: "42501", message: "permission denied for table profiles" } }, "denied"],
    [{ status: 403, body: { code: "42501", message: "permission denied for function has_admin_section" } }, "broken-by-function"],
    [{ status: 404, body: { code: "PGRST205", message: "Could not find the table" } }, "missing"],
    [{ status: 500, body: { code: "XX000", message: "boom" } }, "error"],
  ];
  let ok = true;
  for (const [input, expected] of cases) {
    const got = classify(input).verdict;
    if (got !== expected) {
      console.log(`  SELF-TEST FAIL: expected ${expected}, got ${got}`);
      ok = false;
    }
  }
  return ok;
}

if (!selfTest()) {
  console.log("\nself-tests failed — fix the checker before trusting a pass");
  process.exit(2);
}
console.log('ok   control: rows            -> "readable"');
console.log('ok   control: denied on TABLE  -> "denied"');
console.log('ok   control: denied on FUNCTION -> "broken-by-function" (an outage, not a lock)');
console.log("");

// ---- the actual look ------------------------------------------------------
const failures = [];

console.log("PUBLIC — a visitor must be able to read these");
for (const { table, why } of PUBLIC) {
  const r = classify(await ask(`${table}?select=*&limit=1`));
  if (r.verdict === "readable") {
    console.log(`  ok        ${table.padEnd(20)} ${why}`);
  } else if (r.verdict === "broken-by-function") {
    console.log(`  OUTAGE    ${table.padEnd(20)} ${r.message}`);
    failures.push(`${table}: a policy calls a function anon cannot execute — ${why} is broken for every signed-out visitor`);
  } else {
    console.log(`  BROKEN    ${table.padEnd(20)} ${r.verdict}: ${r.message || ""}`);
    failures.push(`${table}: not readable by anon (${r.verdict}) — ${why}`);
  }
}

console.log("\nPRIVATE — a visitor must NOT be able to read these");
for (const { table, why } of PRIVATE) {
  const r = classify(await ask(`${table}?select=*&limit=1`));
  if (r.verdict === "denied" || r.verdict === "missing") {
    console.log(`  ok        ${table.padEnd(20)} refused`);
  } else if (r.verdict === "readable") {
    console.log(`  EXPOSED   ${table.padEnd(20)} returned ${r.rows} row(s) — ${why}`);
    failures.push(`${table}: READABLE BY ANYONE — ${why}`);
  } else {
    // An unexpected error is not proof of safety; say so rather than passing.
    console.log(`  UNKNOWN   ${table.padEnd(20)} ${r.verdict}: ${r.message || ""}`);
    failures.push(`${table}: could not be shown to be locked (${r.verdict})`);
  }
}

console.log("\nROWS that must stay hidden");
for (const { label, query, why } of HIDDEN_ROWS) {
  const r = classify(await ask(query));
  if (r.verdict === "readable" && r.rows === 0) {
    console.log(`  ok        ${label.padEnd(20)} 0 rows`);
  } else if (r.verdict === "readable") {
    console.log(`  EXPOSED   ${label.padEnd(20)} ${r.rows} row(s) — ${why}`);
    failures.push(`${label}: ${r.rows} visible to anon — ${why}`);
  } else {
    console.log(`  UNKNOWN   ${label.padEnd(20)} ${r.verdict}: ${r.message || ""}`);
    failures.push(`${label}: could not be checked (${r.verdict})`);
  }
}

console.log("");
if (!failures.length) {
  console.log("A signed-out visitor sees exactly what they should.");
  process.exit(0);
}
console.log(`${failures.length} problem(s):\n`);
for (const f of failures) console.log("  - " + f);
console.log(
  "\n⚠ This runs against PRODUCTION. A failure here is live for real visitors now."
);
process.exit(1);
