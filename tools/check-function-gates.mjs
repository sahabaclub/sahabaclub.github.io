// check-function-gates.mjs
// ------------------------------------------------------------
//   node tools/check-function-gates.mjs
//
// The fourth instance in this project of a control being stricter than the
// thing it protects, and the first one a colleague hit doing her job rather
// than a reviewer finding it on paper:
//
//   10 Aug 2026. Ghadir (operations_manager) opened app/admin/events.html,
//   which admits her — `requireStaff("events")`, and 0054 grants her the
//   `events` section. The events table's own policies let that section insert,
//   update and delete events. She pressed "Read the event" and got
//   403 "Staff only", because supabase/functions/import-event/index.ts gated on
//   a hardcoded `role in ('admin','staff','global_admin')`.
//
//   So the page let her in, the database would have taken her event, and only
//   the importer — WHICH WRITES NO EVENT AT ALL — refused her, while its own
//   error told her to type the same thing in by hand.
//
// 865921f fixed import-event, send-campaign and write-contact-email to ask
// `has_admin_section()`. Nothing stopped it happening again, because nothing
// compared the two sides. This does.
//
// It is deliberately static — it reads the pages, the functions and the
// migrations, and needs no database, no key and no session, so it runs in CI
// and on a laptop with no secrets.
//
// ⚠ `is_staff()` IS NOT A SAFE GATE FOR A SECTION-GATED PAGE. 0054 defines it
// as `role in ('staff','admin','global_admin')` — exactly the hardcoded list it
// was meant to replace. Ghadir does not pass it. It is the right gate only for
// a page whose section no non-staff role holds; the check below works that out
// from role_permissions rather than trusting the shape of the call.
//
// ⚠ Self-tests in both directions at the end. A checker that has never been
// seen to fail is a checker nobody should trust: two of the three written for
// this project were wrong on their first run and passed anyway.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- Functions that are meant to be narrower than the page that calls them --
//
// Listed here, with the reason, rather than skipped quietly somewhere in the
// middle of the file. An exception nobody can find is how the next Ghadir
// happens: whoever revisits this needs to see the argument, not just the name.
const INTENTIONALLY_NARROWER = {
  "provision-ms365":
    // Creates, licenses and resets real Microsoft 365 mailboxes against the
    // tenant, and spends a paid licence per account. Handing somebody a mailbox
    // is an act of identity, not administration-by-section: it is the one thing
    // a section grant should NOT carry with it. Its provisioning branch is
    // deliberately admin-only and keeps its role names; the read-only diagnose
    // branch is wider. licences.html and members.html call it and a non-admin
    // will see a 403 from it — that refusal is the intended answer, not a
    // lockout, which is why the checks above skip it rather than ruling on it.
    "creates/resets real mailboxes and spends licences — identity, not a section",
  "send-newsletter":
    // Sends to the entire subscriber list in one unrecallable action. There is
    // no draft, no undo and no per-recipient throttle; the blast radius is the
    // whole list and the club's sending reputation. Admin-only on purpose.
    "one unrecallable blast to the whole list — no undo, reputational blast radius",
};

let failed = 0;

function check(label, ok, detail) {
  if (ok) { console.log(`  ok    ${label}`); return; }
  failed++;
  console.log(`  FAIL  ${label}${detail ? "\n        " + detail : ""}`);
}

// Not every surprise is a failure. Things the checker could not read are said
// out loud rather than counted as passes — silence is what let the last one
// through.
const warnings = [];
function warn(message) { warnings.push(message); }

// ---- Reading code without being fooled by prose ----------------------------
//
// ⚠ THE COMMENTS IN THIS CODEBASE QUOTE THE BUG. import-event's fix note reads
// "It used to read `role in ('admin','staff','global_admin')`", and events.html
// explains what `functions.invoke()` does with error.context. A checker that
// regexed the raw text would call the fixed function broken and invent a call
// that is not there. So every file is stripped of comments first, by a scanner
// that understands strings, template literals and regex literals — a naive
// `//` strip would cut every "https://" URL in half.
function stripJsComments(src) {
  let out = "";
  let prev = "";                  // last significant char, to tell regex from division
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") i++;   // leaves the \n to be copied
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";              // keep line count honest
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c; i++;
      while (i < src.length) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
        if (src[i] === c) { out += src[i]; i++; break; }
        out += src[i]; i++;
      }
      prev = c;
      continue;
    }
    // A `/` where an operand is expected opens a regex literal, not a division.
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev))) {
      out += c; i++;
      let inClass = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === "\\") { out += ch + (src[i + 1] ?? ""); i += 2; continue; }
        if (ch === "\n") break;                        // unterminated: it was not a regex
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) { out += ch; i++; break; }
        out += ch; i++;
      }
      prev = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

// Only <script> bodies are code. The surrounding markup is prose, and prose is
// full of apostrophes ("You don't have the Events section") that would send a
// string-aware scanner into the weeds.
function inlineScriptCode(html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]).join("\n;\n");
}

// ⚠ `src="ai-admin.js"` IS A RELATIVE PATH; `import x from "ai-admin.js"` is a
// bare specifier and would not resolve in a browser. Treating the two alike
// costs five of the twelve pages: ai, data, notify, organizers and interest all
// reach their guard and their invoke() through a src attribute with no "./" on
// it. The first run of this checker did exactly that and reported "ok" about
// pages it had never opened.
function moduleRefs(raw, code, isHtml) {
  const out = [];
  if (isHtml) {
    for (const m of raw.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)) out.push({ ref: m[1], relative: true });
  }
  for (const m of code.matchAll(/\bfrom\s*["']([^"']+)["']/g)) out.push({ ref: m[1], relative: false });
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push({ ref: m[1], relative: false });
  return out;
}

// A page is not one file. ai.html carries no guard and no call of its own — both
// live in ai-admin.js, and promptarena.html reaches its module through a bare
// `import` rather than a src attribute. Following the imports is the difference
// between checking twelve pages and checking six.
function collectPage(pageFile) {
  const start = join(root, "app", "admin", pageFile);
  const seen = new Set();
  const queue = [start];
  const parts = [];
  while (queue.length) {
    const abs = queue.shift();
    if (seen.has(abs) || !existsSync(abs)) continue;
    seen.add(abs);
    const raw = readFileSync(abs, "utf8");
    const isHtml = abs.endsWith(".html");
    const code = stripJsComments(isHtml ? inlineScriptCode(raw) : raw);
    parts.push(code);
    for (const { ref, relative: isRelative } of moduleRefs(raw, code, isHtml)) {
      const bare = ref.split("?")[0].split("#")[0];
      if (!bare.endsWith(".js")) continue;
      if (!isRelative && !bare.startsWith(".") && !bare.startsWith("/")) continue;  // bare specifier
      const next = resolve(dirname(abs), bare);
      if (next.startsWith(root)) queue.push(next);
    }
  }
  return { code: parts.join("\n;\n"), files: [...seen].map((f) => relative(root, f)) };
}

function sectionsOf(code) {
  return [...new Set([...code.matchAll(/\brequireStaff\(\s*["']([a-z_]+)["']\s*\)/g)].map((m) => m[1]))];
}

function invokesOf(code, label) {
  const names = new Set();
  for (const m of code.matchAll(/\bfunctions\s*\.\s*invoke\(\s*["']([a-z0-9-]+)["']/g)) names.add(m[1]);
  for (const m of code.matchAll(/\/functions\/v1\/([a-z0-9-]+)/g)) names.add(m[1]);
  // A name built at runtime cannot be followed. Say so instead of reporting a
  // clean page.
  if (/\bfunctions\s*\.\s*invoke\(\s*[^"'\s)]/.test(code)) {
    warn(`${label} invokes a function whose name is not a literal — check that one by hand`);
  }
  if (/\/functions\/v1\/\$\{/.test(code)) {
    warn(`${label} fetches /functions/v1/ with an interpolated name — check that one by hand`);
  }
  return [...names];
}

// ---- What the database believes --------------------------------------------

function readMigrations() {
  const dir = join(root, "supabase", "migrations");
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

// Read the staff roles out of is_staff() itself rather than typing them here.
// The first bug in this series was a hardcoded copy of this list going stale
// when 0054 renamed `admin` to `global_admin`; a checker with its own copy
// would rot the same way. The LAST definition wins — 0054 replaces 0003.
function staffRolesFromSql(sql) {
  const bodies = [...sql.matchAll(/create or replace function public\.is_staff\(\)[\s\S]*?\$\$([\s\S]*?)\$\$/g)];
  if (!bodies.length) return null;
  const last = bodies[bodies.length - 1][1];
  const list = last.match(/role\s+in\s*\(([^)]*)\)/);
  if (!list) return null;
  return [...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

// Every section the database knows about. `has_admin_section('evnets')` is not
// an error anywhere — it simply answers "no" to everyone forever, and reads as
// a permissions problem to whoever it refuses.
function sectionKeysFromSql(sql) {
  const keys = [];
  let at = 0;
  while ((at = sql.indexOf("insert into public.admin_sections", at)) !== -1) {
    const end = sql.indexOf(";", at);
    for (const m of sql.slice(at, end).matchAll(/\(\s*'([a-z_]+)'/g)) keys.push(m[1]);
    at = end;
  }
  return [...new Set(keys)];
}

function rolePermsFromSql(sql) {
  const at = sql.indexOf("insert into public.role_permissions");
  if (at === -1) return [];
  const chunk = sql.slice(at, sql.indexOf(";", at));
  return [...chunk.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*\)/g)]
    .map((m) => ({ role: m[1], section: m[2] }));
}

// ---- What an edge function believes ----------------------------------------

// `["campaigns", "contacts"].map((section) => rpc("has_admin_section", { p_section: section }))`
// — write-contact-email accepts either section, so the argument is a variable.
// Resolve it from the array literal that feeds the map; refuse to guess if
// there isn't one.
function resolveSectionExpr(expr, before) {
  const literal = expr.trim().match(/^["']([a-z_]+)["']$/);
  if (literal) return [literal[1]];
  const arrays = [...before.matchAll(/\[\s*((?:["'][a-z_]+["']\s*,\s*)*["'][a-z_]+["'])\s*\]\s*\.\s*map/g)];
  if (!arrays.length) return null;
  const last = arrays[arrays.length - 1][1];
  return [...last.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]);
}

// kind: "section" | "is_staff" | "roles" | "none"
function classifyGate(src, knownGateRoles) {
  const code = stripJsComments(src);

  const sections = [];
  let unresolved = false;
  for (const m of code.matchAll(/\.rpc\(\s*["']has_admin_section["']\s*,\s*\{[^}]*?p_section\s*:\s*([^,}]+)/g)) {
    const got = resolveSectionExpr(m[1], code.slice(Math.max(0, m.index - 400), m.index));
    if (got) sections.push(...got); else unresolved = true;
  }

  const isStaff = /\.rpc\(\s*["']is_staff["']/.test(code);

  // Role-name comparisons, but only against names the database actually gates
  // on. `profile.role === "coach"` in write-member-intro decides how somebody is
  // introduced, not whether they may call — counting it would be an invented
  // finding, and a checker that cries wolf gets switched off.
  const roles = new Set();
  for (const m of code.matchAll(/\.role\s*(?:===|!==|==|!=)\s*["']([a-z_]+)["']/g)) {
    if (knownGateRoles.has(m[1])) roles.add(m[1]);
  }
  for (const m of code.matchAll(/\.in\(\s*["']role["']\s*,\s*\[([^\]]*)\]/g)) {
    for (const r of m[1].matchAll(/["']([a-z_]+)["']/g)) if (knownGateRoles.has(r[1])) roles.add(r[1]);
  }

  if (sections.length || unresolved) {
    return { kind: "section", sections: [...new Set(sections)], unresolved, alsoRoles: [...roles] };
  }
  if (isStaff) return { kind: "is_staff", sections: [], unresolved: false, alsoRoles: [...roles] };
  if (roles.size) return { kind: "roles", sections: [], unresolved: false, roles: [...roles] };
  return { kind: "none", sections: [], unresolved: false };
}

function describeGate(g) {
  if (g.kind === "section") {
    return `has_admin_section(${g.sections.map((s) => `'${s}'`).join(" or ") || "?"})` +
      (g.unresolved ? " + an argument this checker could not resolve" : "");
  }
  if (g.kind === "is_staff") return "is_staff()";
  if (g.kind === "roles") return `hardcoded role list (${g.roles.join(", ")})`;
  return "NO GATE";
}

// Which roles get through — the only question that matters. A page and the
// function behind it are compared as role sets, so the answer does not depend
// on the two sides being written in the same style.
function admittedRoles(gate, staffRoles, rolesBySection) {
  if (gate.kind === "none") return null;                    // null means everybody
  const out = new Set(staffRoles);
  if (gate.kind === "is_staff") return out;
  if (gate.kind === "roles") return new Set(gate.roles);
  for (const s of gate.sections) for (const r of rolesBySection.get(s) ?? []) out.add(r);
  return out;
}

function pageRoles(section, staffRoles, rolesBySection) {
  return new Set([...staffRoles, ...(rolesBySection.get(section) ?? [])]);
}

// ⚠ THE CHECK THAT WOULD HAVE CAUGHT GHADIR'S SCREEN.
function lockedOutRoles(section, gate, staffRoles, rolesBySection) {
  const admitted = admittedRoles(gate, staffRoles, rolesBySection);
  if (admitted === null) return [];
  return [...pageRoles(section, staffRoles, rolesBySection)].filter((r) => !admitted.has(r));
}

// ---- Gather ----------------------------------------------------------------

const sql = readMigrations();
const dbSections = sectionKeysFromSql(sql);
const staffRoles = staffRolesFromSql(sql) ?? ["staff", "admin", "global_admin"];
if (!staffRolesFromSql(sql)) warn("could not read is_staff() from the migrations — fell back to the 0054 list");
const perms = rolePermsFromSql(sql);

const rolesBySection = new Map();
for (const p of perms) {
  if (!rolesBySection.has(p.section)) rolesBySection.set(p.section, []);
  rolesBySection.get(p.section).push(p.role);
}
const knownGateRoles = new Set([...staffRoles, ...perms.map((p) => p.role)]);

const adminDir = join(root, "app", "admin");
const pages = [];
for (const f of readdirSync(adminDir).filter((f) => f.endsWith(".html")).sort()) {
  const { code, files } = collectPage(f);
  const sections = sectionsOf(code);
  const functions = invokesOf(code, f);
  pages.push({ file: f, sections, functions, files });
}

const fnDir = join(root, "supabase", "functions");
const gates = new Map();
function gateOf(name) {
  if (gates.has(name)) return gates.get(name);
  const path = join(fnDir, name, "index.ts");
  if (!existsSync(path)) {
    warn(`supabase/functions/${name}/index.ts does not exist — called but not found`);
    gates.set(name, null);
    return null;
  }
  const g = classifyGate(readFileSync(path, "utf8"), knownGateRoles);
  gates.set(name, g);
  return g;
}

// Who calls what, and under which sections.
const callers = new Map();          // function -> [{page, section}]
for (const p of pages) {
  for (const fn of p.functions) {
    if (!callers.has(fn)) callers.set(fn, []);
    for (const s of p.sections.length ? p.sections : [null]) {
      callers.get(fn).push({ page: p.file, section: s });
    }
  }
}

console.log(`${pages.length} admin pages, ${callers.size} functions reached from them, ${perms.length} role grants, staff = ${staffRoles.join("/")}`);
console.log("");

console.log("what each page admits, and what it calls");
for (const p of pages) {
  if (!p.functions.length) continue;
  const holders = p.sections.flatMap((s) => rolesBySection.get(s) ?? []);
  console.log(`  ${p.file}  [${p.sections.join(", ") || "no requireStaff"}]` +
    `${holders.length ? ` also held by ${[...new Set(holders)].join(", ")}` : ""}` +
    ` -> ${p.functions.join(", ")}`);
}
console.log("");

// ---- The checks -------------------------------------------------------------

console.log("no page admits somebody the function it calls will refuse");
for (const [fn, calls] of callers) {
  if (INTENTIONALLY_NARROWER[fn]) continue;
  const gate = gateOf(fn);
  if (!gate) continue;
  for (const c of calls) {
    if (!c.section) continue;
    const locked = lockedOutRoles(c.section, gate, staffRoles, rolesBySection);
    check(
      `${c.page} [${c.section}] -> ${fn} (${describeGate(gate)})`,
      locked.length === 0,
      `${locked.join(", ")} hold the ${c.section} section and the page lets them in, but the function refuses them`,
    );
  }
}

console.log("");
console.log("no function reached from a section-gated page gates on role names");
// Even when it locks nobody out today. Every one of these is a lockout waiting
// for the day somebody grants its section to a role outside full staff — which
// is precisely how Ghadir's 403 came to exist: import-event's list was harmless
// right up until 0054 handed `events` to operations_manager.
for (const [fn, calls] of callers) {
  if (INTENTIONALLY_NARROWER[fn]) continue;
  const gate = gateOf(fn);
  if (!gate) continue;
  const sections = [...new Set(calls.map((c) => c.section).filter(Boolean))];
  if (!sections.length) continue;
  check(
    `${fn} asks the database, not a list of names`,
    gate.kind === "section",
    gate.kind === "none"
      ? `no gate at all, and ${calls.map((c) => c.page).join(", ")} calls it — any signed-in member can reach it`
      : `gates on ${describeGate(gate)}; the pages that call it are gated on ${sections.join(", ")}` +
        (gate.kind === "is_staff"
          ? " — is_staff() is the same list 0054 wrote, so a section granted outside staff will not pass it"
          : ""),
  );
}

console.log("");
console.log("no function demands a section its callers do not have");
for (const [fn, calls] of callers) {
  if (INTENTIONALLY_NARROWER[fn]) continue;
  const gate = gateOf(fn);
  if (!gate || gate.kind !== "section") continue;
  // A function that asks the database AND still compares role names somewhere
  // is a half-finished migration: the section gate may be the loosest of two
  // gates, and the stricter one is what the caller will actually hit. Not a
  // failure — a branch may narrow on purpose, as provision-ms365 does — but not
  // something to pass over in silence either.
  if (gate.alsoRoles?.length) {
    warn(`${fn} gates on a section but still compares role names (${gate.alsoRoles.join(", ")}) — check which branch a caller hits`);
  }
  check(`${fn}'s p_section argument is readable`, !gate.unresolved,
    "one has_admin_section() call takes a value this checker could not follow — verify it by hand");
  const callerSections = new Set(calls.map((c) => c.section).filter(Boolean));
  for (const s of gate.sections) {
    check(`${fn} gates on '${s}', which is a real section`, dbSections.includes(s),
      `no admin_sections row for '${s}' — the gate answers "no" to everybody, including administrators`);
    check(
      `${fn} accepts '${s}', which a calling page is gated on`,
      callerSections.has(s),
      `no page that calls ${fn} is gated on '${s}' (callers: ${[...callerSections].join(", ") || "none"})` +
      ` — either a page stopped calling it, or the gate is wider than anything that uses it`,
    );
  }
}

console.log("");
console.log("the deployed twin agrees with the source");
// ⚠ index.deploy.ts is what is actually deployed. Fixing index.ts alone leaves
// the 403 in production and the fix in git, which would read as "already fixed"
// to the next person who looks.
for (const fn of [...callers.keys()].sort()) {
  const twin = join(fnDir, fn, "index.deploy.ts");
  const src = join(fnDir, fn, "index.ts");
  if (!existsSync(twin) || !existsSync(src)) continue;
  const a = describeGate(classifyGate(readFileSync(src, "utf8"), knownGateRoles));
  const b = describeGate(classifyGate(readFileSync(twin, "utf8"), knownGateRoles));
  check(`${fn}: index.deploy.ts gates the same way as index.ts`, a === b, `index.ts: ${a}\n        deploy:   ${b}`);
}

// ---- For the record ---------------------------------------------------------
//
// Functions no admin page calls are out of scope for the checks above — nothing
// can be concluded about a page/function disagreement where there is no page.
// They are printed anyway: a hardcoded list here is the next one to hit
// somebody, and a list nobody prints is a list nobody fixes.
const unreached = readdirSync(fnDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
  .map((d) => d.name)
  .filter((n) => !callers.has(n) && existsSync(join(fnDir, n, "index.ts")));

const latent = unreached
  .map((n) => ({ name: n, gate: classifyGate(readFileSync(join(fnDir, n, "index.ts"), "utf8"), knownGateRoles) }))
  .filter((x) => x.gate.kind === "roles");

if (latent.length) {
  console.log("");
  console.log("not reached from any admin page — not checked, listed so they are not forgotten");
  for (const x of latent) {
    const why = INTENTIONALLY_NARROWER[x.name];
    console.log(`  ${x.name}: ${describeGate(x.gate)}${why ? ` — intentional: ${why}` : ""}`);
  }
}

// ---- Self-test, both directions ---------------------------------------------
//
// Every one of these asserts a FAILURE as well as a pass. The bug this file
// exists to catch is subtle enough that a checker quietly answering "ok" to
// everything would have been believed.

console.log("");
console.log("the checker itself");
{
  const known = new Set(["staff", "admin", "global_admin", "operations_manager"]);

  // 1. Comments must not be read as code. This is import-event's actual fix
  //    note, which quotes the old gate twice, plus the commented-out original —
  //    the shape most likely to be left behind in a real fix.
  const fixedWithProse = [
    "// ⚠ THE GATE IS THE `events` SECTION, NOT A LIST OF ROLE NAMES. It used to",
    "// read `role in ('admin','staff','global_admin')`, which is the fourth",
    "// instance of a control being stricter than the thing it protects.",
    '// if (profile.role !== "admin" && profile.role !== "staff") return json(403);',
    '/* .in("role", ["admin", "staff", "global_admin"]) */',
    'const u = "https://example.test/functions/v1/import-event"; // not a comment cut',
    'const { data: allowed } = await asCaller.rpc("has_admin_section", { p_section: "events" });',
  ].join("\n");
  const g1 = classifyGate(fixedWithProse, known);
  check("control: a fixed function whose comments quote the old role list reads as a section gate",
    g1.kind === "section" && g1.sections.join() === "events", `read it as ${describeGate(g1)}`);
  check("control: the URL in that fixture survived comment-stripping",
    stripJsComments(fixedWithProse).includes("functions/v1/import-event"),
    "the // scanner cut an https:// URL in half");

  // ...and the same text with the gate NOT commented out must read as a list.
  // If this direction passes too, the stripper is deleting everything.
  const stillBroken = fixedWithProse.replace(
    '// if (profile.role !== "admin" && profile.role !== "staff") return json(403);',
    'if (profile.role !== "admin" && profile.role !== "staff") return json(403);',
  ).replace('const { data: allowed } = await asCaller.rpc("has_admin_section", { p_section: "events" });', "");
  const g2 = classifyGate(stillBroken, known);
  check("control: the same file with a LIVE role list reads as a hardcoded list",
    g2.kind === "roles" && g2.roles.sort().join() === "admin,staff", `read it as ${describeGate(g2)}`);

  // 2. The other gate shapes.
  const g3 = classifyGate('const { data: staff } = await asCaller.rpc("is_staff");', known);
  check("control: an is_staff() gate is recognised", g3.kind === "is_staff", `read it as ${describeGate(g3)}`);
  const g4 = classifyGate(
    'const r = await Promise.all(["campaigns", "contacts"].map((section) =>' +
    ' asCaller.rpc("has_admin_section", { p_section: section })));', known);
  check("control: a section list passed through .map() resolves to both sections",
    g4.kind === "section" && g4.sections.sort().join() === "campaigns,contacts", `read it as ${describeGate(g4)}`);
  const g5 = classifyGate('joins_as: profile.role === "coach" ? "coach" : "member";', known);
  check("control: a non-gate role comparison is NOT mistaken for a gate",
    g5.kind === "none", `read it as ${describeGate(g5)}`);
  const g6 = classifyGate('const body = await req.json(); return json({ ok: true });', known);
  check("control: an ungated function reads as NO GATE", g6.kind === "none", `read it as ${describeGate(g6)}`);
  const g7 = classifyGate('await asCaller.rpc("has_admin_section", { p_section: wanted });', known);
  check("control: an unresolvable p_section is reported, not assumed fine",
    g7.kind === "section" && g7.unresolved === true, `read it as ${describeGate(g7)}`);

  // 3. Ghadir's case, end to end, against a fixture rather than the live
  //    migrations — the point of the test is the comparison, and it must keep
  //    meaning the same after somebody edits 0054.
  const rbs = new Map([["events", ["operations_manager"]], ["members", []]]);
  const staff = ["staff", "admin", "global_admin"];
  const oldGate = { kind: "roles", roles: ["admin", "staff", "global_admin"] };
  const newGate = { kind: "section", sections: ["events"], unresolved: false };
  check("control: the 10 Aug gate on the events page DOES lock Ghadir out",
    lockedOutRoles("events", oldGate, staff, rbs).join() === "operations_manager",
    "the check that exists to catch this said it was fine");
  check("control: 865921f's replacement does NOT lock her out",
    lockedOutRoles("events", newGate, staff, rbs).length === 0,
    "the fixed gate was reported as a lockout");
  check("control: is_staff() on the events page ALSO locks her out",
    lockedOutRoles("events", { kind: "is_staff", sections: [] }, staff, rbs).join() === "operations_manager",
    "is_staff() is role in ('staff','admin','global_admin') — she is none of those");
  check("control: the same old gate on a staff-only page locks nobody out",
    lockedOutRoles("members", oldGate, staff, rbs).length === 0,
    "reported a lockout where no role outside staff holds the section");
  check("control: an ungated function admits everybody",
    lockedOutRoles("events", { kind: "none", sections: [] }, staff, rbs).length === 0, "");

  // 4. Reading a page: a call that exists only in a comment is not a call.
  const pageCode = stripJsComments([
    'const r = await supabase.functions.invoke("import-event", { body });',
    '// functions.invoke("send-newsletter") puts the real body on error.context,',
    'await fetch(`${SUPABASE_URL}/functions/v1/send-campaign`, { method: "POST" });',
    'const user = await requireStaff("events");',
  ].join("\n"));
  const found = invokesOf(pageCode, "fixture").sort();
  check("control: real invoke() and /functions/v1/ calls are both found",
    found.includes("import-event") && found.includes("send-campaign"), `found ${found.join(", ")}`);
  check("control: a call that appears only in a comment is NOT found",
    !found.includes("send-newsletter"), "invented a call out of a comment — the events.html trap");
  check("control: the page's section is read", sectionsOf(pageCode).join() === "events", "");

  // 5. The regression that nearly shipped. The first run of this file skipped
  //    every page whose script tag reads src="ai-admin.js" with no "./" on it,
  //    and printed nothing but "ok" — it had not opened five of the twelve
  //    pages. A checker's silence must mean "I looked", so both directions of
  //    the specifier rule are pinned here.
  const htmlRefs = moduleRefs('<script type="module" src="ai-admin.js?v=38ecac"></script>', "", true);
  check("control: a <script src> with no ./ is followed",
    htmlRefs.some((r) => r.ref.startsWith("ai-admin.js") && r.relative), "the five-page blind spot is back");
  const jsRefs = moduleRefs("", 'import { readFileSync } from "node:fs";\nimport { x } from "./local.js";', false);
  check("control: a bare import specifier is NOT followed as a path",
    jsRefs.some((r) => r.ref === "node:fs" && !r.relative) && jsRefs.some((r) => r.ref === "./local.js"),
    "node:fs would be resolved as a file next to the page");
  // End to end, against the real page: ai.html carries neither the guard nor
  // the call, so if the module is not followed this finds nothing.
  if (existsSync(join(adminDir, "ai.html"))) {
    const ai = collectPage("ai.html");
    check("control: ai.html's guard and invoke are found through its module",
      sectionsOf(ai.code).includes("ai") && invokesOf(ai.code, "selftest").includes("ai-admin"),
      `followed ${ai.files.join(", ")}`);
  }

  // 6. The exception list must be a list of real functions. An exception for a
  //    function that has been renamed is a hole that looks like a decision.
  for (const name of Object.keys(INTENTIONALLY_NARROWER)) {
    check(`control: exception '${name}' names a function that exists`,
      existsSync(join(fnDir, name, "index.ts")), "exception for a function that is not there");
  }
}

console.log("");
for (const w of warnings) console.log(`⚠ ${w}`);
if (warnings.length) console.log("");

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("every function an admin page calls admits everyone that page admits.");
