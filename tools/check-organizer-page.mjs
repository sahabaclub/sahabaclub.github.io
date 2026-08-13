// check-organizer-page.mjs
// ------------------------------------------------------------
//   node tools/check-organizer-page.mjs
//
// Ahmed, 13 Aug: clicking an organiser's name should show everything the club
// lists from them. Before organizer.html existed, that chip linked to
// `o.website` — so the obvious thing to press when you want more of somebody's
// events sent you OFF the club's site, to the one place their other Sahaba Club
// events are not.
//
// The regression is a single character: swap `organizer.html?o=` back for
// `o.website` and the page still renders, still looks right, and quietly stops
// being the reason it was built. Nothing else in the repo would notice.
//
// Static: it reads the two pages. No database, no key, no browser.
//
// ⚠ Self-tests at the end, per this project's rule that a checker never seen to
// fail is a checker nobody should trust.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const FILES = { page: read("organizer.html"), event: read("event.html") };

function runWiring(f, report) {
  // ---- the link out of the event page ----
  const chip = f.event.slice(f.event.indexOf("function organizerChip"));
  const body = chip.slice(0, 900);

  report("THE ORGANISER CHIP STAYS ON THE CLUB'S SITE",
    /organizer\.html\?o=/.test(body) && !/href="' \+ esc\(o\.website\)/.test(body),
    "linking the chip to o.website is what this page was built to replace");
  report("the slug is URL-encoded into the link",
    /encodeURIComponent\(o\.slug\)/.test(body));
  report("an organiser with no slug is plain text, not a broken link",
    /o\.slug\s*\?/.test(body),
    "?o=null renders a page that can only say 'not found'");
  report("the chip says where it goes",
    /aria-label="All events from/.test(body),
    "an icon-and-name chip gives a screen reader nothing else to go on");

  // ---- the page itself ----
  report("the page reads its slug from ?o=",
    /params\.get\("o"\)/.test(f.page));
  report("it only lists PUBLISHED events",
    /\.eq\("is_published", true\)/.test(f.page),
    "an unpublished draft would become publicly readable through this page");
  report("it splits upcoming from past",
    /org-past/.test(f.page) && /e\.event_date >= today/.test(f.page));
  report("upcoming runs soonest-first",
    /upcoming\.reverse\(\)/.test(f.page),
    "one order cannot serve both lists; what is ahead reads soonest first");
  report("an unknown slug says so rather than showing an empty page",
    /isn\\'t here|isn't here/.test(f.page));
  report("the organiser's own website is still reachable",
    /class="org-site"/.test(f.page) && /rel="noopener"/.test(f.page),
    "moving the chip inward must not lose the outbound link entirely");
  report("event cards link to the event page",
    /href="event\.html\?e=' \+ encodeURIComponent\(e\.slug\)/.test(f.page));

  // The shell was copied from event.html so the two cannot drift on chrome.
  report("the page carries the site CSP",
    /Content-Security-Policy/.test(f.page),
    "a new page without one is the gap add-security-headers exists to close");
  report("and the shared header, nav and footer",
    /class="nav has-drawer"/.test(f.page) &&
    /id="mobile-menu"/.test(f.page) &&
    /class="footer"/.test(f.page));
}

let failed = 0;
const report = (label, ok, detail) => {
  if (ok) { console.log("  ok    " + label); return; }
  failed++;
  console.log("  FAIL  " + label + (detail ? "\n        " + detail : ""));
};

console.log("\norganizer pages\n");
runWiring(FILES, report);

console.log("\nself-test — the checks must fail when the page is undone\n");

function mustCatch(name, run1, expectHit) {
  const hits = [];
  try { run1((l, ok) => { if (!ok) hits.push(l); }); } catch (e) { hits.push("threw: " + e.message); }
  if (hits.some((h) => h.includes(expectHit))) {
    console.log('  ok    ' + name + ' → caught by "' + expectHit + '"');
  } else {
    failed++;
    console.log("  FAIL  " + name + " went UNNOTICED — this checker cannot be trusted");
  }
}

// The exact regression this file exists for.
mustCatch("the chip points back at the organiser's own website",
  (r) => runWiring({ ...FILES, event: FILES.event.replace(
    /'<a class="evp-org" href="organizer\.html\?o=' \+ encodeURIComponent\(o\.slug\)/,
    `'<a class="evp-org" href="' + esc(o.website)`) }, r),
  "THE ORGANISER CHIP STAYS ON THE CLUB'S SITE");

// A draft event becoming publicly visible through the organiser page.
mustCatch("the published filter dropped",
  (r) => runWiring({ ...FILES, page: FILES.page.replace(/\.eq\("is_published", true\)/, "") }, r),
  "it only lists PUBLISHED events");

// The outbound link lost in the move.
mustCatch("the organiser's website link removed",
  (r) => runWiring({ ...FILES, page: FILES.page.replace(/class="org-site"/g, "class="+'"x"') }, r),
  "the organiser's own website is still reachable");

// Upcoming silently inheriting the past list's ordering.
mustCatch("upcoming left newest-first",
  (r) => runWiring({ ...FILES, page: FILES.page.replace("upcoming.reverse()", "") }, r),
  "upcoming runs soonest-first");

console.log("\n" + (failed ? failed + " FAILED" : "all checks passed") + "\n");
process.exitCode = failed ? 1 : 0;
