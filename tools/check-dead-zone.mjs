#!/usr/bin/env node
// Sahaba Club — catch the temporal-dead-zone bug that empties a page
// ============================================================================
//
// Why this exists. On 3 Aug 2026 the Data panel shipped with `loadDataset()`
// awaited at module top level and `const ROW_LIMIT` declared further down the
// file. `const` is not hoisted the way `function` is, so the call ran while the
// binding was still in its temporal dead zone and threw before a single request
// left the browser. The page showed placeholders, no data, and no failed
// request to point at — so it read as "the database is empty" rather than "the
// script died on its first line". Two hours went into the database looking for
// a cause that was in the JavaScript.
//
// It then happened a SECOND time, in the commit that fixed the first: the new
// `PAGE_ROWS` constant was declared in the same bad position. And a third
// instance was found sitting in `ai-admin.js`, where `MONTHS` would have thrown
// mid-render because top-level `await` SUSPENDS module evaluation — every
// `const` below the await is unavailable for as long as the awaited work runs.
//
// `node --check` cannot catch any of this. It is a runtime error, not a syntax
// error, so the file parses perfectly and fails the moment it is loaded.
//
// The rule enforced here is deliberately flat, with no judgement calls:
//
//     In a module that executes anything at top level, every module-level
//     `const`/`let` must be declared BEFORE the first executing statement.
//
// "Is this particular one actually reachable?" is exactly the question that was
// answered wrongly twice in one afternoon, so it is not asked. Hoisting a
// constant is free; getting the answer wrong empties a page.
//
// Usage:  node tools/check-dead-zone.mjs        (exit 1 if anything is wrong)

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");

// Every browser module that runs something when it loads. A module that only
// exports functions cannot have this bug.
const DIRS = ["app/admin", "lib", "."];
const SKIP = new Set(["events-data.js"]);

function jsFilesIn(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter((f) => f.endsWith(".js") && !SKIP.has(f))
    .map((f) => path.join(dir, f).replace(/\\/g, "/"));
}

const files = [...new Set(DIRS.flatMap(jsFilesIn))];
let failures = 0;
let checked = 0;
const skipped = [];

for (const rel of files) {
  const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split(/\r?\n/);

  // The first statement at column 0 that RUNS rather than declares.
  let firstRun = -1;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/^\s*$/.test(L)) continue;
    if (/^(\/\/|\/\*|\s|\*)/.test(L)) continue;
    if (/^(const|let|var|function|async function|class|import|export|\})/.test(L)) continue;
    // `(function () {` and `(async () => {` are execution too. This line was
    // missing, so `hackathons-ui.js` — an IIFE — was skipped in SILENCE and
    // reported nothing, which reads exactly like a pass. That is worse than
    // having no check: the whole point of this file is that the bug it hunts
    // is invisible until the page is opened.
    if (/^[(!+~]\s*(async\s+)?(function\b|\()/.test(L)) { firstRun = i; break; }
    if (/^(await\s|if\s*\(|[A-Za-z_$][\w$]*\s*\()/.test(L)) { firstRun = i; break; }
  }
  if (firstRun === -1) { skipped.push(rel); continue; }
  checked++;

  const late = [];
  for (let i = firstRun + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m) late.push({ line: i + 1, name: m[1] });
  }

  if (late.length) {
    failures += late.length;
    console.error(`\n✗ ${rel}`);
    console.error(`  executes at line ${firstRun + 1}: ${lines[firstRun].trim().slice(0, 70)}`);
    console.error(`  ${late.length} module binding(s) declared after that point:`);
    for (const c of late) console.error(`    line ${c.line}: ${c.name}`);
    console.error(`  Move them above line ${firstRun + 1}.`);
  } else {
    console.log(`ok  ${rel} — executes at line ${firstRun + 1}, all bindings declared before it`);
  }
}

// Name what was NOT checked. A silent skip is indistinguishable from a pass,
// which is how an IIFE slipped through this check unexamined while the run
// still printed a clean bill of health.
if (skipped.length) {
  console.log(`\nnot checked — nothing runs at load (cannot have this bug):`);
  for (const s of skipped) console.log(`  ${s}`);
}
console.log(`\n${checked} module(s) with top-level execution checked, ${skipped.length} skipped.`);
if (failures) {
  console.error(`${failures} binding(s) in the dead zone. This throws at load; --check will not see it.`);
  process.exit(1);
}
console.log("No temporal dead zone found.");
