// check-register-prompt.mjs
// ------------------------------------------------------------
//   node tools/check-register-prompt.mjs
//
// Pressing Register sends a member out to somebody else's ticketing site.
// Nothing reports back, so the only way the club ever learns whether they went
// is to ask them when they return. Two screens offer that button — the events
// list and the event's own page — and until 13 Aug only one of them asked.
//
// What this guards is not the dialog's wording. It is that BOTH screens still
// run the SAME flow, out of lib/register-prompt.js, and that neither has grown
// a private copy of it. That is the failure this project keeps repeating: the
// Admin link vs the page it opens (three times), the importer's gate vs the
// table it feeds, missingForConnect() vs 0062. Every one was two sides of one
// rule with nothing comparing them.
//
// Static: it reads the three files and drives the real module against a stub
// DOM. No database, no key, no session, no browser — so it runs in CI.
//
// ⚠ Self-tests in both directions at the end, per this project's rule that a
// checker never seen to fail is a checker nobody should trust.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// The real module, optionally sabotaged, imported as a data: URL. A copy of the
// logic here would keep passing long after lib/register-prompt.js stopped
// agreeing with it — the exact fault this checker exists to catch.
function loadPrompt(sabotage) {
  let src = read("lib/register-prompt.js");
  if (sabotage) src = sabotage(src);
  return import("data:text/javascript," + encodeURIComponent(src));
}

// ---- A stub DOM, just wide enough to drive the flow ------------------------

function makeDom() {
  const open = [];
  const doc = {
    visibilityState: "visible",
    body: { appendChild: (el) => open.push(el) },
    createElement() {
      const el = {
        className: "",
        innerHTML: "",
        press: {},
        querySelector(sel) {
          return { addEventListener: (_e, fn) => { el.press[sel] = fn; } };
        },
        remove() {
          const i = open.indexOf(el);
          if (i >= 0) open.splice(i, 1);
        },
      };
      return el;
    },
    // The module asks this to avoid stacking a second dialog on the first.
    querySelector: (sel) => (sel === ".ev-ask-back" && open.length ? open[0] : null),
    addEventListener: () => {},
  };
  return { doc, open };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    size: () => map.size,
  };
}

function fresh() {
  const dom = makeDom();
  globalThis.document = dom.doc;
  globalThis.window = { addEventListener: () => {} };
  globalThis.sessionStorage = makeStorage();
  return dom;
}

const EVENT_ID = "6f1b7c22-0000-4000-8000-000000000001";
const TITLE = 'AI on "Cloud" & <friends>';

// ---- The checks, as data, so the self-test can run the same list -----------

async function run(mod, report) {
  // --- the note ---
  let dom = fresh();
  mod.rememberPending(EVENT_ID, TITLE);
  const raw = globalThis.sessionStorage.getItem("sc_pending_registration");
  report("pressing Register leaves a note", !!raw);
  const note = raw ? JSON.parse(raw) : {};
  report("the note names the event and its title",
    note.id === EVENT_ID && note.title === TITLE);

  // --- yes ---
  dom = fresh();
  let got = {};
  let api = mod.createRegisterPrompt({
    isFavourite: () => false,
    onRegistered: (id) => { got.registered = id; },
    onFavourite: (id) => { got.favourite = id; },
    onInterested: (id) => { got.interested = id; },
  });
  mod.rememberPending(EVENT_ID, TITLE);
  api.check();
  report("coming back asks the question", dom.open.length === 1,
    "no dialog was raised — the member is never asked");
  const ask = dom.open[0];
  report("the question names the event", ask.innerHTML.includes("Did you register?"));
  report("the title is escaped into it",
    ask.innerHTML.includes("AI on &quot;Cloud&quot; &amp; &lt;friends&gt;"),
    "an event title is member-supplied text and reaches innerHTML");
  ask.press["[data-yes]"]();
  report("yes records the registration", got.registered === EVENT_ID);
  report("ANSWERING CLEARS THE NOTE", globalThis.sessionStorage.size() === 0,
    "the same question would be asked again on the next return");
  report("the dialog closes behind them", dom.open.length === 0);

  // --- no, then saved ---
  dom = fresh();
  got = {};
  api = mod.createRegisterPrompt({
    isFavourite: () => false,
    onRegistered: (id) => { got.registered = id; },
    onFavourite: (id) => { got.favourite = id; },
    onInterested: (id) => { got.interested = id; },
  });
  mod.rememberPending(EVENT_ID, TITLE);
  api.check();
  dom.open[0].press["[data-no]"]();
  report("not yet offers to save it instead", dom.open.length === 1 &&
    dom.open[0].innerHTML.includes("Save it for later?"));
  dom.open[0].press["[data-yes]"]();
  report("saving it records a favourite", got.favourite === EVENT_ID);
  report("and does NOT record a registration", got.registered === undefined,
    "somebody who said 'not yet' would be counted as attending");

  // --- no, then passed ---
  dom = fresh();
  got = {};
  api = mod.createRegisterPrompt({
    isFavourite: () => false,
    onRegistered: (id) => { got.registered = id; },
    onInterested: (id) => { got.interested = id; },
  });
  mod.rememberPending(EVENT_ID, TITLE);
  api.check();
  dom.open[0].press["[data-no]"]();
  dom.open[0].press["[data-no]"]();
  report("looking and passing still records interest", got.interested === EVENT_ID);

  // --- already a favourite ---
  dom = fresh();
  got = {};
  api = mod.createRegisterPrompt({
    isFavourite: () => true,
    onInterested: (id) => { got.interested = id; },
  });
  mod.rememberPending(EVENT_ID, TITLE);
  api.check();
  dom.open[0].press["[data-no]"]();
  report("an event already saved is not offered again", dom.open.length === 0,
    "addFavourite() is a plain insert and the duplicate would fail");

  // --- a stale note ---
  dom = fresh();
  api = mod.createRegisterPrompt({});
  globalThis.sessionStorage.setItem("sc_pending_registration",
    JSON.stringify({ id: EVENT_ID, title: TITLE, at: Date.now() - 3 * 60 * 60 * 1000 }));
  api.check();
  report("A STALE NOTE IS NOT A RETURN", dom.open.length === 0,
    "hours later this is a new visit, and the question is about something they no longer remember");
  report("and the stale note is dropped", globalThis.sessionStorage.size() === 0);

  // --- the pair of listeners ---
  dom = fresh();
  api = mod.createRegisterPrompt({});
  mod.rememberPending(EVENT_ID, TITLE);
  api.check();
  api.check();
  report("TWO RETURNS DO NOT STACK TWO DIALOGS", dom.open.length === 1,
    "visibilitychange and focus both fire on some returns");

  // --- a hidden page ---
  dom = fresh();
  globalThis.document.visibilityState = "hidden";
  api = mod.createRegisterPrompt({});
  mod.rememberPending(EVENT_ID, TITLE);
  api.check();
  report("nothing is asked while the tab is still hidden", dom.open.length === 0);

  // --- storage that throws (private mode, full quota) ---
  dom = fresh();
  globalThis.sessionStorage = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); },
  };
  let threw = null;
  try {
    mod.rememberPending(EVENT_ID, TITLE);
    mod.createRegisterPrompt({}).check();
  } catch (e) { threw = e.message; }
  report("a browser that refuses storage still opens the ticket page",
    threw === null, "threw: " + threw);
}

// ---- The two callers still share it ---------------------------------------

// ⚠ EVERY "MUST NOT CONTAIN" CHECK RUNS ON CODE, NOT PROSE. The first run of
// this file failed twice, both times on its own comments: the note above the
// Register anchor says the handler "does NOT preventDefault", and isSignedIn()'s
// note says it is "deliberately NOT `!isGuest()`" — so a check for the absence
// of those two strings found them being ruled out in writing. A checker that
// reads comments reports the opposite of the truth as soon as somebody explains
// themselves. Full-line comments only, so a URL keeps its `//`.
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

function runWiring(files, report) {
  const { prompt, ui, page } = files;
  const pageCode = code(page);

  report("the module exports what both callers import",
    /export function createRegisterPrompt/.test(prompt) &&
    /export function rememberPending/.test(prompt));

  [["events-ui.js", ui], ["event.html", page]].forEach(([name, src]) => {
    report(name + " loads the shared module", /lib\/register-prompt\.js/.test(src));
    report(name + " leaves the note on the way out", /rememberPending\s*\(/.test(src));
    report(name + " wires the question on the way back",
      /createRegisterPrompt\s*\(/.test(src) && /\.start\(\)/.test(src));
  });

  // THE ANTI-DRIFT CHECK. Not the wording — the fact that the wording lives in
  // exactly one file. A second copy is how the two screens start disagreeing.
  const copies = [["lib/register-prompt.js", prompt], ["events-ui.js", ui], ["event.html", page]]
    .filter(([, src]) => src.includes("Did you register?"))
    .map(([n]) => n);
  report("THE DIALOG EXISTS IN EXACTLY ONE FILE",
    copies.length === 1 && copies[0] === "lib/register-prompt.js",
    "found in: " + copies.join(", ") + " — the two screens will drift apart");

  const keyed = [["lib/register-prompt.js", prompt], ["events-ui.js", ui], ["event.html", page]]
    .filter(([, src]) => src.includes("sc_pending_registration"))
    .map(([n]) => n);
  report("ONE STORAGE KEY, DEFINED ONCE",
    keyed.length === 1 && keyed[0] === "lib/register-prompt.js",
    "found in: " + keyed.join(", ") + " — a second definition is a question asked twice or not at all");

  // event.html's own half.
  report("event.html's Register control is tagged", /data-register="/.test(page));
  report("THE REGISTER CONTROL IS STILL A REAL LINK",
    /<a class="btn btn-glow" href="' \+ esc\(e\.register_link\)/.test(page),
    "a button would break middle-click, open-in-new-tab and copy-link");
  // Scoped to the register handler: other controls on this page may legitimately
  // swallow their own clicks.
  const handler = pageCode.slice(pageCode.indexOf('closest("a[data-register]")'));
  report("and the handler does not swallow the click",
    handler !== "" && !/preventDefault\s*\(/.test(handler.slice(0, 600)),
    "preventDefault would stop the organiser's page opening at all");
  report("the note needs a POSITIVE sign-in signal",
    /isSignedIn\s*\(\)/.test(pageCode) && !/!\s*isGuest\s*\(\)/.test(pageCode),
    "'not known yet' must not promise a question we cannot save the answer to");
}

// ---- Run -------------------------------------------------------------------

let failed = 0;
const report = (label, ok, detail) => {
  if (ok) { console.log("  ok    " + label); return; }
  failed++;
  console.log("  FAIL  " + label + (detail ? "\n        " + detail : ""));
};

const FILES = {
  prompt: read("lib/register-prompt.js"),
  ui: read("events-ui.js"),
  page: read("event.html"),
};

console.log("\nthe \"did you register?\" flow — the shared module\n");
await run(await loadPrompt(null), report);

console.log("\nboth screens still run it\n");
runWiring(FILES, report);

// ---- Self-test -------------------------------------------------------------
//
// Each sabotage is a regression this file exists to catch, and each must be
// NOTICED. Without this, a check that silently stopped inspecting anything
// would report a clean run for ever.
console.log("\nself-test — the checks must fail when the flow is broken\n");

async function mustCatch(name, run1, expectHit) {
  const hits = [];
  try {
    await run1((label, ok) => { if (!ok) hits.push(label); });
  } catch (e) {
    hits.push("threw: " + e.message);
  }
  if (hits.some((h) => h.includes(expectHit))) {
    console.log('  ok    ' + name + ' → caught by "' + expectHit + '"');
  } else {
    failed++;
    console.log("  FAIL  " + name + " went UNNOTICED — this checker cannot be trusted");
  }
}

// "Why keep an expiry?" — a note that never goes stale asks about a click from
// yesterday.
await mustCatch("the expiry removed",
  async (r) => run(await loadPrompt((s) => s.replace("Date.now() - p.at > MAX_AGE_MS", "false")), r),
  "A STALE NOTE IS NOT A RETURN");

// "visibilitychange already covers it" — the guard against the pair firing.
await mustCatch("the already-open guard removed",
  async (r) => run(await loadPrompt((s) =>
    s.replace('if (document.querySelector(".ev-ask-back")) return;', "")), r),
  "TWO RETURNS DO NOT STACK TWO DIALOGS");

// A yes that leaves the note behind asks the same question for two hours.
await mustCatch("the note left behind after an answer",
  async (r) => run(await loadPrompt((s) =>
    s.replace("      clearPending();\n      if (h.onRegistered)", "      if (h.onRegistered)")), r),
  "ANSWERING CLEARS THE NOTE");

// The title reaching innerHTML unescaped.
await mustCatch("the title no longer escaped",
  async (r) => run(await loadPrompt((s) =>
    s.replace("escapeHtml(p.title) + \"</span>.</p>\"", "p.title + \"</span>.</p>\"")), r),
  "the title is escaped into it");

// The regression this whole file was written for: one screen goes its own way.
await mustCatch("events-ui.js grows its own copy of the dialog",
  async (r) => runWiring({ ...FILES, ui: FILES.ui + '\n// "<h3>Did you register?</h3>"\n' }, r),
  "THE DIALOG EXISTS IN EXACTLY ONE FILE");

await mustCatch("a second storage key appears",
  async (r) => runWiring({ ...FILES, page: FILES.page + '\nvar K = "sc_pending_registration";\n' }, r),
  "ONE STORAGE KEY, DEFINED ONCE");

await mustCatch("event.html's Register goes back to a plain link",
  async (r) => runWiring({ ...FILES, page: FILES.page.replace(/data-register="/g, "data-x=\"") }, r),
  "event.html's Register control is tagged");

await mustCatch("the detail page stops asking",
  async (r) => runWiring({ ...FILES, page: FILES.page.replace(/createRegisterPrompt\s*\(/g, "noop(") }, r),
  "event.html wires the question on the way back");

// "It's a handler, handlers preventDefault" — and the ticket page stops opening.
await mustCatch("the handler swallows the click",
  async (r) => runWiring({ ...FILES, page: FILES.page.replace(
    'if (!a || !CURRENT) return;', 'if (!a || !CURRENT) return;\n    ev.preventDefault();') }, r),
  "and the handler does not swallow the click");

// "isSignedIn is just !isGuest" — it is not, and the difference is who gets
// promised a question. ⚠ This pair also proves the comment-stripping works: both
// strings are already in the file, in prose, and a clean run means they were not
// counted.
await mustCatch("the sign-in test flipped to the loose one",
  async (r) => runWiring({ ...FILES, page: FILES.page.replace(
    "if (!isSignedIn()) return;", "if (!isGuest()) return;") }, r),
  "the note needs a POSITIVE sign-in signal");

console.log("\n" + (failed ? failed + " FAILED" : "all checks passed") + "\n");
process.exit(failed ? 1 : 0);
