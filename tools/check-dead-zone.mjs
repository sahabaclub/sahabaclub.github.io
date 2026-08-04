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
// Every file whose whole body is an IIFE, and whether this run actually managed
// to scan inside it. See the block at the bottom for why that is tracked
// separately rather than trusted.
const iifes = [];

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

  // ---- inside a top-level IIFE ----
  //
  // A file whose entire body is `(function () { ... })()` passed the check
  // above VACUOUSLY: its only column-0 statement is the IIFE opener, and every
  // declaration it contains is indented, so the loop above can never find one.
  // That is the silent pass this file exists to stop, one level down —
  // `hackathons-ui.js` is exactly that shape, and its config objects, its
  // module bindings and everything that reads them all live inside the IIFE
  // where nothing was looking.
  //
  // The same flat rule is applied to the IIFE's own body: every `const`/`let`
  // at the body's indentation must be declared before the first statement at
  // that indentation that RUNS. `var` is not flagged and that is not laziness —
  // `var` is hoisted AND initialised to undefined, so it has no temporal dead
  // zone. `const` and `let` are the two that throw.
  //
  // A declaration whose initialiser contains a call counts as running, because
  // it does: `var mount = document.getElementById(...)` is the line after which
  // a `const` is unsafe, not the first bare statement below it.
  if (/^[(!+~]\s*(async\s+)?(function\b|\()/.test(lines[firstRun])) {
    const iife = { rel, scanned: false, bodyRun: -1, why: "" };
    iifes.push(iife);
    let indent = null;
    for (let i = firstRun + 1; i < lines.length && indent === null; i++) {
      const L = lines[i];
      if (/^\s*$/.test(L)) continue;
      if (/^\s*(\/\/|\/\*|\*)/.test(L)) continue;
      const m = L.match(/^(\s+)\S/);
      if (m) indent = m[1];
    }
    if (indent !== null) {
      const at = (L) => L.startsWith(indent) && !/^\s/.test(L.slice(indent.length));
      let bodyRun = -1;
      for (let i = firstRun + 1; i < lines.length; i++) {
        const L = lines[i];
        if (!at(L)) continue;
        const body = L.slice(indent.length);
        if (/^(\/\/|\/\*|\*|\})/.test(body)) continue;
        if (/^["']use strict["'];?$/.test(body)) continue;          // a directive, not a statement
        const decl = body.match(/^(?:var|const|let)\s+[A-Za-z_$][\w$]*\s*=\s*(.*)$/);
        if (decl) {
          // A literal initialiser runs nothing; a call in it does.
          if (/[A-Za-z_$\])]\s*\(/.test(decl[1])) { bodyRun = i; break; }
          continue;
        }
        if (/^(var|const|let|function|async function|class)\b/.test(body)) continue;
        bodyRun = i;
        break;
      }
      if (bodyRun !== -1) {
        for (let i = bodyRun + 1; i < lines.length; i++) {
          const L = lines[i];
          if (!at(L)) continue;
          const m = L.slice(indent.length).match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
          if (m) late.push({ line: i + 1, name: m[1], scope: "IIFE body" });
        }
        iife.scanned = true;
        iife.bodyRun = bodyRun + 1;
        console.log(`    ${rel} — IIFE body runs at line ${bodyRun + 1}, ` +
          `${late.filter((c) => c.scope).length} const/let after it`);
      } else {
        iife.why = "no executing statement was found at the body's indentation";
      }
    } else {
      iife.why = "the body's indentation could not be determined";
    }
  }

  if (late.length) {
    failures += late.length;
    console.error(`\n✗ ${rel}`);
    console.error(`  executes at line ${firstRun + 1}: ${lines[firstRun].trim().slice(0, 70)}`);
    console.error(`  ${late.length} binding(s) declared after that point:`);
    for (const c of late) console.error(`    line ${c.line}: ${c.name}${c.scope ? ` (${c.scope})` : ""}`);
    console.error(`  Move them above the first statement that runs.`);
  } else {
    console.log(`ok  ${rel} — executes at line ${firstRun + 1}, all bindings declared before it`);
  }
}

// ---- an IIFE whose body was never scanned is a SILENT PASS ----
//
// The gap this closes is the same one the block above was written for, one
// level further in. Finding the IIFE opener is not the same as scanning inside
// it: if `indent` cannot be worked out, or if no statement at the body's
// indentation is recognised as executing, the inner loop simply does not run.
// The file then prints `ok  <file> — executes at line N, all bindings declared
// before it`, which is the message a genuinely clean file prints. Nothing says
// the inside was never looked at.
//
// That matters most for the file this repository actually edits: hackathons-ui.js
// is one long IIFE, and its config objects, its DOM bindings, its renderers and
// the listeners that run at load all live in that body. A restructuring that
// moved its first executing statement — a mount lookup becoming a plain
// declaration, say, or the `"use strict"` directive picking up different
// indentation — would take the whole body out of this check without changing a
// single line of the output.
//
// So it is now an error, not a shrug. If a file is an IIFE, this run must have
// scanned its body.
const unscanned = iifes.filter((f) => !f.scanned);
if (iifes.length) {
  console.log(`\ntop-level IIFEs — the body of each must be scanned, not just its opener:`);
  for (const f of iifes) {
    console.log(f.scanned
      ? `  ok  ${f.rel} — body scanned from line ${f.bodyRun}`
      : `  ✗   ${f.rel} — BODY NOT SCANNED: ${f.why}`);
  }
}
if (unscanned.length) {
  failures += unscanned.length;
  console.error(`\n✗ ${unscanned.length} IIFE body/bodies were never examined.`);
  console.error(`  This prints as a pass and is not one — the inside of the file was skipped.`);
  console.error(`  Fix the scanner, or the indentation that defeated it, before trusting this run.`);
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
