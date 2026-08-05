// rebuild-drawer — the same menu, in the hamburger drawer.
//
// On the five public pages the header carries `nav has-drawer`, which hides
// `.nav-actions` at EVERY width — so the drawer is not a mobile fallback, it is
// the main menu on those pages, desktop included. It has to carry what the
// inline nav carries or the menu is one thing on the dashboard and another on
// the home page.
//
// Two exact-string replacements, not a region rewrite. The first attempt tried
// to replace everything between two landmarks and got the boundary wrong,
// because the Settings submenu contains nested <div>s — and it would have taken
// the Reduce motion control with it. Exact strings cannot drift onto the wrong
// boundary, and anything not named here is untouched by construction.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "C:\\sctools\\scpush";
const FILES = ["index.html", "events.html", "hackathons.html", "membership.html", "podcast.html"];

// A. The link rows.
const OLD_LINKS = `    <a class="mobile-menu-item" href="events.html">Events</a>
    <a class="mobile-menu-item" href="hackathons.html">Hackathons</a>
    <a class="mobile-menu-item" href="app/connect.html">Connect</a>
    <a class="mobile-menu-item" href="podcast.html">Podcast</a>
    <a class="mobile-menu-item admin-hidden" id="nav-admin-link-mobile" href="app/admin/index.html">Admin</a>
`;
const NEW_LINKS = `    <a class="mobile-menu-item member-only" href="app/dashboard.html">Dashboard</a>
    <a class="mobile-menu-item member-only" href="app/inbox.html">Messages</a>
    <a class="mobile-menu-item" href="app/connect.html">Connect</a>
    <a class="mobile-menu-item" href="events.html">Events</a>
    <a class="mobile-menu-item" href="hackathons.html">EduHackAI</a>
    <a class="mobile-menu-item" href="podcast.html">Podcast</a>
    <a class="mobile-menu-item admin-hidden" id="nav-admin-link-mobile" href="app/admin/index.html">Admin</a>
`;

// B. Language stops being its own top-level row. Ahmed asked for it inside
// Settings, and two adjacent expandable rows doing neighbouring jobs was
// always odd.
const OLD_LANG = `    <button class="mobile-menu-item mobile-menu-expand" type="button" aria-expanded="false" aria-controls="submenu-language">
      <span>Language</span>
      <span class="mobile-menu-chevron" aria-hidden="true">&#9662;</span>
    </button>
    <div class="mobile-submenu" id="submenu-language" hidden>
      <button class="mobile-submenu-item is-active" type="button" data-lang="en">English</button>
      <button class="mobile-submenu-item" type="button" data-lang="ar">
        العربية <span class="mobile-soon">soon</span>
      </button>
    </div>

`;

// C. …and reappears inside the Settings submenu, immediately above Reduce
// motion. The buttons keep their classes and their data-lang attributes, so
// script.js's existing handler — which still says Arabic is not translated
// rather than switching to a half-translated page — keeps working untouched.
const ANCHOR = `      <label class="mobile-switch">
        <span>Reduce motion</span>`;
const WITH_LANG = `      <div class="mobile-submenu-langs" role="group" aria-label="Language">
        <span class="theme-choice-label">Language</span>
        <button class="mobile-submenu-item is-active" type="button" data-lang="en">English</button>
        <button class="mobile-submenu-item" type="button" data-lang="ar">
          العربية <span class="mobile-soon">soon</span>
        </button>
      </div>
      <label class="mobile-switch">
        <span>Reduce motion</span>`;

// D. A way through to the full settings page, for anyone signed in.
const NOTE = `      <p class="mobile-setting-note">Turns off the moving starfield and scrolling photo strip.</p>
`;
const NOTE_PLUS = NOTE +
  `      <a class="mobile-submenu-item member-only" href="app/settings.html">All settings &rarr;</a>
`;

// ⚠ This script's own file may be CRLF while the HTML it edits is LF, which
// makes every multi-line template literal below match nothing — silently, and
// reported as "not found" rather than as an error. Normalise both sides.
// (This exact trap cost a run earlier today on the slogan swap.)
const lf = (s) => s.replace(/\r\n/g, "\n");

const c = (s, n) => s.split(n).length - 1;
let changed = 0;

for (const name of FILES) {
  const path = join(ROOT, name);
  const src = readFileSync(path, "utf8");
  let out = src;
  const missing = [];

  // ⚠ Match the FILE's line endings, not this script's. `git checkout` writes
  // through core.autocrlf, so reverting a file flips it from LF to CRLF
  // underneath you — which is exactly how this ran four times finding nothing
  // and reporting a tidy "not found" each time.
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const fit = (s) => lf(s).replace(/\n/g, eol);

  // `optional` matters: membership.html never had a top-level Language block,
  // so there is nothing to remove there. Without this the absence of one
  // optional piece blocked the other three and the page kept the old menu.
  for (const [label, from, to, optional] of [
    ["links", fit(OLD_LINKS), fit(NEW_LINKS), false],
    ["language block", fit(OLD_LANG), "", true],
    ["language row", fit(ANCHOR), fit(WITH_LANG), false],
    ["settings link", fit(NOTE), fit(NOTE_PLUS), false],
  ]) {
    if (!out.includes(from)) { if (!optional) missing.push(label); continue; }
    out = out.replace(from, to);
  }

  // The identity rows and the accessibility control must survive untouched.
  // `data-lang` is NOT a guard: moving Language into Settings adds it on a page
  // that never had it (membership.html), so a count change there is the point
  // of the edit rather than a symptom of one going wrong. The guards are the
  // things this script must never touch.
  const guards = ["data-identity-join", "data-signin-link", "setting-reduce-motion"];
  const moved = guards.filter((g) => c(src, g) !== c(out, g));

  if (missing.length) { console.log(`${name.padEnd(18)} SKIPPED — not found: ${missing.join(", ")}`); continue; }
  if (moved.length) { console.log(`${name.padEnd(18)} REFUSED — would change ${moved.join(", ")}`); continue; }

  writeFileSync(path, out, "utf8");
  changed++;
  console.log(`${name.padEnd(18)} drawer updated`);
}
console.log(`\n${changed} drawer(s) rewritten.`);
