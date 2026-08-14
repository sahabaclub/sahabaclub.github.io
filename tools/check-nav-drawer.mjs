// check-nav-drawer.mjs
// ------------------------------------------------------------
//   node tools/check-nav-drawer.mjs
//
// Every page that shows a hamburger must have a drawer the PARSER can see.
//
// ⚠ THIS EXISTS BECAUSE THE DRAWER SHIPPED INSIDE AN HTML COMMENT ON THREE
// PAGES — connect.html, member.html and promptarena.html — and stayed there for
// weeks. Ahmed reported it as "the menu not working" on Connect.
//
// The cause is worth knowing, because it defeats the obvious check.
// `apply-drawer.mjs` inserted the drawer at the first `</header>` in the file.
// Those three pages carry a head comment explaining the header-identity script
// placement, and its prose contains the words "</header>". String.replace takes
// the FIRST match — the one in the comment.
//
// What made it survive:
//   * the markup IS in the file, so every grep finds it;
//   * the markup IS in the served HTML, so curl finds it;
//   * the parser discards it, so the DOM does not have it;
//   * apply-drawer's own `already has a drawer?` guard saw the commented copy
//     and declined to add a real one — so re-running the tool could not repair
//     it either.
//
// So this checker compares against the page WITH COMMENTS STRIPPED. That is the
// only view that matches what a browser builds.
//
// Static: reads the .html files. No database, no key, no browser.
//
// ⚠ Self-tests at the end, per this project's rule that a checker never seen to
// fail is a checker nobody should trust.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (/^(node_modules|\.git|\.claude)$/.test(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

// What the browser keeps. Everything in this file is judged on this, not on the
// raw text — see the header.
const live = (html) => html.replace(/<!--[\s\S]*?-->/g, "");

function loadPages() {
  return walk(root)
    .map((p) => ({ rel: relative(root, p).replace(/\\/g, "/"), raw: readFileSync(p, "utf8") }))
    .filter((p) => /<body/i.test(p.raw));
}

function run(pages, report) {
  let withToggle = 0;

  for (const p of pages) {
    const L = live(p.raw);
    const hasToggle = /id="nav-toggle"/.test(L);
    if (!hasToggle) continue;            // admin pages and login have no drawer, by design
    withToggle++;

    const hasMenu = /id="mobile-menu"/.test(L);
    const hasBackdrop = /mobile-menu-backdrop/.test(L);
    const buriedInComment = !hasMenu && /id="mobile-menu"/.test(p.raw);

    report("THE DRAWER IS IN THE DOM — " + p.rel, hasMenu,
      buriedInComment
        ? "the markup is in the file but INSIDE A COMMENT, so the hamburger opens nothing"
        : "this page shows a hamburger and has no drawer markup at all");

    report("the backdrop is in the DOM — " + p.rel, hasBackdrop,
      "without it the drawer cannot be dismissed by clicking away");

    // The drawer must be in the document, not the head: a browser hoists stray
    // flow content out of <head>, and relying on that is relying on error
    // recovery.
    const bodyAt = L.indexOf("<body");
    report("the drawer sits inside <body> — " + p.rel,
      !hasMenu || L.indexOf('id="mobile-menu"') > bodyAt,
      "drawer markup before <body> depends on parser error-recovery");
  }

  report("at least one page was actually inspected", withToggle > 0,
    "no page had a hamburger — the selector probably changed and this checker is now blind");
}

let failed = 0;
const report = (label, ok, detail) => {
  if (ok) { console.log("  ok    " + label); return; }
  failed++;
  console.log("  FAIL  " + label + (detail ? "\n        " + detail : ""));
};

console.log("\nevery hamburger has a drawer the parser can see\n");
const PAGES = loadPages();
run(PAGES, report);

// ---- Self-test -------------------------------------------------------------
console.log("\nself-test — the checks must fail when a drawer is buried\n");

function mustCatch(name, pages, expectHit) {
  const hits = [];
  try { run(pages, (l, ok) => { if (!ok) hits.push(l); }); } catch (e) { hits.push("threw: " + e.message); }
  if (hits.some((h) => h.includes(expectHit))) {
    console.log('  ok    ' + name + ' → caught by "' + expectHit + '"');
  } else {
    failed++;
    console.log("  FAIL  " + name + " went UNNOTICED — this checker cannot be trusted");
  }
}

// The exact regression: a page whose drawer is wrapped in a comment. This is
// what shipped, and a raw-text search calls it healthy.
const victim = PAGES.find((p) => /id="nav-toggle"/.test(live(p.raw)) && /id="mobile-menu"/.test(live(p.raw)));
mustCatch("a drawer commented out",
  PAGES.map((p) => p === victim
    ? { ...p, raw: p.raw.replace(/(<div class="mobile-menu-backdrop"[\s\S]*?<\/nav>)/, "<!-- $1 -->") }
    : p),
  "THE DRAWER IS IN THE DOM");

// A drawer deleted outright.
mustCatch("a drawer removed entirely",
  PAGES.map((p) => p === victim
    ? { ...p, raw: p.raw.replace(/<div class="mobile-menu-backdrop"[\s\S]*?<\/nav>/, "") }
    : p),
  "THE DRAWER IS IN THE DOM");

// The blindness case: the markup changes and this file silently inspects zero
// pages, reporting a clean run for ever.
mustCatch("the toggle selector changes and nothing is inspected",
  PAGES.map((p) => ({ ...p, raw: p.raw.replace(/id="nav-toggle"/g, 'id="nav-burger"') })),
  "at least one page was actually inspected");

console.log("\n" + (failed ? failed + " FAILED" : "all checks passed") + "\n");
process.exitCode = failed ? 1 : 0;
