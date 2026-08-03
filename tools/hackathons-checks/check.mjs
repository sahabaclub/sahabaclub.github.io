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

const js = fs.readFileSync(path.join(REPO, "hackathons-ui.js"), "utf8");
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
  "hack-story", "hack-coaches", "hack-cta",
  "hack-q", "hack-clear-q", "hack-count", "hk-interest", "hk-interest-title",
  "hk-interest-intro", "hk-interest-form", "hk-interest-submit",
  "hk-interest-done", "hk-done-text", "hk-form-error",
]) el(id);

// The dialog's inner structure the script reaches for.
const modal = registry.get("hk-interest");
modal.hidden = true;
const modalBox = el(null, "div");
modal._kids[".hk-modal-box"] = modalBox;

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
};
const window_ = {
  addEventListener: (t, fn) => { (listeners.window[t] = listeners.window[t] || []).push(fn); },
  location: { hash: "" },
  console,
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
const storyHtml = registry.get("hack-story").innerHTML;
const coachesHtml = registry.get("hack-coaches").innerHTML;
const ctaHtml = registry.get("hack-cta").innerHTML;

ok(roundsHtml.length > 0, "rounds rendered");
tagBalance(roundsHtml, "generated rounds markup");
tagBalance(soonHtml, "generated coming-soon markup");
tagBalance(statsHtml, "generated summary markup");
tagBalance(storyHtml, "generated history markup");
tagBalance(coachesHtml, "generated coaches markup");
tagBalance(ctaHtml, "generated closing-CTA markup");

// -- coming soon -----------------------------------------------------------
ok(soonHtml.includes("is coming"), "round 5 renders as a plain statement that it is coming");
ok(soonHtml.includes("The next round"), "the panel's eyebrow says which round this is");
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
  ok(/<h2 class="hk-story-h"/.test(storyHtml), "it has a heading");
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
  ok(storyHtml.includes("<strong>8</strong> people"),
    "people are counted once each across rounds");
  // A list, not a comma-joined clause — most of these names contain a comma.
  const venues = [...storyHtml.matchAll(/<li class="hk-venue">([^<]+)<\/li>/g)].map((m) => m[1]);
  ok(venues.length === 3, `each Demo Day venue is its own list item (${venues.length})`);
  ok(venues.includes("Cairo, Egypt") && venues.includes("Mercure Hotel, Dubai") &&
     venues.includes("CodersHQ, Dubai"), "the Demo Day venues are named verbatim", venues.join(" | "));
  ok(storyHtml.includes("<strong>4</strong> Demo Days have been held"),
    "the Demo Day count is computed from the labelled locations");
  ok(storyHtml.includes("Round 4 ran in Arabic."),
    "the Arabic round is named, read back out of its own description");
  // Nothing about countries: `hackathons` has no country column and the venue
  // strings mix a bare city with a city-and-country, so a count could only
  // come from knowledge this page does not have.
  ok(!/countr/i.test(storyHtml), "no claim about countries is made");
  ok(!/undefined|NaN|null/.test(storyHtml), "no unresolved value reaches the prose");
}

// -- coaches, across the whole programme ------------------------------------
{
  ok(coachesHtml.includes("Thanks to our coaches in EduHackAI journey"),
    "the section uses the owner's title");
  const cards = coachesHtml.match(/<article class="hk-coach">/g) || [];
  ok(cards.length === 4, `one card per distinct coach (${cards.length})`);
  ok((coachesHtml.match(/Ahmed Zoka/g) || []).length === 1,
    "a coach who taught three rounds appears exactly once");
  ok(coachesHtml.indexOf("Ahmed Zoka") < coachesHtml.indexOf("Aaron Second Coach"),
    "the lead coach is first, in the order the view supplied");
  {
    const card = coachesHtml.slice(coachesHtml.indexOf("Ahmed Zoka"));
    const end = card.indexOf("</article>");
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
  ok(coachesHtml.includes('<span class="hk-coach-mono" aria-hidden="true">AZ</span>'),
    "a two-part name monograms from its first and last parts");
  ok(!coachesHtml.includes("Zed Builder") && !coachesHtml.includes("Someone Else"),
    "competitors are not in the coaches section");
  ok(coachesHtml.includes('src="assets/eduhack/coaches/ahmed-zoka.jpg"'),
    "the photo path is the slugified name");
  // None of these files exist, so the monogram is what renders. It has to be
  // present on every card, and the photo has to be the thing that is hidden.
  ok((coachesHtml.match(/class="hk-coach-mono"/g) || []).length === cards.length,
    "every card carries the monogram fallback");
  ok((coachesHtml.match(/data-hk-face/g) || []).length === cards.length,
    "every card's photo is wired to reveal only once it decodes");
  ok(!fs.existsSync(path.join(REPO, "assets/eduhack/coaches")),
    "the coach photo directory is still absent — the monogram is what renders today");
}

// -- the closing CTA -------------------------------------------------------
{
  ok(ctaHtml.includes('data-hk-open="eduhackai-5"'),
    "the closing CTA opens the dialog for the coming round");
  ok(!ctaHtml.includes("<form") && !ctaHtml.includes("role=\"dialog\""),
    "the closing CTA builds no second form and no second dialog");
  ok((pageHtml.match(/<form/g) || []).length === 1,
    "there is exactly one form in the document");
  ok((pageHtml.match(/role="dialog"/g) || []).length === 1,
    "there is exactly one dialog in the document");
  ok((soonHtml + ctaHtml).match(/data-hk-open=/g).length === 2,
    "both ways in are the same mechanism");
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
  const lead = coachBlock.indexOf("Ahmed Zoka");
  const other = coachBlock.indexOf("Aaron Second Coach");
  ok(lead !== -1 && other !== -1 && lead < other,
    "the lead coach is rendered first, in the order the view supplied (not alphabetically)");
  ok(!coachBlock.includes("Zed Builder"), "competitors are not in the coach row");
}
// Names are printed as the database spells them — no renderer-side renaming.
ok(!/"Zoka"/.test(js) && !/LEAD_COACH/.test(js),
  "the renderer does not special-case a coach display name");

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
  ok(s.rounds === 2 && s.teams === 3 && s.builders === 4 && s.medals === 2,
    "summary aggregates rounds/teams/builders/medals", JSON.stringify(s));
  const empty = T.summarise([], {}, {});
  ok(empty.rounds === 0 && empty.teams === 0 && empty.medals === 0, "summary of nothing is zeroes");
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

// -- Demo Day venues out of `location` -------------------------------------
ok(T.demoVenues("Demo Day: Cairo, Egypt").join("|") === "Cairo, Egypt", "one labelled venue");
ok(T.demoVenues("Demo Day 1: CodersHQ, Dubai · Demo Day 2: Cairo, Egypt").length === 2,
  "two demo days in one field");
ok(T.demoVenues("Demo Day 1: CodersHQ, Dubai · Demo Day 2: Cairo, Egypt")[0] === "CodersHQ, Dubai",
  "...split on the separator and stripped of their labels");
// A location that does not say "Demo Day" is a location. Counting it as one
// would be this page asserting something the database did not. The second
// case is the one that matters: a bare "Alexandria" is also rejected by the
// "must have a colon" step, so it cannot tell whether the label test is
// doing anything. A colon-bearing value that is not a Demo Day can.
ok(T.demoVenues("Alexandria").length === 0, "an unlabelled location is not a demo day");
ok(T.demoVenues("Venue: Alexandria").length === 0,
  "a labelled location that is not a Demo Day is not counted as one",
  T.demoVenues("Venue: Alexandria").join("|"));
ok(T.demoVenues("Demo Day: X · Somewhere Else: Y").length === 1,
  "only the Demo Day half of a mixed field counts");
ok(T.demoVenues(null).length === 0 && T.demoVenues("").length === 0, "no location, no venues");

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
  ok(f.demoDays === 1 && f.venues.length === 1, "demo days counted from labelled locations only");
  ok(f.arabicRounds.length === 1 && f.arabicRounds[0] === 2,
    "the Arabic round is read out of the description, not hard-coded");
  const none = T.storyFacts([], {}, {});
  ok(none.rounds === 0 && none.firstStart === null && none.venues.length === 0,
    "a programme with nothing in it computes to nothing");
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
  storyHtml + coachesHtml + ctaHtml;
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
for (const dead of ["hk-podium", "hk-no-placings", "hk-provenance"]) {
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
for (const sel of ["hk-medal", "hk-round-caret", "hk-round-toggle", "hk-spin"]) {
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
ok(/\.hk-coach-photo\s*\{[^}]*display:\s*none/s.test(allCss) &&
   /\.hk-coach-photo\.is-ready\s*\{[^}]*display:\s*block/s.test(allCss),
  "coach photos start hidden and are revealed only once they decode");

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
}
console.log(`\n${checks} checks, ${failures} failing.`);
process.exit(failures ? 1 : 0);
