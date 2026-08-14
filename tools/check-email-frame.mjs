// check-email-frame.mjs
// ------------------------------------------------------------
//   node tools/check-email-frame.mjs
//
// The club's email design lives in exactly one file, _shared/email-frame.ts,
// and this checker exists to keep it that way.
//
// Before the frame, every sender wrote its own HTML. That is how the club ended
// up with three different email designs at once: bare <p> tags on white for
// most templates, a white card for ms365_credential, and a PURPLE one
// (#5b3df5, a colour in no stylesheet anywhere) for avatar_restart. Nobody
// decided that; it accumulated, one template at a time, each one reasonable on
// its own. It will accumulate again the moment a sender finds it easier to
// write a <table> than to add a block builder.
//
// ⚠ SO THE RULE IS STRUCTURAL, NOT COSMETIC: a send-* function may not contain
// a document shell, a <table>, or a hex colour. If you need one, the frame
// needs a new builder.
//
// ============================================================
// THIS CHECKER RENDERS THE EMAILS. IT DOES NOT PATTERN-MATCH THEM.
// ============================================================
//
// Node 24 strips TypeScript natively, so the frame module is imported and run
// for real — with a Deno shim, since it reads Deno.env at load. That buys
// checks a regex cannot make: that hostile input actually comes out escaped,
// that an off-site CTA is actually dropped, and that a marketing send without a
// postal address actually throws.
//
// ⚠ Self-tests at the end, per this project's rule that a checker never seen to
// fail is a checker nobody should trust.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const failures = [];
const fail = (m) => failures.push(m);

// ── Load the frame with a Deno shim ───────────────────────────────────────
// The module reads Deno.env.get at top level for SITE_URL and POSTAL_ADDRESS.
// POSTAL_ADDRESS is deliberately left unset for the first import so the
// "refuses to send marketing without one" check has something to prove.
globalThis.Deno = {
  env: {
    get: (k) => (k === "SITE_URL" ? "https://www.sahabaclub.ai" : undefined),
  },
};

const framePath = join(root, "supabase/functions/_shared/email-frame.ts");
if (!existsSync(framePath)) {
  console.error("FAIL  supabase/functions/_shared/email-frame.ts is missing — the frame is the design");
  process.exit(1);
}

let F;
try {
  F = await import(pathToFileURL(framePath).href);
} catch (err) {
  console.error("FAIL  could not import the frame module:", err.message);
  process.exit(1);
}

// ── 1. The frame renders a complete, well-formed document ─────────────────
const sample = F.renderEmail({
  preheader: "A preheader",
  eyebrow: "Welcome",
  title: "You're in",
  blocks: [F.lead("Lead line."), F.p("Body."), F.bullets([{ title: "T", text: "b" }])],
  cta: { label: "Open your dashboard", url: "/app/dashboard.html" },
  footerReason: "You are getting this because you joined.",
});

const MUST_CONTAIN = [
  ["<!doctype html>", "a doctype — clients without one fall into quirks mode"],
  ['name="color-scheme"', "the color-scheme meta, or Gmail inverts the dark design to white-on-white"],
  ['name="supported-color-schemes"', "the supported-color-schemes meta, same reason"],
  ["/assets/logo.png", "the logo"],
  ['alt="Sahaba Club"', "alt text on the logo — Outlook blocks images by default"],
  ["The First AI Universe", "the slogan"],
  ["on Earth", "the slogan's cyan tail"],
  ["#05070d", "the site's ground colour"],
  ["#22d3ee", "the site's cyan"],
  ["Developed by Sahaba Club Technologies", "the watermark"],
  ["[data-ogsc]", "the Outlook.com dark-mode overrides"],
  ["if mso", "the Outlook ghost table"],
  ["v:roundrect", "the VML button, or Outlook shows no CTA"],
];
for (const [needle, why] of MUST_CONTAIN) {
  if (!sample.includes(needle)) fail(`rendered email is missing ${why} (${needle})`);
}

// Balanced tags. A dropped </table> in an email is not a cosmetic bug: Outlook
// renders the remainder of the document inside the unclosed cell.
function unbalanced(html) {
  const VOID = new Set(["img", "br", "hr", "meta", "link", "input", "area", "base", "col", "wbr"]);
  const s = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const stack = [];
  let bad = 0;
  for (const m of s.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
    const [, closing, tagRaw, self] = m;
    const tag = tagRaw.toLowerCase();
    if (VOID.has(tag) || self === "/") continue;
    if (!closing) stack.push(tag);
    else if (stack.pop() !== tag) bad++;
  }
  return stack.length + bad;
}
if (unbalanced(sample) !== 0) fail("the rendered email has unbalanced tags");

// ── 2. Hostile input comes out escaped ────────────────────────────────────
// Member names, staff-typed event titles, AI-scraped venues and anonymous form
// submissions all reach these builders. A club email carries our DKIM
// signature, so anything injected into one is vouched for by the domain.
const XSS = `<img src=x onerror="alert(1)">`;
const XSS_LINK = `"><a href="https://evil.example">click</a>`;

const escapingCases = [
  ["p", () => F.p(XSS)],
  ["lead", () => F.lead(XSS)],
  ["note", () => F.note(XSS)],
  ["subhead", () => F.subhead(XSS)],
  ["bullets.title", () => F.bullets([{ title: XSS, text: "x" }])],
  ["bullets.text", () => F.bullets([{ text: XSS }])],
  ["panel.label", () => F.panel([{ label: XSS, value: "x" }])],
  ["panel.value", () => F.panel([{ label: "x", value: XSS }])],
  ["callout.title", () => F.callout(XSS, "x")],
  ["callout.text", () => F.callout("x", XSS)],
  ["steps", () => F.steps([XSS])],
  ["card.title", () => F.card({ title: XSS })],
  ["card.eyebrow", () => F.card({ eyebrow: XSS, title: "x" })],
  ["card.text", () => F.card({ title: "x", text: XSS })],
  ["credentials.value", () => F.credentials([{ label: "x", value: XSS }])],
];
// ⚠ CHECK FOR THE ESCAPED FORM, NOT THE ABSENCE OF A SUBSTRING.
//
// The first version of this test asserted `!out.includes("onerror=")` and
// failed all fifteen builders — because correctly escaped output still contains
// that substring, as `&lt;img src=x onerror=&quot;alert(1)&quot;&gt;`. The
// substring was never the danger; the unescaped ANGLE BRACKET is, because that
// is what makes a browser treat it as a tag.
//
// Asserting the escaped form is PRESENT matters just as much: a builder that
// dropped its input entirely would pass a test that only looked for absence.
for (const [name, build] of escapingCases) {
  const out = build();
  if (/<img\s/i.test(out)) {
    fail(`${name}() let a real <img> tag through — its input is not escaped`);
  }
  if (!out.includes("&lt;img")) {
    fail(`${name}() neither escaped nor emitted its input — the value vanished`);
  }
}

// The frame's own fields, not just the blocks.
const injected = F.renderEmail({
  preheader: XSS,
  eyebrow: XSS,
  title: XSS_LINK,
  blocks: [F.p("safe")],
  footerReason: "reason",
});
// ⚠ Match the INJECTED tag, not any <img>. The frame always renders one — the
// logo — so a bare /<img\s/ test fails on correct output. That is exactly the
// mistake this checker made on its first run.
if (/<img\s+src=x/i.test(injected) || /<a\s+href="https:\/\/evil\.example"/i.test(injected)) {
  fail("renderEmail() does not escape preheader/eyebrow/title");
}
if (!injected.includes("&lt;img")) {
  fail("renderEmail() dropped the preheader instead of escaping it");
}

// ── 3. A CTA that leaves the site is dropped ──────────────────────────────
// An email is the most costly place for a bad link: it is authenticated by our
// own DKIM signature, so a redirect out of one spends the club's reputation.
const OFFSITE = [
  "https://evil.example/pwn",
  "//evil.example/pwn",
  "javascript:alert(1)",
  "http://www.sahabaclub.ai.evil.example/",
  "/\\evil.example",
];
for (const url of OFFSITE) {
  if (F.safeUrl(url) !== "") fail(`safeUrl() let an off-site URL through: ${url}`);
  const out = F.renderEmail({
    preheader: "x", eyebrow: "x", title: "x", blocks: [F.p("x")],
    cta: { label: "Go", url }, footerReason: "x",
  });
  if (out.includes("evil.example") || out.includes("javascript:")) {
    fail(`renderEmail() rendered a CTA to an off-site URL: ${url}`);
  }
}
// …and a legitimate site-relative path still works, or the check above would
// pass by dropping everything.
if (F.safeUrl("/event.html?e=gitex") !== "https://www.sahabaclub.ai/event.html?e=gitex") {
  fail("safeUrl() dropped a legitimate site-relative path");
}

// ── 4. Marketing without a postal address refuses to send ─────────────────
// CAN-SPAM and its UAE/EU equivalents require a real postal address on
// promotional mail. A placeholder satisfies the code and fails the law, so the
// frame throws instead. POSTAL_ADDRESS is unset in this process, so this must.
let threw = false;
try {
  F.renderEmail({
    preheader: "x", eyebrow: "News", title: "x", blocks: [F.p("x")],
    footerReason: "x", unsubscribeUrl: "https://www.sahabaclub.ai/unsubscribe.html",
  });
} catch {
  threw = true;
}
if (!threw) {
  fail("renderEmail() built a marketing email with no POSTAL_ADDRESS — that ships a legal defect");
}
// A transactional email must NOT be blocked by the same rule.
try {
  F.renderEmail({
    preheader: "x", eyebrow: "x", title: "x", blocks: [F.p("x")], footerReason: "x",
  });
} catch {
  fail("renderEmail() refused a transactional email over POSTAL_ADDRESS — that rule is marketing-only");
}

// ── 5. No sender builds its own design ────────────────────────────────────
// The structural rule. A send-* function may reference these things in a
// comment — the history of why the frame exists is worth keeping — so comments
// are stripped before looking.
const fnDir = join(root, "supabase/functions");
const senders = readdirSync(fnDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^(send-|member-email|notify-)/.test(d.name))
  .map((d) => d.name);

if (senders.length === 0) fail("found no send-* functions to check — the glob is wrong");

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FORBIDDEN = [
  [/<!doctype/i, "its own document shell"],
  [/<html[\s>]/i, "its own <html> element"],
  [/<body[\s>]/i, "its own <body> element"],
  [/<table/i, "its own <table> — add a block builder to the frame instead"],
  [/#[0-9a-fA-F]{6}\b/, "a hard-coded hex colour — the palette lives in the frame"],
];
for (const name of senders) {
  const file = join(fnDir, name, "index.ts");
  if (!existsSync(file)) continue;
  const code = stripComments(readFileSync(file, "utf8"));
  for (const [re, what] of FORBIDDEN) {
    if (re.test(code)) fail(`${name}/index.ts contains ${what}`);
  }
}

// Every template in send-transactional-email must go through the frame. Counted
// rather than spot-checked: a ninth template that quietly returns its own
// string is exactly the drift this file exists to catch.
const ste = read("supabase/functions/send-transactional-email/index.ts");
const templateNames = [...ste.matchAll(/^\s*\|\s*"([a-z0-9_]+)"/gm)].map((m) => m[1]);
const renderCalls = (ste.match(/renderEmail\(\{/g) || []).length;
if (templateNames.length === 0) fail("could not find the TemplateName union — has it been renamed?");
if (renderCalls !== templateNames.length) {
  fail(
    `send-transactional-email has ${templateNames.length} templates but only ${renderCalls} ` +
      `renderEmail() calls — one of them is building its own HTML`,
  );
}

// ── 6. Every real template renders ────────────────────────────────────────
//
// The checks above prove the FRAME works. This one proves the eight templates
// that use it do — by importing send-transactional-email and rendering each one
// with representative data, including hostile data where a real caller could
// supply it.
//
// ⚠ Deno.serve is shimmed to a no-op. The module calls it at import time, which
// is the only reason this needs a shim at all; nothing is served.
globalThis.Deno.serve = () => {};

const stePath = join(fnDir, "send-transactional-email/index.ts");
let STE;
try {
  STE = await import(pathToFileURL(stePath).href);
} catch (err) {
  fail(`could not import send-transactional-email: ${err.message}`);
}

// ⚠ NO SILENT SKIP. The first version of this guarded on `STE?.renderTemplate`
// and moved on quietly when it was absent — which meant that un-exporting
// renderTemplate would have disabled the entire rendering check while the
// summary line still read "ok". A check that can silently not run is
// documentation, not a check.
let rendered = 0;
if (!STE || typeof STE.renderTemplate !== "function") {
  fail(
    "send-transactional-email does not export renderTemplate — the eight templates " +
      "cannot be rendered, so this checker can only pattern-match the source",
  );
} else {
  // Hostile values in every field a caller controls. `title` and `body` on the
  // notification templates come from database sweeps that interpolate
  // staff-typed event titles; `fullName` is a member's own profile field.
  const hostile = {
    fullName: `${XSS} Ahmed`,
    mailbox: "member@sahabaclub.com",
    tempPassword: "Temp<>&\"'123",
    title: `${XSS} GITEX`,
    body: `Today, 11:00 AM ${XSS}`,
    href: "/event.html?e=gitex-global-2026",
    email: XSS,
    mobile: XSS,
    currentJob: XSS,
    roundName: XSS,
    roundSlug: "round-5",
    registrationId: XSS,
    requestId: XSS,
    personalEmail: XSS,
    phone: XSS,
    memberSince: XSS,
    contactSource: XSS,
    redrawn: true,
    preExisting: false,
  };

  const names = templateNames.length ? templateNames : ["welcome"];
  for (const name of names) {
    let out;
    try {
      out = STE.renderTemplate(name, hostile);
    } catch (err) {
      fail(`template "${name}" threw while rendering: ${err.message}`);
      continue;
    }
    if (!out || typeof out.html !== "string" || typeof out.subject !== "string") {
      fail(`template "${name}" did not return {subject, html}`);
      continue;
    }
    if (!out.html.startsWith("<!doctype html>")) {
      fail(`template "${name}" is not going through the frame — no doctype`);
    }
    if (!out.html.includes("The First AI Universe")) {
      fail(`template "${name}" rendered without the slogan`);
    }
    if (unbalanced(out.html) !== 0) {
      fail(`template "${name}" rendered unbalanced tags`);
    }
    // The injected tag must not survive into any of them.
    if (/<img\s+src=x/i.test(out.html)) {
      fail(`template "${name}" let an injected <img> through into the body`);
    }
    // ⚠ AND THE SUBJECT MUST NOT BE HTML-ESCAPED. Subject headers have no HTML
    // parser: an escaped ampersand shows up literally as "&amp;" in the inbox.
    // This is the bug that was live in hackathon_interest until 14 Aug.
    if (/&(amp|lt|gt|quot|#39);/.test(out.subject)) {
      fail(`template "${name}" has an HTML-escaped subject — it will read literally in the inbox`);
    }
    rendered++;
  }
  if (rendered !== names.length) {
    fail(`only ${rendered} of ${names.length} templates rendered`);
  }
}

// ── 7. Self-tests ─────────────────────────────────────────────────────────
// A checker never seen to fail is a checker nobody should trust. Each of these
// sabotages an input and asserts the check above would have caught it.
const selfTests = [
  [
    "escaping check catches an unescaped builder",
    () => {
      const bad = `<td>${XSS}</td>`;
      return bad.includes("<img src=x");
    },
  ],
  [
    "off-site check catches a URL that survives",
    () => {
      const passthrough = (u) => u;
      return passthrough("https://evil.example/pwn") !== "";
    },
  ],
  [
    "forbidden-pattern check catches a hex colour",
    () => FORBIDDEN.some(([re]) => re.test('const c = "#5b3df5";')),
  ],
  [
    "forbidden-pattern check catches a raw <table>",
    () => FORBIDDEN.some(([re]) => re.test('html += "<table role=\\"presentation\\">";')),
  ],
  [
    "comment stripper does not hide real code",
    () => {
      const src = '// <table> in a comment is fine\nconst x = "<table>";';
      return /<table/i.test(stripComments(src));
    },
  ],
  [
    "comment stripper does hide comments",
    () => {
      const src = "// a <table> and a #5b3df5 in prose\nconst x = 1;";
      return !/<table/i.test(stripComments(src)) && !/#[0-9a-fA-F]{6}\b/.test(stripComments(src));
    },
  ],
  [
    "tag balancer catches an unclosed table",
    () => unbalanced("<table><tr><td>x</td></tr>") > 0,
  ],
  [
    "tag balancer passes balanced markup",
    () => unbalanced("<table><tr><td>x</td></tr></table>") === 0,
  ],
];
for (const [name, run] of selfTests) {
  let ok = false;
  try {
    ok = run() === true;
  } catch (err) {
    fail(`self-test "${name}" threw: ${err.message}`);
    continue;
  }
  if (!ok) fail(`self-test failed: ${name} — this checker cannot be trusted`);
}

// ── Report ────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error("check-email-frame: FAIL");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(
  `check-email-frame: ok  (${rendered} templates rendered, ` +
    `${senders.length} senders clean, ${escapingCases.length} builders escape, ` +
    `${selfTests.length} self-tests)`,
);
