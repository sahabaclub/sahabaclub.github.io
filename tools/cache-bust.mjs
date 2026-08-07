// Stamp a version on every local script, stylesheet and module import.
//
//   node tools/cache-bust.mjs          show what would change
//   node tools/cache-bust.mjs --apply  write it
//
// ============================================================
// What this actually fixes, and what it does not
// ============================================================
//
// GitHub Pages serves everything with `Cache-Control: max-age=600` and an
// ETag. Measured, not assumed. So nothing here is stale for longer than ten
// minutes, and the "day-old file" framing in the 7 Aug audit was WRONG — the
// headers never allowed it.
//
// The real fault is narrower and it is a genuine one: inside that ten-minute
// window a browser serves from cache WITHOUT revalidating. So after a deploy a
// visitor can pair NEW HTML with OLD JavaScript for up to ten minutes. That is
// version skew, not staleness, and it is worse than either half being old —
// the page and its code disagree about what exists.
//
// It is what bit us repeatedly on 7 Aug: the Admin link "missing", the
// organizer message "not appearing", the related-card images "broken". Every
// one was a fresh page running cached code, and each cost real diagnosis time
// before `transferSize: 0` gave it away.
//
// Stamping a version on the URL removes the skew: new HTML asks for a URL that
// can only return the matching asset, and old HTML keeps asking for the old one
// it was built against. Both are self-consistent.
//
// ⚠ It does NOT make the HTML itself fresher. An HTML file is still up to ten
// minutes old, and nothing here changes that — a query string cannot version
// the document that carries the query strings. Ten minutes is a reasonable
// window for a document; the mismatch was the problem.
//
// ============================================================
// One token for everything, deliberately
// ============================================================
//
// The precise approach is a per-file content hash. It is also wrong here, and
// subtly: `admin-guard.js` imports `supabase-client.js`. Hashing each file
// alone means changing the second does not change the first, so the browser
// reuses cached admin-guard.js — which still names the OLD supabase-client
// URL. Fixing that properly means hashing in dependency order, a small Merkle
// tree over the import graph, and getting it wrong reintroduces exactly the
// bug this file exists to remove.
//
// So: ONE token, derived from the contents of every asset together. Any change
// to any asset re-versions all of them. The cost is that a deploy re-downloads
// perhaps 300KB that has not changed. That is a rounding error against a bug
// that has now cost several hours.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep, dirname, resolve } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", "supabase", "assets", "tools"]);

// ⚠ sw.js is NEVER versioned. A service worker is registered by URL, and the
// browser decides whether to update it by BYTE-COMPARING the script at that
// same URL. Give it a changing query string and every deploy registers what
// looks like a brand new worker, which is a different and worse problem than
// the one being solved.
const NEVER_VERSION = new Set(["sw.js", "manifest.webmanifest"]);

function walk(dir, test, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, test, out);
    else if (test(name)) out.push(full);
  }
  return out;
}

const htmlFiles = walk(ROOT, (n) => n.endsWith(".html"));
const jsFiles = walk(ROOT, (n) => n.endsWith(".js"));
const cssFiles = walk(ROOT, (n) => n.endsWith(".css"));

// Strip any existing stamp so the token is computed from CONTENT, never from a
// previous run. Without this the tool is not idempotent: the token would
// change every time simply because the last token is in the file.
const STAMP = /\?v=[0-9a-f]{10}/g;
function bare(text) {
  return text.replace(STAMP, "");
}

// The token: every asset's content, in a stable order.
const assetFiles = [...jsFiles, ...cssFiles]
  .filter((f) => !NEVER_VERSION.has(f.split(sep).pop()))
  .sort();
const h = createHash("sha256");
for (const f of assetFiles) {
  h.update(relative(ROOT, f).split(sep).join("/"));
  h.update(bare(readFileSync(f, "utf8")));
}
const TOKEN = h.digest("hex").slice(0, 10);

// Does a referenced path point at a real local file we version?
function resolvesToVersionedAsset(fromFile, ref) {
  if (/^(https?:|data:|#|mailto:)/.test(ref)) return false;
  const clean = ref.split("?")[0].split("#")[0];
  if (!/\.(js|css)$/.test(clean)) return false;
  if (NEVER_VERSION.has(clean.split("/").pop())) return false;
  const base = clean.startsWith("/") ? ROOT : dirname(fromFile);
  const abs = resolve(base, clean.startsWith("/") ? "." + clean : clean);
  try { return statSync(abs).isFile(); } catch { return false; }
}

function stamp(fromFile, ref) {
  const clean = ref.split("?")[0].split("#")[0];
  return clean + "?v=" + TOKEN;
}

let changed = 0;
const APPLY = process.argv.includes("--apply");

function rewrite(file, isHtml) {
  const original = readFileSync(file, "utf8");
  let out = original;

  const patterns = isHtml
    ? [
        // <script src="…">
        [/(<script[^>]+src=")([^"]+)(")/g, 2],
        // <link … href="….css">
        [/(<link[^>]+href=")([^"]+\.css(?:\?[^"]*)?)(")/g, 2],
        // import … from "…"  /  import("…") inside inline modules
        [/(from\s+")([^"]+\.js(?:\?[^"]*)?)(")/g, 2],
        [/(import\(\s*")([^"]+\.js(?:\?[^"]*)?)(")/g, 2],
      ]
    : [
        // The same import forms inside .js, so a module's own dependencies
        // move with it rather than being pinned to whatever is cached.
        [/(from\s+")(\.[^"]+\.js(?:\?[^"]*)?)(")/g, 2],
        [/(import\(\s*")(\.[^"]+\.js(?:\?[^"]*)?)(")/g, 2],
      ];

  for (const [re] of patterns) {
    out = out.replace(re, (whole, pre, ref, post) => {
      if (!resolvesToVersionedAsset(file, ref)) return whole;
      return pre + stamp(file, ref) + post;
    });
  }

  if (out !== original) {
    changed++;
    console.log("  " + relative(ROOT, file).split(sep).join("/"));
    if (APPLY) writeFileSync(file, out, "utf8");
  }
}

console.log("token: " + TOKEN + "  (from " + assetFiles.length + " assets)\n");
for (const f of htmlFiles) rewrite(f, true);
for (const f of jsFiles) {
  if (NEVER_VERSION.has(f.split(sep).pop())) continue;
  rewrite(f, false);
}

console.log("\n" + (APPLY ? "APPLIED" : "DRY RUN") + ": " + changed + " file(s)");
if (!APPLY && changed) console.log("re-run with --apply to write");
if (APPLY) {
  console.log("\n⚠ Re-run this whenever an asset changes, BEFORE committing.");
  console.log("  Unversioned edits are not wrong, just unprotected from skew.");
}
