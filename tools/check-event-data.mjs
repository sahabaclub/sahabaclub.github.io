// check-event-data — the 19 Aug event audit, turned into something that runs.
//
// ⚠ WHY THIS EXISTS. An audit of 133 published events found every problem below
// by script in about forty lines. None of them were visible on the page: a wrong
// timezone shows nothing (the page prints `time_label`, not the zone), and a
// duplicate looks like two real events until you notice the register links
// match. One of them — a duplicated Dubai AI Festival — had already collected a
// registration on BOTH copies before anybody spotted it.
//
// The reminder feature only exists because somebody eventually RAN the check
// instead of writing it down. This is that check, run every time.
//
// It reads the live REST API with the publishable key, which is public by
// design, so it needs no secret and no database password.
//
// ERRORS fail the build. WARNINGS are printed and do not.

const API = "https://sobxhcsgtimtiqtvqbag.supabase.co/rest/v1";
const KEY = "sb_publishable_uYzve3z4wfLF_-9fTH67Og_PJ6EhHm4";

const errors = [];
const warns = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

const FIELDS = [
  "slug", "title", "event_date", "start_time_local", "time_zone", "time_label",
  "mode", "country", "location", "image_url", "register_link", "description",
  "is_published", "is_featured",
].join(",");

let rows;
try {
  const r = await fetch(`${API}/events?select=${FIELDS}&order=event_date.asc&limit=1000`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  rows = await r.json();
} catch (e) {
  // ⚠ A network failure is NOT a pass. An unverified check that reports success
  // is the exact thing this file exists to prevent.
  console.error("  FAIL  could not reach the events API — treat as UNVERIFIED: " + String(e).slice(0, 70));
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const published = rows.filter((e) => e.is_published);
const upcoming = published.filter((e) => e.event_date >= today);

// ── 1. the timezone must match the country ────────────────────────────────
// The zone is the input to `starts_at` (0066's trigger) and therefore to the
// two-hour reminder. Riyadh is UTC+3 and Dubai UTC+4, so a Saudi event stored
// as Asia/Dubai reminds an hour late and nothing on the page reveals it.
const ZONE_FOR = {
  "United Arab Emirates": "Asia/Dubai",
  "Egypt": "Africa/Cairo",
  "Saudi Arabia": "Asia/Riyadh",
  "Qatar": "Asia/Qatar",
  "Kuwait": "Asia/Kuwait",
};
for (const e of upcoming) {
  const want = ZONE_FOR[e.country];
  if (want && e.time_zone && e.time_zone !== want) {
    err(`${e.event_date}  ${e.slug}\n          country ${e.country} but time_zone ${e.time_zone} — expected ${want}. The reminder will fire at the wrong hour.`);
  }
}

// ── 2. the country column must hold a country ─────────────────────────────
// Seen in the wild: 'Online' (that is the mode) and 'Africa/Cairo' (that is a
// timezone). Online events correctly carry NULL.
for (const e of upcoming) {
  if (!e.country) continue;
  if (e.country === "Online" || e.country.includes("/")) {
    err(`${e.event_date}  ${e.slug}\n          country is "${e.country}" — that is a mode or a timezone, not a country. Online events use NULL.`);
  }
}

// ── 3. duplicate listings ─────────────────────────────────────────────────
// Matching on the title alone misses them: "27th Connected Banking Summit" and
// "Connected Banking Summit 2026" do not normalise alike. Same DATE plus the
// same REGISTER LINK is the signal that actually catches them.
const seen = new Map();
for (const e of upcoming) {
  if (!e.register_link) continue;
  const k = e.event_date + "|" + e.register_link.trim().toLowerCase();
  if (seen.has(k)) {
    err(`${e.event_date}  duplicate listing — same date and same register link:\n          ${seen.get(k).slug}\n          ${e.slug}\n          Unpublish one; do NOT delete (registrations cascade).`);
  } else {
    seen.set(k, e);
  }
}

// ── 4. the label a member reads must match the time that fires ────────────
// Only checked when the label actually looks like a TIME. Multi-day events put
// a date range in this field ("7 – 11 Dec 2026"), which is a separate problem
// and is warned about below rather than failed here.
const looksLikeTime = (l) => /\d\s*[:.]\s*\d{2}|\d\s*(am|pm)\b/i.test(String(l || ""));
const firstTime = (l) => {
  const m = String(l || "").match(/(\d{1,2})\s*[:.]?\s*(\d{2})?\s*(am|pm)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  const ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h !== 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h * 60 + mi;
};
for (const e of upcoming) {
  if (!e.time_label || !e.start_time_local || !looksLikeTime(e.time_label)) continue;
  const lab = firstTime(e.time_label);
  if (lab === null) continue;
  const [H, M] = e.start_time_local.split(":").map(Number);
  const diff = Math.abs(lab - (H * 60 + M));
  if (diff >= 15) {
    err(`${e.event_date}  ${e.slug}\n          label says "${e.time_label}" but start_time_local is ${e.start_time_local} — ${(diff / 60).toFixed(1)}h apart. The member reads one and the reminder counts from the other.`);
  }
}

// ── 5. nothing featured in the past ───────────────────────────────────────
for (const e of published) {
  if (e.is_featured && e.event_date < today) {
    err(`${e.event_date}  ${e.slug}\n          still is_featured, but it has already happened.`);
  }
}

// ── 6. placeholder titles ─────────────────────────────────────────────────
for (const e of upcoming) {
  const t = String(e.title || "").trim();
  if (/^(test|digest|draft|untitled|tbd|todo|placeholder)$/i.test(t) || t.length < 5) {
    err(`${e.event_date}  ${e.slug}\n          title is "${t}" — that reads like a placeholder that went live.`);
  }
}

// ── warnings: real, but not worth failing a build over ────────────────────
for (const e of upcoming) {
  if (!e.description || e.description.trim().length < 40) {
    warn(`${e.event_date}  ${e.slug} — no description; the page shows only a title and a date.`);
  }
  if (e.time_label && !looksLikeTime(e.time_label)) {
    warn(`${e.event_date}  ${e.slug} — time_label "${e.time_label}" is a date range, not a time, so the page never states a start time.`);
  }
}

// ── report ────────────────────────────────────────────────────────────────
console.log(`  ${published.length} published events, ${upcoming.length} upcoming`);
if (warns.length) {
  console.log(`\n  ${warns.length} warning(s):`);
  for (const w of warns) console.log("  ~ " + w);
}
if (errors.length) {
  console.error(`\n  ${errors.length} problem(s):`);
  for (const e of errors) console.error("  FAIL  " + e);
  console.error("\n  These are member-visible: wrong reminder times, duplicate listings, or placeholders on the public site.");
  process.exit(1);
}
console.log("\n  event data is clean: zones match countries, no duplicate listings, labels agree with start times.");
