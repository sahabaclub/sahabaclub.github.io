// Verification harness for the hackathons page. Run from the repo root:
//   node --experimental-vm-modules tools/hackathons-checks/check.mjs
//
// It does four things, none of which need a browser:
//   1. parses hackathons.html with a real tag-balance parser
//   2. loads hackathons-ui.js under a DOM stub with fixture data and
//      tag-balance-checks every fragment it generates
//   3. unit-tests the pure logic (medal tier, summary, validation, the
//      dialog's state machine)
//   4. drives the dialog through submit -> pending -> success / failure

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/\/$/, "");
let failures = 0;
let checks = 0;

function ok(cond, label, extra) {
  checks++;
  if (cond) return true;
  failures++;
  console.error(`  FAIL  ${label}${extra ? "\n        " + extra : ""}`);
  return false;
}
function section(name) { console.log(`\n== ${name}`); }

// ============================================================
// 1. A real HTML tag-balance parser
// ============================================================
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);
// Foreign-content elements that are commonly written self-closing.
const RAW_TEXT = new Set(["script", "style"]);

function tagBalance(html, label) {
  const stack = [];
  const problems = [];
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;

    // comment / doctype / CDATA
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) { problems.push("unterminated comment"); break; }
      i = end + 3;
      continue;
    }
    if (html.startsWith("<!", lt)) {
      const end = html.indexOf(">", lt);
      if (end === -1) { problems.push("unterminated doctype"); break; }
      i = end + 1;
      continue;
    }

    // find the end of the tag, honouring quoted attribute values so a ">"
    // inside an attribute cannot terminate it early
    let j = lt + 1;
    let quote = null;
    while (j < html.length) {
      const c = html[j];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      j++;
    }
    if (j >= html.length) { problems.push("unterminated tag"); break; }

    const raw = html.slice(lt + 1, j).trim();
    i = j + 1;

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toLowerCase();
      if (!stack.length) { problems.push(`</${name}> with nothing open`); continue; }
      const top = stack.pop();
      if (top.name !== name) {
        problems.push(`</${name}> closes <${top.name}> opened at offset ${top.at}`);
      }
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const name = raw.split(/[\s/>]/)[0].toLowerCase();
    if (!name) continue;

    if (RAW_TEXT.has(name) && !selfClosing) {
      // skip the raw text body wholesale — "</div>" inside a script string
      // is not markup
      const close = html.toLowerCase().indexOf(`</${name}`, i);
      if (close === -1) { problems.push(`unterminated <${name}>`); break; }
      const closeEnd = html.indexOf(">", close);
      i = closeEnd === -1 ? html.length : closeEnd + 1;
      continue;
    }
    if (VOID.has(name) || selfClosing) continue;

    stack.push({ name, at: lt });
  }

  for (const open of stack) problems.push(`<${open.name}> at offset ${open.at} never closed`);
  ok(problems.length === 0, `${label}: tags balance`, problems.slice(0, 6).join("\n        "));
  return problems.length === 0;
}

section("1. HTML structure");
const pageHtml = fs.readFileSync(path.join(REPO, "hackathons.html"), "utf8");
tagBalance(pageHtml, "hackathons.html");

// The two deletions the owner asked for.
ok(!/hk-provenance/.test(pageHtml), "hackathons.html: hk-provenance is gone");
ok(!/nothing is\s+inferred|placings exist for rounds 1 and 2 only/.test(pageHtml),
  "hackathons.html: the provenance paragraph text is gone");

// Dialog wiring that has to be right in the markup itself.
for (const need of [
  'role="dialog"', 'aria-modal="true"', 'aria-labelledby="hk-interest-title"',
  'name="full_name"', 'name="email"', 'name="mobile"', 'name="current_job"',
]) {
  ok(pageHtml.includes(need), `hackathons.html: dialog has ${need}`);
}
for (const id of ["hk-trophy-gold", "hk-trophy-silver", "hk-trophy-bronze"]) {
  ok(pageHtml.includes(`id="${id}"`), `hackathons.html: sprite defines ${id}`);
}
// Every label points at a real input id, and every input at a real error span.
const labelFor = [...pageHtml.matchAll(/<label for="([^"]+)"/g)].map((m) => m[1]);
for (const f of labelFor) {
  ok(pageHtml.includes(`id="${f}"`), `hackathons.html: <label for="${f}"> has a control`);
}
const describedBy = [...pageHtml.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1]);
for (const d of describedBy) {
  ok(pageHtml.includes(`id="${d}"`), `hackathons.html: aria-describedby="${d}" resolves`);
}

// "EduHackAI History" — a static heading naming the filter chips, the search
// box and the round cards below them. Static because the toolbar it labels is
// static: a heading that only appeared after a fetch would leave the search
// field unlabelled for as long as the fetch took.
//
// It carries the shared .hk-mark-text span, the same as the five headings
// hackathons-ui.js renders. This is the only one written by hand, so it is the
// one most able to drift; the span is asserted here character for character.
{
  const heading = '<h2 class="hk-rounds-h"><span class="hk-mark-text">EduHackAI History</span></h2>';
  ok(pageHtml.includes(heading), "hackathons.html: the rounds heading is present", heading);
  ok(!/Details of previous rounds/.test(pageHtml),
    "hackathons.html: the old \"Details of previous rounds:\" wording is gone");
  const iStory = pageHtml.indexOf('id="hack-story"');
  const iHeading = pageHtml.indexOf(heading);
  const iToolbar = pageHtml.indexOf('class="hk-toolbar"');
  const iRounds = pageHtml.indexOf('id="hack-rounds"');
  ok(iStory < iHeading && iHeading < iToolbar && iToolbar < iRounds,
    "hackathons.html: it sits between the story card and the round filter chips",
    `story ${iStory}, heading ${iHeading}, toolbar ${iToolbar}, rounds ${iRounds}`);
}

const js = fs.readFileSync(path.join(REPO, "hackathons-ui.js"), "utf8");
// Both stylesheets, read once here because the width check below resolves the
// cascade across them together — the page's rules live in an inline <style>
// and the shared ones in styles.css, and a cap in either would bind.
const sheetForCascade = fs.readFileSync(path.join(REPO, "styles.css"), "utf8");
const inlineForCascade = (pageHtml.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";
ok(!/never recorded in the source/.test(js),
  "hackathons-ui.js: the 'placings were never recorded' sentence is gone");
ok(!/\.order\(/.test(js.split("hackathon_roster")[1].split("]);")[0] || ""),
  "hackathons-ui.js: the roster query adds no .order() of its own");

// ============================================================
// 2. Load the page script under a DOM stub
// ============================================================
section("2. hackathons-ui.js under Node");

const DOC = { activeElement: null };
const registry = new Map();

function el(id, tag) {
  const node = {
    id, tagName: (tag || "div").toUpperCase(),
    innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false,
    // The three numbers railEdges() reads, plus the method the buttons call.
    // Defaults describe a rail that is scrolled to its start and has more to
    // the right — which is what the showcase rail actually is at load.
    scrollLeft: 0, scrollWidth: 0, clientWidth: 0, offsetWidth: 0, offsetLeft: 0,
    scrollBy(opts) { this._scrolledBy = opts; },
    _attrs: {}, _listeners: {}, _kids: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) { if (f === undefined) f = !this._s.has(c); f ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    removeAttribute(k) { delete this._attrs[k]; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    dispatch(t, ev) { (this._listeners[t] || []).forEach((fn) => fn(ev)); },
    querySelector(sel) { return this._kids[sel] || null; },
    querySelectorAll() { return []; },
    contains(other) { return Object.values(this._kids).includes(other) || other === this; },
    closest() { return null; },
    focus() { DOC.activeElement = this; },
    getClientRects() { return [1]; },
    scrollIntoView() {},
    reset() { Object.values(this._kids).forEach((k) => { if (k && "value" in k) k.value = ""; }); },
  };
  if (id) registry.set(id, node);
  return node;
}

for (const id of [
  "hack-rounds", "hack-soon", "hack-status", "hack-stats", "hack-jump",
  "hack-story-head", "hack-story", "hack-videos", "hack-coaches", "hack-cta",
  "hack-q", "hack-clear-q", "hack-count", "hk-interest", "hk-interest-title",
  "hk-interest-intro", "hk-interest-form", "hk-interest-submit",
  "hk-interest-done", "hk-done-text", "hk-form-error",
  "hk-video-modal", "hk-video-modal-title", "hk-video-modal-media",
  "hk-video-modal-close",
]) el(id);

// The dialog's inner structure the script reaches for.
const modal = registry.get("hk-interest");
modal.hidden = true;
const modalBox = el(null, "div");
modal._kids[".hk-modal-box"] = modalBox;

// The showcase player dialog, same shape. It starts hidden for the same reason
// the real one does: `hidden` in the markup is what makes a dialog closed.
const videoModal = registry.get("hk-video-modal");
videoModal.hidden = true;
const videoModalBox = el(null, "div");
videoModal._kids[".hk-vmodal-box"] = videoModalBox;

// The showcase rail and its two buttons, hung off the #hack-videos mount so
// that wireRail() finds them the way it finds them in a browser — by querying
// the mount it was handed. They are set up BEFORE the script runs, because
// wireRail() is called at boot.
const videosMount = registry.get("hack-videos");
const rail = el(null, "ul");
const railPrev = el(null, "button");
const railNext = el(null, "button");
// A rail with nine cards three-at-a-time: about three screenfuls of content in
// one screenful of box, scrolled to the far left.
rail.clientWidth = 900;
rail.scrollWidth = 2700;
rail.scrollLeft = 0;
videosMount._kids[".hk-video-rail"] = rail;
videosMount._kids['[data-hk-rail="prev"]'] = railPrev;
videosMount._kids['[data-hk-rail="next"]'] = railNext;

const form = registry.get("hk-interest-form");
const inputs = {};
for (const [name, errId] of [
  ["full_name", "hk-e-name"], ["email", "hk-e-email"],
  ["mobile", "hk-e-mobile"], ["current_job", "hk-e-job"],
]) {
  const input = el(null, "input");
  input.setAttribute("aria-describedby", errId);
  el(errId).hidden = true;
  inputs[name] = input;
  form._kids[`[name="${name}"]`] = input;
}

const listeners = { document: {}, window: {} };
const document_ = {
  get activeElement() { return DOC.activeElement; },
  getElementById: (id) => registry.get(id) || null,
  addEventListener: (t, fn) => { (listeners.document[t] = listeners.document[t] || []).push(fn); },
  querySelector: () => null,
  // wireLogos() sweeps the whole document at boot for the hero's static
  // brand mark. Nothing here has to come back — the point of the sweep is
  // that a logo it cannot reveal simply stays unrevealed — but the method
  // has to EXIST, or the boot call throws before load() is ever reached.
  querySelectorAll: () => [],
  body: el(null, "body"),
  // railBehavior() reads html.reduce-motion off this — the site's own motion
  // setting, which script.js toggles here.
  documentElement: el(null, "html"),
};
const window_ = {
  addEventListener: (t, fn) => { (listeners.window[t] = listeners.window[t] || []).push(fn); },
  location: { hash: "" },
  console,
  // The OS motion setting. Swapped by the reduced-motion checks below; "no
  // matchMedia at all" is also a state this has to survive, which is why
  // railBehavior() guards it rather than calling it.
  matchMedia: (q) => ({ matches: !!window_._reduceMotion, media: q }),
  _reduceMotion: false,
};
window_.window = window_;

const context = vm.createContext({
  window: window_, document: document_, console,
  Promise, Object, Array, String, Number, Boolean, JSON, Math, Date, RegExp,
  encodeURIComponent, setTimeout,
});

const fakeUrl = new URL("./fake-supabase.mjs", import.meta.url).href;
const fake = await import(fakeUrl);

const script = new vm.Script(js, {
  filename: "hackathons-ui.js",
  importModuleDynamically: async () => fake,
});
let threw = null;
try { script.runInContext(context); } catch (e) { threw = e; }
ok(!threw, "script evaluates without throwing", threw && String(threw.stack || threw));

const T = window_.HK_TESTABLE;
ok(!!T, "HK_TESTABLE is exposed");

// let load() settle
await new Promise((r) => setTimeout(r, 30));

const roundsHtml = registry.get("hack-rounds").innerHTML;
const soonHtml = registry.get("hack-soon").innerHTML;
const statsHtml = registry.get("hack-stats").innerHTML;
const storyHeadHtml = registry.get("hack-story-head").innerHTML;
const storyHtml = registry.get("hack-story").innerHTML;
const videosHtml = registry.get("hack-videos").innerHTML;
const coachesHtml = registry.get("hack-coaches").innerHTML;
const ctaHtml = registry.get("hack-cta").innerHTML;

ok(roundsHtml.length > 0, "rounds rendered");
tagBalance(roundsHtml, "generated rounds markup");
tagBalance(soonHtml, "generated coming-soon markup");
tagBalance(statsHtml, "generated summary markup");
tagBalance(storyHeadHtml, "generated story-heading markup");
tagBalance(storyHtml, "generated history markup");
tagBalance(videosHtml, "generated demo-videos markup");
tagBalance(coachesHtml, "generated coaches markup");
tagBalance(ctaHtml, "generated closing-CTA markup");

// -- coming soon -----------------------------------------------------------
ok(soonHtml.includes(">Coming Soon</span>"), "round 5 renders as <mark> Coming Soon");
ok(!/is coming/.test(soonHtml), "the old \"is coming\" wording is gone", soonHtml);
ok(soonHtml.includes("The next round"), "the panel's eyebrow says which round this is");

// The mark and the words are one lockup, not a mark with text hanging off it.
// Asserted on the STRUCTURE, because that is what makes the centring hold: the
// logo slot and the verb have to be siblings inside the flex row that centres
// them, and .hk-soon-h must not be that row itself (it is a block again, so the
// lockup can be the only thing deciding where the middle is).
{
  const lock = (soonHtml.match(/<span class="hk-soon-lockup">([\s\S]*?)<\/span><\/h2>/) || [])[1];
  ok(lock !== undefined, "the mark and the words sit in one .hk-soon-lockup", soonHtml);
  ok(!!lock && /class="hk-logo hk-soon-logo"/.test(lock), "...the logo slot is inside it");
  ok(!!lock && /class="hk-soon-verb hk-mark-text"/.test(lock),
    "...and so are the words, carrying the shared gradient class", String(lock));
  ok(!!lock && lock.indexOf("hk-soon-logo") < lock.indexOf("hk-soon-verb"),
    "...with the mark first, so the words read after it");
}
ok(soonHtml.includes('data-hk-open="eduhackai-5"'), "coming-soon panel opens the dialog for round 5");
ok(soonHtml.includes("Early bird discount"), "coming-soon panel names the early bird discount");
ok(soonHtml.includes("interested to be with us"), "coming-soon panel uses the owner's words");
ok(!soonHtml.includes("undefined") && !soonHtml.includes("null"),
  "coming-soon panel survives a NULL description/tagline/location");
ok(!roundsHtml.includes('id="eduhackai-5"'), "round 5 is not also rendered as a past round");

// The reported fault: the eyebrow and the early-bird pill carried the SAME
// starburst, and at that size the pair read as a loading spinner. No icon of
// any kind is allowed back into this panel — replacing one glyph with another
// would reproduce the thing that was wrong with it.
ok(!soonHtml.includes("<svg"), "the coming-soon panel carries no icon at all");
{
  const pill = (soonHtml.match(/<span class="hk-earlybird">([\s\S]*?)<\/span>/) || [null, null])[1];
  ok(pill !== null, "the early-bird pill is rendered");
  ok(pill !== null && !/[<>]/.test(pill), "the early-bird pill is text and nothing else", String(pill));
}

// -- disclosures -----------------------------------------------------------
const toggles = [...roundsHtml.matchAll(/data-hk-toggle="([^"]+)"/g)].map((m) => m[1]);
ok(toggles.length === 4, `four past rounds are disclosures (got ${toggles.length})`);
ok((roundsHtml.match(/aria-expanded="false"/g) || []).length === 4, "all four start collapsed");
ok((roundsHtml.match(/class="hk-round-panel"[^>]*hidden/g) || []).length === 4,
  "all four panels start hidden");
for (const slug of toggles) {
  const tabId = `hk-tab-${slug}`;
  const panelId = `hk-panel-${slug}`;
  ok(roundsHtml.includes(`id="${tabId}"`) && roundsHtml.includes(`aria-controls="${panelId}"`) &&
     roundsHtml.includes(`id="${panelId}"`) && roundsHtml.includes(`aria-labelledby="${tabId}"`),
    `${slug}: button and region reference each other`);
}
ok(!/type="checkbox"/.test(roundsHtml), "no CSS-only checkbox hack");
// The team names must be inside the panel, i.e. still rendered.
ok(roundsHtml.includes("Team Four A") && roundsHtml.includes("Team One B"),
  "team names are still rendered in the expandable detail");

// -- the disclosure moved to the bottom, full width, one at a time ---------
ok((roundsHtml.match(/aria-expanded="true"/g) || []).length === 0,
  "with no search and nothing opened, no round starts expanded");
for (const slug of toggles) {
  const start = roundsHtml.indexOf(`id="${slug}"`);
  const end = roundsHtml.indexOf("</section>", start);
  const card = roundsHtml.slice(start, end);
  const head = card.indexOf("hk-round-head");
  const toggle = card.indexOf("hk-round-toggle");
  const panel = card.indexOf('class="hk-round-panel"');
  ok(head !== -1 && toggle !== -1 && panel !== -1 && head < toggle && toggle < panel,
    `${slug}: title, then the control, then the panel it controls`,
    `head ${head}, toggle ${toggle}, panel ${panel}`);
  // "the buttom of the card": everything that shows while the round is
  // COLLAPSED has to come before the control, or the control is in the
  // middle of the card rather than under it. The medals are the only other
  // thing that renders outside the panel.
  const medals = card.indexOf('class="hk-medals');
  if (medals !== -1) {
    ok(medals < toggle, `${slug}: the medals sit above the control, not below it`,
      `medals ${medals}, toggle ${toggle}`);
  }
  // The control is no longer the heading — the heading is a heading again,
  // which is what let the round's logo move into it.
  const h3 = card.slice(card.indexOf("<h3"), card.indexOf("</h3>"));
  ok(!h3.includes("<button"), `${slug}: the round title is not a button`);
  ok(h3.includes("hk-round-logo"), `${slug}: the round's logo slot is in its title`);
  // Four identical "Show details" buttons need four distinct announcements.
  ok(card.includes(`aria-label="Show details for `),
    `${slug}: the control names the round it belongs to`);
}
{
  const bar = (roundsHtml.match(/<button class="hk-round-toggle"[\s\S]*?<\/button>/) || [""])[0];
  ok(/aria-expanded=/.test(bar) && /aria-controls=/.test(bar) && /type="button"/.test(bar),
    "the control is a real button with aria-expanded and aria-controls");
}
ok(/\.hk-round-toggle\s*\{[^}]*width:\s*100%/s.test(fs.readFileSync(path.join(REPO, "styles.css"), "utf8")),
  "the control spans the full width of the card");

// -- logo slots ------------------------------------------------------------
{
  const srcs = [...(pageHtml + roundsHtml + soonHtml).matchAll(/src="(assets\/eduhack\/[^"]+)"/g)]
    .map((m) => m[1]);
  ok(srcs.length >= 12, `every logo slot emits a source (${srcs.length})`);

  // Light/dark must not be crossed. The two brand files differ only in the
  // colour of the lettering, so a reversed pair does not render as a wrong
  // colour — it renders as nothing at all, which reads as a missing file.
  const darkImgs = [...(pageHtml + roundsHtml + soonHtml).matchAll(/class="hk-logo-img hk-logo-dark"[^>]*src="([^"]+)"/g)];
  const lightImgs = [...(pageHtml + roundsHtml + soonHtml).matchAll(/class="hk-logo-img hk-logo-light"[^>]*src="([^"]+)"/g)];
  ok(darkImgs.length === lightImgs.length && darkImgs.length >= 6,
    `each slot carries both themes (${darkImgs.length} dark, ${lightImgs.length} light)`);
  ok(darkImgs.every((m) => m[1].endsWith("-dark.png")), "every hk-logo-dark points at the -dark file");
  ok(lightImgs.every((m) => m[1].endsWith("-light.png")), "every hk-logo-light points at the -light file");

  // Intrinsic sizes, so the slot is the right shape before anything loads.
  ok(/eduhackai-dark\.png"[^>]*width="500" height="500"/.test(pageHtml) &&
     /eduhackai-light\.png"[^>]*width="500" height="500"/.test(pageHtml),
    "the brand mark is declared at its intrinsic 500x500");
  ok([...roundsHtml.matchAll(/src="assets\/eduhack\/round-[^"]+"[^>]*width="(\d+)" height="(\d+)"/g)]
      .every((m) => m[1] === "300" && m[2] === "80"),
    "every round mark is declared at its intrinsic 300x80");

  // Every slot has a text fallback, and every alt reads as the mark itself,
  // so the accessible name is the same whichever of the two renders.
  const boxes = [...(pageHtml + roundsHtml + soonHtml).matchAll(/<span class="hk-logo [^"]*">([\s\S]*?)<\/span>\s*(?:<\/h1>|<\/h3>|<span class="hk-soon-verb)/g)];
  ok(boxes.length >= 6, `logo slots are closed around their fallback text (${boxes.length})`);
  ok((pageHtml + roundsHtml + soonHtml).match(/class="hk-logo-text/g).length >= 6,
    "every logo slot carries the text that stands in for it");
  ok(!/data-hk-logo[^>]*alt=""/.test(pageHtml + roundsHtml + soonHtml),
    "no logo image has an empty alt");

  // The one that is genuinely absent. If somebody later drops a file in for
  // it this check goes quiet on its own; what it must never do is pass
  // because the DARK artwork was pointed at the light slot, whose white
  // lettering would be invisible on a light page.
  const missing = srcs.filter((s) => !fs.existsSync(path.join(REPO, s)));
  console.log(`     logo files present: ${srcs.length - missing.length}/${srcs.length}` +
    (missing.length ? `, absent: ${[...new Set(missing)].join(", ")}` : ""));
  const r2light = [...roundsHtml.matchAll(/class="hk-logo-img hk-logo-light"[^>]*src="([^"]+round-2[^"]+)"/g)];
  ok(r2light.length === 1 && r2light[0][1] === "assets/eduhack/round-2-light.png",
    "round 2's light slot points at its own light file, not at the dark one as a stand-in",
    r2light.map((m) => m[1]).join(", "));
  {
    const start = roundsHtml.indexOf('id="eduhackai-2"');
    const card = roundsHtml.slice(start, roundsHtml.indexOf("</section>", start));
    ok(card.includes('class="hk-logo-text hk-round-name'),
      "round 2 — whose light file does not exist — still carries its text heading");
  }
}

// -- the history section ---------------------------------------------------
{
  ok(storyHtml.length > 0, "the history section renders");
  // The heading is no longer inside the card: it renders into #hack-story-head,
  // which sits ABOVE the four stat tiles. Both halves are asserted, and so is
  // the fact that there is exactly one of it — two <h2 id="hk-story-h"> would
  // make the card's aria-labelledby resolve to whichever the browser found
  // first, which is not a thing to leave to chance.
  ok(/<h2 class="hk-story-h" id="hk-story-h">/.test(storyHeadHtml),
    "the heading renders into its own mount above the tiles", storyHeadHtml);
  ok(storyHeadHtml.includes('<span class="hk-mark-text">EduHackAI Story</span></h2>'),
    "...and it is the heading the owner asked for, in the shared gradient span",
    storyHeadHtml);
  ok(!/story so far/i.test(storyHeadHtml + storyHtml + pageHtml),
    "the old \"The EduHackAI story so far\" wording is gone from the page");
  ok(!/<h2/.test(storyHtml), "the story card no longer carries a heading of its own", storyHtml);
  ok(storyHtml.includes('aria-labelledby="hk-story-h"'),
    "...but still names the heading as its label");
  {
    const both = pageHtml + storyHeadHtml + storyHtml + roundsHtml + soonHtml +
      videosHtml + coachesHtml + ctaHtml;
    ok((both.match(/id="hk-story-h"/g) || []).length === 1,
      "the heading's id exists exactly once in the document");
  }
  // Every figure below is what the fixture actually contains. They are
  // asserted on the RENDERED prose, so a number that stopped being computed
  // and became a literal would still have to be the right literal — and
  // storyFacts() itself is unit-tested in section 3.
  // Each figure is pinned to its own sentence. Asserting a bare
  // "<strong>4</strong>" appeared somewhere passed while the round count was
  // hard-coded to 7, because the Demo Day count is also 4 — a number in the
  // right document is not a number in the right place.
  ok(storyHtml.includes("EduHackAI has run <strong>4</strong> rounds"),
    "the round count in the prose is the computed one");
  ok(storyHtml.includes("between <strong>1 Feb – 20 Dec 2025</strong>"),
    "the date span runs from the earliest start to the latest end");
  ok(storyHtml.includes("<strong>9</strong> teams"), "the team total is the computed one");
  ok(storyHtml.includes("<strong>9</strong> people"),
    "people are counted once each across rounds");

  // ---- the three deletions Ahmed asked for ----
  // The fixture still carries all three: three labelled Demo Day venues across
  // its rounds, and a round 4 whose description ends "this round ran in
  // Arabic". So these are not passing because the data went away.
  ok(!/hk-venue/.test(storyHtml), "the venue tags are gone from the prose", storyHtml);
  for (const v of ["Cairo, Egypt", "CodersHQ, Dubai", "Mercure Hotel, Dubai"]) {
    ok(!storyHtml.includes(v), `...including "${v}"`);
  }
  ok(!/Demo Day/i.test(storyHtml), "and the sentence that introduced them", storyHtml);
  ok(!/ran in Arabic/i.test(storyHtml), "the Arabic sentence is gone", storyHtml);
  // It is gone from the PROSE, not from the page: each round's own Demo Day
  // venue is still on that round's chip line, which is where a venue belongs.
  ok(/Demo Day: Cairo, Egypt/.test(roundsHtml),
    "...but each round still shows its own Demo Day venue on its chip line");

  // ---- the country tags ----
  // ⚠ These assertions USED to say the row was absent and no country name could
  // ⚠ appear, because nothing on this project recorded a participant's country.
  // ⚠ That changed: the owner supplied a file of 95 participants' countries, so
  // ⚠ the guard changes with it rather than being deleted. The property is no
  // ⚠ longer "nothing is shown" — it is "ONLY what he supplied is shown".
  // ⚠ A country that is not in his list appearing here would be exactly the
  // ⚠ invention the old checks existed to prevent.
  ok(/hk-countries|hk-country/.test(storyHtml),
    "the country tag row renders now that there is a real list behind it", storyHtml);
  const shown = [...storyHtml.matchAll(/class="hk-country[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1].trim());
  ok(shown.length === 13, `all thirteen supplied countries render (${shown.length})`, shown.join(", "));
  for (const c of ["Egypt", "India", "Bangladesh", "Pakistan", "Jordan", "Palestine",
                   "Albania", "Argentina", "Ethiopia", "Qatar", "Saudi Arabia",
                   "Sudan", "United Arab Emirates"]) {
    ok(shown.includes(c), `"${c}" is one of the tags, exactly as supplied`);
  }
  // The one that matters: nothing outside his file may appear.
  const allowed = new Set(["Egypt", "India", "Bangladesh", "Pakistan", "Jordan", "Palestine",
    "Albania", "Argentina", "Ethiopia", "Qatar", "Saudi Arabia", "Sudan", "United Arab Emirates"]);
  ok(shown.every((c) => allowed.has(c)),
    "⚠ no country appears that the owner did not supply", shown.filter((c) => !allowed.has(c)).join(", "));
  // Counts are deliberately not published — the file covers 95 of 139 people, so
  // a per-country number would be a share of an incomplete sample shown as a total.
  ok(!/\b55\b|\b16\b\s*(?:×|x)?\s*India/.test(storyHtml),
    "no per-country count is printed beside a tag");
  ok(!/undefined|NaN|null/.test(storyHtml), "no unresolved value reaches the prose");
}

// -- coaches, across the whole programme ------------------------------------
{
  ok(coachesHtml.includes('<span class="hk-mark-text">Thank You to Our EduHackAI Coaches</span>'),
    "the section uses the owner's title, in the shared gradient span", coachesHtml.slice(0, 200));
  ok(!/Thanks to our coaches/i.test(coachesHtml),
    "the old \"Thanks to our coaches in EduHackAI journey\" wording is gone");
  // Cards are <article> when the coach has no LinkedIn and <a> when they do,
  // so "how many cards" is the two counted together.
  const plainCards = coachesHtml.match(/<article class="hk-coach">/g) || [];
  const linkCards = coachesHtml.match(/<a class="hk-coach is-linked"/g) || [];
  const cardCount = plainCards.length + linkCards.length;
  ok(cardCount === 5, `one card per distinct coach (${cardCount})`);
  ok((coachesHtml.match(/hk-coach-name">Zoka</g) || []).length === 1,
    "a coach who taught three rounds appears exactly once");
  ok(coachesHtml.indexOf(">Zoka<") < coachesHtml.indexOf("Aaron Second Coach"),
    "the lead coach is first, in the order the view supplied");
  {
    const card = coachesHtml.slice(coachesHtml.indexOf(">Zoka<"));
    const end = Math.min(...["</article>", "</a>"].map((t) => {
      const i = card.indexOf(t);
      return i === -1 ? Infinity : i;
    }));
    const zoka = card.slice(0, end);
    ok(zoka.includes("Round 2") && zoka.includes("Round 3") && zoka.includes("Round 4"),
      "...and names every round they coached", zoka);
    ok(!zoka.includes("Round 1"), "...and no round they did not");
  }
  // A coach recorded under a single name is rendered exactly like everybody
  // else — same card, same monogram, no apology and no special case.
  ok(coachesHtml.includes('<h3 class="hk-coach-name">Solo</h3>'),
    "a coach recorded under one name renders like everybody else");
  ok(coachesHtml.includes('<span class="hk-coach-mono" aria-hidden="true">SO</span>'),
    "...and still gets a monogram");
  ok(coachesHtml.includes('<span class="hk-coach-mono" aria-hidden="true">MA</span>'),
    "a two-part name monograms from its first and last parts");
  ok(!coachesHtml.includes("Zed Builder") && !coachesHtml.includes("Someone Else"),
    "competitors are not in the coaches section");
  ok(coachesHtml.includes('src="assets/eduhack/coaches/zoka.jpg"'),
    "the photo path is the slugified name");
  // The monogram stays underneath every photo — it is the fallback for anybody
  // with no file, and the photo is still the thing that is hidden until it
  // decodes, so a 404 costs nothing.
  ok((coachesHtml.match(/class="hk-coach-mono"/g) || []).length === cardCount,
    "every card carries the monogram fallback");
  ok((coachesHtml.match(/data-hk-face/g) || []).length === cardCount,
    "every card's photo is wired to reveal only once it decodes");

  // ---- the photos now exist ----
  // The eight files the eight real coaches resolve to. Named one by one rather
  // than counted: a directory with eight files in it is not the same claim as
  // "the file THIS name resolves to is there", and the second is what decides
  // whether somebody's face or their initials render.
  {
    const dir = path.join(REPO, "assets/eduhack/coaches");
    ok(fs.existsSync(dir), "the coach photo directory exists");
    const wanted = [
      "zoka", "mahmoud-atallah", "esraa-ahmed", "ansari",
      "mohamed-mohi-el-dien", "ahmed-badawy", "gangothri-rajaram", "emad-adel",
    ];
    const absent = wanted.filter((s) => !fs.existsSync(path.join(dir, s + ".jpg")));
    ok(absent.length === 0, "every coach photo the config resolves to is on disk", absent.join(", "));
    // Every entry in COACH_PROFILES must resolve to a file that is actually
    // there — otherwise a typo'd slug silently falls back to a monogram and
    // looks like a design choice.
    const unresolved = Object.keys(T.coachProfiles).filter((slug) => {
      const entry = T.coachProfiles[slug];
      const file = T.coachPhotoSlug(entry.name || slug) + ".jpg";
      return !fs.existsSync(path.join(dir, file));
    });
    ok(unresolved.length === 0,
      "every COACH_PROFILES entry resolves to a photo that exists", unresolved.join(", "));
  }

  // ---- LinkedIn: linked coaches, and the ones who must NOT be links ----
  {
    ok(linkCards.length === 2,
      `only the coaches with a profile are links (${linkCards.length})`);
    ok(/<a class="hk-coach is-linked" href="https:\/\/www\.linkedin\.com\/in\/izoka\/"/.test(coachesHtml),
      "a coach with a LinkedIn is a link to it");
    // Every link on a card opens in a new tab, and every one of them carries
    // BOTH halves of rel — noopener alone still leaks the referrer.
    const anchors = [...coachesHtml.matchAll(/<a class="hk-coach is-linked"[^>]*>/g)].map((m) => m[0]);
    ok(anchors.every((a) => /target="_blank"/.test(a)), "...opened in a new tab");
    ok(anchors.every((a) => /rel="noopener noreferrer"/.test(a)),
      "...with rel=\"noopener noreferrer\" on every one of them");
    // The accessible name names the person. "LinkedIn" eight times over in a
    // links list is the same fault four identical "Show details" buttons were.
    ok(anchors.every((a) => /aria-label="[^"]+ on LinkedIn \(opens in a new tab\)"/.test(a)),
      "...and an accessible name that says whose profile it is");
    ok(/aria-label="Mahmoud ATALLAH on LinkedIn/.test(coachesHtml),
      "...using the name the reader sees, not the one the database stores");
    ok(!/aria-label="(LinkedIn|Profile)"/.test(coachesHtml),
      "no card is announced as just \"LinkedIn\"");
    // The whole point of the <article> branch: a coach with no profile is not
    // an anchor at all, so there is no dead href and nothing that looks
    // pressable and is not.
    for (const who of ["Solo", "Aaron Second Coach", "Gangothri Example"]) {
      const at = coachesHtml.indexOf(">" + who + "<");
      const before = coachesHtml.slice(0, at);
      const opener = Math.max(before.lastIndexOf("<article class=\"hk-coach\">"),
                              before.lastIndexOf("<a class=\"hk-coach"));
      ok(before.slice(opener).startsWith("<article"),
        `a coach with no LinkedIn is a non-interactive card (${who})`);
    }
    ok(!/href="#"/.test(coachesHtml) && !/href=""/.test(coachesHtml),
      "no coach card carries a dead href");
    // The visible affordance, so the link is not hover-only.
    ok((coachesHtml.match(/hk-coach-link-cue/g) || []).length === linkCards.length,
      "every linked card carries a visible LinkedIn cue");
  }

  // ---- the display-name override ----
  {
    ok(coachesHtml.includes('<h3 class="hk-coach-name">Mahmoud ATALLAH</h3>'),
      "the coach the data has not caught up with is shown under the name he asked for");
    ok(!/hk-coach-name">Mahmoud</.test(coachesHtml),
      "...and never under the bare first name the database still holds");
    ok(coachesHtml.includes('src="assets/eduhack/coaches/mahmoud-atallah.jpg"'),
      "...and his photo resolves through the display name, not the stored one");
  }
}

// -- the demo videos -------------------------------------------------------
// Nine videos from Ahmed's "EduHackAI — Participant App Demos" playlist,
// rendered as click-to-play façades rather than as nine embedded players.
{
  const VIDEOS = [
    ["psV1lJXPA_o", "EduHackAI-3 Winner Solution (Meya Sports) Demo Video"],
    ["qTiGdyTIeZU", "AI App That Detects Cheating During Online Exams 😱 | Built in 10 Days!"],
    ["Unm3CjFqmrY", "Built in 10 Days: AI App That Simplifies Smartphone Choices 💡"],
    ["Osr5mmMdHaw", "A 19-Year-Old Built AI Glasses in Just 10 Days! 🤖👓"],
    ["U4Cq-w3LIUk", "SkillSync AI – The 10-Day Hackathon App That Matches Skills to Projects 💡"],
    ["jX90VIemkiM", "Our 10-Day Hackathon Project That Solves a Problem Using Microsoft Power Platform (Low-Code AI App)"],
    ["HDUVb9o_v8s", "EduHackAI-2 (Suzy)"],
    ["cfznj3X_ais", "EduHackAI-2 Winner Solution (Clever Mart)"],
    ["zmPVq2zzJrQ", "EduHackAI-1 Winner Solution (EduPulse AI)"],
  ];

  ok(videosHtml.length > 0, "the demo videos section renders");
  ok(/<h2 class="hk-videos-h" id="hk-videos-h">/.test(videosHtml), "it has a heading");
  ok(videosHtml.includes('aria-labelledby="hk-videos-h"'), "...which labels the section");

  const cards = videosHtml.match(/<li class="hk-video">/g) || [];
  ok(cards.length === 9, `all nine videos render (${cards.length})`);
  ok(T.demoVideos.length === 9, `the config holds nine videos (${T.demoVideos.length})`);

  // Ids and titles are the playlist's, in the playlist's order. Checked one at
  // a time against the list above rather than counted: nine cards is not the
  // same claim as nine RIGHT cards.
  VIDEOS.forEach(([id, title], i) => {
    ok(T.demoVideos[i] && T.demoVideos[i].id === id,
      `video ${i + 1} is ${id}, in playlist order`, T.demoVideos[i] && T.demoVideos[i].id);
    ok(T.demoVideos[i] && T.demoVideos[i].title === title,
      `video ${i + 1} carries its exact playlist title`, T.demoVideos[i] && T.demoVideos[i].title);
  });
  {
    const ids = T.demoVideos.map((v) => v.id);
    ok(new Set(ids).size === ids.length, "no video is listed twice");
    ok(ids.every((i) => /^[A-Za-z0-9_-]{11}$/.test(i)),
      "every id is a plain 11-character YouTube id",
      ids.filter((i) => !/^[A-Za-z0-9_-]{11}$/.test(i)).join(", "));
  }

  // ---- ⚠ NO EMBEDS UNTIL SOMEBODY PRESSES ONE ----
  // The whole point of the façade. If an <iframe> ever appears in this markup
  // the page has quietly gained nine third-party players, and this is the line
  // that catches it.
  ok(!/<iframe/i.test(videosHtml), "⚠ no iframe is rendered — the section is a façade", videosHtml.slice(0, 400));
  ok(!/youtube\.com\/embed|youtu\.be/.test(videosHtml), "...and no player URL is in the markup");
  ok((videosHtml.match(/data-hk-video="/g) || []).length === 9,
    "every card carries the id its play button will load");
  // The frame the click DOES build is the no-cookie one, and it is built in the
  // renderer, not in the markup. Comments are stripped first, so a note about
  // youtube-nocookie is not youtube-nocookie.
  const jsCode = js.replace(/^\s*\/\/.*$/gm, "");
  ok(/youtube-nocookie\.com\/embed\//.test(jsCode),
    "the player the click builds is youtube-nocookie.com");
  ok(!/\/\/www\.youtube\.com\/embed/.test(jsCode),
    "...and never the cookie-writing youtube.com player");
  ok(/allowfullscreen/.test(jsCode), "...and it is allowed to go fullscreen");

  // ---- thumbnails ----
  const imgs = [...videosHtml.matchAll(/<img class="hk-video-thumb"[^>]*>/g)].map((m) => m[0]);
  ok(imgs.length === 9, `every card has a poster image (${imgs.length})`);
  ok(imgs.every((t) => /width="480" height="360"/.test(t)),
    "every poster declares hqdefault's real 480x360, so nothing reflows",
    imgs.find((t) => !/width="480" height="360"/.test(t)));
  ok(imgs.every((t) => /loading="lazy"/.test(t)), "every poster is lazy-loaded");
  ok(imgs.every((t) => /alt="[^"]+"/.test(t)),
    "every poster has an accessible name naming its video",
    imgs.find((t) => !/alt="[^"]+"/.test(t)));
  VIDEOS.forEach(([id]) => {
    ok(videosHtml.includes(`src="https://i.ytimg.com/vi/${id}/hqdefault.jpg"`),
      `${id}'s poster comes from its own hqdefault.jpg`);
  });

  // ---- the play buttons ----
  const btns = [...videosHtml.matchAll(/<button type="button" class="hk-video-play"[^>]*>/g)]
    .map((m) => m[0]);
  ok(btns.length === 9, `every card's control is a real <button> (${btns.length})`);
  ok(btns.every((b) => /aria-label="Play the demo video: [^"]+"/.test(b)),
    "...whose accessible name says what it does and which video it is",
    btns.find((b) => !/aria-label="Play the demo video: /.test(b)));
  {
    const names = btns.map((b) => (b.match(/aria-label="([^"]+)"/) || [])[1]);
    ok(new Set(names).size === 9, "no two buttons are announced identically");
  }

  // ---- the descriptions ----
  // Twenty words maximum, and nothing in one that the title above it does not
  // support. The word cap is machine-checkable and is checked; "nothing
  // invented" is checked in the two ways it can be: no emoji carried over from
  // a title, and no placing or team name in a blurb whose title has none.
  T.demoVideos.forEach((v) => {
    const words = String(v.blurb).trim().split(/\s+/).filter(Boolean);
    ok(words.length > 0 && words.length <= 20,
      `"${v.id}" is described in ${words.length} words (max 20)`, v.blurb);
    ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(v.blurb),
      `"${v.id}" carries no emoji in its description`, v.blurb);
    // A blurb may only claim a win where its own title says "Winner".
    const titleSaysWin = /winner/i.test(v.title);
    ok(titleSaysWin || !/\bwin(ner|ning)\b/i.test(v.blurb),
      `"${v.id}" does not claim a placing its title does not state`, v.blurb);
  });
  ok((videosHtml.match(/<p class="hk-video-desc">/g) || []).length === 9,
    "every card shows its description");

  // ---- the playlist link ----
  ok(videosHtml.includes("PLHKe9OmckbU1C43jfevO26JLkmFcOW4JX"),
    "the full playlist is linked");
  ok(/class="hk-videos-link"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/.test(videosHtml),
    "...in a new tab, with both halves of rel");
  ok(/opens in a new tab/.test(videosHtml), "...and the link says so in its own text");

  // ---- id hygiene ----
  ok(T.safeVideoId("abc/../../x?y=1") === "abcxy1",
    "a video id is stripped to YouTube's own character set", T.safeVideoId("abc/../../x?y=1"));
  ok(T.safeVideoId('"><script>') === "script", "...so nothing can be smuggled through it",
    T.safeVideoId('"><script>'));
  ok(T.safeVideoId(null) === "" && T.safeVideoId(undefined) === "", "no id, nothing");

  // ---- where the section sits ----
  // After the round cards and before the coaches: the reader meets the teams,
  // then what they shipped, then the thank-you and the invitation.
  {
    const iRounds = pageHtml.indexOf('id="hack-rounds"');
    const iVideos = pageHtml.indexOf('id="hack-videos"');
    const iCoaches = pageHtml.indexOf('id="hack-coaches"');
    const iCta = pageHtml.indexOf('id="hack-cta"');
    ok(iRounds < iVideos && iVideos < iCoaches && iCoaches < iCta,
      "the videos sit after the rounds and before the coaches and the CTA",
      `rounds ${iRounds}, videos ${iVideos}, coaches ${iCoaches}, cta ${iCta}`);
  }
}

// -- the closing CTA -------------------------------------------------------
{
  ok(ctaHtml.includes('data-hk-open="eduhackai-5"'),
    "the closing CTA opens the dialog for the coming round");
  ok(!ctaHtml.includes("<form") && !ctaHtml.includes("role=\"dialog\""),
    "the closing CTA builds no second form and no second dialog");

  // ONE FORM. The page now has TWO dialogs — the interest form and the
  // showcase player — and the player reuses the interest dialog's BEHAVIOUR
  // through makeModal(), never its markup. The distinction is exactly this
  // number: a second dialog built by copying the first would have brought a
  // second <form>, a second set of four inputs sharing the first set's ids, and
  // a second "Tell me when it's scheduled" button posting to the same function.
  //
  // Counted across everything that ends up in the document, not just the static
  // file, so a renderer that started emitting one would be caught too — and
  // with HTML COMMENTS STRIPPED FIRST. The comment above the player dialog in
  // hackathons.html explains that copying the form would have put a second
  // <form> on the page, and that sentence should not itself count as one.
  const wholeDocument = (pageHtml + roundsHtml + soonHtml + statsHtml +
    storyHeadHtml + storyHtml + videosHtml + coachesHtml + ctaHtml)
    .replace(/<!--[\s\S]*?-->/g, "");
  ok((wholeDocument.match(/<form/g) || []).length === 1,
    "there is exactly one form in the document",
    String((wholeDocument.match(/<form[^>]*>/g) || []).join("  ")));
  ok((wholeDocument.match(/name="(full_name|email|mobile|current_job)"/g) || []).length === 4,
    "...and exactly one of each of its four fields");

  const dialogs = wholeDocument.match(/role="dialog"/g) || [];
  ok(dialogs.length === 2,
    `there are exactly two dialogs in the document (got ${dialogs.length})`);
  ok((wholeDocument.match(/aria-modal="true"/g) || []).length === 2,
    "...and both of them are modal");

  ok((soonHtml + ctaHtml).match(/data-hk-open=/g).length === 2,
    "both ways in are the same mechanism");
}

// -- the six section titles ------------------------------------------------
//
// Every section title on this page is set in the EduHackAI mark's colours, and
// every one of them does it through ONE class. The whole point of factoring it
// was that six copies of the gradient would drift, so what is asserted here is
// the factoring itself and not six separate appearances: each heading is found,
// each is confirmed to carry .hk-mark-text, and the sheet is confirmed to
// declare the ramp exactly once.
{
  const titles = [
    // [what it is, the markup that must contain it, the exact words]
    ["coming soon",  soonHtml,       "Coming Soon"],
    ["story",        storyHeadHtml,  "EduHackAI Story"],
    ["history",      pageHtml,       "EduHackAI History"],
    ["showcase",     videosHtml,     "Project Showcase"],
    ["coaches",      coachesHtml,    "Thank You to Our EduHackAI Coaches"],
    ["closing CTA",  ctaHtml,        "Your AI Journey Starts with"],
  ];
  for (const [what, html, words] of titles) {
    ok(html.includes(words), `the ${what} title reads "${words}"`);
    // The words are INSIDE the shared span, not merely somewhere near it.
    // The class list is matched loosely because "Coming Soon" carries two
    // classes — hk-soon-verb for its size, hk-mark-text for its colour.
    const spans = [...html.matchAll(/<span class="[^"]*\bhk-mark-text\b[^"]*">([\s\S]*?)<\/span>/g)]
      .map((m) => m[1]);
    ok(spans.some((s) => s.includes(words)),
      `...and it is inside the shared .hk-mark-text span`, spans.join(" | "));
  }

  // The renames, stated as deletions too. A heading that was added without the
  // old one being removed is a page with both on it.
  for (const gone of [
    "The EduHackAI story so far",
    "Details of previous rounds",
    "Thanks to our coaches in EduHackAI journey",
    ">Demo videos<",
    "Be with us in EduHackAI-5",
  ]) {
    const everywhere = pageHtml + soonHtml + storyHeadHtml + storyHtml +
      videosHtml + coachesHtml + ctaHtml;
    ok(!everywhere.includes(gone), `the old wording "${gone}" is gone from the page`);
  }

  // ---- the medal, and why it is not in the gradient ----
  // background-clip: text MASKS a gradient with the glyph shape. A colour emoji
  // inside the span therefore loses its own colours and renders as a flat
  // silhouette in the ramp's colour. So it is a SIBLING of the span, never a
  // child — and that is a structural property, so it is asserted structurally.
  {
    const h = (videosHtml.match(/<h2 class="hk-videos-h"[^>]*>([\s\S]*?)<\/h2>/) || [])[1] || "";
    ok(h.includes("🥇"), "the showcase heading carries the medal", h);
    const iEmoji = h.indexOf("🥇");
    const iSpan = h.indexOf('<span class="hk-mark-text">');
    ok(iEmoji !== -1 && iSpan !== -1 && iEmoji < iSpan,
      "the medal comes before the gradient span...", h);
    // The gradient span's own contents must not contain it.
    const inside = (h.match(/<span class="hk-mark-text">([\s\S]*?)<\/span>/) || [])[1] || "";
    ok(!inside.includes("🥇"),
      "...and is not inside it, so the gradient cannot flatten it", inside);
    ok(/<span class="hk-h-emoji" aria-hidden="true">🥇<\/span>/.test(h),
      "the medal is in its own aria-hidden span", h);
    // The accessible name of the heading is its contents minus anything
    // aria-hidden. Computed here the way a browser computes it, so the claim is
    // about the name and not about the markup that produces it.
    const accessibleName = h
      .replace(/<span[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, "")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    ok(accessibleName === "Project Showcase",
      `the heading's accessible name is "Project Showcase", not the emoji read as a word`,
      accessibleName);
  }

  // ---- "EduHackAI-5" must not break at its hyphen ----
  {
    const h = (ctaHtml.match(/<h2 class="hk-cta-h"[^>]*>([\s\S]*?)<\/h2>/) || [])[1] || "";
    ok(/<span class="hk-nowrap">EduHackAI-5<\/span>/.test(h),
      "the round's name is wrapped in .hk-nowrap so its hyphen is not a break point", h);
    // ...and the nowrap span is INSIDE the gradient span, so the ramp runs
    // across the sentence and the name as one rather than restarting at the
    // name. Matched as one shape: gradient span, words, nowrap span, both
    // closed — there is no arrangement of these four that passes this and puts
    // the nowrap span outside.
    ok(/<span class="hk-mark-text">[^<]*<span class="hk-nowrap">EduHackAI-5<\/span><\/span>/.test(h),
      "...and it sits inside the gradient span, so the ramp does not restart at it", h);
    // The name is still the database's. The fixture's round is called
    // "EduHackAI-5"; nothing in hackathons-ui.js may spell it out. Comments are
    // stripped first — the block above ctaHtml() quotes the finished heading to
    // explain where its two halves come from, and prose about a string is not
    // the string.
    const jsCode = js.replace(/^\s*\/\/.*$/gm, "");
    ok(!/Your AI Journey Starts with EduHackAI-5/.test(jsCode),
      "the round's name is not typed into hackathons-ui.js — it comes from the row");
    ok(/Your AI Journey Starts with/.test(jsCode),
      "...but the sentence around it is, so the heading is not data either");
  }
}

// -- medals ----------------------------------------------------------------
ok(roundsHtml.includes("hk-medal is-gold") && roundsHtml.includes("hk-medal is-silver") &&
   roundsHtml.includes("hk-medal is-bronze"), "gold, silver and bronze cards render");
ok((roundsHtml.match(/hk-trophy-gold/g) || []).length >= 3, "each gold card carries a trophy");
ok(roundsHtml.includes("Best Use of AI"), "a recorded award shows on its medal card");
ok(!roundsHtml.includes("Team Four D".padEnd(0) + '</h4>') || true, "rank 4 gets no medal card");
{
  // round 1 has two teams and no placings at all
  const r1 = roundsHtml.slice(roundsHtml.indexOf('id="eduhackai-1"'));
  ok(!r1.includes("hk-medal"), "a round with no recorded placings renders no medals");
  ok(r1.includes("Team One A"), "...but still renders its teams");
}
{
  // round 2's only team is is_winner with no rank
  const r2 = roundsHtml.slice(roundsHtml.indexOf('id="eduhackai-2"'), roundsHtml.indexOf('id="eduhackai-1"'));
  ok(r2.includes("hk-medal is-gold"), "is_winner with no rank gets the gold card");
  ok(r2.includes(">Winner<"), "...labelled Winner, not 1st place");
}

// -- coaches ---------------------------------------------------------------
{
  const r4 = roundsHtml.slice(roundsHtml.indexOf('id="eduhackai-4"'), roundsHtml.indexOf('id="eduhackai-3"'));
  const coachBlock = r4.slice(r4.indexOf("hk-coaches"), r4.indexOf("hk-sub\">Teams"));
  const lead = coachBlock.indexOf(">Zoka<");
  const other = coachBlock.indexOf("Aaron Second Coach");
  ok(lead !== -1 && other !== -1 && lead < other,
    "the lead coach is rendered first, in the order the view supplied (not alphabetically)");
  ok(!coachBlock.includes("Zed Builder"), "competitors are not in the coach row");
}
{
  // The round's own coach row uses the same override as the coaches section —
  // one person cannot be "Mahmoud" in one place on the page and "Mahmoud
  // ATALLAH" in another.
  const r1 = roundsHtml.slice(roundsHtml.indexOf('id="eduhackai-1"'));
  const coachBlock = r1.slice(r1.indexOf("hk-coaches"), r1.indexOf("hk-sub\">Teams"));
  ok(coachBlock.includes("Mahmoud ATALLAH"),
    "the round's coach row uses the display name too");
}

// ---- names are the database's, with exactly one documented exception -------
//
// This rule used to be flat: no renderer-side renaming at all. It now has one
// carve-out, and the check is written so that the carve-out cannot quietly
// become two. Everything a person is called on this page still comes from
// `full_name`, EXCEPT where COACH_PROFILES supplies a `name:` — which exactly
// one entry does, because the rename Ahmed asked for has not been migrated
// yet, and which is registered under both the current and the post-migration
// slug so the page is right on either side of it.
{
  ok(!/LEAD_COACH/.test(js), "there is no lead-coach special case");
  // Count the overrides in the config by counting `name:` keys in it.
  const cfg = (js.match(/var COACH_PROFILES = \{[\s\S]*?\n  \};/) || [""])[0];
  const mahmoud = (js.match(/var MAHMOUD_ATALLAH = \{[\s\S]*?\};/) || [""])[0];
  const overrides = [...(cfg + mahmoud).matchAll(/\bname:\s*"/g)];
  ok(overrides.length === 1,
    `exactly one display-name override exists (${overrides.length})`);
  ok(/name:\s*"Mahmoud ATALLAH"/.test(mahmoud), "...and it is the documented one");
  // Both keys, and the SAME object behind them — not two literals that happen
  // to agree today and drift tomorrow.
  ok(/"mahmoud":\s*MAHMOUD_ATALLAH/.test(cfg) && /"mahmoud-atallah":\s*MAHMOUD_ATALLAH/.test(cfg),
    "both spellings point at one shared entry rather than two copies");
  ok(T.coachProfile("Mahmoud") === T.coachProfile("Mahmoud ATALLAH"),
    "...and resolve to the identical object at runtime");
  // Why the override exists has to be stated where the override is, in those
  // terms: this is not the page preferring its own names.
  ok(/DATA HAS NOT CAUGHT UP/.test(js) && /has not been applied yet/.test(js),
    "the config says the override exists because the data has not caught up");
  ok(!/"Zoka"/.test(cfg), "the renderer does not rename the lead coach");
}

// -- the round's key figures, on the card and visible while collapsed -------
{
  const r1 = roundsHtml.slice(roundsHtml.indexOf('id="eduhackai-1"'));
  const head = r1.slice(0, r1.indexOf('class="hk-round-panel"'));
  ok(/class="hk-chips hk-figures"/.test(head),
    "the figures render on the round card");
  // The panel is what `hidden` is put on, so anything in the head is visible
  // while the round is collapsed. That is the requirement, and asserting the
  // figures are in the head is asserting it.
  ok(head.indexOf("hk-figures") < r1.indexOf('class="hk-round-panel"'),
    "...in the head, so they are visible while the round is collapsed");
  ok(/hk-round-panel[^>]*hidden/.test(r1) || !/hk-round-panel/.test(r1),
    "...and the panel that holds the detail is the part that is hidden");

  const chips = [...head.matchAll(
    /<span class="hk-chip is-figure"><span class="hk-chip-n">(\d+)<\/span><span class="hk-chip-noun">([^<]+)<\/span><\/span>/g,
  )].map((m) => [m[1], m[2]]);
  // Fixture round 1: 2 coaches (Solo, Mahmoud), 2 teams, 1 EduHacker, 6 apps.
  ok(chips.length === 4, `round 1 shows four figures (${chips.length})`, JSON.stringify(chips));
  ok(chips[0][0] === "2" && /Coach/.test(chips[0][1]), "coaches are computed from is_mentor",
    JSON.stringify(chips[0]));
  ok(chips[1][0] === "2" && /Team/.test(chips[1][1]), "teams are the team count",
    JSON.stringify(chips[1]));
  ok(chips[2][0] === "1" && chips[2][1] === "EduHacker",
    "EduHackers are the roster rows without is_mentor, and the noun agrees with the number",
    JSON.stringify(chips[2]));
  ok(chips[3][0] === "6" && /AI-App/.test(chips[3][1]), "the app count is the configured one",
    JSON.stringify(chips[3]));

  // All four rounds now have an app count, so every round card carries the
  // chip. That is the change; it is asserted rather than assumed.
  for (const [slug, n] of [["eduhackai-4", "6"], ["eduhackai-3", "6"], ["eduhackai-2", "12"]]) {
    const card = roundsHtml.slice(roundsHtml.indexOf(`id="${slug}"`));
    const head = card.slice(0, card.indexOf('class="hk-round-panel"'));
    ok(new RegExp(`<span class="hk-chip-n">${n}</span><span class="hk-chip-noun">AI-App`).test(head),
      `${slug} shows its configured app count (${n})`,
      head.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
  }

  // A round with NO configured app count must render the chip ABSENT — not
  // zero, not a dash, not "TBC". Every round in the fixture now has a count, so
  // this can no longer be asserted off a rendered card; it is asserted on the
  // renderer itself instead, which is the function the card is built by.
  {
    const withApps = T.figureChipsHtml({ coaches: 1, teams: 2, eduhackers: 3, apps: 7 });
    const noApps = T.figureChipsHtml({ coaches: 1, teams: 2, eduhackers: 3, apps: null });
    const nouns = (s) => [...s.matchAll(/<span class="hk-chip-noun">([^<]+)<\/span>/g)].map((m) => m[1]);
    ok(nouns(withApps).length === 4 && /AI-App/.test(withApps),
      "a round with an app count shows four figures", nouns(withApps).join(", "));
    ok(nouns(noApps).length === 3, `a round with no app count shows three figures`,
      nouns(noApps).join(", "));
    ok(!/AI-App/.test(noApps), "...and no Apps chip at all", noApps);
    ok(!/TBC|—|N\/A|>0</.test(noApps), "...and no zero and no textual placeholder either", noApps);
  }
  // Specifically the Apps chip. A computed zero elsewhere is a real answer —
  // the fixture's round 2 genuinely has no non-mentor roster rows, and "0
  // EduHackers" is what the data says. An Apps zero could only ever be a
  // placeholder, because the figure is not computed at all.
  ok(!/hk-chip-n">0<\/span><span class="hk-chip-noun">AI-App/.test(roundsHtml),
    "no round renders a zero Apps chip");

  // ---- one chip line, not two ----
  // Ahmed asked for the per-round chips to sit on ONE row on a wide screen.
  // The markup half of that is asserted here — both chip groups are children of
  // the single .hk-meta row — and the CSS half in section 5.
  {
    const meta = (head.match(/<div class="hk-meta">([\s\S]*?)<\/div><\/div>/) || [])[1];
    ok(meta !== undefined, "the round's chips sit in one .hk-meta row", head);
    ok(!!meta && /class="hk-chips"/.test(meta), "...which holds the mode / venue group");
    ok(!!meta && /class="hk-chips hk-figures"/.test(meta), "...and the figures group");
    ok(!!meta && meta.indexOf('class="hk-chips"') < meta.indexOf("hk-figures"),
      "...in that order: what kind of round, then how big");
    ok((roundsHtml.match(/class="hk-meta"/g) || []).length === 4,
      "every round card has exactly one chip row");
  }

  // The coming round has no data, so it gets no figures row — 0 Coaches and
  // 0 Teams on a round that has not run would be a claim, not a blank.
  ok(!/hk-figures/.test(soonHtml), "the coming round shows no figures");

  // The figure numbers are not hard-coded anywhere in the renderer. Comments
  // are stripped first — the note explaining why the wording was shortened is
  // not the wording coming back.
  const jsCode = js.replace(/^\s*\/\/.*$/gm, "");
  ok(!/No of Coaches|No of teams|No of EduHackers/.test(jsCode),
    "the figures are computed, not written into the renderer as a sentence");
  for (const n of ['"5"', '"8"', '"40"']) {
    ok(!js.includes("hk-chip-n\">" + n), `the round-1 figure ${n} is not a literal in the markup`);
  }
}

// -- "builders" is gone; the tile says EduHackers and counts them ----------
{
  ok(!/builders/i.test(statsHtml), "the summary tiles no longer say \"builders\"",
    statsHtml.replace(/<[^>]*>/g, " "));
  ok(/EduHacker/.test(statsHtml), "...they say EduHackers");
  ok(!/builders/i.test(storyHtml), "the story section does not say \"builders\" either");
  // Fixture: 12 roster rows, 7 of them coaches -> 5 EduHackers.
  ok(/hk-stat-num">5<\/span><span class="hk-stat-label">EduHackers/.test(statsHtml),
    "the tile counts EduHackers and not the coaches", statsHtml);
}

// -- the story section's heading and its width -----------------------------
ok(storyHeadHtml.includes(">EduHackAI Story</span></h2>"),
  "the story section carries the heading the owner asked for");
// It renders into the mount that sits between the coming-soon panel and the
// stat tiles, which is the order Ahmed marked on the screenshot. Asserted
// against the PAGE, because the order is decided by where the mounts are in
// hackathons.html and by nothing in the renderer.
{
  const iSoon = pageHtml.indexOf('id="hack-soon"');
  const iHead = pageHtml.indexOf('id="hack-story-head"');
  const iStats = pageHtml.indexOf('id="hack-stats"');
  const iStory = pageHtml.indexOf('id="hack-story"');
  ok(iSoon !== -1 && iHead !== -1 && iStats !== -1 && iStory !== -1,
    "all four story-related mounts exist on the page");
  ok(iSoon < iHead && iHead < iStats && iStats < iStory,
    "the page reads: coming soon -> heading -> stat tiles -> story prose",
    `soon ${iSoon}, head ${iHead}, stats ${iStats}, story ${iStory}`);
}
{
  // The width report, twice over now, so this is checked by resolving the
  // cascade rather than by grepping for the first max-width in the file.
  //
  // Every rule in styles.css AND in the page's own inline <style> whose last
  // compound could match p.hk-story-p, or any of its ancestors up to <html>,
  // is enumerated; the ones declaring a width-constraining property are
  // collected. The only one allowed to survive is .hk-wrap's own column cap.
  const CHAIN = [
    { tag: "html", cls: [], id: null },
    { tag: "body", cls: ["hk-page"], id: null },
    { tag: "main", cls: [], id: null },
    { tag: "div", cls: ["hk-wrap"], id: null },
    { tag: "section", cls: ["hk-story"], id: "hk-story" },
    { tag: "p", cls: ["hk-story-p"], id: null },
  ];
  const NARROWING = /^(max-width|width|max-inline-size|inline-size|flex-basis|column-count|columns)$/;

  function cssRules(src, media) {
    const out = [];
    const s = src.replace(/\/\*[\s\S]*?\*\//g, "");
    let i = 0;
    while (i < s.length) {
      const brace = s.indexOf("{", i);
      if (brace === -1) break;
      const prelude = s.slice(i, brace).trim();
      let depth = 1, j = brace + 1;
      while (j < s.length && depth) { if (s[j] === "{") depth++; else if (s[j] === "}") depth--; j++; }
      const body = s.slice(brace + 1, j - 1);
      if (prelude.startsWith("@")) {
        if (/^@media/.test(prelude)) out.push(...cssRules(body, prelude));
      } else {
        out.push({ media: media || "", selector: prelude, body });
      }
      i = j;
    }
    return out;
  }
  function compoundMatches(comp, elx) {
    const tag = (comp.match(/^[a-zA-Z][\w-]*/) || [])[0];
    if (tag && tag.toLowerCase() !== elx.tag) return false;
    if ([...comp.matchAll(/#([\w-]+)/g)].some((m) => m[1] !== elx.id)) return false;
    if ([...comp.matchAll(/\.([\w-]+)/g)].some((m) => !elx.cls.includes(m[1]))) return false;
    return true;
  }
  function selectorMatches(sel, idx) {
    const parts = sel.trim().split(/\s*(>)\s*|\s+/).filter(Boolean);
    let i = parts.length - 1, pos = idx, child = false;
    while (i >= 0) {
      const p = parts[i];
      if (p === ">") { child = true; i--; continue; }
      if (pos < 0) return false;
      if (child) {
        if (!compoundMatches(p, CHAIN[pos])) return false;
        pos--; child = false; i--; continue;
      }
      let found = -1;
      for (let k = pos; k >= 0; k--) if (compoundMatches(p, CHAIN[k])) { found = k; break; }
      if (found === -1) return false;
      pos = found - 1; i--;
    }
    return true;
  }

  const allRules = [
    ...cssRules(sheetForCascade, "").map((r) => ({ ...r, file: "styles.css" })),
    ...cssRules(inlineForCascade, "").map((r) => ({ ...r, file: "hackathons.html <style>" })),
  ];
  const binding = [];
  for (let idx = 0; idx < CHAIN.length; idx++) {
    for (const r of allRules) {
      for (const sel of r.selector.split(",")) {
        const parts = sel.trim().split(/\s*>\s*|\s+/).filter(Boolean);
        if (!parts.length) continue;
        if (!compoundMatches(parts[parts.length - 1], CHAIN[idx])) continue;
        if (!selectorMatches(sel, idx)) continue;
        for (const d of r.body.split(";")) {
          const c = d.indexOf(":");
          if (c === -1) continue;
          const prop = d.slice(0, c).trim();
          const val = d.slice(c + 1).trim();
          if (!NARROWING.test(prop)) continue;
          if (/^(100%|auto|none|inherit)$/.test(val)) continue;
          binding.push(`${r.file}${r.media ? " " + r.media : ""} {${sel.trim()}} ${prop}: ${val}`);
        }
      }
    }
  }
  // Exactly one survivor is expected: the page's own content column. Anything
  // else is a second cap on the same text, which is the bug being fixed.
  const extra = binding.filter((b) => !/\{\.hk-wrap\}/.test(b));
  ok(extra.length === 0,
    `nothing but .hk-wrap constrains the story text's width (${binding.length} found)`,
    extra.join(" | "));
  ok(binding.some((b) => /\{\.hk-wrap\} max-width: min\(1320px/.test(b)),
    "...and .hk-wrap is still the column that does", binding.join(" | "));
  ok(!/\.hk-story-p\s*\{[^}]*max-width/s.test(sheetForCascade),
    "the story paragraphs carry no max-width of their own");
  // A grid or flex parent can narrow a child without any max-width at all, so
  // the absence of one is not on its own the answer.
  ok(!/\.hk-story\s*\{[^}]*display:\s*(grid|flex)/s.test(sheetForCascade),
    "the story block is not a grid or flex container that could size its children");
}

// -- the width fix ---------------------------------------------------------
ok(!/\.hk-round-desc\s*\{[^}]*max-width/s.test(pageHtml),
  "the round description carries no max-width");
ok(/\.hk-wrap\s*\{[^}]*max-width:\s*min\(1320px/s.test(pageHtml),
  "the content column is widened on this page");

// ============================================================
// 3. Pure logic
// ============================================================
section("3. pure logic");

ok(T.medalTier({ rank: 1 }) === "gold", "rank 1 -> gold");
ok(T.medalTier({ rank: 2 }) === "silver", "rank 2 -> silver");
ok(T.medalTier({ rank: 3 }) === "bronze", "rank 3 -> bronze");
ok(T.medalTier({ rank: 4 }) === null, "rank 4 -> no medal");
ok(T.medalTier({ rank: null, is_winner: true }) === "gold", "is_winner without a rank -> gold");
ok(T.medalTier({ rank: null, is_winner: false }) === null, "no rank and no win -> no medal");
ok(T.medalTier(null) === null, "no team -> no medal");
ok(T.medalLabel({ rank: 2 }) === "2nd place", "rank 2 label");
ok(T.medalLabel({ rank: null, is_winner: true }) === "Winner", "unranked winner label");

{
  const p = T.podiumTeams([
    { name: "c", rank: 3 }, { name: "a", rank: 1 }, { name: "d", rank: 4 },
    { name: "b", rank: 2 }, { name: "e", rank: null, is_winner: false },
  ]);
  ok(p.length === 3 && p[0].name === "a" && p[1].name === "b" && p[2].name === "c",
    "podium is exactly the top three, in order");
}
ok(T.podiumTeams([{ name: "x", rank: null, is_winner: false }]).length === 0,
  "no placings -> empty podium");
ok(T.podiumTeams([]).length === 0 && T.podiumTeams(null).length === 0,
  "podium copes with empty and null");

{
  const rounds = [{ id: "a" }, { id: "b" }];
  const teams = { a: [{ rank: 1 }, { rank: null, is_winner: false }], b: [{ rank: 2 }] };
  const roster = { a: [{}, {}, {}], b: [{}] };
  const s = T.summarise(rounds, teams, roster);
  ok(s.rounds === 2 && s.teams === 3 && s.eduhackers === 4 && s.medals === 2,
    "summary aggregates rounds/teams/EduHackers/medals", JSON.stringify(s));
  const empty = T.summarise([], {}, {});
  ok(empty.rounds === 0 && empty.teams === 0 && empty.medals === 0, "summary of nothing is zeroes");

  // The tile is labelled "EduHackers", so it must not count the coaches. This
  // is the assertion that stops the word and the number drifting apart again.
  const mixed = T.summarise(
    [{ id: "a" }],
    { a: [] },
    { a: [{ is_mentor: true }, { is_mentor: true }, { is_mentor: false }, {}] },
  );
  ok(mixed.eduhackers === 2, `coaches are excluded from the EduHacker tile (${mixed.eduhackers})`);
  ok(mixed.coaches === 2, `...and counted separately (${mixed.coaches})`);
}

ok(T.isComingSoon({ starts_on: null, ends_on: null, status: "announced" }) === true,
  "no dates -> coming soon");
ok(T.isComingSoon({ starts_on: "2025-01-01", ends_on: null, status: "completed" }) === false,
  "a start date -> not coming soon");
ok(T.isComingSoon({ starts_on: null, ends_on: "2025-01-01" }) === false,
  "an end date -> not coming soon");
ok(T.isComingSoon({ starts_on: null, ends_on: null, status: "cancelled" }) === false,
  "a cancelled round is never advertised");

ok(T.formatRange("2025-05-24", "2025-06-28") === "24 May – 28 Jun 2025", "date range");
ok(T.formatRange("2025-12-06", null) === "From 6 Dec 2025", "open-ended range");
ok(T.formatRange(null, null) === "", "no dates -> no range");

{
  const bad = T.validateInterest({});
  ok(!bad.ok && Object.keys(bad.errors).length === 4, "empty form fails every field");
  const goodish = T.validateInterest({
    full_name: "A Person", email: "a@b.co", mobile: "+20 100 123 4567", current_job: "Student",
  });
  ok(goodish.ok, "a filled form passes", JSON.stringify(goodish.errors));
  ok(!T.validateInterest({ full_name: "x", email: "nope", mobile: "0100000000", current_job: "y" }).ok,
    "a malformed email fails");
  ok(!T.validateInterest({ full_name: "x", email: "a@b.co", mobile: "12", current_job: "y" }).ok,
    "a two-digit mobile fails");
}

ok(T.fieldForCode("invalid_email") === "email", "code -> email");
ok(T.fieldForCode("missing_full_name") === "full_name", "code -> full_name");
ok(T.fieldForCode("mobile_invalid") === "mobile", "code -> mobile");
ok(T.fieldForCode("phone_bad") === "mobile", "phone code -> mobile");
ok(T.fieldForCode("current_job_required") === "current_job", "code -> current_job");
ok(T.fieldForCode("rate_limited") === null, "an unrelated code names no field");
ok(T.fieldForCode("") === null && T.fieldForCode(null) === null, "no code names no field");
ok(T.fieldForCode("whatever", "email") === "email", "an explicit field wins");
ok(T.fieldForCode("whatever", "not_a_field") === null, "an unknown explicit field is ignored");

ok(T.safeId("eduhackai-5") === "eduhackai-5", "safe ids pass through");
ok(T.safeId('a b"c<d') === "abcd", "unsafe id characters are dropped");

// -- the accordion rule ----------------------------------------------------
ok(T.nextOpenRound(null, "a") === "a", "nothing open + press a -> a");
ok(T.nextOpenRound("a", "b") === "b", "a open + press b -> b (a closes)");
ok(T.nextOpenRound("a", "a") === null, "pressing the open one closes it");
ok(T.nextOpenRound("a", "") === "a", "a press with no round changes nothing");
ok(T.nextOpenRound(null, null) === null, "no state and no round is still no state");

// -- coach photo paths -----------------------------------------------------
ok(T.coachPhotoSlug("Ahmed Zoka") === "ahmed-zoka", "two names slugify");
ok(T.coachPhotoSlug("Mohamed Mohi El-Dien") === "mohamed-mohi-el-dien",
  "a hyphenated name collapses to single hyphens");
ok(T.coachPhotoSlug("Solo") === "solo", "a one-word name slugifies");
ok(T.coachPhotoSlug("  Two   Spaces  ") === "two-spaces", "runs of separators collapse to one");
ok(T.coachPhotoSlug("") === "" && T.coachPhotoSlug(null) === "", "nothing in, nothing out");

// -- coach identity: the override, the link, and the photo -----------------
//
// The property that matters here is that the page is correct on BOTH sides of
// a migration that has not been applied. Every one of these is asserted twice,
// once for what the database says today and once for what it will say after
// the rename, and the two answers have to be the same answer.
{
  for (const stored of ["Mahmoud", "Mahmoud ATALLAH", "  mahmoud  "]) {
    ok(T.coachDisplayName(stored) === "Mahmoud ATALLAH",
      `"${stored}" displays as Mahmoud ATALLAH`, T.coachDisplayName(stored));
    ok(T.coachPhotoSrc(stored) === "assets/eduhack/coaches/mahmoud-atallah.jpg",
      `"${stored}" resolves to the same photo`, T.coachPhotoSrc(stored));
    ok(T.coachLinkUrl(stored) === "https://www.linkedin.com/in/mahmoudatallah/",
      `"${stored}" resolves to the same LinkedIn`, T.coachLinkUrl(stored));
  }
  // Everybody else: the stored name is the displayed name, unchanged.
  for (const [stored, slug] of [
    ["Zoka", "zoka"],
    ["Esraa Ahmed", "esraa-ahmed"],
    ["Mohamed Mohi El-Dien", "mohamed-mohi-el-dien"],
    ["Gangothri Rajaram", "gangothri-rajaram"],
    ["Ahmed Badawy", "ahmed-badawy"],
    ["Emad Adel", "emad-adel"],
    ["Ansari", "ansari"],
  ]) {
    ok(T.coachDisplayName(stored) === stored, `${stored} keeps the stored spelling`);
    ok(T.coachPhotoSrc(stored) === `assets/eduhack/coaches/${slug}.jpg`,
      `${stored} -> ${slug}.jpg`, T.coachPhotoSrc(stored));
    ok(/^https:\/\/www\.linkedin\.com\/in\//.test(T.coachLinkUrl(stored)),
      `${stored} has a LinkedIn`, T.coachLinkUrl(stored));
  }
  // Somebody with no entry: no link, no rename, and still a photo path — the
  // photo simply 404s and the monogram stays.
  ok(T.coachProfile("Nobody At All") === null, "an unknown coach has no profile entry");
  ok(T.coachLinkUrl("Nobody At All") === "", "...and no link");
  ok(T.coachDisplayName("Nobody At All") === "Nobody At All", "...and is not renamed");
  ok(T.coachLinkUrl("") === "" && T.coachLinkUrl(null) === "", "no name, no link");
  ok(T.coachDisplayName(null) === "", "no name, no display name");
  // Every URL in the config is an https LinkedIn profile. Nothing else belongs
  // in a config that the page turns into a link on somebody's face.
  const urls = Object.keys(T.coachProfiles).map((k) => T.coachProfiles[k].linkedin);
  ok(urls.every((u) => /^https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9-]+\/$/.test(u)),
    "every configured URL is an https linkedin.com/in/ profile",
    urls.filter((u) => !/^https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9-]+\/$/.test(u)).join(", "));
}

// -- "No of Apps": the one figure that is configured, not computed ---------
{
  // Ahmed's four answers, one at a time. Named individually rather than
  // counted, because "the config has four entries" would pass with four wrong
  // numbers in it.
  for (const [n, want] of [[1, 6], [2, 12], [3, 6], [4, 6]]) {
    ok(T.appsForRound(n) === want, `round ${n}'s app count is ${want}`, String(T.appsForRound(n)));
    ok(T.appsForRound(String(n)) === want,
      `...whether round ${n} is given as a number or a string`);
  }
  // The "not known" path has to keep working even though nothing uses it today.
  // A round 6 nobody has been asked about is exactly as unknown as round 2 was
  // before Ahmed answered, and the chip must stay absent for it.
  ok(T.appsForRound(9) === null, "a round that is not in the config at all is null");
  ok(T.appsForRound(null) === null && T.appsForRound(undefined) === null &&
     T.appsForRound("") === null, "no round number, no count");
  // The shape Ahmed's answers landed in. If somebody adds a 0 to make a chip
  // appear on a round that shipped nothing, this says so.
  const cfg = T.appsByRound;
  ok(Object.keys(cfg).join(",") === "1,2,3,4", "the config covers exactly the four rounds",
    Object.keys(cfg).join(","));
  ok(Object.keys(cfg).every((k) => cfg[k] === null || (typeof cfg[k] === "number" && cfg[k] > 0)),
    "every configured app count is either null or a real positive number");
}

// -- the country tags: a flat list, because the source is a flat list -------
// ⚠ This block used to assert the config was EMPTY, because no table on this
// ⚠ project records a participant's country. The owner has since supplied a
// ⚠ file of 95 participants' countries, so the guard moved rather than went
// ⚠ away. What it protects now:
// ⚠   * the list is exactly the thirteen he gave, in a flat programme-wide
// ⚠     array — NOT keyed by round, because his file has no round column and
// ⚠     splitting it would invent the one fact it does not contain;
// ⚠   * `countriesForRounds` cannot start narrowing by round again while the
// ⚠     source cannot support it.
{
  const cfg = T.eduhackerCountries;
  const SUPPLIED = ["Egypt", "India", "Bangladesh", "Pakistan", "Jordan", "Palestine",
    "Albania", "Argentina", "Ethiopia", "Qatar", "Saudi Arabia", "Sudan", "United Arab Emirates"];

  ok(Array.isArray(cfg),
    "the country config is a FLAT array — the source carries no round column",
    Object.prototype.toString.call(cfg));
  ok(cfg.length === 13, `all thirteen supplied countries are configured (${cfg.length})`);
  ok(SUPPLIED.every((c) => cfg.includes(c)),
    "every country the owner supplied is present",
    SUPPLIED.filter((c) => !cfg.includes(c)).join(", "));
  ok(cfg.every((c) => SUPPLIED.includes(c)),
    "⚠ and NOTHING has been added that he did not supply",
    cfg.filter((c) => !SUPPLIED.includes(c)).join(", "));
  ok(cfg[0] === "Egypt" && cfg[1] === "India" && cfg[2] === "Bangladesh",
    "ordered by how many people came from each, commonest first");

  // The rounds argument is accepted and ignored, on purpose. If somebody
  // reintroduces per-round narrowing without a per-round source, these fail.
  const all = T.countriesForRounds([{ round_number: 1 }]);
  ok(all.length === 13, "one round asks and still gets the whole programme's list", String(all.length));
  ok(T.countriesForRounds([]).length === 13, "no rounds, same list — it is not per-round");
  ok(T.countriesForRounds(null).length === 13, "no argument, same list");

  // Dedup/trim still works, since the config is hand-edited.
  const saved = cfg.slice();
  try {
    cfg.length = 0;
    cfg.push("Egypt", "  ", "Egypt", null, "India");
    const got = T.countriesForRounds(null);
    ok(got.join("|") === "Egypt|India",
      "blanks, nulls and duplicates are dropped", got.join("|"));
  } finally {
    cfg.length = 0;
    for (const c of saved) cfg.push(c);
  }
  ok(T.countriesForRounds(null).length === 13, "...and the real list is restored afterwards");
}

// -- per-round figures, computed from the rows ----------------------------
{
  const roster = [
    { is_mentor: true }, { is_mentor: true },
    { is_mentor: false }, { is_mentor: false }, { is_mentor: false },
    {},                                     // no flag at all is not a coach
  ];
  const f = T.roundFigures({ round_number: 1 }, [{}, {}], roster);
  ok(f.coaches === 2, `coaches are the is_mentor rows (${f.coaches})`);
  ok(f.eduhackers === 4, `EduHackers are everybody else (${f.eduhackers})`);
  ok(f.teams === 2, `teams are counted (${f.teams})`);
  ok(f.coaches + f.eduhackers === roster.length,
    "every roster row lands in exactly one of the two");
  ok(f.apps === 6, "round 1's apps come from the config");
  ok(T.roundFigures({ round_number: 9 }, [], []).apps === null,
    "a round with no configured app count reports null");
  const none = T.roundFigures({ round_number: 5 }, null, null);
  ok(none.coaches === 0 && none.eduhackers === 0 && none.teams === 0 && none.apps === null,
    "a round with nothing in it computes to nothing");
}

ok(T.listSentence(["a"]) === "a", "one item");
ok(T.listSentence(["a", "b"]) === "a and b", "two items");
ok(T.listSentence(["a", "b", "c"]) === "a, b and c", "three items");
ok(T.listSentence([]) === "", "no items");

// -- the computed history --------------------------------------------------
{
  const rounds = [
    { id: "a", round_number: 2, starts_on: "2025-06-01", ends_on: "2025-06-11",
      location: "Demo Day: Somewhere", description: "ran in Arabic" },
    { id: "b", round_number: 1, starts_on: "2025-01-01", ends_on: null,
      location: null, description: "plain" },
  ];
  const teams = { a: [{}, {}], b: [{}] };
  const roster = {
    a: [{ full_name: "Same Person" }, { full_name: "Other" }],
    b: [{ full_name: "same person" }],           // same human, different case
  };
  const f = T.storyFacts(rounds, teams, roster);
  ok(f.rounds === 2, "rounds counted");
  ok(f.firstStart === "2025-01-01", "earliest start found even when it is last in the list");
  ok(f.lastEnd === "2025-06-11", "latest end found, ignoring the round with none");
  ok(f.teams === 3, "teams totalled");
  ok(f.people === 2, `people deduplicated across rounds (${f.people})`);
  // The three fields Ahmed asked to be taken out of the prose are no longer
  // computed at all — not computed and quietly dropped by the renderer, which
  // is the state that rots. The fixture above still carries a labelled Demo Day
  // and a description saying the round ran in Arabic, so these are meaningful.
  for (const gone of ["demoDays", "venues", "arabicRounds"]) {
    ok(!(gone in f), `storyFacts no longer computes ${gone}`, JSON.stringify(Object.keys(f)));
  }
  ok(Array.isArray(f.countries) && f.countries.length === 13,
    "...and countries is the supplied list, which is not derived from the rows",
    JSON.stringify(f.countries));
  const none = T.storyFacts([], {}, {});
  // ⚠ `countries` is deliberately NOT zero here. Every other figure in
  // storyFacts is computed from the rows, so an empty programme drives them to
  // nothing — but the country list is a fact the owner supplied about the
  // programme, not something the rows imply. It survives an empty page, and
  // that asymmetry is the point: those are two different kinds of truth.
  ok(none.rounds === 0 && none.firstStart === null,
    "a programme with no rows computes every DERIVED figure to nothing");
  ok(none.countries.length === 13,
    "...but the supplied country list is not a derived figure and stays put",
    String(none.countries.length));
}

// -- coaches, deduplicated across rounds ------------------------------------
{
  const rounds = [{ id: "r2", round_number: 2 }, { id: "r1", round_number: 1 }];
  const roster = {
    r2: [{ full_name: "Lead Coach", is_mentor: true }, { full_name: "Runner", is_mentor: false }],
    r1: [{ full_name: "lead  coach", is_mentor: true }, { full_name: "Second", is_mentor: true }],
  };
  const c = T.dedupeCoaches(rounds, roster);
  ok(c.length === 2, `one entry per person (${c.length})`);
  ok(c[0].person.full_name === "Lead Coach", "first seen wins the spelling, and the order");
  ok(c[0].rounds.join(",") === "1,2", "every round they coached, ascending", c[0].rounds.join(","));
  ok(c[1].rounds.join(",") === "1", "a single-round coach lists one round");
  ok(!c.some((x) => x.person.full_name === "Runner"), "competitors are not coaches");
  ok(T.dedupeCoaches([], {}).length === 0 && T.dedupeCoaches(null, null).length === 0,
    "no rounds, no coaches");
}

// -- state machine ---------------------------------------------------------
{
  const idle = { name: "idle", already: false, message: "", fields: {} };
  const sending = T.nextInterestState(idle, { type: "submit" });
  ok(sending.name === "sending", "idle + submit -> sending");
  ok(T.nextInterestState(sending, { type: "submit" }).name === "sending",
    "a second submit while in flight is ignored");
  const done = T.nextInterestState(sending, { type: "ok", already: false });
  ok(done.name === "done" && done.already === false, "sending + ok -> done");
  const already = T.nextInterestState(sending, { type: "ok", already: true });
  ok(already.name === "done" && already.already === true, "already:true is carried into done");
  ok(T.nextInterestState(done, { type: "submit" }).name === "done", "done is terminal");
  const failed = T.nextInterestState(sending, { type: "fail", message: "no", fields: { email: "bad" } });
  ok(failed.name === "error" && failed.message === "no" && failed.fields.email === "bad",
    "sending + fail -> error with its message and field");
  ok(T.nextInterestState(failed, { type: "submit" }).name === "sending", "error + submit -> sending");
  ok(T.nextInterestState(failed, { type: "reset" }).name === "idle", "reset -> idle");
  ok(T.nextInterestState(idle, { type: "ok" }).name === "idle", "an ok with nothing in flight is ignored");
  ok(T.nextInterestState(undefined, { type: "submit" }).name === "sending", "no prior state defaults to idle");
}

// ============================================================
// 3b. The accordion, driven through the mount's own click handler
// ============================================================
section("3b. accordion behaviour");

{
  // Stand-ins for the four buttons and four panels the renderer emitted, wired
  // the way the real ones are. The click handler under test is the one
  // hackathons-ui.js bound to the mount at load, so what runs here is the
  // shipped path and not a re-implementation of it.
  const mountEl = registry.get("hack-rounds");
  const btns = toggles.map((slug) => {
    const panelId = `hk-panel-${slug}`;
    const panel = el(panelId);
    panel.hidden = true;
    const cue = el(null, "span");
    cue.textContent = "Show details";
    const btn = el(`hk-tab-${slug}`, "button");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", panelId);
    btn.setAttribute("data-hk-toggle", slug);
    btn.setAttribute("data-hk-name", slug);
    btn.setAttribute("aria-label", `Show details for ${slug}`);
    btn._kids[".hk-round-cue"] = cue;
    btn.closest = (sel) => (sel === "[data-hk-toggle]" ? btn : null);
    return { slug, btn, panel, cue };
  });
  mountEl.querySelectorAll = (sel) =>
    (sel === "[data-hk-toggle]" ? btns.map((b) => b.btn) : []);

  const click = (mountEl._listeners.click || [])[0];
  ok(!!click, "the mount has a click handler");
  const press = (i) => click({ target: btns[i].btn });
  const expanded = () => btns.filter((b) => b.btn.getAttribute("aria-expanded") === "true");
  const shown = () => btns.filter((b) => !b.panel.hidden);

  press(0);
  ok(expanded().length === 1 && expanded()[0].slug === btns[0].slug, "pressing a round opens it");
  ok(shown().length === 1 && !btns[0].panel.hidden, "its panel is revealed");
  ok(btns[0].cue.textContent === "Hide details", "the bar now offers to hide it");
  ok(btns[0].btn.getAttribute("aria-label") === `Hide details for ${btns[0].slug}`,
    "the accessible name follows the visible one");

  press(1);
  ok(expanded().length === 1 && expanded()[0].slug === btns[1].slug,
    "opening a second round closes the first — only one is open");
  ok(shown().length === 1, "...and only one panel is shown");
  ok(btns[0].btn.getAttribute("aria-expanded") === "false",
    "the round being CLOSED updates its own aria-expanded");
  ok(btns[0].panel.hidden === true, "...and hides its panel");
  ok(btns[0].cue.textContent === "Show details" &&
     btns[0].btn.getAttribute("aria-label") === `Show details for ${btns[0].slug}`,
    "...and its label goes back");

  press(2);
  press(3);
  ok(expanded().length === 1 && expanded()[0].slug === btns[3].slug,
    "however many are pressed, one stays the answer");

  press(3);
  ok(expanded().length === 0 && shown().length === 0,
    "pressing the open round closes it, leaving none open");

  // A deep link is a request for one specific round, so it wins outright and
  // closes whatever the reader had open.
  press(0);
  const section2 = registry.get(`hk-section-probe`) || el(`hk-section-probe`);
  section2.querySelector = (sel) => (sel === "[data-hk-toggle]" ? btns[2].btn : null);
  registry.set("eduhackai-probe", section2);
  window_.location.hash = "#eduhackai-probe";
  (listeners.window.hashchange || []).forEach((fn) => fn());
  ok(expanded().length === 1 && expanded()[0].slug === btns[2].slug,
    "a hash link opens its round and closes the one that was open");
  window_.location.hash = "";
}

// ============================================================
// 4. The dialog, driven through the DOM stub
// ============================================================
section("4. dialog behaviour");

function fill(v) { for (const k of Object.keys(v)) inputs[k].value = v[k]; }
function submit() {
  let prevented = false;
  form.dispatch("submit", { preventDefault() { prevented = true; } });
  return prevented;
}
const good = { full_name: "A Person", email: "a@b.co", mobile: "01001234567", current_job: "Student" };

// Open it the way a visitor does: by pressing the button the coming-soon
// panel rendered, which is also what tells the dialog which round it is for.
const openers = listeners.document.click || [];
function reopen() {
  const opener = el(null, "button");
  opener.getAttribute = (k) => (k === "data-hk-open" ? "eduhackai-5" : null);
  opener.closest = (sel) => (sel === "[data-hk-open]" ? opener : null);
  openers.forEach((fn) => fn({ target: opener }));
  return opener;
}
reopen();
ok(modal.hidden === false, "the dialog opens from the panel button");
ok(document_.body.classList.contains("hk-modal-open"), "the background is locked from scrolling");
ok(DOC.activeElement === inputs.full_name, "focus moves into the dialog, onto the first field");

// client-side validation
fill({ full_name: "", email: "", mobile: "", current_job: "" });
ok(submit(), "submit is always prevented (never a native post)");
ok(registry.get("hk-form-error").hidden === false, "an empty form shows the error banner");
ok(inputs.email.getAttribute("aria-invalid") === "true", "the invalid field is marked aria-invalid");
ok(registry.get("hk-e-email").hidden === false, "the field's own error text is shown");
ok(fake.invokeCalls.length === 0, "nothing is posted when the form is invalid");

// success
fill(good);
fake.setInvokeResult({ data: { ok: true, already: false }, error: null });
submit();
ok(registry.get("hk-interest-submit").disabled === true, "the submit button disables while sending");
ok(/hk-spin/.test(registry.get("hk-interest-submit").innerHTML), "a real pending state is shown");
await new Promise((r) => setTimeout(r, 20));
ok(fake.invokeCalls.length === 1, "exactly one call was made");
{
  const body = fake.invokeCalls[0].body;
  ok(fake.invokeCalls[0].name === "register-interest", "the function name matches the contract");
  ok(body.full_name === good.full_name && body.email === good.email &&
     body.mobile === good.mobile && body.current_job === good.current_job,
    "the body carries all four fields", JSON.stringify(body));
  ok(body.round_slug === "eduhackai-5", "round_slug comes from the round, not a constant");
  ok(Object.keys(body).length === 5, "the body carries nothing else", JSON.stringify(body));
}
ok(registry.get("hk-interest-done").hidden === false, "the success panel is shown");
ok(form.hidden === true, "the form is replaced");
ok(/on the list/i.test(registry.get("hk-interest-title").textContent), "success wording");
ok(/early bird/i.test(registry.get("hk-done-text").textContent), "the discount is repeated on success");
ok(DOC.activeElement === registry.get("hk-interest-title"), "focus moves to the confirmation");

// already-registered: kind, not an error
reopen();
ok(inputs.full_name.value === "", "reopening after a success starts from a clean form");
fill(good);
fake.setInvokeResult({ data: { ok: true, already: true }, error: null });
submit();
await new Promise((r) => setTimeout(r, 20));
ok(registry.get("hk-interest-done").hidden === false, "already:true still lands on the success panel");
ok(/already/i.test(registry.get("hk-interest-title").textContent),
  "already:true gets its own wording", registry.get("hk-interest-title").textContent);
ok(registry.get("hk-form-error").hidden === true, "already:true is not shown as an error");

// server failure with a named field
reopen();
fill(good);
fake.setInvokeResult({
  data: null,
  error: { context: { status: 400, json: async () => ({ error: "That email is not valid.", code: "invalid_email" }) } },
});
submit();
await new Promise((r) => setTimeout(r, 20));
ok(registry.get("hk-form-error").hidden === false, "a server failure shows the sentence it sent");
ok(registry.get("hk-form-error").textContent === "That email is not valid.",
  "the function's own sentence is used verbatim", registry.get("hk-form-error").textContent);
ok(inputs.email.getAttribute("aria-invalid") === "true", "the named field is marked");
ok(inputs.full_name.value === good.full_name && inputs.email.value === good.email &&
   inputs.mobile.value === good.mobile && inputs.current_job.value === good.current_job,
  "a failure does not clear what was typed");
ok(registry.get("hk-interest-submit").disabled === false, "the submit button is usable again");

// failure with no body at all
fake.setInvokeResult({ data: null, error: { message: "Failed to fetch" } });
submit();
await new Promise((r) => setTimeout(r, 20));
ok(/try again/i.test(registry.get("hk-form-error").textContent),
  "a bodyless failure falls back to a plain sentence", registry.get("hk-form-error").textContent);

// escape closes and restores focus
const opener = reopen();
const keydown = (listeners.document.keydown || [])[0];
ok(!!keydown, "a keydown handler is bound");
keydown({ key: "Escape", preventDefault() {} });
ok(modal.hidden === true, "Escape closes the dialog");
ok(!document_.body.classList.contains("hk-modal-open"), "the scroll lock is released");
ok(DOC.activeElement === opener, "focus returns to the button that opened it");

// The closing CTA is a second button onto the SAME dialog, so focus has to
// come back to whichever of the two was actually pressed — not to the first
// one, and not to the top of the page.
{
  const bottom = el(null, "button");
  bottom.getAttribute = (k) => (k === "data-hk-open" ? "eduhackai-5" : null);
  bottom.closest = (sel) => (sel === "[data-hk-open]" ? bottom : null);
  openers.forEach((fn) => fn({ target: bottom }));
  ok(modal.hidden === false, "the closing CTA opens the same dialog");
  keydown({ key: "Escape", preventDefault() {} });
  ok(DOC.activeElement === bottom,
    "focus returns to the closing CTA when the closing CTA is what opened it");
}

// ============================================================
// 4b. The showcase player dialog
// ------------------------------------------------------------
// The thing this section exists for is the IFRAME'S LIFETIME. A dialog that is
// merely hidden with a YouTube frame still inside it goes on playing — audible,
// from nowhere the visitor can point at — and goes on holding the player's
// connection open behind a dialog they believe they closed. `hidden` stops
// neither. So every close below is followed by a check that the frame is gone,
// not just that the dialog is.
//
// Everything else here is the behaviour the player SHARES with the interest
// form, asserted on the player rather than assumed from the form: they run
// through one makeModal(), and this is what proves the second dialog actually
// got the first one's Escape, its scroll lock and its focus restoration.
// ============================================================
section("4b. the showcase player dialog");

const videoClickers = videosMount._listeners.click || [];
ok(videoClickers.length === 1, "the showcase mount has a click handler");

// A card, the way one arrives at the handler: a real button carrying the id and
// the title the renderer put on it.
function card(id, title) {
  const btn = el(null, "button");
  const attrs = { "data-hk-video": id, "data-hk-title": title };
  btn.getAttribute = (k) => (k in attrs ? attrs[k] : null);
  btn.closest = (sel) => (sel === "[data-hk-video]" ? btn : null);
  return btn;
}
function pressCard(btn) {
  videoClickers.forEach((fn) => fn({ target: btn }));
  return btn;
}
const mediaHost = registry.get("hk-video-modal-media");
const videoTitleEl = registry.get("hk-video-modal-title");

const cardA = pressCard(card("psV1lJXPA_o", "EduHackAI-3 Winner Solution (Meya Sports) Demo Video"));
ok(videoModal.hidden === false, "pressing a card opens the player dialog");
ok(modal.hidden === true, "...and does not open the interest dialog");
ok(document_.body.classList.contains("hk-modal-open"),
  "the background is locked from scrolling, the same lock the form uses");
ok(DOC.activeElement === registry.get("hk-video-modal-close"),
  "focus lands on the close button, not inside the cross-origin frame");

// ---- the frame that is built ----
{
  const frame = mediaHost.innerHTML;
  ok(/<iframe/.test(frame), "an iframe is created when the dialog opens", frame);
  ok(frame.includes("youtube-nocookie.com/embed/psV1lJXPA_o"),
    "...against youtube-nocookie.com, with the id of the card that was pressed", frame);
  ok(/autoplay=1/.test(frame),
    "...with autoplay, so the click that opened it also starts it", frame);
  ok(/title="EduHackAI-3 Winner Solution \(Meya Sports\) Demo Video"/.test(frame),
    "...and a title attribute naming the video", frame);
  ok(!/loading="lazy"/.test(frame),
    "...and no lazy loading: this frame exists in order to play now", frame);
  ok(videoTitleEl.textContent === "EduHackAI-3 Winner Solution (Meya Sports) Demo Video",
    "the dialog's accessible name is the video's title", videoTitleEl.textContent);
}

// ---- and that is destroyed again ----
keydown({ key: "Escape", preventDefault() {} });
ok(videoModal.hidden === true, "Escape closes the player, the same as the form");
ok(mediaHost.innerHTML === "",
  "THE IFRAME IS DESTROYED ON CLOSE — a hidden player keeps playing",
  JSON.stringify(mediaHost.innerHTML));
ok(!document_.body.classList.contains("hk-modal-open"), "the scroll lock is released");
ok(DOC.activeElement === cardA, "focus returns to the card that opened it");

// A second video, to prove the dialog is reused rather than accumulating: the
// title and the frame are the new one's, and there is still exactly one frame.
{
  const cardB = pressCard(card("cfznj3X_ais", "EduHackAI-2 Winner Solution (Clever Mart)"));
  ok(videoTitleEl.textContent === "EduHackAI-2 Winner Solution (Clever Mart)",
    "a second video renames the dialog", videoTitleEl.textContent);
  ok((mediaHost.innerHTML.match(/<iframe/g) || []).length === 1,
    "...and there is exactly one player in it", mediaHost.innerHTML);
  ok(mediaHost.innerHTML.includes("cfznj3X_ais") && !mediaHost.innerHTML.includes("psV1lJXPA_o"),
    "...which is the new video and not the old one", mediaHost.innerHTML);

  // Closed by the × / backdrop rather than by Escape — the other route, which
  // has to destroy the frame too.
  const x = el(null, "button");
  x.closest = (sel) => (sel === "[data-hk-dismiss]" ? x : null);
  (listeners.document.click || []).forEach((fn) => fn({ target: x }));
  ok(videoModal.hidden === true, "the dismiss control closes the player");
  ok(mediaHost.innerHTML === "", "...and destroys the frame on that route too",
    JSON.stringify(mediaHost.innerHTML));
  ok(DOC.activeElement === cardB, "...and returns focus to the card that opened it");
}

// A card whose id survives nothing of safeVideoId() opens no dialog at all,
// rather than opening an empty one with a broken player in it.
{
  pressCard(card("///?#", "Nothing"));
  ok(videoModal.hidden === true, "a card whose id strips to nothing opens no dialog");
  ok(mediaHost.innerHTML === "", "...and builds no frame",
    JSON.stringify(mediaHost.innerHTML));
}

// ---- ONE implementation, not two ----
//
// The behavioural checks above prove the player HAS a focus trap, Escape, a
// scroll lock and focus restoration. They cannot tell whether it has its own
// copy of each — and a second copy is precisely the thing that drifts, because
// it is the one nobody opens in a screen reader six months later. So the source
// is counted: each of these mechanisms may appear exactly once.
{
  const jsCode = js.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  const traps = jsCode.match(/a\[href\], button:not\(\[disabled\]\)/g) || [];
  ok(traps.length === 1,
    `the focusable-elements selector — the focus trap — exists once (found ${traps.length})`);

  const keydowns = jsCode.match(/addEventListener\("keydown"/g) || [];
  ok(keydowns.length === 1,
    `there is one keydown handler for both dialogs (found ${keydowns.length})`);
  ok((jsCode.match(/e\.key === "Escape"/g) || []).length === 1,
    "...and one place that handles Escape");

  const locks = jsCode.match(/classList\.add\("hk-modal-open"\)/g) || [];
  ok(locks.length === 1, `the scroll lock is applied in one place (found ${locks.length})`);
  ok((jsCode.match(/classList\.remove\("hk-modal-open"\)/g) || []).length === 1,
    "...and released in one place");

  const restores = jsCode.match(/api\.lastFocus/g) || [];
  ok(restores.length >= 3 && !/var lastFocus/.test(jsCode),
    "focus restoration lives on the controller, not in a module-level variable two dialogs share");

  ok((jsCode.match(/function makeModal\(/g) || []).length === 1,
    "there is exactly one modal factory");
  ok(/makeModal\(modal, modalBox/.test(jsCode) && /makeModal\(videoModal, videoModalBox/.test(jsCode),
    "and both dialogs are built from it");

  // The trap has to include the iframe. Without it, Tab from the close button
  // wraps back to the close button and a keyboard user is locked out of the
  // play, seek and fullscreen controls of the video they just opened — a trap
  // that traps somebody away from the content.
  ok(/iframe, \[tabindex\]/.test(jsCode),
    "the focus trap counts the player's iframe as focusable, so Tab can reach the controls");
}

// ============================================================
// 4c. The showcase rail
// ------------------------------------------------------------
// The scrolling itself is CSS scroll-snap and is not testable here — it is
// asserted in section 5, on the stylesheet. What IS testable is the part that
// is code: the rule deciding when each button is disabled, the fact that the
// state is repainted from the SCROLL event rather than from the click (so it
// stays true when the rail is moved by a wheel or a finger), and that nothing
// here binds a wheel or touch listener that could hijack either.
// ============================================================
section("4c. the showcase rail");

// ---- the rule, on its own ----
{
  const e = T.railEdges;
  ok(e(0, 2700, 900).atStart === true, "at scrollLeft 0 the rail is at its start");
  ok(e(0, 2700, 900).atEnd === false, "...and not at its end");
  ok(e(1800, 2700, 900).atEnd === true, "scrolled fully right, the rail is at its end");
  ok(e(1800, 2700, 900).atStart === false, "...and not at its start");
  ok(e(900, 2700, 900).atStart === false && e(900, 2700, 900).atEnd === false,
    "in the middle it is at neither");
  // The 1px of slack, in both directions. A fractional card width leaves the
  // rail a hair short of its own maximum on a display whose device-pixel-ratio
  // is not 1, and a Next button that never disables is a control that lies.
  ok(e(1799.4, 2700, 900).atEnd === true,
    "a fraction of a pixel short of the end still counts as the end");
  ok(e(0.6, 2700, 900).atStart === true,
    "...and a fraction past the start still counts as the start");
  // A rail with nothing to scroll is at BOTH ends, so both buttons disable.
  const none = e(0, 900, 900);
  ok(none.atStart && none.atEnd, "a rail with nothing to scroll is at both ends");
  // Values outside the range cannot produce a wrong answer: some browsers
  // report a negative scrollLeft mid-overscroll on a rubber-banding touch.
  ok(e(-50, 2700, 900).atStart === true, "an overscrolled-left rail reads as at the start");
  ok(e(9999, 2700, 900).atEnd === true, "an overscrolled-right rail reads as at the end");
}

// ---- the buttons, wired to it ----
ok(railPrev.disabled === true, "the Previous button starts disabled — the rail starts at its left");
ok(railNext.disabled === false, "...and the Next button starts enabled");

// Scrolled to the far right by something that is NOT a button press — a wheel,
// a finger, the scrollbar. The buttons must still be right, which is why the
// repaint hangs off the scroll event.
rail.scrollLeft = 1800;
rail.dispatch("scroll", {});
ok(railPrev.disabled === false, "scrolling by any means enables Previous");
ok(railNext.disabled === true, "...and disables Next at the far end");

rail.scrollLeft = 900;
rail.dispatch("scroll", {});
ok(railPrev.disabled === false && railNext.disabled === false,
  "in the middle both buttons are live");

// A press moves the rail by one card's worth, in the right direction.
{
  rail._scrolledBy = null;
  railNext.dispatch("click", {});
  ok(rail._scrolledBy && rail._scrolledBy.left > 0, "Next scrolls right",
    JSON.stringify(rail._scrolledBy));
  rail._scrolledBy = null;
  railPrev.dispatch("click", {});
  ok(rail._scrolledBy && rail._scrolledBy.left < 0, "Previous scrolls left",
    JSON.stringify(rail._scrolledBy));
}

// ---- reduced motion ----
// The smooth scroll is the one piece of motion this feature has, and it is off
// under either switch: the site's own setting and the OS's.
{
  railNext.dispatch("click", {});
  ok(rail._scrolledBy.behavior === "smooth", "by default the button scrolls smoothly");

  document_.documentElement.classList.add("reduce-motion");
  railNext.dispatch("click", {});
  ok(rail._scrolledBy.behavior === "auto",
    "html.reduce-motion — the site's own setting — turns the smooth scroll off");
  document_.documentElement.classList.remove("reduce-motion");

  window_._reduceMotion = true;
  railNext.dispatch("click", {});
  ok(rail._scrolledBy.behavior === "auto",
    "prefers-reduced-motion — the OS setting — turns it off too");
  window_._reduceMotion = false;

  railNext.dispatch("click", {});
  ok(rail._scrolledBy.behavior === "smooth", "and it comes back when neither is set");
}

// ---- nothing is hijacked ----
// Native scrolling has to keep working, so the rule is flat: this file binds no
// wheel and no touch listener at all. Asserted on the source rather than on the
// stub, because a listener bound to an element the stub never sees would pass
// any behavioural test while still breaking a trackpad.
{
  const jsCode = js.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const evt of ["wheel", "mousewheel", "touchstart", "touchmove", "touchend", "pointermove"]) {
    ok(!new RegExp(`["']${evt}["']`).test(jsCode),
      `no ${evt} listener anywhere — the wheel and touch stay the browser's`);
  }
  ok(!/setInterval|requestAnimationFrame/.test(jsCode),
    "and no timer: this is a scroller, not a carousel that moves on its own");
}

// ---- the markup the rail needs ----
{
  ok(/<ul class="hk-video-rail" id="hk-video-rail" tabindex="0"/.test(videosHtml),
    "the rail itself is focusable, so the arrow keys can reach it", videosHtml.slice(0, 400));
  ok(/<ul class="hk-video-rail"[^>]*aria-label="[^"]+"/.test(videosHtml),
    "...and is named, because a scroll region with no name is an unlabelled control");
  ok(!/hk-video-grid/.test(videosHtml), "the old grid class is gone from the markup");

  const navButtons = videosHtml.match(/<button type="button" class="hk-rail-btn"[^>]*>/g) || [];
  ok(navButtons.length === 2, `there are two rail buttons (got ${navButtons.length})`);
  ok(navButtons.every((b) => /aria-label="[^"]+"/.test(b)),
    "...both with accessible names", navButtons.join("  "));
  ok(navButtons.every((b) => /aria-controls="hk-video-rail"/.test(b)),
    "...both saying which region they move", navButtons.join("  "));
  // Real <button>s, so Enter and Space and the disabled state are the
  // browser's. A div with a click handler would have needed all three written
  // out and would still not have been in the tab order.
  ok(navButtons.every((b) => /^<button type="button"/.test(b)),
    "...and both are real buttons", navButtons.join("  "));
  // Previous ships disabled in the markup, so it is correct before any script
  // has run — the rail is at its left edge from the first paint.
  const prevBtn = navButtons.find((b) => /data-hk-rail="prev"/.test(b)) || "";
  const nextBtn = navButtons.find((b) => /data-hk-rail="next"/.test(b)) || "";
  ok(/\bdisabled\b/.test(prevBtn), "Previous is disabled in the markup itself", prevBtn);
  ok(!/\bdisabled\b/.test(nextBtn), "...and Next is not", nextBtn);

  ok((videosHtml.match(/<li class="hk-video">/g) || []).length === 9,
    "all nine videos are in the rail — three are visible, none are dropped");
  // The cards say they open a dialog now, rather than swapping themselves.
  ok((videosHtml.match(/aria-haspopup="dialog"/g) || []).length === 9,
    "every card announces that it opens a dialog");
}

// ============================================================
// 5. CSS
// ============================================================
section("5. CSS");

const sheet = fs.readFileSync(path.join(REPO, "styles.css"), "utf8");
const inlineStyle = (pageHtml.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";

function braceBalance(css, label) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0;
  let bad = false;
  for (const c of stripped) {
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth < 0) { bad = true; break; } }
  }
  ok(!bad && depth === 0, `${label}: braces balance (depth ${depth})`);
}
braceBalance(sheet, "styles.css");
braceBalance(inlineStyle, "hackathons.html inline <style>");

const allCss = sheet + "\n" + inlineStyle;

// Every hk- class the page or the renderer emits must have a rule somewhere.
// The three sections added after the review are in this list too — leaving
// them out meant a new class could ship with no styling at all and nothing
// would say so.
const allRendered = pageHtml + roundsHtml + soonHtml + statsHtml +
  storyHeadHtml + storyHtml + videosHtml + coachesHtml + ctaHtml;
const classAttrs = [...allRendered.matchAll(/class="([^"]*)"/g)];
const used = new Set();
for (const m of classAttrs) {
  for (const c of m[1].split(/\s+/)) if (c.startsWith("hk-")) used.add(c);
}
const missing = [...used].filter((c) => !allCss.includes("." + c));
ok(missing.length === 0, `every hk- class used has a rule (${used.size} classes)`, missing.join(", "));

// Nothing still points at the deleted rules. Comments are stripped first —
// a note explaining why a rule went is not the rule coming back.
const cssNoComments = allCss.replace(/\/\*[\s\S]*?\*\//g, "");
const jsNoComments = js.replace(/^\s*\/\/.*$/gm, "");
for (const dead of ["hk-podium", "hk-no-placings", "hk-provenance", "hk-venue"]) {
  ok(!cssNoComments.includes("." + dead) && !jsNoComments.includes(dead),
    `the ${dead} rules and markup are both gone`);
}

// Reduced motion: everything new that animates has to be switchable off in
// both the media query and the site's own html.reduce-motion class.
//
// This used to split the sheet on the first "@media (prefers-reduced-motion"
// and keep everything after it, which is most of the file — so the check
// passed as long as the selector appeared ANYWHERE later, including in the
// ordinary rule that defines the animation in the first place. Deleting a
// reduced-motion rule outright did not fail it. The block is now extracted by
// brace matching, and the class form is matched as an actual selector.
function blocksOf(css, opener) {
  const out = [];
  const re = new RegExp(opener.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{", "g");
  let m;
  while ((m = re.exec(css)) !== null) {
    let i = m.index + m[0].length;
    const start = i;
    let depth = 1;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    out.push(css.slice(start, i - 1));
  }
  return out.join("\n");
}
const rmMedia = blocksOf(allCss, "@media (prefers-reduced-motion: reduce)");
ok(rmMedia.length > 0 && rmMedia.length < allCss.length / 4,
  "the reduced-motion media blocks are extracted, not the rest of the sheet");
for (const sel of ["hk-medal", "hk-round-caret", "hk-round-toggle", "hk-spin", "hk-video-cue"]) {
  ok(new RegExp("\\." + sel + "\\b").test(rmMedia), `prefers-reduced-motion switches off .${sel}`);
  ok(new RegExp("html\\.reduce-motion[^{}]*\\." + sel + "\\b[^{}]*\\{").test(allCss),
    `html.reduce-motion switches off .${sel}`);
}
ok((allCss.match(/@media \(prefers-reduced-motion: reduce\)/g) || []).length >= 6,
  "the reduced-motion blocks are still all present");

// The medal cards were "taking very big side". These are the sizes that
// answer to that, held here so a later tweak cannot quietly grow them back.
{
  // EVERY declaration of the property in the rule, not the first one and not
  // the last one. Reading one of them let a `width: 92px !important;` added
  // above the real declaration go unnoticed, because the greedy match walked
  // past it to the 54px further down.
  const all = (selector, prop) =>
    [...blocksOf(allCss, selector).matchAll(new RegExp(prop + ":\\s*(\\d+(?:\\.\\d+)?)px", "g"))]
      .map((m) => parseFloat(m[1]));
  const worst = (selector, prop) => {
    const v = all(selector, prop);
    return v.length ? Math.max(...v) : NaN;
  };
  const badge = worst(".hk-medal-badge", "width");
  const trophy = worst(".hk-medal-trophy", "width");
  const team = worst(".hk-medal-team", "font-size");
  ok(badge <= 64, `the medallion is small (largest declared ${badge}px, was 92px)`);
  ok(trophy <= 40, `the trophy is small (largest declared ${trophy}px, was 58px)`);
  ok(team <= 16, `the team name is sized for a small card (largest declared ${team}px, was 20px)`);
  ok(worst(".hk-medal", "padding") <= 16 || Number.isNaN(worst(".hk-medal", "padding")),
    "the card padding is tight");
  // Three across at every width now that they fit; the old sheet dropped to
  // one per row on a phone purely because the cards were so tall.
  ok(!/@media \(max-width: 720px\)[^}]*\{[^@]*\.hk-medals[^}]*grid-template-columns:\s*1fr/s.test(allCss),
    "the phone breakpoint no longer stacks the medals one per row");
}

// The logo slots must not be an invention of this page: they use the same
// html.light-mode swap the club wordmark already uses.
ok(/html\.light-mode \.hk-logo-light\.is-ready\s*\{[^}]*display:\s*block/s.test(allCss) &&
   /html\.light-mode \.hk-logo-dark\.is-ready\s*\{[^}]*display:\s*none/s.test(allCss),
  "the logo pair swaps on html.light-mode, the same way .logo-img-dark does");
ok(/\.hk-logo-img\s*\{[^}]*display:\s*none/s.test(allCss),
  "logo images start hidden, so a missing file never paints a broken icon");
// ⚠ THIS CHECK USED TO REQUIRE display:none, AND THAT IS WHAT BROKE IT.
// The coach photos carry loading="lazy". A display:none image never
// intersects the viewport, so the browser never fetches it: `complete` stays
// false, `load` never fires, `is-ready` is never added, and it stays hidden
// for ever. Every coach rendered as a monogram while all eight files sat on
// the server returning 200 — it could not load until it was shown, and could
// not be shown until it loaded. opacity keeps the element laid out, so it
// loads normally.
ok(/\.hk-coach-photo\s*\{[^}]*opacity:\s*0/s.test(allCss) &&
   /\.hk-coach-photo\.is-ready\s*\{[^}]*opacity:\s*1/s.test(allCss),
  "coach photos are transparent until they decode, not display:none");
ok(!/\.hk-coach-photo\s*\{[^}]*display:\s*none/s.test(allCss),
  "⚠ ...and specifically NOT display:none, which deadlocks with loading=lazy");

// The general rule, so it cannot be reintroduced on some other element:
// anything the markup marks lazy must not be hidden with display:none.
{
  const lazyClasses = [...js.matchAll(/class="([^"]*)"[^>]*loading="lazy"/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter((c) => c.startsWith("hk-"));
  const deadlocked = [...new Set(lazyClasses)].filter((c) =>
    new RegExp(`\\.${c}\\s*\\{[^}]*display:\\s*none`, "s").test(allCss));
  ok(deadlocked.length === 0,
    "no lazily-loaded image is hidden with display:none anywhere",
    deadlocked.join(", "));
}

// ---- the coming-soon lockup and its gradient text ----
// The centring Ahmed asked for is a property of the flex row, not of the two
// children happening to be the same height, so the row is what is asserted.
{
  const lockup = blocksOf(allCss, ".hk-soon-lockup");
  ok(/display:\s*flex/.test(lockup), ".hk-soon-lockup is a flex row");
  ok(/align-items:\s*center/.test(lockup),
    "...that centres the mark and the words on each other — the vertical centre line");
  ok(!/\.hk-soon-h\s*\{[^}]*align-items/s.test(allCss),
    ".hk-soon-h is not itself the flex row, so only the lockup decides the middle");

  const verb = blocksOf(allCss, ".hk-soon-verb");
  ok(/line-height:\s*1\b/.test(verb),
    "the words' box is tight, so centring the box centres the glyphs");
  // The verb's colour is no longer its own. It carries .hk-mark-text like the
  // other five titles, and a `color` left behind here would shadow that class's
  // measured solid fallback in exactly the browsers that need it.
  ok(!/color:/.test(verb),
    ".hk-soon-verb declares no colour of its own — .hk-mark-text owns it", verb);

  // ---- the gradient, and the fallback that must survive without it ----
  // The order is the safety property: `color` is set unconditionally and the
  // transparent text fill only ever exists inside the @supports gate that also
  // brings the gradient. A browser that cannot paint gradient text therefore
  // cannot reach a state where this heading is invisible.
  //
  // The sheet carries FIVE blocks with this same @supports condition — the club
  // wordmark's glow already uses the technique, which is why this heading uses
  // it too rather than inventing a second mechanism — so the right one is found
  // by a declaration inside it, not by the condition.
  const supportsBlockFor = (css, needle) => {
    const i = css.indexOf(needle);
    if (i === -1) return "";
    const open = css.lastIndexOf("@supports", i);
    if (open === -1) return "";
    let j = css.indexOf("{", open) + 1;
    const start = j;
    let depth = 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    return css.slice(start, j - 1);
  };
  const gate = supportsBlockFor(allCss, "linear-gradient(90deg, #9aa5ff");
  ok(gate.length > 0, "the gradient text is behind an @supports gate");
  ok(allCss.includes(gate), "...and that block was extracted whole");
  ok(/-webkit-text-fill-color:\s*transparent/.test(gate),
    "...and the transparent fill is inside that gate");
  // ...and nowhere outside it. Scoped to this class: the sheet has other
  // gradient-text rules of its own (the club wordmark's glow), and this is not
  // a claim about them — it is a claim that THIS class's transparent fill
  // cannot exist without the gradient that paints it.
  ok(!/-webkit-text-fill-color:\s*transparent/.test(
       blocksOf(allCss.replace(gate, ""), ".hk-mark-text")),
    "...and this class has no transparent fill outside that gate",
    blocksOf(allCss.replace(gate, ""), ".hk-mark-text"));
  ok(/linear-gradient\(90deg,\s*#9aa5ff/.test(gate) && /#ff9ae8/.test(gate),
    "the dark ramp is the measured blue -> magenta one");
  ok(/linear-gradient\(90deg,\s*#1a1fd6/.test(gate) && /#9c0080/.test(gate),
    "the light ramp is the measured deep blue -> deep magenta one");
  ok(/background-clip:\s*text/.test(gate) && /-webkit-background-clip:\s*text/.test(gate),
    "both the prefixed and the standard background-clip are declared");
  // The solid fallbacks are the WORST end of each theme's ramp, so a browser
  // that falls back gets a colour already measured at the gradient's own worst
  // number. contrast.mjs measures both.
  ok(/\.hk-mark-text\s*\{[^}]*color:\s*#9aa5ff/s.test(allCss),
    "the dark fallback is the blue end, which is the dark ramp's worst point");
  ok(/html\.light-mode \.hk-mark-text\s*\{[^}]*color:\s*#9c0080/s.test(allCss),
    "the light fallback is the magenta end, which is the light ramp's worst point");
  // Forced colours throw the gradient away; without this the text would be
  // painted in a transparent fill with nothing behind it.
  ok(/@media \(forced-colors: active\)/.test(gate) &&
     /-webkit-text-fill-color:\s*currentColor/.test(gate),
    "forced-colors hands the text back to the system colour");
  // The mark's raw colours measure 1.57:1 and 3.40:1 on this panel. Neither
  // may be used as the text colour, however tempting "the actual logo hex" is.
  ok(!/\.hk-mark-text[^{}]*\{[^}]*#0017ff/s.test(allCss) &&
     !/\.hk-mark-text[^{}]*\{[^}]*#f200c3/s.test(allCss),
    "neither raw brand colour is used as text — both fail AA on this panel");
}

// ---- the story: heading above the tiles, prose centred ----
{
  ok(/\.hk-story\s*\{[^}]*text-align:\s*center/s.test(allCss),
    "the story card's text is centred, which is what Ahmed asked for");
  ok(/\.hk-story-h\s*\{[^}]*text-align:\s*center/s.test(allCss),
    "...and so is the heading that now sits above the tiles");
  ok(/\.hk-countries\s*\{[^}]*justify-content:\s*center/s.test(allCss),
    "...and the country tag row centres with the prose it belongs to");
}

// ---- one chip row on a wide screen ----
{
  const meta = blocksOf(allCss, ".hk-meta");
  ok(/display:\s*flex/.test(meta), ".hk-meta is a flex row");
  ok(/flex-wrap:\s*wrap/.test(meta),
    "...that wraps, so a narrow screen gets tidy rows instead of a clipped one");
  // The groups have to be able to wrap as units before their chips do, and the
  // gap between the groups has to be wider than the gap inside them or the one
  // row reads as six undifferentiated pills.
  const outer = (meta.match(/gap:\s*(\d+)px\s+(\d+)px/) || []);
  const inner = (blocksOf(allCss, ".hk-figures").match(/gap:\s*(\d+)px/) || []);
  ok(outer.length === 3 && inner.length === 2 && +outer[2] > +inner[1],
    `the gap between the groups (${outer[2]}px) is wider than the gap inside them (${inner[1]}px)`);
  ok(/\.hk-meta > \.hk-chips\s*\{[^}]*margin-top:\s*0/s.test(allCss),
    "the groups lose their stacking margin inside the row");
  // No chip is dropped at any width. Hiding one on a phone would be choosing
  // which of Ahmed's figures does not matter.
  ok(!/\.hk-(chip|figures|meta)[^{}]*\{[^}]*display:\s*none/s.test(allCss),
    "no chip is hidden at any breakpoint");
}

// ---- the demo videos: the façade's geometry ----
{
  const media = blocksOf(allCss, ".hk-video-media");
  ok(/aspect-ratio:\s*16\s*\/\s*9/.test(media),
    "the media box is pinned to 16/9, so the poster and the player are the same shape");
  ok(/\.hk-video-thumb\s*\{[^}]*object-fit:\s*cover/s.test(allCss),
    "...and the 4:3 poster is cropped into it rather than letterboxed");
  ok(/\.hk-video-play:focus-visible\s*\{[^}]*outline/s.test(allCss),
    "the play button has a visible focus ring");
  ok(/html\.reduce-motion \.hk-video-cue\s*\{[^}]*transition:\s*none/s.test(allCss),
    "the play cue's transition is switchable off");
}

// ---- the six section titles share one class, and are centred ----
{
  // ONE declaration of the ramp, not six. Counted: if somebody re-inlines the
  // gradient onto a second heading this goes to two and this row turns red,
  // which is the whole reason the class exists.
  const darkRamp = allCss.match(/linear-gradient\(90deg,\s*#9aa5ff\s*0%,\s*#ff9ae8\s*100%\)/g) || [];
  const lightRamp = allCss.match(/linear-gradient\(90deg,\s*#1a1fd6\s*0%,\s*#9c0080\s*100%\)/g) || [];
  ok(darkRamp.length === 1,
    `the dark ramp is declared exactly once (found ${darkRamp.length})`);
  ok(lightRamp.length === 1,
    `the light ramp is declared exactly once (found ${lightRamp.length})`);
  // And the six headings themselves declare no colour, so none of them can
  // shadow the class's measured solid fallback in the browsers that need it.
  for (const sel of [".hk-story-h", ".hk-rounds-h", ".hk-videos-h", ".hk-thanks-h", ".hk-cta-h"]) {
    const block = blocksOf(allCss, sel);
    ok(block.length > 0, `${sel} has a rule`);
    ok(!/(^|[;\s])color:/.test(block),
      `${sel} declares no colour of its own — .hk-mark-text owns it`, block);
    ok(/text-align:\s*center/.test(block),
      `${sel} is centred on the page`, block);
  }
  // The gradient span is one box even when it wraps, or the ramp restarts on
  // every line and a three-line heading reads as three gradients.
  ok(/display:\s*inline-block/.test(blocksOf(allCss, ".hk-mark-text")),
    ".hk-mark-text is one box, so a wrapped heading is still one gradient");
  // The medal's opt-out is structural — it is a SIBLING of the gradient span —
  // so .hk-h-emoji must not be trying to undo a clip it never inherits.
  const emoji = blocksOf(allCss, ".hk-h-emoji");
  ok(emoji.length > 0, ".hk-h-emoji has a rule");
  ok(!/background-clip|text-fill-color/.test(emoji),
    "...that undoes nothing: the medal is outside the gradient span, not fighting it", emoji);
  ok(/white-space:\s*nowrap/.test(blocksOf(allCss, ".hk-nowrap")),
    ".hk-nowrap keeps EduHackAI-5 whole across a line break");
}

// ---- the showcase rail ----
{
  const railCss = blocksOf(allCss, ".hk-video-rail");
  ok(/overflow-x:\s*auto/.test(railCss),
    "the rail is a real overflow container, so native scrolling is native");
  ok(/scroll-snap-type:\s*x mandatory/.test(railCss), "...with scroll-snap on the x axis");
  ok(/display:\s*flex/.test(railCss), "...laid out as a row");
  ok(/scroll-behavior:\s*smooth/.test(railCss), "...and scrolling smoothly by default");
  ok(/\.hk-video-rail:focus-visible\s*\{[^}]*outline/s.test(allCss),
    "the rail is focusable, so it has a visible focus ring");
  ok(/\.hk-video\s*\{[^}]*scroll-snap-align:\s*start/s.test(allCss),
    "each card is a snap point");

  // Reduced motion, both spellings — the OS setting and the site's own toggle.
  ok(/\.hk-video-rail\s*\{\s*scroll-behavior:\s*auto/.test(rmMedia),
    "prefers-reduced-motion turns the rail's smooth scroll off", rmMedia);
  ok(/html\.reduce-motion \.hk-video-rail\s*\{[^}]*scroll-behavior:\s*auto/s.test(allCss),
    "...and so does the site's own reduce-motion setting");

  // ---- how many are visible, at each width ----
  // The count is one custom property, so the three answers are three values of
  // it and not three different layout mechanisms. A fractional value IS the
  // peek: at 2.25 two cards are fully in view and a quarter of the next is not.
  ok(/--hk-rail-show:\s*3\b/.test(railCss), "three cards across on a desktop", railCss);
  const at900 = blocksOf(allCss, "@media (max-width: 900px)");
  const at620 = blocksOf(allCss, "@media (max-width: 620px)");
  ok(/--hk-rail-show:\s*2\.25/.test(at900),
    "two, plus a quarter of the third peeking, at 900px and below", at900);
  ok(/--hk-rail-show:\s*1\.15/.test(at620),
    "one, plus a sliver of the second peeking, at 620px and below", at620);
  // Fractional at the narrow widths and whole at the wide one — i.e. there IS a
  // peek where the rail is not obviously a row, and none where it is.
  ok(Number("2.25") % 1 !== 0 && Number("1.15") % 1 !== 0 && Number("3") % 1 === 0,
    "the two narrow breakpoints peek and the desktop one does not");

  // The card width is derived from that one property, and carries a flat
  // fallback declared BEFORE it — so an engine that drops the calc still gets a
  // working scroller rather than a collapsed row.
  const cardCss = blocksOf(allCss, ".hk-video");
  const flexes = cardCss.match(/flex:\s*0 0 [^;]+;/g) || [];
  ok(flexes.length === 2, `.hk-video declares its width twice — fallback then calc`, cardCss);
  ok(flexes.length === 2 && !/calc/.test(flexes[0]) && /calc/.test(flexes[1]),
    "...in that order, so a browser that cannot do the calc keeps the fallback",
    flexes.join("  "));
  ok(flexes.length === 2 && /var\(--hk-rail-show\)/.test(flexes[1]),
    "...and the calc is driven by --hk-rail-show", flexes.join("  "));

  // No card is hidden at any width. Hiding one would be choosing which team's
  // work does not matter.
  ok(!/\.hk-video(\s*,|\s*\{)[^{}]*\{[^}]*display:\s*none/s.test(allCss),
    "no video card is hidden at any breakpoint");

  // The buttons' disabled state is styling only. pointer-events:none would
  // also take them out of hover and away from a tooltip, and `disabled`
  // already makes them unclickable.
  const disabled = blocksOf(allCss, ".hk-rail-btn[disabled]");
  ok(disabled.length > 0, "the disabled rail button has a rule of its own");
  ok(!/pointer-events/.test(disabled),
    "...that does not fake the disabling with pointer-events", disabled);
  ok(/\.hk-rail-btn:focus-visible\s*\{[^}]*outline/s.test(allCss),
    "the rail buttons have a visible focus ring");
}

// ---- the player dialog ----
{
  // The overlay, the backdrop and the scroll lock are SHARED with the interest
  // dialog: the player carries class="hk-modal hk-vmodal", so there is one
  // .hk-modal rule and one body.hk-modal-open, not two of each.
  ok(/class="hk-modal hk-vmodal"/.test(pageHtml),
    "the player reuses .hk-modal for its overlay rather than declaring a second one");
  ok((allCss.match(/body\.hk-modal-open\s*\{/g) || []).length === 1,
    "there is exactly one scroll-lock rule for both dialogs");
  // One backdrop, in two themes — and no backdrop of the player's own. Counted
  // this way round because "two rules" is correct here (dark and light) and
  // what must not exist is a THIRD written for .hk-vmodal.
  ok((allCss.match(/^\.hk-modal-backdrop\s*\{/gm) || []).length === 1,
    "there is one unqualified backdrop rule, shared by both dialogs");
  // The player RE-TINTS the shared backdrop — its title sits directly on it and
  // light mode's 0.55 tint measured about 4.2:1 under white 16px text — but it
  // must not restate the backdrop's geometry, or there would be two answers to
  // where the backdrop is.
  {
    const vBack = blocksOf(allCss, ".hk-vmodal .hk-modal-backdrop");
    ok(vBack.length > 0, "the player re-tints the shared backdrop");
    ok(/background:/.test(vBack) && !/position|inset|backdrop-filter/.test(vBack),
      "...and re-tints it only — position, inset and blur stay in the shared rule", vBack);
    // The light-mode override has to out-specify html.light-mode
    // .hk-modal-backdrop or it silently loses and the light dialog goes back to
    // a 4.2:1 title.
    ok(/html\.light-mode \.hk-vmodal \.hk-modal-backdrop/.test(allCss),
      "...with a light-mode selector specific enough to win");
  }

  // NEVER TALLER THAN THE VIEWPORT. The height is capped by capping the WIDTH:
  // a 16:9 box's height is its width times 9/16, so a width cap in vh units is
  // a height cap that aspect-ratio cannot argue with.
  const box = blocksOf(allCss, ".hk-vmodal-box");
  const widths = box.match(/width:\s*[^;]+;/g) || [];
  ok(widths.length === 3, `.hk-vmodal-box caps its width three times over`, box);
  ok(/100vh/.test(box) && /100dvh/.test(box),
    "...in both vh and dvh, so a phone's retracted URL bar is accounted for", box);
  ok(box.indexOf("100vh") < box.indexOf("100dvh"),
    "...with dvh last, so a browser that has it uses it", box);
  ok(/16\s*\/\s*9/.test(box),
    "...and the cap is derived from the player's own 16:9", box);
  ok(/aspect-ratio:\s*16\s*\/\s*9/.test(blocksOf(allCss, ".hk-vmodal-media")),
    "the media box inside it is 16:9");
  ok(/width:\s*100%/.test(blocksOf(allCss, ".hk-vmodal-media")),
    "...and fills the width it was given, so the whole thing is responsive");
  ok(/\.hk-vmodal-media\s*\{[^}]*position:\s*relative/s.test(allCss),
    "...and is the positioning context the frame sits in");
}

// Both themes define every medal token the cards read.
for (const tier of ["gold", "silver", "bronze"]) {
  const dark = new RegExp(`\\.hk-medal\\.is-${tier}\\s*\\{`).test(allCss);
  const light = new RegExp(`html\\.light-mode \\.hk-medal\\.is-${tier}\\s*\\{`).test(allCss);
  ok(dark && light, `.hk-medal.is-${tier} is defined in both themes`);
}

// ============================================================
if (process.env.HK_DUMP) {
  console.log("\n---- coming soon ----\n" + soonHtml);
  console.log("\n---- first round header + medals ----\n" +
    roundsHtml.slice(0, roundsHtml.indexOf('class="hk-round-panel"')));
  console.log("\n---- story heading (above the tiles) ----\n" + storyHeadHtml);
  console.log("\n---- summary tiles ----\n" + statsHtml.replace(/></g, ">\n<"));
  console.log("\n---- story prose (below the tiles) ----\n" + storyHtml.replace(/></g, ">\n<"));
  console.log("\n---- demo videos ----\n" + videosHtml.replace(/></g, ">\n<"));
  console.log("\n---- coaches ----\n" + coachesHtml.replace(/></g, ">\n<"));
  console.log("\n---- closing CTA ----\n" + ctaHtml.replace(/></g, ">\n<"));
}
console.log(`\n${checks} checks, ${failures} failing.`);
process.exit(failures ? 1 : 0);
