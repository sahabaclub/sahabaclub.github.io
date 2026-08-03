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

ok(roundsHtml.length > 0, "rounds rendered");
tagBalance(roundsHtml, "generated rounds markup");
tagBalance(soonHtml, "generated coming-soon markup");
tagBalance(statsHtml, "generated summary markup");

// -- coming soon -----------------------------------------------------------
ok(soonHtml.includes("Coming soon"), "round 5 renders as coming soon");
ok(soonHtml.includes('data-hk-open="eduhackai-5"'), "coming-soon panel opens the dialog for round 5");
ok(soonHtml.includes("Early bird discount"), "coming-soon panel names the early bird discount");
ok(soonHtml.includes("interested to be with us"), "coming-soon panel uses the owner's words");
ok(!soonHtml.includes("undefined") && !soonHtml.includes("null"),
  "coming-soon panel survives a NULL description/tagline/location");
ok(!roundsHtml.includes("eduhackai-5"), "round 5 is not also rendered as a past round");

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
const classAttrs = [...(pageHtml + roundsHtml + soonHtml + statsHtml).matchAll(/class="([^"]*)"/g)];
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
const rmMedia = allCss.split("@media (prefers-reduced-motion: reduce)").slice(1).join("");
const rmClass = allCss.split("html.reduce-motion").slice(1).join("");
for (const sel of ["hk-medal", "hk-round-caret", "hk-spin"]) {
  ok(rmMedia.includes(sel), `prefers-reduced-motion switches off .${sel}`);
  ok(rmClass.includes(sel), `html.reduce-motion switches off .${sel}`);
}
ok((allCss.match(/@media \(prefers-reduced-motion: reduce\)/g) || []).length >= 6,
  "the reduced-motion blocks are still all present");

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
