// Does the client ask for things the migrations actually define?
//
// The notification feature spans two migrations and six client files, and the
// join between them is a set of strings: RPC names, RPC PARAMETER names, table
// names and view names. None of it is checked by any compiler. A typo in an
// rpc() parameter does not fail at build time, does not fail at page load, and
// does not fail until a member presses the button — where it surfaces as a
// generic Postgres error about a function that "does not exist", naming a
// signature nobody wrote.
//
// This reads both sides and compares them.
//
// COVERED: every supabase.rpc("x", {...}) call in the client has a matching
// `create ... function public.x(...)` in supabase/migrations, and every named
// argument passed exists in that function's signature.
// Also: every .from("x") reads a table or view some migration creates.
//
// NOT COVERED: column names, types, grants, or whether the migration has been
// APPLIED. This compares source to source — it cannot tell you what is in the
// database. That distinction is the whole reason 0043 exists: a source-only
// audit of this project once reported a clean bill of health while four
// unrecorded views leaked live data.
//
// Run: node tools/check-notification-contract.mjs

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Client files that talk to the notification schema.
const CLIENT_FILES = [
  "lib/notifications.js",
  "app/admin/notify.js",
  "app/dashboard.html",
  "app/inbox.html",
  "app/settings.html",
  "script.js",
  "lib/push.js",
  "lib/event-images.js",
  "lib/event-related.js",
  "event.html",
  "events-ui.js",
  "app/admin/events.html",
  "supabase/functions/send-push/index.ts",
  // Server-side, but it reads the same schema by the same bare strings and a
  // typo there fails the same way — silently, in a scheduled job nobody is
  // watching, which is the exact failure mode the function exists to detect.
  "supabase/functions/sweep-health/index.ts",
];

// Objects that predate this feature and are defined in migrations we are not
// re-reading here. Listed explicitly so an unknown name is still an error.
const KNOWN_EXISTING = new Set([
  "profiles", "subscriptions", "ms365_accounts", "events", "event_registrations",
  "member_messages", "member_follows", "member_directory",
]);

function readMigrations() {
  const dir = join(root, "supabase", "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ name: f, sql: readFileSync(join(dir, f), "utf8") }));
}

const migrations = readMigrations();
const rawSql = migrations.map((m) => m.sql).join("\n");

// ⚠ Strip SQL line comments before parsing signatures.
//
// The first version of this file did not, and reported that
// staff_send_notification "does not take p_kind" — which it plainly does. The
// cause was a trailing comment inside the parameter list:
//
//   p_user_ids uuid[],          -- null or empty = every member
//   p_kind text,
//
// The parameter pattern keys off the comma before each name, and the comment
// sat between the comma and the next name, so p_kind was never seen. That is a
// check modelling the thing loosely and raising a false alarm — the exact
// failure this project has now hit five separate times. When a check and the
// code disagree, suspect the check first.
const allSql = rawSql.replace(/--[^\n]*/g, "");

// ---- What the migrations define ----------------------------------------

const definedObjects = new Set(KNOWN_EXISTING);
for (const m of allSql.matchAll(/create\s+(?:or\s+replace\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi)) {
  definedObjects.add(m[1].toLowerCase());
}
// `create view x with (security_invoker = on) as` and materialized variants.
for (const m of allSql.matchAll(/create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:public\.)?"?([a-z0-9_]+)"?/gi)) {
  definedObjects.add(m[1].toLowerCase());
}

// function name -> Set of parameter names
const definedFunctions = new Map();
for (const m of allSql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*returns/gi)) {
  const name = m[1].toLowerCase();
  const params = new Set();
  for (const p of m[2].matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s+[a-z]/gi)) {
    params.add(p[1].toLowerCase());
  }
  definedFunctions.set(name, params);
}

// ---- What the client asks for -------------------------------------------

let problems = 0;
let rpcChecked = 0;
let fromChecked = 0;

function fail(file, msg) {
  problems++;
  console.log(`FAIL  ${file}`);
  console.log(`      ${msg}`);
}

for (const rel of CLIENT_FILES) {
  let src;
  try {
    src = readFileSync(join(root, rel), "utf8");
  } catch (e) {
    fail(rel, "file not found");
    continue;
  }

  // supabase.rpc("name", { p_x: ..., p_y: ... })
  for (const call of src.matchAll(/\.rpc\(\s*["']([a-z0-9_]+)["']\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/gi)) {
    rpcChecked++;
    const fn = call[1].toLowerCase();
    const defined = definedFunctions.get(fn);
    if (!defined) {
      fail(rel, `rpc("${fn}") — no such function is created in supabase/migrations`);
      continue;
    }
    const argBlock = call[2] || "";
    for (const arg of argBlock.matchAll(/(?:^|,|\{)\s*([a-z_][a-z0-9_]*)\s*:/gi)) {
      const key = arg[1].toLowerCase();
      if (!defined.has(key)) {
        fail(
          rel,
          `rpc("${fn}") passes "${key}", which is not a parameter of that function. ` +
            `It takes: ${[...defined].join(", ") || "(none)"}`
        );
      }
    }
  }

  // .from("name")
  for (const f of src.matchAll(/\.from\(\s*["']([a-z0-9_]+)["']\s*\)/gi)) {
    fromChecked++;
    const obj = f[1].toLowerCase();
    if (!definedObjects.has(obj)) {
      fail(rel, `.from("${obj}") — no migration creates that table or view`);
    }
  }

  // channel(...).on("postgres_changes", { table: "x" })
  for (const t of src.matchAll(/table:\s*["']([a-z0-9_]+)["']/gi)) {
    const obj = t[1].toLowerCase();
    if (!definedObjects.has(obj)) {
      fail(rel, `realtime subscription names table "${obj}", which no migration creates`);
    }
    // A realtime subscription on a table that is not in the publication
    // delivers nothing, silently and forever.
    const inPublication = new RegExp(
      `alter\\s+publication\\s+supabase_realtime\\s+add\\s+table\\s+public\\.${obj}\\b`, "i"
    ).test(allSql);
    if (!inPublication) {
      fail(
        rel,
        `realtime subscribes to "${obj}" but no migration adds it to the ` +
          `supabase_realtime publication — the socket would connect and never deliver a row`
      );
    }
  }
}

console.log("");
console.log(`${definedFunctions.size} function(s) and ${definedObjects.size} object(s) found in migrations`);
console.log(`${rpcChecked} rpc call(s) and ${fromChecked} .from() call(s) checked in ${CLIENT_FILES.length} client file(s)`);

// ---- Self-test ----------------------------------------------------------
//
// The check must be able to both pass and fail on things whose answer is
// known. Counting matches is not enough: the comment bug above produced a
// healthy-looking "5 rpc calls checked" while the parameter set it compared
// against was wrong.
const selfTests = [
  [
    "staff_send_notification is found with all five of its parameters",
    () => {
      const p = definedFunctions.get("staff_send_notification");
      return p && ["p_user_ids", "p_kind", "p_title", "p_body", "p_href"].every((k) => p.has(k));
    },
  ],
  [
    "mark_notifications_read is found with p_ids",
    () => {
      const p = definedFunctions.get("mark_notifications_read");
      return p && p.has("p_ids");
    },
  ],
  [
    "a parameter that does not exist is NOT reported as existing",
    () => {
      const p = definedFunctions.get("staff_send_notification");
      return p && !p.has("p_not_a_real_parameter");
    },
  ],
  ["a table nobody creates is not in the object set", () => !definedObjects.has("no_such_table_xyz")],
  ["notifications IS in the object set", () => definedObjects.has("notifications")],
];

let selfOk = true;
console.log("");
for (const [label, fn] of selfTests) {
  const ok = Boolean(fn());
  if (!ok) selfOk = false;
  console.log(`${ok ? "ok  " : "BAD "} self-test: ${label}`);
}

if (rpcChecked === 0 || fromChecked === 0) {
  console.error("\nSELF-TEST FAILED — nothing was actually inspected; the patterns no longer match.");
  process.exit(1);
}
if (!selfOk) {
  console.error("\nSELF-TEST FAILED — the parser is misreading the migrations; ignore the results above.");
  process.exit(1);
}

console.log(problems === 0 ? "\nclient and migrations agree" : `\n${problems} MISMATCH(ES)`);
process.exit(problems === 0 ? 0 : 1);
