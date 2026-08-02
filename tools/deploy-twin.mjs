#!/usr/bin/env node
// deploy-twin.mjs
// ------------------------------------------------------------
// Three Edge Functions ship a second copy of themselves — `index.deploy.ts` —
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
//   1. A four-line "GENERATED - do not edit" banner, then a blank line,
//      prepended.
//   2. Every `… from "../_shared/X.ts";` import statement — however many lines
//      it spans — replaced by
//
//          // ---- inlined from ../_shared/X.ts ----
//
//      followed by that file, minus its own header comment, with `export `
//      stripped off the front of its declarations. The twin is one file; there
//      is nothing left for it to export to.
//   3. Nothing else. Line endings are taken from `index.ts` (these files are
//      CRLF) so a regeneration shows up as the lines that actually changed
//      rather than as the whole file.
//
// The `build-prospect-profile` twin in git was written by hand before this
// script existed, and `write` reproduces it byte for byte. That is the test
// that the rule above is the rule that was really being followed, rather than
// a tidier one invented afterwards.
//
// Adding a fourth function to the list is the whole of the work of putting it
// under the same check: the transformation reads the imports out of index.ts.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// The banner is prose, so it is written here rather than assembled from the
// import list — and two of the three functions inline the same one file, so
// they say so in the same words.
const CORS_ONLY = `// GENERATED - do not edit. Deploy-time twin of index.ts with the ../_shared/cors.ts
// import replaced by the corsHeaders object inline, and nothing else. The Supabase
// dashboard editor deploys one function directory at a time and cannot reach a
// shared parent file. Edit index.ts and regenerate; the two must stay in step.`;

const TWINS = [
  { fn: "build-prospect-profile", banner: CORS_ONLY },
  { fn: "parse-profile-document", banner: CORS_ONLY },
  {
    fn: "generate-avatar",
    banner: `// GENERATED - do not edit. Deploy-time twin of index.ts with the ../_shared/cors.ts
// and ../_shared/avatar-art.ts imports replaced by those files inline, and nothing
// else. The Supabase dashboard editor deploys one function directory at a time and
// cannot reach a shared parent file. Edit index.ts and regenerate; keep them in step.`,
  },
];

const USAGE = `
deploy-twin — generate and check the index.deploy.ts twins

  node tools/deploy-twin.mjs write     regenerate every twin from its index.ts
  node tools/deploy-twin.mjs verify    exit 1 if a twin is not what write would produce

Covers: ${TWINS.map((t) => t.fn).join(", ")}
`;

const mode = process.argv[2];
if (mode !== "write" && mode !== "verify") {
  console.error(USAGE);
  process.exit(2);
}

let stale = 0;
let written = 0;

for (const twin of TWINS) {
  const dir = resolve(ROOT, "supabase/functions", twin.fn);
  const twinPath = resolve(dir, "index.deploy.ts");
  const want = Buffer.from(generate(dir, twin.banner), "utf8");
  const have = readIfPresent(twinPath);

  if (have && have.equals(want)) {
    console.log(`ok       ${rel(twinPath)}`);
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

if (mode === "verify" && stale) {
  console.error(`\n${stale} twin${stale === 1 ? "" : "s"} out of date. Run: node tools/deploy-twin.mjs write\n`);
  process.exit(1);
}

if (mode === "write" && !written) console.log("\nEvery twin was already up to date.");

// ============================================================
// The transformation
// ============================================================

function generate(dir, banner) {
  const src = readFileSync(resolve(dir, "index.ts"), "utf8");
  const eol = src.includes("\r\n") ? "\r\n" : "\n";

  // Split on /\r?\n/ rather than on the ending just detected, so that a file
  // which has picked up a stray LF is rejoined with one consistent ending
  // instead of carrying the stray through into the twin.
  const lines = src.split(/\r?\n/);
  const out = banner.split(/\r?\n/);
  out.push("");

  let inlined = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!/^import[\s{]/.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }

    // An import statement is however many lines it takes to reach the
    // semicolon: generate-avatar's avatar-art import spans eleven of them.
    const start = i;
    while (i < lines.length - 1 && !/;\s*$/.test(lines[i])) i++;

    const statement = lines.slice(start, i + 1).join(" ");
    const shared = statement.match(/from\s+"(\.\.\/_shared\/[^"]+)";\s*$/);
    if (!shared) {
      out.push(...lines.slice(start, i + 1));
      continue;
    }

    out.push(`// ---- inlined from ${shared[1]} ----`, ...inline(resolve(dir, shared[1])));
    inlined++;
  }

  // A twin with nothing inlined is a plain copy of index.ts, which would pass
  // verify for ever while meaning that the import this script exists to
  // replace has been renamed out from under it.
  if (!inlined) {
    throw new Error(`${rel(dir)}/index.ts has no "../_shared/…" import — refusing to generate a twin that is only a copy`);
  }

  return out.join(eol);
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

  // Same lines, different bytes: the endings changed and nothing else did.
  return "same lines, different line endings";
}

function rel(path) {
  return path.slice(ROOT.length + 1).replace(/\\/g, "/");
}
