// Emit the 0049 seed for Sahaba Club's archived events FROM the source
// workbook, and refuse to emit anything that would break on application.
//
// Reads:  C:\Users\AhmedAbdelRazek\Downloads\Old Events.xlsx  (17 rows)
// Writes: stdout — SQL for the migration.
//
// Why generated and not typed: nine of the seventeen rows carry Arabic titles
// or Arabic descriptions, and a transcription slip in one would be invisible
// in review and would ship a wrong title onto a live page. Same rule as
// tools/generate-podcast-seed.mjs, and the reason 0043 exists.
//
// ============================================================
// Two traps this handles, both of which would fail on application
// ============================================================
//
// 1. **SLUGS ARE COMPUTED HERE, NOT LEFT TO THE TRIGGER.**
//    `events_set_slug` calls `next_event_slug`, which is `stable` — inside a
//    single INSERT statement every row sees the SAME snapshot, so it cannot
//    see the slugs its sibling rows are taking. Two of these rows have Arabic
//    titles that slugify to nothing and both fall back to `event-2023`;
//    inserted together they would collide on `events_slug_key` and abort the
//    whole migration. Explicit slugs make the SQL deterministic and reviewable
//    and never depend on trigger timing.
//
// 2. **A TITLE+DATE COLLISION WITH THE LIVE TABLE.** 0048 added a unique index
//    on (lower(trim(title)), event_date). If one of these 17 matched an
//    existing event the import would abort. This checks against the live table
//    before emitting and refuses rather than producing SQL that cannot run.
//
// Usage:
//   node tools/generate-archive-events-seed.mjs           check only
//   node tools/generate-archive-events-seed.mjs --sql     emit the SQL

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const SOURCE = "C:\\Users\\AhmedAbdelRazek\\Downloads\\Old Events.xlsx";

// ⚠ The workbook records wall-clock times with no timezone. The club is
// UAE-registered and its site is sahabaclub.ai, so these are read as Gulf
// Standard Time (UTC+4). For events three years past, displayed as a date,
// an hour's error changes nothing visible — but storing a timestamptz means
// committing to an offset, so the assumption is stated rather than hidden.
// If these were actually run on Cairo time (UTC+2) the stored instants are
// two hours late and can be corrected with one UPDATE.
const TZ_OFFSET = "+04";

const clientSrc = readFileSync(join(root, "lib", "supabase-client.js"), "utf8");
const SUPABASE_URL = /const SUPABASE_URL = "([^"]+)"/.exec(clientSrc)[1];
const SUPABASE_ANON_KEY = /const SUPABASE_ANON_KEY = "([^"]+)"/.exec(clientSrc)[1];

// Organizer as written in the workbook -> organizer slugs seeded by 0048.
// Sahaba Club is appended to every row: Ahmed confirmed the whole file is
// "old events organized by Sahaba Club", and 0048's rule is that an event is
// ours when Sahaba Club is among its organizers.
//
// "Ahmed Abdel Razek" maps to Sahaba Club, confirmed by Ahmed — that is how
// the club's own events were recorded early on, not a separate organizer.
const ORGANIZER_MAP = {
  "Sahaba Club": [],
  "Ahmed Abdel Razek": [],
  "Sahaba Club Team": [],
  "Microsoft & Sahaba Club": ["microsoft"],
  "IEEE": ["ieee"],
  "Google - DevFest": ["google-devfest"],
  "منصة أكوا إنيرجي إكسبو": ["aqua-energy-expo"],
};

function q(v) {
  if (v === null || v === undefined || String(v).trim() === "") return "null";
  return `'${String(v).trim().replace(/'/g, "''")}'`;
}

function slugify(text) {
  const s = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || null;
}

// "8/2/23 20:30" -> { date: "2023-08-02", ts: "2023-08-02 20:30:00+04" }
// M/D/YY confirmed by the data itself: 8/23 and 8/30 appear, and there is no
// 23rd or 30th month.
function parseWhen(raw) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})$/.exec(String(raw).trim());
  if (!m) return null;
  const [, mo, d, y, hh, mm] = m;
  const year = Number(y) < 100 ? 2000 + Number(y) : Number(y);
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${year}-${pad(mo)}-${pad(d)}`;
  return { date, ts: `${date} ${pad(hh)}:${mm}:00${TZ_OFFSET}` };
}

if (!existsSync(SOURCE)) {
  console.error(`Source workbook not found: ${SOURCE}`);
  process.exit(1);
}

const XLSX = require("xlsx");
const wb = XLSX.readFile(SOURCE);
const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });

const problems = [];
const rows = [];
const usedSlugs = new Set();

raw.forEach((r, i) => {
  const n = i + 1;
  const title = String(r["Title"] || "").trim();
  if (!title) { problems.push(`row ${n}: no title`); return; }

  const when = parseWhen(r["Start Date & Time"]);
  if (!when) { problems.push(`row ${n}: unparseable date "${r["Start Date & Time"]}"`); return; }

  const orgRaw = String(r["Organizer"] || "").trim();
  if (!(orgRaw in ORGANIZER_MAP)) { problems.push(`row ${n}: unmapped organizer "${orgRaw}"`); return; }

  const rec = String(r["The Recording"] || "").trim();
  const recording = /^https?:\/\//i.test(rec) ? rec : null;

  const hours = parseFloat(r['Duration "Hours"']);
  const minutes = Number.isFinite(hours) ? Math.round(hours * 60) : null;

  // Arabic titles slugify to nothing. Rather than the bare `event-<year>`
  // fallback the trigger would produce, give them something a human can read
  // and that stays unique: the club name plus the date.
  let stem = slugify(title);
  stem = stem ? `${stem}-${when.date.slice(0, 4)}` : `sahaba-club-webinar-${when.date}`;
  let slug = stem;
  let k = 1;
  while (usedSlugs.has(slug)) { k += 1; slug = `${stem}-${k}`; }
  usedSlugs.add(slug);

  rows.push({
    n, title, slug,
    description: String(r["Event Details"] || "").trim() || null,
    date: when.date,
    ts: when.ts,
    minutes,
    presenter: String(r["Presenter-Events"] || "").trim() || null,
    recording,
    orgSlugs: ORGANIZER_MAP[orgRaw],
    orgRaw,
  });
});

if (problems.length) {
  console.error("Refusing to emit — unresolved rows:");
  problems.forEach((p) => console.error("  " + p));
  process.exit(1);
}

// Collision check against the live table. 0048's unique index would abort the
// import, and finding that out during application is the expensive way.
const res = await fetch(`${SUPABASE_URL}/rest/v1/events?select=title,event_date&limit=500`, {
  headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
});
if (!res.ok) {
  console.error(`Could not read live events to check for collisions: HTTP ${res.status}`);
  process.exit(1);
}
const live = new Set((await res.json()).map((e) => `${e.title.trim().toLowerCase()}|${e.event_date}`));
const clashes = rows.filter((r) => live.has(`${r.title.toLowerCase()}|${r.date}`));

// And against each other.
const seen = new Set();
const selfClashes = [];
for (const r of rows) {
  const k = `${r.title.toLowerCase()}|${r.date}`;
  if (seen.has(k)) selfClashes.push(r);
  seen.add(k);
}

if (!process.argv.includes("--sql")) {
  console.log(`${rows.length} rows parsed from the workbook`);
  console.log(`timezone assumed: UTC${TZ_OFFSET} (Gulf) — stated, not hidden`);
  console.log(`recordings: ${rows.filter((r) => r.recording).length}/${rows.length}`);
  console.log(`slugs from Arabic-only titles: ${rows.filter((r) => r.slug.startsWith("sahaba-club-webinar-")).length}`);
  console.log(`\ncollisions with live events: ${clashes.length}`);
  clashes.forEach((c) => console.log(`  ! ${c.title} on ${c.date}`));
  console.log(`collisions within the file: ${selfClashes.length}`);
  selfClashes.forEach((c) => console.log(`  ! row ${c.n}: ${c.title}`));
  console.log("\nco-organizers (Sahaba Club is on every row):");
  const co = {};
  rows.forEach((r) => r.orgSlugs.forEach((s) => (co[s] = (co[s] || 0) + 1)));
  Object.entries(co).forEach(([s, c]) => console.log(`  ${s}: ${c}`));
  console.log(`\n${clashes.length || selfClashes.length ? "REFUSE" : "OK"} — re-run with --sql to emit.`);
  process.exit(clashes.length || selfClashes.length ? 1 : 0);
}

if (clashes.length || selfClashes.length) {
  console.error("Refusing to emit SQL: collisions would abort the migration.");
  process.exit(1);
}

console.log(`-- GENERATED by tools/generate-archive-events-seed.mjs from "Old Events.xlsx"`);
console.log(`-- ${rows.length} events. Do not hand-edit: re-run the generator.`);
console.log(`-- Times read as UTC${TZ_OFFSET} (Gulf); the workbook records no timezone.`);
console.log("");
console.log("insert into public.events");
console.log("  (title, slug, description, event_date, starts_at, duration_minutes, presenter,");
console.log("   recording_url, mode, country, price_label, tier_required, is_published)");
console.log("values");
console.log(
  rows
    .map(
      (r) =>
        `  (${q(r.title)}, ${q(r.slug)}, ${q(r.description)}, ${q(r.date)}, ${q(r.ts)}::timestamptz, ` +
        `${r.minutes === null ? "null" : r.minutes}, ${q(r.presenter)}, ${q(r.recording)}, ` +
        `'Online', null, 'Free', 'all', true)`
    )
    .join(",\n")
);
console.log("on conflict do nothing;");
console.log("");
console.log("-- Organizers. Sahaba Club on every row — Ahmed confirmed the whole file is the");
console.log("-- club's own archive, and 0048's rule is that an event is ours when Sahaba Club");
console.log("-- is among its organizers. is_lead marks the named co-organizer where there is");
console.log("-- one, so their logo leads the card.");
for (const r of rows) {
  const all = [...r.orgSlugs.map((s) => [s, true]), ["sahaba-club", r.orgSlugs.length === 0]];
  for (const [orgSlug, lead] of all) {
    console.log(
      `insert into public.event_organizers (event_id, organizer_id, is_lead)\n` +
        `select e.id, o.id, ${lead} from public.events e, public.organizers o\n` +
        ` where e.slug = ${q(r.slug)} and o.slug = ${q(orgSlug)}\n` +
        `on conflict do nothing;`
    );
  }
}
