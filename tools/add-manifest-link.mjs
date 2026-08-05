// Add <link rel="manifest"> to every page.
//
// Why it has to be in the HTML rather than injected by script.js: iOS reads
// the manifest when the member taps Share - Add to Home Screen, and web push
// on iPhone works ONLY from a home-screen install. A manifest that arrives
// after page load is not reliably picked up, so the one platform that most
// needs this is the one platform a JavaScript shortcut would fail on.
//
// ============================================================
// The rules this script follows, and why each one exists
// ============================================================
//
// 1. MATCH ON WHAT THE ELEMENT IS, and insert relative to it. The anchor is
//    `<link rel="icon"`, which every page has exactly once. An earlier sweep
//    in this repo (tools/rebuild-nav.mjs) matched on an href and deleted the
//    signed-in identity chip from two pages, because that chip and a menu item
//    pointed at the same place.
//
// 2. COUNT THE MARKERS THAT MUST NOT MOVE, before and after, and refuse to
//    write if any of them changed. Here: the number of <link> tags must go up
//    by exactly one, and the number of <script> and <title> tags must not
//    change at all.
//
// 3. TAKE THE LINE ENDING FROM THE FILE. This clone is MIXED - settings.html
//    is LF while dashboard.html is CRLF, in the same tree. A hard-coded "\n"
//    matches nothing in a CRLF file and reports a tidy "0 replacements"
//    rather than an error. That has cost this project four consecutive runs
//    of another script.
//
// 4. IDEMPOTENT. A page that already has a manifest link is skipped, so
//    re-running is safe.
//
// 5. NAME WHAT IT SKIPPED. A checker or a rewriter that silently passes over
//    a file is worse than one that fails - a clean run must mean "I looked at
//    all of them", not "I found nothing to look at".
//
// Run:  node tools/add-manifest-link.mjs           (dry run, shows the plan)
//       node tools/add-manifest-link.mjs --write   (actually writes)

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const WRITE = process.argv.includes("--write");

const LINK = '<link rel="manifest" href="/manifest.webmanifest">';
const ANCHOR = /^(\s*)<link rel="icon"[^>]*>\s*$/m;

// Root-absolute href on purpose: pages live at three different depths
// (/index.html, /app/*.html, /app/admin/*.html) and a relative manifest path
// would need to differ per depth, which is one more thing to get wrong.

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    // node_modules and .git have no pages and scanning them is a waste; the
    // worktrees under .claude/ are stale copies and editing them would be
    // actively wrong.
    if (name === "node_modules" || name === ".git" || name === ".claude") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...htmlFiles(full));
    else if (name.endsWith(".html")) out.push(full);
  }
  return out;
}

const files = htmlFiles(root).sort();
const added = [];
const already = [];
const skipped = [];

for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, "/");
  const src = readFileSync(file, "utf8");

  if (src.includes('rel="manifest"')) {
    already.push(rel);
    continue;
  }

  const anchor = ANCHOR.exec(src);
  if (!anchor) {
    skipped.push(`${rel} — no <link rel="icon"> to anchor to`);
    continue;
  }

  // Rule 3: read the ending from THIS file, never assume.
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const indent = anchor[1].replace(/[\r\n]/g, "");

  // Rule 2: the markers that must not move.
  const before = {
    link: (src.match(/<link\b/g) || []).length,
    script: (src.match(/<script\b/g) || []).length,
    title: (src.match(/<title\b/g) || []).length,
  };

  const out = src.replace(ANCHOR, (m) => m.replace(/\s*$/, "") + eol + indent + LINK);

  const after = {
    link: (out.match(/<link\b/g) || []).length,
    script: (out.match(/<script\b/g) || []).length,
    title: (out.match(/<title\b/g) || []).length,
  };

  if (after.link !== before.link + 1 || after.script !== before.script || after.title !== before.title) {
    skipped.push(
      `${rel} — REFUSED: markers moved (link ${before.link}->${after.link}, ` +
        `script ${before.script}->${after.script}, title ${before.title}->${after.title})`
    );
    continue;
  }

  // Rule 3 again: verify by RE-READING rather than trusting the counter. A
  // replace that reports success and wrote nothing is this project's most
  // repeated silent failure.
  if (WRITE) {
    writeFileSync(file, out, "utf8");
    const check = readFileSync(file, "utf8");
    if (!check.includes('rel="manifest"')) {
      console.error(`FAILED to persist ${rel} — stopping.`);
      process.exit(1);
    }
  }
  added.push(rel);
}

console.log(WRITE ? "WROTE:" : "WOULD ADD (dry run):");
added.forEach((f) => console.log("  + " + f));
if (already.length) {
  console.log("\nalready had one:");
  already.forEach((f) => console.log("  = " + f));
}
// Rule 5: never silent about what was passed over.
if (skipped.length) {
  console.log("\nSKIPPED — read these, do not assume they did not matter:");
  skipped.forEach((f) => console.log("  ! " + f));
}

console.log(
  `\n${added.length} added, ${already.length} already present, ${skipped.length} skipped, ` +
    `${files.length} html files examined`
);
if (!WRITE) console.log("\nDry run. Re-run with --write to apply.");
process.exit(skipped.some((s) => s.includes("REFUSED")) ? 1 : 0);
