// check-admin-entry.mjs
// ------------------------------------------------------------
//   node tools/check-admin-entry.mjs
//
// Three times now this project has shipped an admin menu entry and an admin
// page that disagree about who may pass, and every time the person affected
// could do nothing about it and saw a permissions error that was not their
// fault:
//
//   1. 0054 relabelled admins to `global_admin` while the deployed
//      lib/admin-guard.js still tested for `admin`. The only administrator was
//      locked out of his own dashboard.
//   2. The fix for that hardcoded a role list, which did not contain
//      `operations_manager`, so the Admin link stayed hidden from Ghadir.
//   3. The fix for THAT made the link ask `my_admin_sections()` — correct — but
//      left `app/admin/index.html` demanding the `overview` section, which an
//      Operations Manager does not have. She could see the Admin link, click
//      it, and be told "Not one of your sections" about a page she never chose.
//
// Each fix was right and each one moved the disagreement somewhere new, because
// nothing compared the two sides. This does. It is deliberately static — it
// reads the migrations and the client and needs no database, no key and no
// session, so it can run in CI and on a laptop with no secrets.
//
// ⚠ Self-tests in both directions at the end. A checker that has never been
// seen to fail is a checker nobody should trust: two of the three written for
// this project were wrong on their first run and passed anyway.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function check(label, ok, detail) {
  if (ok) { console.log(`  ok    ${label}`); return; }
  failed++;
  console.log(`  FAIL  ${label}${detail ? "\n        " + detail : ""}`);
}

// ---- What the database believes -------------------------------------------

function readMigrations() {
  const dir = join(root, "supabase", "migrations");
  return readdirSync(dir).filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

// `insert into public.admin_sections ... values ('overview', ...), ('members', ...)`
function sectionKeysFromSql(sql) {
  const at = sql.indexOf("insert into public.admin_sections");
  if (at === -1) return [];
  const chunk = sql.slice(at, sql.indexOf(";", at));
  return [...chunk.matchAll(/\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
}

// `('operations_manager', 'events'),`
function rolePermsFromSql(sql) {
  const at = sql.indexOf("insert into public.role_permissions");
  if (at === -1) return [];
  const chunk = sql.slice(at, sql.indexOf(";", at));
  return [...chunk.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*\)/g)]
    .map((m) => ({ role: m[1], section: m[2] }));
}

// ---- What the client believes ---------------------------------------------

function navFromGuard(js) {
  const at = js.indexOf("const SECTIONS = [");
  const chunk = js.slice(at, js.indexOf("\n];", at));
  return [...chunk.matchAll(/\{[^}]*href:\s*"([^"]+)"[^}]*section:\s*"([a-z_]+)"[^}]*\}/g)]
    .map((m) => ({ href: m[1], section: m[2], adminOnly: /adminOnly:\s*true/.test(m[0]), soon: /soon:\s*true/.test(m[0]) }));
}

function homeSectionFromGuard(js) {
  const m = js.match(/const HOME_SECTION\s*=\s*"([a-z_]+)"/);
  return m ? m[1] : null;
}

function requireStaffCalls() {
  const dir = join(root, "app", "admin");
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!/\.(html|js)$/.test(f)) continue;
    const text = readFileSync(join(dir, f), "utf8");
    for (const m of text.matchAll(/(?<!\/\/[^\n]*)\brequireStaff\(\s*"([a-z_]+)"\s*\)/g)) {
      out.push({ file: f, section: m[1] });
    }
  }
  return out;
}

// ---- The checks ------------------------------------------------------------

const sql = readMigrations();
const guardJs = readFileSync(join(root, "lib", "admin-guard.js"), "utf8");

const dbSections = sectionKeysFromSql(sql);
const perms = rolePermsFromSql(sql);
const nav = navFromGuard(guardJs);
const home = homeSectionFromGuard(guardJs);
const calls = requireStaffCalls();

console.log(`${dbSections.length} sections in the database, ${nav.length} in the menu, ${calls.length} guarded pages, ${perms.length} role grants`);
console.log("");

console.log("the two sides agree on what a section is");
check("HOME_SECTION is named in the guard", !!home, "expected `const HOME_SECTION = \"...\"`");
check("HOME_SECTION is a real section", dbSections.includes(home), `${home} not in ${dbSections.join(", ")}`);

for (const c of calls) {
  check(`${c.file} guards on a real section (${c.section})`, dbSections.includes(c.section));
}
for (const n of nav) {
  check(`menu entry ${n.href} names a real section (${n.section})`, dbSections.includes(n.section));
}

console.log("");
console.log("nobody is granted a section with nowhere to go");
const navSections = new Set(nav.map((n) => n.section));
for (const section of new Set(perms.map((p) => p.section))) {
  check(`${section} has a page in the menu`, navSections.has(section));
}

console.log("");
console.log("every role that gets the Admin link can open what it lands on");
// ⚠ THE CHECK THAT WOULD HAVE CAUGHT GHADIR'S SCREEN. script.js shows the link
// to anyone with >=1 section, so any such role must be able to reach a real
// page — either it holds HOME_SECTION, or the guard's redirect has somewhere to
// send it.
const byRole = new Map();
for (const p of perms) {
  if (!byRole.has(p.role)) byRole.set(p.role, []);
  byRole.get(p.role).push(p.section);
}

function landsSomewhere(sections, isAdmin, navList, homeSection) {
  if (sections.includes(homeSection)) return true;
  return navList.some((n) =>
    n.section !== homeSection && !n.soon && (!n.adminOnly || isAdmin) && sections.includes(n.section)
  );
}

for (const [role, sections] of byRole) {
  check(
    `${role} (${sections.length} sections) lands on a page it can open`,
    landsSomewhere(sections, false, nav, home),
    `has ${sections.join(", ")} but the entry point asks for ${home}, and no fallback page matched`,
  );
}

// The guard must actually implement that fallback; the check above is only
// meaningful if the redirect exists.
check(
  "the guard redirects rather than dead-ending at the entry point",
  /firstReachableHref\s*\(/.test(guardJs) && /window\.location\.replace/.test(guardJs),
  "expected firstReachableHref() and a location.replace() in requireStaff",
);

// ---- Self-test, both directions -------------------------------------------

console.log("");
console.log("the checker itself");
{
  const navList = [
    { href: "index.html", section: "overview" },
    { href: "members.html", section: "members", adminOnly: true },
    { href: "events.html", section: "events" },
  ];
  // The real bug: five sections, none of them the entry point, one of which
  // does have a page. Must land.
  check("control: a role without overview but with events DOES land",
    landsSomewhere(["events", "contacts"], false, navList, "overview"), true);
  // A role holding only sections that have no page, or only admin-only pages,
  // must NOT be reported as landing — this is the direction that matters,
  // because a checker that always says yes is worse than no checker.
  check("control: a role whose only page is adminOnly does NOT land",
    !landsSomewhere(["members"], false, navList, "overview"), true);
  check("control: a role with no matching page does NOT land",
    !landsSomewhere(["nowhere"], false, navList, "overview"), true);
  check("control: a full admin holding overview lands",
    landsSomewhere(["overview"], true, navList, "overview"), true);
}

console.log("");
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log("admin entry point is reachable by every role that is offered it.");
