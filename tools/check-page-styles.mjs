// check-page-styles — markup wearing a class no stylesheet the page loads
// has ever heard of.
//
// ⚠ WHY THIS EXISTS. The speaker block on event.html was styled in
// app/connect.css. That page loads styles.css and its own inline <style>, and
// NEVER connect.css — so all eight rules were dead. The avatar rendered at its
// natural size instead of a 40px circle, and it looked like a CSS bug rather
// than what it was: the rules sitting in a file the page cannot see. Ahmed
// reported it as "the speaker photo is very big … I think some mistake in the
// css", which is exactly right and exactly hard to find by reading either
// file, because both of them look correct on their own.
//
// The same shape as the missing import that killed the sessions on
// app/member.html: code that is perfectly good and simply not connected to the
// page that needs it.
//
// ⚠ SCOPED TO PAGE-PREFIXED CLASSES ONLY (cx-, evp-, hk-, ad-, onb-). Those
// are the conventions this codebase already follows for "these belong to one
// area", so a missing rule is a real mistake rather than a shared utility
// defined somewhere reasonable. Generic classes are none of this file's
// business, and checking them would be all false positives.
//
// ERRORS fail the build.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PREFIXES = ["cx-", "evp-", "hk-", "ad-", "onb-"];

let failed = 0;
const fail = (m) => { console.error("  FAIL  " + m); failed++; };

// Pages that render one area's markup. Listed rather than globbed: a page with
// no prefixed classes has nothing to say here.
const PAGES = [
  "event.html", "events.html", "events-hub.html", "hackathons.html",
  "app/member.html", "app/connect.html", "app/inbox.html", "app/dashboard.html",
  "app/onboarding.html", "app/profile.html", "app/settings.html",
];

let checkedPages = 0;
let checkedClasses = 0;

for (const rel of PAGES) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) continue;
  const html = readFileSync(file, "utf8");
  checkedPages++;

  // Everything this page can actually see: its own inline <style> blocks plus
  // every stylesheet it links, resolved relative to the page.
  let css = "";
  for (const m of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) css += m[1];
  for (const m of html.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/g)) {
    const href = m[1].split("?")[0];
    if (/^https?:/.test(href)) continue;              // Google Fonts and friends
    const p = resolve(dirname(file), href);
    if (existsSync(p)) css += readFileSync(p, "utf8");
  }

  // Class names the page puts into markup, from both static HTML and the
  // strings its JS builds.
  // ⚠ Tokens are sanitised to what can legally be in a class attribute. The
  // JS on these pages builds markup by concatenation, so a naive split hands
  // back fragments carrying the surrounding quote — `cx-chip-art'` — and every
  // one of those is reported as an undefined class. Four such phantoms turned
  // up the first time this ran, which would have made the whole check noise.
  const used = new Set();
  const addAll = (s) => {
    for (const raw of String(s).split(/\s+/)) {
      const c = raw.replace(/[^A-Za-z0-9_-]/g, "");
      if (c) used.add(c);
    }
  };
  for (const m of html.matchAll(/class="([^"]*)"/g)) addAll(m[1]);
  for (const m of html.matchAll(/class=\\?["']([^"'\\]*)/g)) addAll(m[1]);

  const orphans = [];
  for (const c of used) {
    if (!PREFIXES.some((p) => c.startsWith(p))) continue;
    // A trailing fragment from a built-up string ("evp-share-" + name) is not
    // a class anybody wrote; skip it rather than reporting a name that does
    // not exist.
    if (c.endsWith("-")) continue;
    checkedClasses++;
    if (!new RegExp("\\." + c.replace(/[-]/g, "\\-") + "(?![\\w-])").test(css)) orphans.push(c);
  }

  if (orphans.length) {
    fail(`${rel} uses ${orphans.length} class(es) that no stylesheet it loads defines:\n` +
         `          ${orphans.sort().join(", ")}\n` +
         `          The markup renders unstyled. Check whether the rules were written into a\n` +
         `          stylesheet this page does not link — that is what happened to .evp-speaker.`);
  }
}

if (!failed) {
  console.log(`  ok    page styles: ${checkedClasses} prefixed class(es) across ${checkedPages} pages, all defined`);
} else {
  console.log(`\n  ${failed} problem(s).`);
}
process.exit(failed ? 1 : 0);
