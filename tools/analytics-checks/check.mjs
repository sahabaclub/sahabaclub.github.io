// Verification harness for the analytics consent gate. Run from the repo root:
//   node tools/analytics-checks/check.mjs
//
// Same shape as tools/member-checks/check.mjs and for the same reason: none of
// this needs a browser, so none of it is allowed to need one.
//
//   1. PARSES every HTML file this change touched — a real tag-stack walk, not
//      a grep — and asserts the markup that was added is there and well formed
//   2. asserts the include list: exactly the seven public pages carry
//      analytics.js, and NOTHING under app/ mentions it at all
//   3. loads analytics.js FOR REAL under a vm realm against a hand-built DOM,
//      and drives the consent state machine through every state:
//      no choice / accepted / declined / DNT / GPC / withdrawn / not configured
//   4. asserts the thing the whole design rests on — that a <script> element
//      pointing at googletagmanager.com is created in EXACTLY ONE state, and
//      that the state is "the visitor pressed accept"
//   5. asserts nothing page-specific reaches the wire: a login.html URL
//      carrying ?next= and an OAuth #error_description is put through the real
//      code and the entire dataLayer is searched for any of it
//
// The measurement id is a real one and that is fine — a GA4 id is served to
// every visitor in the page source by design. Nothing else here is real.

import fs from "node:fs";
import vm from "node:vm";

const REPO = new URL("../..", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1").replace(/\/$/, "");

let failures = 0;
let checks = 0;

// Passes are printed as well as failures. A check that says nothing when it
// succeeds is indistinguishable from a check that did not run — which is the
// mistake tools/check-dead-zone.mjs exists to shout about, and it is not worth
// repeating here.
function ok(cond, label, extra) {
  checks++;
  if (cond) { console.log(`  ok    ${label}`); return true; }
  failures++;
  console.error(`  FAIL  ${label}${extra ? "\n        " + extra : ""}`);
  return false;
}
function eq(actual, expected, label) {
  return ok(actual === expected, label,
    actual === expected ? "" : `expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
}
function has(haystack, needle, label) {
  return ok(String(haystack).includes(needle), label, `not found: ${JSON.stringify(needle)}`);
}
function lacks(haystack, needle, label) {
  return ok(!String(haystack).includes(needle), label, `should not be present: ${JSON.stringify(needle)}`);
}
function section(name) { console.log(`\n== ${name}`); }

const PUBLIC_PAGES = [
  "index.html", "events.html", "hackathons.html", "podcast.html",
  "membership.html", "privacy.html", "login.html",
];
const MEASUREMENT_ID = "G-34MFEPNDJH";
const TAG_HOST = "https://www.googletagmanager.com/gtag/js?id=";

// ============================================================
// 1. An actual HTML parser
// ============================================================
// Small, and only as clever as it needs to be: a tag stack, the void elements,
// raw-text elements skipped whole, and the elements HTML5 lets you leave
// unclosed treated as leavable. That last part is why this is not stricter —
// these pages are hand-written HTML5 and `<p>` without `</p>` is legal; a
// parser that called it an error would report failures that are not failures
// and teach everyone to ignore it.
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"]);
const OPTIONAL_END = new Set(["p", "li", "td", "th", "tr", "thead", "tbody", "tfoot",
  "option", "dt", "dd", "colgroup", "rt", "rp"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

function parseHtml(src, file) {
  const errors = [];
  const stack = [];
  let i = 0;
  let elements = 0;

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end === -1) { errors.push("unterminated comment"); break; }
      i = end + 3;
      continue;
    }
    if (src.startsWith("<!", lt)) {                       // doctype
      const end = src.indexOf(">", lt);
      if (end === -1) { errors.push("unterminated doctype"); break; }
      i = end + 1;
      continue;
    }

    const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(src.slice(lt));
    if (!m) { i = lt + 1; continue; }

    // Walk to the end of the tag, respecting quoted attribute values so that a
    // `>` inside an attribute does not end the tag early.
    let j = lt + m[0].length;
    let quote = null;
    while (j < src.length) {
      const c = src[j];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      j++;
    }
    if (j >= src.length) { errors.push(`unterminated <${m[2]}>`); break; }

    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    const selfClosed = src[j - 1] === "/";
    const line = src.slice(0, lt).split("\n").length;
    i = j + 1;

    if (closing) {
      let k = stack.length - 1;
      while (k >= 0 && stack[k].name !== name && OPTIONAL_END.has(stack[k].name)) k--;
      if (k < 0 || stack[k].name !== name) {
        errors.push(`line ${line}: </${name}> with no open <${name}>` +
          (stack.length ? ` (innermost open is <${stack[stack.length - 1].name}> from line ${stack[stack.length - 1].line})` : ""));
      } else {
        stack.length = k;
      }
      continue;
    }

    elements++;
    if (VOID.has(name) || selfClosed) continue;

    if (RAW_TEXT.has(name)) {
      const close = src.toLowerCase().indexOf(`</${name}`, i);
      if (close === -1) { errors.push(`line ${line}: unterminated <${name}>`); break; }
      const end = src.indexOf(">", close);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    stack.push({ name, line });
  }

  for (const open of stack) {
    if (!OPTIONAL_END.has(open.name)) {
      errors.push(`line ${open.line}: <${open.name}> was never closed`);
    }
  }
  return { errors, elements, file };
}

section("every HTML file this change touched parses");
const SOURCES = {};
for (const page of PUBLIC_PAGES) {
  const src = fs.readFileSync(`${REPO}/${page}`, "utf8");
  SOURCES[page] = src;
  const r = parseHtml(src, page);
  ok(r.errors.length === 0, `${page} parses cleanly (${r.elements} elements)`,
    r.errors.slice(0, 6).join("\n        "));
}

// ============================================================
// 2. Which pages carry it, and which must never
// ============================================================
section("the include list");
for (const page of PUBLIC_PAGES) {
  const n = SOURCES[page].split('<script src="analytics.js"></script>').length - 1;
  eq(n, 1, `${page} includes analytics.js exactly once`);
}

// Walked rather than globbed, so a page added under app/ tomorrow is covered
// by this the day it appears.
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const appFiles = walk(`${REPO}/app`);
ok(appFiles.length > 0, `app/ was found and has files (${appFiles.length})`);
let appMentions = [];
for (const f of appFiles) {
  const src = fs.readFileSync(f, "utf8");
  if (/analytics\.js|googletagmanager|gtag\(/.test(src)) appMentions.push(f.slice(REPO.length + 1));
}
ok(appMentions.length === 0,
  "NOTHING under app/ references analytics.js, gtag or googletagmanager",
  appMentions.join(", "));

// The other root pages that were deliberately left out.
for (const page of ["unsubscribe.html"]) {
  const src = fs.readFileSync(`${REPO}/${page}`, "utf8");
  lacks(src, "analytics.js", `${page} was left out (it is a one-purpose link target)`);
}

section("privacy.html says what the code does");
const PRIV = SOURCES["privacy.html"];
has(PRIV, 'id="analytics"', "there is an #analytics section to link to");
has(PRIV, 'data-ga-when="off"', "the not-configured block exists");
has(PRIV, 'data-ga-when="on"', "the configured block exists");
has(PRIV, "data-ga-status", "there is a status line for the current choice");
has(PRIV, "data-ga-withdraw", "there is a withdrawal control");
has(PRIV, "<noscript>", "and a noscript fallback, for the case where nothing can run");
has(PRIV, "sc_analytics_consent", "the storage key is named, so it can be looked for");
has(PRIV, "Google Analytics 4", "Google Analytics is named");
has(PRIV, "Do Not Track", "the DNT/GPC behaviour is described");
has(PRIV, "Global Privacy Control", "…both signals");
has(PRIV, "_ga", "the cookies it sets are named");
has(PRIV, "Retention is a setting on the Analytics property itself",
  "retention points at the property setting rather than quoting a number");
// The two sentences that adding analytics would have made false.
lacks(PRIV, "No analytics, no tag manager, no advertising pixel",
  "the old 'no analytics' claim in the summary is gone");
lacks(PRIV, "there is no advertising\n      or analytics anywhere in this site",
  "the old 'no analytics anywhere' claim is gone");
// A retention number would be a claim nobody can check from here.
for (const n of ["14 months", "26 months", "2 months", "months of data"]) {
  lacks(PRIV, n, `no invented retention period (${n})`);
}

// ============================================================
// 3. The real analytics.js, under a fake DOM
// ============================================================
const SRC = fs.readFileSync(`${REPO}/analytics.js`, "utf8");

section("analytics.js itself");
new vm.Script(SRC, { filename: "analytics.js" });     // throws if it does not parse
ok(true, "analytics.js parses under Node");
eq(SRC.split(`"${MEASUREMENT_ID}"`).length - 1, 1,
  `the measurement id appears exactly once in the file`);
has(SRC, "NEVER ADD THIS SCRIPT TO ANYTHING UNDER app/",
  "the app/ exclusion and its reason are written down in the file");
has(SRC, "NOT A SECRET", "…and so is why the id is allowed to be in a public file");

// ---- the DOM ----
// Hand-built rather than a library, because the surface analytics.js touches
// is small and a fake that is honest about its own size is easier to trust
// than a big one. Anything the file reaches for that is missing here throws,
// which is the point.
function makeEnv(opts = {}) {
  const raf = [];
  const rendered = [];

  function El(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      attrs: Object.create(null),
      children: [],
      parentNode: null,
      className: "",
      textContent: "",
      hidden: false,
      listeners: Object.create(null),
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null;
        return c;
      },
      insertBefore(c, ref) {
        c.parentNode = this;
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i >= 0) this.children.splice(i, 0, c);
        else this.children.push(c);
        return c;
      },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      click() { (this.listeners.click || []).forEach((fn) => fn({ preventDefault() {} })); },
      get firstChild() { return this.children[0] || null; },
    };
    return el;
  }

  const documentElement = El("html");
  const head = El("head");
  const body = El("body");
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  // Text nodes are children too, and they have no attributes — so they are
  // filtered out here rather than crashing the selector.
  function all(node, out = []) {
    for (const c of node.children || []) {
      if (typeof c.getAttribute === "function") out.push(c);
      all(c, out);
    }
    return out;
  }
  function match(node, sel) {
    const attr = /^\[([a-zA-Z0-9-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (!attr) throw new Error("the fake DOM only understands attribute selectors: " + sel);
    const v = node.getAttribute(attr[1]);
    if (v === null) return false;
    return attr[2] === undefined ? true : v === attr[2];
  }

  const document = {
    documentElement, head, body,
    cookie: opts.cookie || "",
    referrer: opts.referrer || "",
    createElement: El,
    createTextNode: (t) => ({ nodeType: 3, textContent: t, children: [] }),
    querySelectorAll: (sel) => all(documentElement).filter((n) => match(n, sel)),
    querySelector: (sel) => all(documentElement).filter((n) => match(n, sel))[0] || null,
  };

  // localStorage, optionally one that throws the way Safari's private mode does
  const store = new Map(Object.entries(opts.storage || {}));
  const localStorage = opts.storageThrows
    ? {
        getItem() { throw new Error("SecurityError"); },
        setItem() { throw new Error("SecurityError"); },
        removeItem() { throw new Error("SecurityError"); },
      }
    : {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
      };

  const href = opts.href || "https://sahabaclub.ai/index.html";
  const sandbox = {
    document,
    localStorage,
    navigator: Object.assign({ userAgent: "node" }, opts.navigator || {}),
    location: { href, hostname: new URL(href).hostname, origin: new URL(href).origin },
    requestAnimationFrame: (fn) => { raf.push(fn); return raf.length; },
    setTimeout: (fn) => { raf.push(fn); return raf.length; },
    URL, encodeURIComponent, Date, console,
  };
  if (opts.windowGpc !== undefined) sandbox.globalPrivacyControl = opts.windowGpc;
  if (opts.windowDnt !== undefined) sandbox.doNotTrack = opts.windowDnt;
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  return {
    sandbox, document, head, body, store, rendered,
    flush() { while (raf.length) raf.shift()(); },
    // Every script element that ended up in <head>, which on this site is the
    // only way gtag.js can arrive.
    tagScripts: () => head.children.filter((c) => c.tagName === "SCRIPT"),
    banner: () => body.children.filter((c) => c.getAttribute("data-ga-banner") !== null)[0] || null,
    find: (sel) => document.querySelectorAll(sel),
    text(node) {
      let s = node.textContent || "";
      for (const c of node.children || []) s += " " + this.text(c);
      return s;
    },
  };
}

function run(env, source = SRC) {
  vm.runInContext(source, env.sandbox, { filename: "analytics.js" });
  return env;
}

// The single assertion this whole file exists for.
function assertNoTag(env, when) {
  const scripts = env.tagScripts();
  ok(scripts.length === 0, `NO script element is created — ${when}`,
    scripts.map((s) => s.src).join(", "));
  ok(env.sandbox.dataLayer === undefined, `dataLayer is never created — ${when}`);
}

// ---- state: nobody has answered ----
section("state: no choice yet");
{
  const env = run(makeEnv());
  eq(env.sandbox.scAnalytics.state(), "ask", "state is 'ask'");
  ok(env.banner() !== null, "the banner is on the page");
  assertNoTag(env, "the question has not been answered");
  env.flush();
  const b = env.banner();
  eq(b.getAttribute("role"), "region", "the banner is a region…");
  eq(b.getAttribute("aria-live"), "polite", "…and a polite live region, so it announces itself");
  ok(b.getAttribute("aria-label"), "…with an accessible name");
  eq(b.getAttribute("aria-modal"), null, "it is NOT a modal");
  eq(env.body.children[0], b, "it is the first child of <body>, so Tab reaches it next");
  const accept = env.find('[data-ga-accept]');
  const decline = env.find('[data-ga-decline]');
  eq(accept.length, 1, "there is one accept button");
  eq(decline.length, 1, "there is one decline button");
  eq(accept[0].className, decline[0].className,
    "accept and decline are the SAME class — same size, same weight, same colour");
  eq(accept[0].tagName, "BUTTON", "accept is a real button");
  eq(decline[0].tagName, "BUTTON", "decline is a real button");
  // Set as a property, which in a real DOM reflects to the attribute.
  eq(accept[0].type, "button", "accept is typed, so it cannot submit anything");
  eq(decline[0].type, "button", "…and so is decline");
  ok(!env.text(b).toLowerCase().includes("manage preferences"),
    "there is no 'manage preferences' detour on the way to no");
  eq(env.find("[data-ga-dismiss]").length, 0,
    "there is no third dismiss control that would leave the question unanswered");
  assertNoTag(env, "the banner is drawn but nothing has been pressed");
}

// ---- state: accepted ----
section("state: accept");
{
  const env = run(makeEnv({ href: "https://sahabaclub.ai/events.html" }));
  env.flush();
  env.find("[data-ga-accept]")[0].click();

  eq(env.store.get("sc_analytics_consent"), "granted", "the yes is remembered");
  eq(env.banner(), null, "the banner is taken away");
  const scripts = env.tagScripts();
  eq(scripts.length, 1, "EXACTLY ONE script element is created");
  eq(scripts[0].src, TAG_HOST + MEASUREMENT_ID, "…pointing at gtag.js with the right id");
  eq(scripts[0].async, true, "…async, so it cannot block the page");
  ok(Array.isArray(env.sandbox.dataLayer), "the dataLayer exists now and not before");

  const layer = env.sandbox.dataLayer.map((a) => Array.prototype.slice.call(a));
  const consent = layer.find((e) => e[0] === "consent");
  ok(consent, "a consent call is made before anything else");
  eq(consent[2].analytics_storage, "granted", "analytics storage granted");
  eq(consent[2].ad_storage, "denied", "ad storage denied");
  eq(consent[2].ad_user_data, "denied", "ad user data denied");
  eq(consent[2].ad_personalization, "denied", "ad personalisation denied");
  const config = layer.find((e) => e[0] === "config");
  ok(config, "a config call is made");
  eq(config[1], MEASUREMENT_ID, "…for the right property");
  eq(config[2].allow_google_signals, false, "Google Signals off");
  eq(config[2].allow_ad_personalization_signals, false, "ad personalisation signals off");
  eq(config[2].send_page_view, true, "page views on — which is the whole payload");

  // Pressing accept twice must not produce a second tag.
  env.sandbox.scAnalytics.accept();
  eq(env.tagScripts().length, 1, "accepting twice still injects only one script");
}

// ---- state: declined ----
section("state: decline");
{
  const env = run(makeEnv());
  env.flush();
  env.find("[data-ga-decline]")[0].click();
  eq(env.store.get("sc_analytics_consent"), "denied", "the no is remembered");
  eq(env.banner(), null, "the banner is taken away");
  assertNoTag(env, "the visitor declined");
}

// ---- state: a remembered decline ----
section("state: a decline remembered from a previous page");
{
  const env = run(makeEnv({ storage: { sc_analytics_consent: "denied" } }));
  eq(env.sandbox.scAnalytics.state(), "denied", "state is 'denied'");
  eq(env.banner(), null, "the banner is NOT shown again on the next page");
  env.flush();
  eq(env.banner(), null, "…and does not arrive a frame later either");
  assertNoTag(env, "a decline was remembered");
}

// ---- state: a remembered accept ----
section("state: an accept remembered from a previous page");
{
  const env = run(makeEnv({ storage: { sc_analytics_consent: "granted" } }));
  eq(env.sandbox.scAnalytics.state(), "granted", "state is 'granted'");
  eq(env.banner(), null, "the banner is not shown again");
  eq(env.tagScripts().length, 1, "the tag loads straight away, without asking again");
}

// ---- state: the browser already said no ----
section("state: Do Not Track and Global Privacy Control");
for (const [label, opts] of [
  ["navigator.doNotTrack = '1'", { navigator: { doNotTrack: "1" } }],
  ["navigator.doNotTrack = 'yes'", { navigator: { doNotTrack: "yes" } }],
  ["navigator.msDoNotTrack = '1'", { navigator: { msDoNotTrack: "1" } }],
  ["window.doNotTrack = '1'", { windowDnt: "1" }],
  ["navigator.globalPrivacyControl", { navigator: { globalPrivacyControl: true } }],
  ["window.globalPrivacyControl", { windowGpc: true }],
]) {
  const env = run(makeEnv(opts));
  eq(env.sandbox.scAnalytics.state(), "signal", `${label} → state 'signal'`);
  eq(env.banner(), null, `${label} → the banner is never shown`);
  env.flush();
  assertNoTag(env, label);
}
{
  // The signal has to beat a stored yes, or it is not a signal.
  const env = run(makeEnv({
    navigator: { globalPrivacyControl: true },
    storage: { sc_analytics_consent: "granted" },
  }));
  assertNoTag(env, "GPC is set even though a yes was stored earlier");
  eq(env.banner(), null, "…and the banner is still not shown");
}

// ---- state: withdrawn ----
section("state: withdrawn");
{
  const env = run(makeEnv({
    storage: { sc_analytics_consent: "granted" },
    cookie: "_ga=GA1.1.111.222; _ga_ABCDEF=GS1.1.x; sc_other=keep",
    href: "https://sahabaclub.ai/privacy.html",
  }));
  eq(env.tagScripts().length, 1, "it was running before the withdrawal");
  env.sandbox.scAnalytics.withdraw();

  eq(env.store.has("sc_analytics_consent"), false, "the remembered choice is cleared");
  eq(env.sandbox["ga-disable-" + MEASUREMENT_ID], true,
    "gtag.js's own kill switch is set, so the loaded tag stops sending — no reload needed");
  const layer = env.sandbox.dataLayer.map((a) => Array.prototype.slice.call(a));
  const update = layer.filter((e) => e[0] === "consent" && e[1] === "update").pop();
  ok(update, "a consent update is sent");
  eq(update[2].analytics_storage, "denied", "…revoking analytics storage");
  eq(env.sandbox.scAnalytics.state(), "ask", "the state is back to unanswered");
  ok(env.banner() !== null, "and the question is put back");
  env.flush();
  eq(env.find("[data-ga-accept]").length, 1, "…with both buttons, so it can be answered again");
  eq(env.find("[data-ga-decline]").length, 1, "…both of them");
}
{
  // The withdrawal control on the page, rather than the console.
  const env = makeEnv({ storage: { sc_analytics_consent: "granted" } });
  const btn = env.document.createElement("button");
  btn.setAttribute("data-ga-withdraw", "");
  env.body.appendChild(btn);
  run(env);
  eq(env.tagScripts().length, 1, "the tag is running");
  btn.click();
  eq(env.store.has("sc_analytics_consent"), false,
    "clicking the privacy page's own link clears the choice");
  ok(env.banner() !== null, "…and re-asks");
}

// ---- state: no measurement id ----
section("state: not configured (the constant emptied)");
{
  const blanked = SRC.replace(`var GA_MEASUREMENT_ID = "${MEASUREMENT_ID}";`,
    'var GA_MEASUREMENT_ID = "";');
  ok(blanked !== SRC, "the constant was found and could be emptied for this test");

  for (const [label, opts] of [
    ["nobody has answered", {}],
    ["a yes is stored from before it was switched off", { storage: { sc_analytics_consent: "granted" } }],
  ]) {
    const env = run(makeEnv(opts), blanked);
    eq(env.sandbox.scAnalytics.state(), "off", `state is 'off' — ${label}`);
    eq(env.banner(), null, `no banner is shown — ${label}`);
    env.flush();
    eq(env.banner(), null, `…not a frame later either — ${label}`);
    assertNoTag(env, `there is no measurement id (${label})`);
  }

  // The placeholder people paste out of a tutorial must not count as configured.
  for (const bad of ["G-XXXXXXXXXX", "G-", "UA-12345-1", "g-abcd123456", " G-ABCD123456"]) {
    const env = run(makeEnv(), SRC.replace(`"${MEASUREMENT_ID}"`, JSON.stringify(bad)));
    eq(env.sandbox.scAnalytics.state(), "off", `${JSON.stringify(bad)} is rejected as an id`);
    assertNoTag(env, `the id was ${JSON.stringify(bad)}`);
  }
}

// ---- the privacy page's two blocks ----
section("the privacy page's blocks follow the configured state");
function privacyEnv(opts, source) {
  const env = makeEnv(opts);
  const off = env.document.createElement("div");
  off.setAttribute("data-ga-when", "off");
  off.hidden = true;
  const on = env.document.createElement("div");
  on.setAttribute("data-ga-when", "on");
  on.hidden = true;
  const status = env.document.createElement("p");
  status.setAttribute("data-ga-status", "");
  on.appendChild(status);
  env.body.appendChild(off);
  env.body.appendChild(on);
  run(env, source);
  return { env, off, on, status };
}
{
  const { off, on, status } = privacyEnv({});
  eq(on.hidden, false, "configured → the 'on' block is shown");
  eq(off.hidden, true, "configured → the 'off' block stays hidden");
  ok(status.textContent.length > 0, "the status line is filled in");
  has(status.textContent, "not answered", "…and says the question is unanswered");
}
{
  const blanked = SRC.replace(`var GA_MEASUREMENT_ID = "${MEASUREMENT_ID}";`,
    'var GA_MEASUREMENT_ID = "";');
  const { off, on, status } = privacyEnv({}, blanked);
  eq(off.hidden, false, "not configured → the 'off' block is shown");
  eq(on.hidden, true, "not configured → the 'on' block stays hidden");
  has(status.textContent, "not switched on", "…and the status line says so");
}
{
  const { status } = privacyEnv({ navigator: { globalPrivacyControl: true } });
  has(status.textContent, "Do Not Track", "a GPC visitor is told why they are never asked");
}
{
  const { status } = privacyEnv({ storage: { sc_analytics_consent: "denied" } });
  has(status.textContent, "said no", "a declined visitor is told what they chose");
}

// ============================================================
// 5. Nothing page-specific reaches the wire
// ============================================================
section("login.html's query string and OAuth fragment never leave the browser");
{
  const nasty = "https://sahabaclub.ai/login.html" +
    "?next=%2Fapp%2Fmember.html%3Fid%3D9f3&utm_source=newsletter" +
    "#error=access_denied&error_description=User%20did%20not%20consent&access_token=abc123";
  const env = run(makeEnv({
    href: nasty,
    referrer: "https://sahabaclub.ai/app/inbox.html?thread=8812#msg-3",
    storage: { sc_analytics_consent: "granted" },
  }));
  const layer = env.sandbox.dataLayer.map((a) => Array.prototype.slice.call(a));
  const config = layer.find((e) => e[0] === "config");
  eq(config[2].page_location, "https://sahabaclub.ai/login.html",
    "page_location is the origin and path, and stops there");
  eq(config[2].page_referrer, "",
    "a referrer from one of our own signed-in pages is dropped entirely, " +
    "not merely trimmed — otherwise the app/ exclusion leaks back in through " +
    "the referrer of a member following the footer link");

  // The blunt version of the same assertion: search EVERYTHING queued and the
  // tag URL as well, not just the two fields that were expected to carry it.
  const whole = JSON.stringify(layer) + JSON.stringify(env.tagScripts().map((s) => s.src));
  for (const leak of ["error_description", "access_token", "access_denied", "next=",
    "utm_source", "id%3D9f3", "thread=", "member.html", "inbox.html"]) {
    lacks(whole, leak, `nothing queued or requested contains ${JSON.stringify(leak)}`);
  }
  // And no `?` or `#` anywhere in what is SENT. Scoped to the dataLayer rather
  // than to `whole`, because gtag.js's own URL legitimately carries `?id=` —
  // that is the tag asking for itself, not a page parameter being reported.
  const sent = JSON.stringify(layer);
  lacks(sent, "?", "no query string survives anywhere in the queued parameters");
  lacks(sent, "#", "no fragment survives anywhere in the queued parameters");
}
{
  // Every signed-in page by name, so this does not rest on one example.
  for (const page of ["dashboard", "profile", "connect", "member", "inbox",
    "promptarena", "onboarding", "admin/members"]) {
    const env = run(makeEnv({
      referrer: `https://sahabaclub.ai/app/${page}.html`,
      storage: { sc_analytics_consent: "granted" },
    }));
    const config = env.sandbox.dataLayer.map((a) => Array.prototype.slice.call(a))
      .find((e) => e[0] === "config");
    eq(config[2].page_referrer, "", `a referrer from app/${page}.html is dropped`);
  }
}
{
  // A referrer from another site is trimmed too — its query string is somebody
  // else's business and none of ours.
  const env = run(makeEnv({
    referrer: "https://www.google.com/search?q=who+are+sahaba+club",
    storage: { sc_analytics_consent: "granted" },
  }));
  const config = env.sandbox.dataLayer.map((a) => Array.prototype.slice.call(a))
    .find((e) => e[0] === "config");
  eq(config[2].page_referrer, "https://www.google.com/search",
    "an external referrer keeps its page and loses its query");
}
{
  // No referrer at all is the common case and must not become "undefined".
  const env = run(makeEnv({ storage: { sc_analytics_consent: "granted" } }));
  const config = env.sandbox.dataLayer.map((a) => Array.prototype.slice.call(a))
    .find((e) => e[0] === "config");
  eq(config[2].page_referrer, "", "an absent referrer stays empty");
}

section("page views only — no other event is sent");
{
  const env = run(makeEnv({ storage: { sc_analytics_consent: "granted" } }));
  const layer = env.sandbox.dataLayer.map((a) => Array.prototype.slice.call(a));
  const verbs = layer.map((e) => e[0]);
  eq(verbs.filter((v) => v === "event").length, 0,
    "no custom events — this pass sends page views and nothing else");
  eq(JSON.stringify(verbs), JSON.stringify(["consent", "js", "config"]),
    "the whole conversation is: consent, js, config");
}

section("storage that refuses to work");
{
  // Safari private mode and locked-down enterprise profiles throw rather than
  // returning null. That must land on "no consent", never on "assume yes".
  const env = run(makeEnv({ storageThrows: true }));
  eq(env.sandbox.scAnalytics.state(), "ask", "a throwing localStorage reads as no consent");
  assertNoTag(env, "localStorage throws");
  env.flush();
  env.find("[data-ga-accept]")[0].click();
  eq(env.tagScripts().length, 1, "accepting still works for this visit…");
  eq(env.banner(), null, "…and the banner still goes away");
}

console.log(`\n${checks} checks, ${failures} failing.`);
if (failures) process.exit(1);
console.log("Consent gate verified: a script element is created in exactly one state.");
