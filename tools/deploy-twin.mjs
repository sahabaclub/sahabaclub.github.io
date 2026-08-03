#!/usr/bin/env node
// deploy-twin.mjs
// ------------------------------------------------------------
// Most Edge Functions ship a second copy of themselves — `index.deploy.ts` —
// for whoever is deploying from the Supabase dashboard editor rather than the
// CLI. The editor uploads one function directory at a time and cannot reach
// `../_shared/`, so the twin is `index.ts` with those imports replaced by the
// shared files themselves.
//
//   node tools/deploy-twin.mjs write     # regenerate every twin from index.ts
//   node tools/deploy-twin.mjs verify    # exit 1 if any twin is out of date
//
// The twins were maintained by hand, with SETUP.md asking that they be kept in
// sync. Nothing checked, and a stale twin does not fail to deploy — it deploys
// the previous version of the function, silently, which is the failure mode
// worth spending a script on. `verify` is the check that was missing.
//
// No dependencies and no package.json: this repo has neither, and the job is
// reading a handful of files and writing a handful. Needs Node 18 or newer.
//
// ============================================================
// The transformation, in full
// ============================================================
//
//   1. Every `… from "../_shared/X.ts";` import statement — however many lines
//      it spans — replaced by
//
//          // ---- inlined from ../_shared/X.ts ----
//
//      followed by that file, minus its own header comment, with `export `
//      stripped off the front of its declarations. The twin is one file; there
//      is nothing left for it to export to.
//   2. A four-line "GENERATED - do not edit" banner, then a blank line,
//      prepended. The banner names the imports that step 1 actually replaced,
//      so it is written last, from the list step 1 collected — see `bannerFor`.
//   3. Nothing else.
//
// The `build-prospect-profile` twin in git was written by hand before this
// script existed, and `write` reproduces it line for line. That is the test
// that the rule above is the rule that was really being followed, rather than
// a tidier one invented afterwards.
//
// ============================================================
// Which twins are covered
// ============================================================
//
// All of them, found by looking: any `supabase/functions/*/` holding an
// `index.deploy.ts` is generated and checked. This used to be a hard-coded
// list of three, which is why six functions had grown twins that nothing
// verified. A list that has to be edited to cover a new function is a list
// that will be out of date the first time someone forgets, and the thing it
// fails at is the thing the script is for. `LEGACY` below is the one list
// still written by hand, and it is a list of exclusions, so forgetting to
// edit it adds coverage rather than losing it.
//
// ============================================================
// Line endings
// ============================================================
//
// Compared by line, not by byte. Every one of these files is stored in git
// with LF endings, but this repo is checked out with `core.autocrlf=true`, so
// what lands on disk is CRLF for whatever git converted at checkout and LF for
// whatever a tool wrote in place afterwards — a per-machine, per-file mix that
// says nothing about whether the twin is current. `build-prospect-profile`'s
// twin, for one, sits on disk as 1535 CRLF endings and 6 lone LFs.
//
// A byte-exact check would fail on that, and `write` would "fix" it by
// rewriting a file whose content was already correct — into a commit git then
// normalises straight back to LF, so the next machine sees the same failure.
// A check that reports staleness depending on who checked the repo out is
// worse than no check: people learn to run `write` to silence it, and a real
// staleness gets rewritten along with the noise, unread.
//
// So: differing endings are reported, and are not staleness. `write` leaves a
// file alone when only its endings differ, and uses index.ts's endings for the
// files it does rewrite.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const FUNCTIONS = resolve(ROOT, "supabase/functions");

// `provision-ms365` and `send-transactional-email` carry an older, differently
// worded banner and an older layout: no blank line under the banner, cors.ts
// inlined without a `// ---- inlined from … ----` marker above it, and — in
// send-transactional-email — the corsHeaders object folded onto a single line.
// Generating them would rewrite two twins wholesale, which is a change to what
// gets deployed and not something a script that claims to only check things
// should do on its own. They are listed here so that `verify` can say out loud
// that they are unchecked, rather than leaving them out silently.
const LEGACY = new Set(["provision-ms365", "send-transactional-email"]);

// Nine of the ten twins name their inlined imports in one substituted list.
// `build-prospect-profile` inlines cors.ts alone and says so in prose that
// reads better than a one-item list would; it is the only twin that does, and
// this is the wording it has always had.
const CORS_ONLY = `// GENERATED - do not edit. Deploy-time twin of index.ts with the ../_shared/cors.ts
// import replaced by the corsHeaders object inline, and nothing else. The Supabase
// dashboard editor deploys one function directory at a time and cannot reach a
// shared parent file. Edit index.ts and regenerate; the two must stay in step.`;

// The first line runs long and is deliberately not wrapped: the import list is
// substituted into it, so where it would wrap depends on the function, and the
// committed twins all leave it on one line rather than rewrap per function.
function bannerFor(imports) {
  if (imports.length === 1 && imports[0] === "../_shared/cors.ts") return CORS_ONLY;

  return [
    `// GENERATED - do not edit. Deploy-time twin of index.ts with the ${imports.join(", ")} imports replaced by those files inline, and`,
    "// nothing else. The Supabase dashboard editor deploys one function directory at a",
    "// time and cannot reach a shared parent file. Edit index.ts and regenerate; the",
    "// two must stay in step.",
  ].join("\n");
}

function discover() {
  return readdirSync(FUNCTIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((fn) => existsSync(resolve(FUNCTIONS, fn, "index.deploy.ts")))
    .sort();
}

const ALL = discover();
const TWINS = ALL.filter((fn) => !LEGACY.has(fn));
const SKIPPED = ALL.filter((fn) => LEGACY.has(fn));

const USAGE = `
deploy-twin — generate and check the index.deploy.ts twins

  node tools/deploy-twin.mjs write     regenerate every twin from its index.ts
  node tools/deploy-twin.mjs verify    exit 1 if a twin is not what write would produce

Covers every supabase/functions/*/index.deploy.ts (${TWINS.length}), except the
hand-maintained ${SKIPPED.join(" and ")}.
`;

const mode = process.argv[2];
if (mode !== "write" && mode !== "verify") {
  console.error(USAGE);
  process.exit(2);
}

let stale = 0;
let written = 0;
let rewrapped = 0;

for (const fn of TWINS) {
  const dir = resolve(FUNCTIONS, fn);
  const twinPath = resolve(dir, "index.deploy.ts");
  const want = Buffer.from(generate(dir), "utf8");
  const have = readIfPresent(twinPath);

  if (have && sameLines(have, want)) {
    // Content is current. Endings may still differ; say so and move on.
    const note = have.equals(want) ? "" : "   (differing line endings, content is current)";
    if (note) rewrapped++;
    console.log(`ok       ${rel(twinPath)}${note}`);
    continue;
  }

  if (mode === "verify") {
    stale++;
    console.log(`STALE    ${rel(twinPath)} — ${have ? firstDifference(have, want) : "missing"}`);
    continue;
  }

  writeFileSync(twinPath, want);
  written++;
  console.log(`written  ${rel(twinPath)}`);
}

for (const fn of SKIPPED) {
  console.log(`skipped  ${rel(resolve(FUNCTIONS, fn, "index.deploy.ts"))} — hand-maintained, older banner and layout`);
}

if (mode === "verify" && stale) {
  console.error(`\n${stale} twin${stale === 1 ? "" : "s"} out of date. Run: node tools/deploy-twin.mjs write\n`);
  process.exit(1);
}

if (mode === "verify") console.log(`\n${TWINS.length} twins up to date, ${SKIPPED.length} not checked.`);
if (mode === "write" && !written) console.log(`\nEvery twin was already up to date.`);
if (mode === "write" && rewrapped) {
  console.log(`${rewrapped} left as ${rewrapped === 1 ? "it is" : "they are"}: line endings differ, content does not.`);
}

// ============================================================
// The transformation
// ============================================================

function generate(dir) {
  const src = readFileSync(resolve(dir, "index.ts"), "utf8");
  const eol = src.includes("\r\n") ? "\r\n" : "\n";

  // Split on /\r?\n/ rather than on the ending just detected, so that a file
  // which has picked up a stray LF is rejoined with one consistent ending
  // instead of carrying the stray through into the twin.
  const lines = src.split(/\r?\n/);
  const body = [];
  const imports = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/^import[\s{]/.test(lines[i])) {
      body.push(lines[i]);
      continue;
    }

    // An import statement is however many lines it takes to reach the
    // semicolon: generate-avatar's avatar-art import spans eleven of them.
    const start = i;
    while (i < lines.length - 1 && !/;\s*$/.test(lines[i])) i++;

    const statement = lines.slice(start, i + 1).join(" ");
    const shared = statement.match(/from\s+"(\.\.\/_shared\/[^"]+)";\s*$/);
    if (!shared) {
      body.push(...lines.slice(start, i + 1));
      continue;
    }

    body.push(`// ---- inlined from ${shared[1]} ----`, ...inline(resolve(dir, shared[1])));
    imports.push(shared[1]);
  }

  // A twin with nothing inlined is a plain copy of index.ts, which would pass
  // verify for ever while meaning that the import this script exists to
  // replace has been renamed out from under it.
  if (!imports.length) {
    throw new Error(`${rel(dir)}/index.ts has no "../_shared/…" import — refusing to generate a twin that is only a copy`);
  }

  return [...bannerFor(imports).split(/\r?\n/), "", ...body].join(eol);
}

function inline(path) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);

  // Drop the shared file's own header comment. It explains why the file is
  // shared between two functions, which is not something a reader of a
  // single-file twin can do anything with; the marker line above says where
  // the code came from.
  let i = 0;
  while (i < lines.length && lines[i].startsWith("//")) i++;
  while (i < lines.length && lines[i].trim() === "") i++;

  const body = lines.slice(i);
  while (body.length && body[body.length - 1].trim() === "") body.pop();

  return body.map((line) => line.replace(/^export /, ""));
}

// ============================================================
// Reporting
// ============================================================

function readIfPresent(path) {
  try {
    return readFileSync(path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// The comparison the whole check rests on: same lines, whatever ended them.
// See the "Line endings" note in the header for why that is the right test.
function sameLines(have, want) {
  const a = have.toString("utf8").split(/\r?\n/);
  const b = want.toString("utf8").split(/\r?\n/);
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

// Line numbers, not byte offsets: the point of the message is to be pasteable
// into an editor.
function firstDifference(have, want) {
  const a = have.toString("utf8").split(/\r?\n/);
  const b = want.toString("utf8").split(/\r?\n/);

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === undefined || b[i] === undefined) {
      return `${a.length} lines on disk, ${b.length} generated; they diverge at line ${i + 1}`;
    }
    return `first differs at line ${i + 1}`;
  }

  return "no difference"; // unreachable: sameLines would have caught it
}

function rel(path) {
  return path.slice(ROOT.length + 1).replace(/\\/g, "/");
}
