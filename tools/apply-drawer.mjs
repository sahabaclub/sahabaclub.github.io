// One menu everywhere, always reachable, with an icon on every item.
//
//   node tools/apply-drawer.mjs          report
//   node tools/apply-drawer.mjs --apply  write
//
// ⚠ RE-RUN UNTIL IT REPORTS 0. This tool is not idempotent in one pass: the
// toggle-removal regex consumes the newline after </button> and the re-insert
// puts one back in a slightly different place, so a page can settle over two or
// three runs. Measured 14 Aug on the eight app/* pages: 8 changes, then 3, then
// 0. It converges — it just does not converge immediately, and a single run
// leaving "3 change(s)" is not a failure.
//
// ⚠ Every one of those changes was a BLANK LINE. If a run ever reports changes
// that are not whitespace, read the diff before applying: that is real drift
// between the tool and the pages, and it is worth knowing why.
//
// ============================================================
// Why
// ============================================================
//
// Ahmed: "In users dashboard, don't keep sections names in the headder, just
// keep the menu always their. Add icons to the menu items to look better, make
// it simple, tech, and AI icons representing each section."
//
// The seven public pages already carry the drawer: `.nav.has-drawer` hides the
// inline links AT EVERY WIDTH and shows a hamburger instead. The nine member
// pages under app/ never got it, so they still print eight or nine link labels
// across the top — the thing Ahmed is looking at.
//
// So this is not a new pattern, it is the existing one finally applied
// everywhere. That matters for a small reason worth stating: the drawer's
// open/close behaviour, the header-height pinning and the Escape handling all
// already exist in script.js and key off #nav-toggle / #mobile-menu /
// #mobile-menu-backdrop. Producing the same ids means no new JavaScript, and
// nothing new to keep in step.
//
// ⚠ The inline `.nav-actions` links are LEFT IN PLACE, not deleted. `has-drawer`
// hides them with CSS, and they are what `lib/notifications.js` counts badges
// against (BADGE_SELECTOR is ".nav-link, .mobile-menu-item"). Removing them
// would silently drop the unread counts from pages that still had them, which
// is the kind of change that looks tidy and breaks something two files away.
//
// ============================================================
// The icons
// ============================================================
//
// Inline SVG, 18px, 1.6 stroke, currentColor, no fills. Drawn as geometry
// rather than pictograms — nodes, grids, waveforms — so the set reads as one
// family and stays legible at 18px on a phone. currentColor means they inherit
// hover and the light theme for free.
//
// aria-hidden on every one: the anchor already says where it goes, and a
// screen reader announcing "graduation cap, EduHackAI" is noise.

import { readFileSync, writeFileSync } from "node:fs";

const ROOT = "C:\\sctools\\scpush";

const S = (d) =>
  '<svg class="menu-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  d + "</svg>";

// Keyed by the destination file name, so it works from any depth.
const ICONS = {
  "dashboard.html": S('<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>'),
  "inbox.html": S('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.5 9.5 0 0 1-2.9-.4L4 21l1.4-4a8.1 8.1 0 0 1-1.4-4.5A8.4 8.4 0 0 1 12.6 3 8.4 8.4 0 0 1 21 11.5z"/>'),
  // Connect: a small network. The most "AI" of the set, and the right idea —
  // members linked to members.
  "connect.html": S('<circle cx="12" cy="5" r="2.2"/><circle cx="5" cy="17" r="2.2"/><circle cx="19" cy="17" r="2.2"/><path d="M10.4 6.7 6.4 14.9M13.6 6.7l4 8.2M7.2 17h9.6"/>'),
  "events.html": S('<rect x="3" y="5" width="18" height="16" rx="2.4"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  // EduHackAI: a mortarboard over a circuit node — learning plus machine.
  "hackathons.html": S('<path d="M12 4 2.5 8.5 12 13l9.5-4.5L12 4z"/><path d="M6.5 10.8V15c0 1.6 2.5 2.9 5.5 2.9s5.5-1.3 5.5-2.9v-4.2"/><circle cx="12" cy="8.5" r="1"/>'),
  // Podcast: a waveform rather than a microphone — it reads as audio at 18px,
  // where a mic collapses into a blob.
  "podcast.html": S('<path d="M4 12v1M8 8v8M12 5v14M16 8v8M20 12v1"/>'),
  "settings.html": S('<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>'),
  // Admin: sliders. Deliberately not a shield or a key — this is the panel that
  // runs the club, not a security badge.
  "index.html": S('<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>'),
  "newsletter.html": S('<rect x="2.5" y="5" width="19" height="14" rx="2.2"/><path d="m3.5 7 7.9 5.6a1 1 0 0 0 1.2 0L20.5 7"/>'),
  "membership.html": S('<path d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.2l5.9-.9L12 3z"/>'),
  "login.html": S('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5M15 12H3"/>'),
  "promptarena.html": S('<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="3.2"/>'),
};

function iconFor(href) {
  const file = href.split("?")[0].split("#")[0].split("/").pop();
  // Admin is app/admin/index.html; a bare index.html is the site home.
  if (file === "index.html" && !/admin\//.test(href)) return null;
  return ICONS[file] || null;
}

// ---- pages ---------------------------------------------------------------

// The member pages. app/admin/* is excluded on purpose: it has its own sidebar
// shell (`.ad-side`) and no top nav to convert.
const MEMBER_PAGES = [
  "app/dashboard.html", "app/inbox.html", "app/connect.html",
  "app/settings.html", "app/profile.html", "app/member.html",
  "app/promptarena.html", "app/onboarding.html", "app/newsletter.html",
];

const TOGGLE = [
  '      <button class="nav-toggle" id="nav-toggle" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="mobile-menu">',
  '        <span class="nav-toggle-bar"></span>',
  '        <span class="nav-toggle-bar"></span>',
  '        <span class="nav-toggle-bar"></span>',
  "      </button>",
].join("\n");

// Same order as tools/rebuild-nav.mjs. Sign in / Join are omitted — every one
// of these pages already requires a session.
const DRAWER_ITEMS = [
  { href: "dashboard.html", label: "Dashboard", cls: "member-only" },
  { href: "inbox.html", label: "Messages", cls: "member-only" },
  { href: "connect.html", label: "Connect", cls: "" },
  { href: "../events.html", label: "Events", cls: "" },
  { href: "../hackathons.html", label: "EduHackAI", cls: "" },
  { href: "../podcast.html", label: "Podcast", cls: "" },
  { href: "admin/index.html", label: "Admin", cls: "admin-hidden", id: "nav-admin-link-mobile" },
  { href: "settings.html", label: "Settings", cls: "member-only" },
];

function drawerFor() {
  const items = DRAWER_ITEMS.map((i) => {
    const cls = ("mobile-menu-item " + i.cls).trim();
    const id = i.id ? ` id="${i.id}"` : "";
    const ico = iconFor(i.href);
    return `    <a class="${cls}"${id} href="${i.href}">${ico || ""}<span>${i.label}</span></a>`;
  }).join("\n");
  return [
    '<div class="mobile-menu-backdrop" id="mobile-menu-backdrop" hidden></div>',
    '<nav class="mobile-menu" id="mobile-menu" aria-label="Menu" hidden>',
    '  <div class="mobile-menu-panel">',
    items,
    "  </div>",
    "</nav>",
  ].join("\n");
}

const APPLY = process.argv.includes("--apply");
let changed = 0;

// ---- 1. member pages get the drawer --------------------------------------
for (const rel of MEMBER_PAGES) {
  const path = join_(rel);
  let src;
  try { src = readFileSync(path, "utf8"); } catch { console.log(`  ${rel}: not found`); continue; }
  const before = src;

  if (!/class="nav has-drawer"/.test(src)) {
    src = src.replace(/<header class="nav">/, '<header class="nav has-drawer">');
  }
  // ⚠ The toggle must be a SIBLING of .nav-actions, not a child of it.
  //
  // The first version inserted before the pair of closing divs, which put the
  // button INSIDE .nav-actions — and `.nav.has-drawer .nav-actions` is
  // `display: none`, so the hamburger was hidden along with the links it was
  // meant to replace. The page ended up with no menu at all, which is worse
  // than the header it was fixing.
  //
  // Any existing toggle is removed first, so a misplaced one from that version
  // is relocated rather than left where it is and skipped.
  src = src.replace(
    /\n\s*<button class="nav-toggle"[\s\S]*?<\/button>\n?/,
    "\n"
  );
  // Group 1 is the </div> closing .nav-actions; group 2 closes .nav-inner and
  // the header. The button goes between them.
  src = src.replace(
    /(\n\s*<\/div>)(\s*\n\s*<\/div>\s*\n<\/header>)/,
    "$1\n" + TOGGLE + "$2"
  );
  // ⚠⚠ BOTH OF THESE READ THE PAGE WITH COMMENTS STRIPPED, AND THE INSERT IS
  // SCOPED TO THE BODY. Read this before simplifying either back.
  //
  // This wrote the entire drawer INTO AN HTML COMMENT on three pages —
  // connect.html, member.html and promptarena.html — and nobody noticed for
  // weeks. Each of them carries a head comment explaining the header-identity
  // placement, and that prose contains the words "</header>". `String.replace`
  // takes the FIRST match, which was the one inside the comment.
  //
  // The result is the worst kind of broken: the markup is in the file, it is in
  // the served HTML, every grep for `id="mobile-menu"` finds it — and the
  // parser throws it away, so the hamburger opens nothing. The `!test(src)`
  // guard then saw the commented copy and declined to add a real one, so
  // re-running the tool could never repair it either.
  //
  // liveSrc is what the PARSER keeps. bodyAt is where the document actually
  // begins. Anchoring on prose is impossible from here.
  const liveSrc = src.replace(/<!--[\s\S]*?-->/g, "");
  if (!/id="mobile-menu"/.test(liveSrc)) {
    const bodyAt = src.indexOf("<body");
    if (bodyAt === -1) {
      console.log("  ! no <body>, drawer skipped  " + rel);
    } else {
      const head = src.slice(0, bodyAt);
      const body = src.slice(bodyAt);
      if (!/<\/header>/.test(body)) {
        console.log("  ! no </header> in body, drawer skipped  " + rel);
      } else {
        src = head + body.replace(/<\/header>/, "</header>\n\n" + drawerFor());
      }
    }
  }

  if (src !== before) {
    changed++;
    console.log("  + drawer  " + rel);
    if (APPLY) writeFileSync(path, src, "utf8");
  }
}

// ---- 2. every menu item on every page gets its icon ----------------------
const ALL = [
  ...MEMBER_PAGES,
  "index.html", "events.html", "event.html", "events-hub.html",
  "hackathons.html", "podcast.html", "membership.html",
];

for (const rel of ALL) {
  const path = join_(rel);
  let src;
  try { src = readFileSync(path, "utf8"); } catch { continue; }
  const before = src;

  // Only .mobile-menu-item anchors, and only ones not already carrying an icon.
  src = src.replace(
    /(<a class="mobile-menu-item[^"]*"[^>]*href="([^"]+)"[^>]*>)([\s\S]{0,80}?)(<\/a>)/g,
    (whole, open, href, inner, close) => {
      if (/menu-ico/.test(inner)) return whole;
      const ico = iconFor(href);
      if (!ico) return whole;
      const label = inner.replace(/<\/?span>/g, "").trim();
      if (!label) return whole;
      return open + ico + "<span>" + label + "</span>" + close;
    }
  );

  if (src !== before) {
    changed++;
    console.log("  + icons   " + rel);
    if (APPLY) writeFileSync(path, src, "utf8");
  }
}

function join_(rel) { return ROOT + "\\" + rel.split("/").join("\\"); }

console.log("\n" + (APPLY ? "APPLIED" : "DRY RUN") + ": " + changed + " change(s)");
if (!APPLY && changed) console.log("re-run with --apply to write");
if (APPLY) console.log("\n⚠ Then run: node tools/cache-bust.mjs --apply");
