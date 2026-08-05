// rebuild-nav — put the same main menu on every page, in Ahmed's order.
//
// The menu was drifting: five different link lists across fourteen pages, some
// with Hackathons, some without Connect, the app pages carrying only Events and
// Podcast. This writes one canonical list everywhere.
//
// It is deliberately NOT a whole-nav replacement. Each page's `.nav-actions`
// also holds things this script has no business touching — the signed-in
// identity chip, the Join/Sign in buttons, the staff-only Newsletter link, and
// a comment explaining the identity gating. So it removes only the anchors
// whose href is one of ours, and inserts the canonical block where the first
// one used to be. Anything it does not recognise is left exactly where it is.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "C:\\sctools\\scpush";

// href (from the site root) -> label. Order is the menu order.
const ITEMS = [
  { href: "app/dashboard.html", label: "Dashboard", gate: "member" },
  { href: "app/inbox.html", label: "Messages", gate: "member" },
  { href: "app/connect.html", label: "Connect", gate: null },
  { href: "events.html", label: "Events", gate: null },
  { href: "hackathons.html", label: "EduHackAI", gate: null },
  { href: "podcast.html", label: "Podcast", gate: null },
  { href: "app/admin/index.html", label: "Admin", gate: "admin" },
  { href: "app/settings.html", label: "Settings", gate: "member" },
];

// Every href the script owns and may therefore delete. Includes the old
// membership link and the pre-rename hackathons entry so a stale one is
// cleaned up rather than left beside its replacement.
const OWNED = new Set([
  ...ITEMS.map((i) => i.href),
  "membership.html",
  "app/promptarena.html",
]);

// A page in app/ reaches the site root with "../"; a page at the root does not.
function rel(href, depth) {
  if (depth === 0) return href;
  // depth 1 = app/. Strip the leading "app/" for siblings, prefix "../" for root pages.
  return href.startsWith("app/") ? href.slice(4) : "../" + href;
}

function anchor(item, depth, indent) {
  const cls = ["nav-link"];
  if (item.gate === "member") cls.push("member-only");
  if (item.gate === "admin") cls.push("admin-hidden");
  const id = item.gate === "admin" ? ' id="nav-admin-link"' : "";
  return `${indent}<a href="${rel(item.href, depth)}" class="${cls.join(" ")}"${id}>${item.label}</a>`;
}

// ⚠ Anchors that are NEVER ours, whatever they point at.
//
// The first version of this script matched on href alone and deleted the
// signed-in identity chip from login.html and privacy.html — because that chip
// is an <a href="app/dashboard.html">, which is a menu destination as well as
// the avatar's target. An href is not enough to identify a menu item; what the
// element IS matters more than where it goes.
const NEVER_OURS = /data-identity-(me|join|avatar|name)|nav-identity|class="[^"]*\bbtn\b/;

// Which of OWNED an anchor points at, normalised back to a root-relative href
// so "../events.html" and "events.html" are recognised as the same link.
function ownedHref(tag) {
  if (NEVER_OURS.test(tag)) return null;
  // Only plain nav links are ours. Anything without the class is some other
  // control that happens to live in the same container.
  if (!/class="[^"]*\bnav-link\b/.test(tag)) return null;
  const m = /href="([^"]+)"/.exec(tag);
  if (!m) return null;
  let href = m[1].replace(/^\.\.\//, "");
  if (!href.includes("/") && !OWNED.has(href) && OWNED.has("app/" + href)) href = "app/" + href;
  return OWNED.has(href) ? href : null;
}

const FILES = [
  ["index.html", 0], ["events.html", 0], ["hackathons.html", 0], ["membership.html", 0],
  ["podcast.html", 0], ["privacy.html", 0], ["login.html", 0],
  ["app/connect.html", 1], ["app/dashboard.html", 1], ["app/inbox.html", 1],
  ["app/member.html", 1], ["app/newsletter.html", 1], ["app/profile.html", 1],
  ["app/promptarena.html", 1],
];

let changed = 0;
for (const [name, depth] of FILES) {
  const path = join(ROOT, name);
  const src = readFileSync(path, "utf8");

  const open = src.indexOf('<div class="nav-actions">');
  if (open === -1) { console.log(`${name.padEnd(24)} no nav-actions — skipped`); continue; }
  const close = src.indexOf("</div>", open);
  const block = src.slice(open, close);

  // Every anchor in the block, with the ones we own marked.
  const anchors = [...block.matchAll(/[ \t]*<a\b[^>]*>[\s\S]*?<\/a>\n?/g)];
  const ours = anchors.filter((a) => ownedHref(a[0]) !== null);
  const kept = anchors.filter((a) => ownedHref(a[0]) === null);

  if (!ours.length) { console.log(`${name.padEnd(24)} no owned links found — skipped`); continue; }

  const indent = (/^([ \t]*)/.exec(ours[0][0]) || ["", "      "])[1];
  const menu = ITEMS.map((i) => anchor(i, depth, indent)).join("\n") + "\n";

  // Rebuild: canonical menu first, then whatever the page had that we do not own.
  let next = block;
  for (const a of ours) next = next.replace(a[0], "");
  const insertAt = next.indexOf("\n") + 1;
  next = next.slice(0, insertAt) + menu + next.slice(insertAt);

  const out = src.slice(0, open) + next + src.slice(close);

  // ⚠ INVARIANT, and the reason this block exists: the first run of this script
  // silently deleted the signed-in identity chip from two pages. Anything that
  // is not a menu link must survive untouched, so count the markers before and
  // after and refuse to write if any of them moved.
  const marks = [
    "data-identity-me", "data-identity-join", "data-identity-avatar",
    "data-identity-name", "data-signin-link", "nav-identity",
  ];
  const bad = marks.filter((m) => count(src, m) !== count(out, m));
  if (bad.length) {
    console.log(`${name.padEnd(24)} REFUSED — would have changed: ${bad.join(", ")}`);
    continue;
  }

  writeFileSync(path, out, "utf8");
  changed++;
  console.log(
    `${name.padEnd(24)} replaced ${String(ours.length).padStart(2)} link(s), kept ${kept.length}`,
  );
}
console.log(`\n${changed} file(s) rewritten.`);

function count(s, needle) {
  return s.split(needle).length - 1;
}
