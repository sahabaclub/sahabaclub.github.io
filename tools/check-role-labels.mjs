// Catch role comparisons in client code that know `admin` but not `global_admin`.
//
//   node tools/check-role-labels.mjs
//
// ============================================================================
// Why this exists
// ============================================================================
//
// 0053/0054 added the `global_admin` label and 0054 relabelled Ahmed's profile.
// `lib/admin-guard.js` was updated. Three other role comparisons were not:
//
//   script.js               the Admin link in the PUBLIC site menu
//   app/dashboard.html      the Newsletter tool on the member dashboard
//   app/admin/promptarena-admin.js   staff-account flagging, three copies
//
// The result: /app/admin worked perfectly, so the change looked complete, while
// the Admin link vanished from the public menu for the only person who has it.
// Ahmed found it, not us. A rename is never one edit, and "the obvious file
// works" is not evidence that the rest do.
//
// ============================================================================
// What it flags, and what it deliberately does not
// ============================================================================
//
// FLAGS: a string comparison against "admin" (=== or !==, either quote style)
// on a line that does not also mention `global_admin`.
//
// ⚠ THE FIRST VERSION OF THIS FILE SKIPPED `supabase/functions/**`, on the
// reasoning that "server code reads roles from the database and is not part of
// this class of bug". That was wrong, and wrong in the most expensive way: it
// was written down as a justification, so it read like a decision rather than
// an assumption. Eleven Edge Functions hardcode the same literals, and every
// one of them refused the global admin — including import-event, which is how
// Ahmed found it ("Adding new event from link is failing!"). An exclusion is
// only as good as the claim behind it, and this one was never tested.
//
// DOES NOT FLAG:
//   - `supabase/migrations/**` — SQL, where 'admin' is data, not a comparison.
//   - anything inside a // or /* */ comment, including the notes above.
//   - `.claude/worktrees/**` and `node_modules/**`.
//
// ⚠ This is a lint, not a proof. It cannot see a role name built at runtime, or
// held in a variable, or compared inside a template. It catches the shape that
// actually bit us. The real check is signing in as each role and looking.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
// `migrations` is SQL — 'admin' there is data, not a comparison. `functions`
// is deliberately NOT skipped; see the note above about why it once was.
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", "migrations", "seed"]);
const EXTS = [".js", ".html", ".mjs", ".ts"];

// The label that must accompany "admin" wherever it is compared.
const PARTNER = "global_admin";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

// Strip // line comments and /* */ blocks so the explanatory prose in this
// repo — which mentions `=== "admin"` a lot — does not trip the check.
function stripComments(src) {
  let out = "";
  let i = 0;
  let inBlock = false;
  let inLine = false;
  let inStr = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; } else { out += " "; }
      i++; continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") { inBlock = false; out += "  "; i += 2; continue; }
      out += c === "\n" ? c : " ";
      i++; continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
      if (c === inStr) inStr = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; out += c; i++; continue; }
    if (c === "/" && n === "/") { inLine = true; out += "  "; i += 2; continue; }
    if (c === "/" && n === "*") { inBlock = true; out += "  "; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}

// A comparison against the literal "admin" — not "global_admin", which the
// closing quote in the pattern excludes.
//
// ⚠ One operand must be named `role`. Without that this fires on
// `tools/rebuild-nav.mjs`, where `item.gate === "admin"` names a NAV GATE, not
// a database role — a true positive by shape and a false one by meaning. The
// first run of this checker produced exactly that, alongside its own
// self-test strings.
const CMP =
  /\b[\w.]*\brole\s*[=!]==?\s*(["'])admin\1|(["'])admin\2\s*[=!]==?\s*[\w.]*\brole\b/;

// Files whose self-tests contain the very strings this looks for.
//
// ⚠ A CHECKER'S FIXTURES ARE NOT LIVE CODE. Every checker in this project is
// required to prove it can fail, which means each one carries deliberately
// broken sample code — and a broken role comparison is exactly what this file
// hunts for. It has always skipped itself for that reason; on 10 Aug 2026
// `check-function-gates.mjs` arrived with fixtures of its own and this file
// reported two "failures" in them, which are the other checker working.
//
// ⚠ The list is FILES, not a blanket skip of `tools/`. A tool that genuinely
// gated on a role name would be a real finding and must still be caught —
// `rebuild-nav.mjs` is already handled separately, as a nav gate rather than a
// database role. Add a file here only when its matches are fixtures, and say
// so in the commit.
const FIXTURE_FILES = new Set([
  "tools/check-role-labels.mjs",
  "tools/check-function-gates.mjs",
]);

// A condition can span lines:
//
//     res.data.role === "admin" ||
//     res.data.role === "global_admin" ||
//
// so `global_admin` may sit two lines from the comparison that needs it.
// Judging a line in isolation reported script.js as broken immediately after
// it had been fixed. Look at a small window instead.
const WINDOW = 3;

function findings() {
  const hits = [];
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).split(sep).join("/");
    if (FIXTURE_FILES.has(rel)) continue;
    const lines = stripComments(readFileSync(file, "utf8")).split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (!CMP.test(line)) return;
      const near = lines
        .slice(Math.max(0, idx - WINDOW), idx + WINDOW + 1)
        .join("\n");
      if (near.includes(PARTNER)) return;
      hits.push({ file: rel, line: idx + 1, text: line.trim().slice(0, 100) });
    });
  }
  return hits;
}

// ---- self-tests -----------------------------------------------------------
// Both directions. A checker that passes everything passes its negative control
// too — the badge-contrast checker in this repo shipped broken for exactly that
// reason, so a POSITIVE control is not optional.
function selfTest() {
  const shouldFlag = [
    'if (p.role === "admin") {',
    "if (p.role === 'admin' || x) {",
    'if (data.role !== "admin") {',
    'if ("admin" === role) {',
  ];
  const shouldNotFlag = [
    'if (p.role === "admin" || p.role === "global_admin") {',
    'if (p.role === "global_admin") {',
    'const label = "admin";',
    'if (p.role === "staff") {',
    // A nav-gate name, not a database role. tools/rebuild-nav.mjs.
    'if (item.gate === "admin") cls.push("admin-hidden");',
  ];
  let ok = true;
  for (const s of shouldFlag) {
    if (!(CMP.test(s) && !s.includes(PARTNER))) {
      console.log("  SELF-TEST FAIL (should flag):", s);
      ok = false;
    }
  }
  for (const s of shouldNotFlag) {
    if (CMP.test(s) && !s.includes(PARTNER)) {
      console.log("  SELF-TEST FAIL (should NOT flag):", s);
      ok = false;
    }
  }
  // The comment stripper must actually strip, or every explanatory note in
  // this repo becomes a false positive.
  const stripped = stripComments('// if (r === "admin") {\nlet a = 1;');
  if (CMP.test(stripped)) {
    console.log("  SELF-TEST FAIL: comment stripper let a commented comparison through");
    ok = false;
  }
  return ok;
}

if (!selfTest()) {
  console.log("\nself-tests failed — the checker itself is wrong, fix it before trusting a pass");
  process.exit(2);
}
console.log("ok   control: a bare === \"admin\" IS detected");
console.log("ok   control: \"admin\" alongside global_admin is NOT flagged");
console.log("ok   control: a commented-out comparison is NOT flagged");

const hits = findings();
if (!hits.length) {
  console.log("\nno role comparisons missing `global_admin`.");
  process.exit(0);
}
console.log("\n" + hits.length + " role comparison(s) know `admin` but not `global_admin`:\n");
for (const h of hits) console.log("  " + h.file + ":" + h.line + "\n    " + h.text);
console.log("\nEach of these treats a global admin as a non-admin.");
process.exit(1);
