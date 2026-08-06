// Find objects referenced BEFORE they are created, within one migration.
//
// Written after 0044 failed on its first real application with:
//
//     ERROR: 42P01: relation "public.notification_optouts" does not exist
//
// The cause: `should_notify` is `language sql`, and Postgres RESOLVES THE
// RELATIONS IN A SQL FUNCTION BODY WHEN THE FUNCTION IS CREATED. The table it
// read was declared 200 lines further down. A `language plpgsql` function does
// NOT behave this way — its body is parsed but relations are not resolved
// until it runs — which is why the rest of the file was fine and only this one
// function failed. Views behave like SQL functions: resolved at creation.
//
// Nothing else in this repo could have caught it. check-notification-contract
// compares NAMES between the client and the migrations; the SQL parse checker
// validates GRAMMAR. Neither knows what exists at a given LINE.
//
// COVERED: within a single file, a `language sql` function body or a `create
// view` body that references public.<name> where <name> is created later in
// that same file.
//
// NOT COVERED: cross-file ordering (0045 referencing something 0046 creates),
// because migrations are applied in filename order and that is a different
// question; and anything that exists in the live database already. This is a
// source-only check and cannot know what has been applied.
//
// Run: node tools/check-migration-order.mjs

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "supabase", "migrations");

// Objects whose creation point matters, and where each is created.
function creationLines(sql) {
  const map = new Map();
  const re =
    /^\s*create\s+(?:or\s+replace\s+)?(?:materialized\s+)?(table|view)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gim;
  let m;
  while ((m = re.exec(sql))) {
    const name = m[2].toLowerCase();
    const line = sql.slice(0, m.index).split("\n").length;
    if (!map.has(name)) map.set(name, line);
  }
  return map;
}

// Bodies that are resolved AT CREATION: `language sql` functions, and views.
function eagerBodies(sql) {
  const out = [];

  // create [or replace] function ... language sql ... as $tag$ BODY $tag$
  const fnRe =
    /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)[\s\S]*?language\s+(sql|plpgsql)\b[\s\S]*?as\s+\$([a-z0-9_]*)\$([\s\S]*?)\$\3\$/gi;
  let m;
  while ((m = fnRe.exec(sql))) {
    if (m[2].toLowerCase() !== "sql") continue; // plpgsql resolves at run time
    out.push({
      what: `function ${m[1]}() [language sql]`,
      body: m[4],
      line: sql.slice(0, m.index).split("\n").length,
    });
  }

  // create [or replace] view NAME ... as SELECT ... ;
  const viewRe =
    /create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?([a-z0-9_]+)([\s\S]*?);/gi;
  while ((m = viewRe.exec(sql))) {
    out.push({
      what: `view ${m[1]}`,
      body: m[2],
      line: sql.slice(0, m.index).split("\n").length,
    });
  }

  return out;
}

const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
let problems = 0;
let inspected = 0;

for (const file of files) {
  const raw = readFileSync(join(dir, file), "utf8");
  // Strip comments so a `public.x` inside prose is not treated as a reference.
  const sql = raw.replace(/--[^\n]*/g, "");
  const created = creationLines(sql);

  for (const b of eagerBodies(sql)) {
    inspected++;
    const refs = new Set(
      [...b.body.matchAll(/\bpublic\.([a-z0-9_]+)\b/gi)].map((r) => r[1].toLowerCase())
    );
    for (const ref of refs) {
      const madeAt = created.get(ref);
      if (madeAt !== undefined && madeAt > b.line) {
        problems++;
        console.log(`FAIL  ${file}`);
        console.log(
          `      ${b.what} at line ${b.line} reads public.${ref}, which is created at line ${madeAt}`
        );
        console.log(
          `      A SQL-function/view body is resolved when it is CREATED. Move the table above it.`
        );
      }
    }
  }
}

console.log("");
console.log(`${files.length} migration(s), ${inspected} eagerly-resolved bod(ies) inspected`);

// The check must be able to fail. This is the exact shape of the real bug.
const control = `
create function public.f() returns boolean language sql as $$
  select exists (select 1 from public.later_table);
$$;
create table public.later_table (id int);
`;
const cCreated = creationLines(control);
const cBodies = eagerBodies(control);
const controlCaught =
  cBodies.length === 1 &&
  cCreated.get("later_table") !== undefined &&
  cCreated.get("later_table") > cBodies[0].line;
console.log(
  `${controlCaught ? "ok  " : "BAD "} control: a SQL function reading a table declared below it IS detected`
);

// And the opposite: correct order must NOT be flagged.
const ok = `
create table public.first_table (id int);
create function public.f() returns boolean language sql as $$
  select exists (select 1 from public.first_table);
$$;
`;
const okCreated = creationLines(ok);
const okBodies = eagerBodies(ok);
const okClean = okCreated.get("first_table") < okBodies[0].line;
console.log(`${okClean ? "ok  " : "BAD "} control: correct order is NOT flagged`);

if (!controlCaught || !okClean) {
  console.error("\nSELF-TEST FAILED — do not trust this checker.");
  process.exit(1);
}

console.log(problems === 0 ? "\nno ordering problems found" : `\n${problems} ORDERING PROBLEM(S)`);
process.exit(problems === 0 ? 0 : 1);
