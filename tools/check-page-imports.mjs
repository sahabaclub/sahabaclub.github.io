// check-page-imports — a page that uses a shared value it never imported.
//
// ⚠ WHY THIS EXISTS. app/member.html reached for `supabase` in two lines and
// never imported it. Every other query on that page goes through a helper in
// connect.js, which imports its own client, so the identifier had simply never
// appeared in the file before. The two lines threw ReferenceError, a
// `try { … } catch { LAST_SESSIONS = [] }` around them turned that into "this
// member has no sessions", and a whole feature was invisible on the live site
// with no error anywhere. Ahmed found it by asking where his events were.
//
// Nothing else could have caught it:
//   * the parse check strips imports before compiling, so an undefined
//     identifier is exactly what it cannot see;
//   * the profile tests had no session fixture, so the assertion that would
//     have covered it read `sess === -1 || …` and passed on the -1;
//   * querying the REST API by hand proved the DATA was there, which looked
//     like proof and was proof of a different thing.
//
// A ReferenceError at module top level would be loud. Inside a try/catch, or
// inside a handler that only runs on click, it is silent — so this is a source
// check, not a runtime one.
//
// ERRORS fail the build.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const fail = (m) => { console.error("  FAIL  " + m); failed++; };

// ---- What counts as a shared value ---------------------------------------
// Everything lib/*.js exports. Narrowing to these keeps the check meaningful:
// a page is free to use any name it defines itself, and this only ever asks
// about names that have to come from somewhere else.
const shared = new Map();          // name -> module that exports it
for (const f of readdirSync(join(ROOT, "lib")).filter((n) => n.endsWith(".js"))) {
  const src = readFileSync(join(ROOT, "lib", f), "utf8");
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (!shared.has(m[1])) shared.set(m[1], "lib/" + f);
  }
  // `export { a, b }` re-export lists.
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name && !shared.has(name)) shared.set(name, "lib/" + f);
    }
  }
}

// ---- Every page module ---------------------------------------------------
function pages(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...pages(p));
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

let checked = 0;
for (const file of pages(ROOT)) {
  const html = readFileSync(file, "utf8");
  for (const block of html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)) {
    const code = block[1];
    checked++;

    // Names this module brings in.
    const imported = new Set();
    for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) imported.add(name);
      }
    }
    // …and names it defines for itself, which shadow the shared one and are
    // none of this file's business.
    const declared = new Set();
    for (const m of code.matchAll(/(?:^|\s)(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
      declared.add(m[1]);
    }
    // A named function parameter counts as declared too — otherwise a callback
    // taking `(supabase)` would be reported, which would be nonsense.
    for (const m of code.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/[=:\s]/)[0];
        if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
      }
    }

    for (const [name, from] of shared) {
      if (imported.has(name) || declared.has(name)) continue;
      // Used as a value: `name.` or `name(` or `name,` in an expression.
      const used = new RegExp("(^|[^\\w$.'\"`])" + name + "\\s*[.(]").test(code);
      if (!used) continue;
      fail(`${relative(ROOT, file).replace(/\\/g, "/")} uses "${name}" but never imports it.\n` +
           `          It is exported by ${from}. At runtime this is a ReferenceError — and if the\n` +
           `          call sits inside a try/catch or an event handler, the page will look fine\n` +
           `          and simply do nothing.`);
    }
  }
}

if (!failed) console.log(`  ok    page imports: ${checked} module block(s), every shared value imported`);
else console.log(`\n  ${failed} problem(s).`);
process.exit(failed ? 1 : 0);
