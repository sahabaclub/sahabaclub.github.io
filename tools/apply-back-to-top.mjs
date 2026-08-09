#!/usr/bin/env node
// apply-back-to-top.mjs
// ------------------------------------------------------------
//   node tools/apply-back-to-top.mjs          # report what would change
//   node tools/apply-back-to-top.mjs --apply  # write it
//
// Puts `lib/back-to-top.js` on every page. Idempotent, like
// tools/apply-drawer.mjs — running it twice changes nothing, so it can be
// re-run after new pages are added without anyone having to remember which
// ones already have it.
//
// ⚠ THE PATH IS RELATIVE AND THE DEPTH VARIES. Root pages want
// `lib/back-to-top.js`, `app/*` wants `../lib/...` and `app/admin/*` wants
// `../../lib/...`. Getting that wrong does not fail the build or the deploy —
// it 404s in the browser on a subset of pages, which is exactly the kind of
// fault that ships. The depth is computed from the file's own location rather
// than listed.
//
// The tag goes immediately before </body> and carries `defer`: the script
// appends to document.body, and it must not be a render-blocking request for a
// decoration.
//
// ⚠ NO CACHE-BUSTING TOKEN IS WRITTEN HERE. `tools/cache-bust.mjs` owns that
// and stamps every local script on every page; a `?v=` written by this tool
// would be a second thing claiming the same job, and the two would disagree the
// first time either ran alone. Run cache-bust.mjs after this one — it is the
// step this repo already requires before committing any asset change.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");

// Every .html under the site, minus the places that are not pages.
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", "supabase", "tools", "assets"]);

function pages(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) pages(full, out);
    else if (entry.endsWith(".html")) out.push(full);
  }
  return out;
}

const MARKER = "lib/back-to-top.js";
let changed = 0, already = 0, skipped = 0;

for (const file of pages(root).sort()) {
  const rel = relative(root, file).split(sep).join("/");
  let html = readFileSync(file, "utf8");

  if (html.includes(MARKER)) {
    already++;
    console.log(`  ok       ${rel}`);
    continue;
  }

  // A page with no </body> is not a page this tool understands. Reported
  // rather than patched at a guess.
  const at = html.lastIndexOf("</body>");
  if (at === -1) {
    skipped++;
    console.log(`  SKIPPED  ${rel} — no </body>`);
    continue;
  }

  // Depth from the file to the repo root: index.html → "", app/x.html → "../".
  const depth = rel.split("/").length - 1;
  const prefix = "../".repeat(depth);

  // ⚠ Matches the line endings the file already uses. This repo is mixed per
  // file — some CRLF, some LF — and writing the wrong one turns a one-line
  // insert into a whole-file diff that hides what actually changed.
  const eol = html.includes("\r\n") ? "\r\n" : "\n";
  const tag = `<script defer src="${prefix}${MARKER}"></script>${eol}`;

  html = html.slice(0, at) + tag + html.slice(at);
  if (apply) writeFileSync(file, html, "utf8");
  changed++;
  console.log(`  ${apply ? "written " : "would   "} ${rel}  →  ${prefix}${MARKER}`);
}

console.log("");
console.log(`${changed} to change, ${already} already had it, ${skipped} skipped`);
if (!apply && changed) console.log("re-run with --apply to write");
if (apply && changed) console.log("\n⚠ Now run: node tools/cache-bust.mjs --apply");
