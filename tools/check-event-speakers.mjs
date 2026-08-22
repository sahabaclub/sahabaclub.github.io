// check-event-speakers — the speaker credit, from both ends.
//
// ⚠ WHY THIS EXISTS. `event_speakers_public` (0080/0081) is the first view on
// this site that publishes a named member to signed-out visitors. Two things
// can go wrong with it and neither one raises an error anywhere:
//
//   1. IT GROWS A COLUMN. It exposes four fields about a person and no contact
//      details. `profiles` sitting right there in the join has email-adjacent
//      company, city and mailbox links a `select *` would happily pick up. A
//      view that quietly starts publishing those looks identical from the
//      outside — the page renders the same, nothing 500s, and the extra field
//      is just sitting in the JSON for anyone who opens devtools.
//
//   2. A SPEAKER HAS NO NAME. Five profiles today have a blank full_name. The
//      admin panel refuses to credit them and the event page drops them, so
//      the only symptom of a bad row is a speaker who was saved and is not on
//      the page — which nobody notices, because the page looks fine with two
//      speakers on it. This file is the thing that notices.
//
// Both checks work with ZERO speaker rows recorded, which is the state the
// table is in right now. Asking PostgREST for a column that does not exist is
// a 400 whether or not the view has rows in it, so the privacy assertion does
// not wait for the feature to be used before it starts guarding.
//
// ERRORS fail the build.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://sobxhcsgtimtiqtvqbag.supabase.co/rest/v1";
const KEY = "sb_publishable_uYzve3z4wfLF_-9fTH67Og_PJ6EhHm4";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

let failed = 0;
const fail = (m) => { console.error("  FAIL  " + m); failed++; };
const ok = (m) => console.log("  ok    " + m);

// ── 1. the view is readable by a signed-out visitor ───────────────────────
// If it is not, every public event page silently loses its speakers. An
// unreachable API is a FAILURE, not a pass — a check that goes green because
// the network was down is worse than no check.
let rows = null;
try {
  const r = await fetch(`${API}/event_speakers_public?select=event_id,user_id,slot,full_name,is_linkable`, { headers: H });
  if (!r.ok) {
    fail(`anon cannot read event_speakers_public (HTTP ${r.status}).\n          Every public event page loses its speaker credits.`);
  } else {
    rows = await r.json();
    ok(`anon can read event_speakers_public (${rows.length} speaker row(s))`);
  }
} catch (e) {
  fail(`could not reach the API — treat as UNVERIFIED: ${String(e).slice(0, 60)}`);
}

// ── 2. it exposes those fields and NOT these ──────────────────────────────
// ⚠ Asked for by name, one at a time. PostgREST answers 400 for a column the
// view does not have, so a present column is a 200 and that is the failure.
const FORBIDDEN = ["email", "mailbox", "company", "city", "country", "position", "phone"];
for (const col of FORBIDDEN) {
  try {
    const r = await fetch(`${API}/event_speakers_public?select=${col}&limit=1`, { headers: H });
    if (r.ok) {
      fail(`event_speakers_public exposes "${col}" to signed-out visitors.\n          This view publishes a name, a picture and a headline. Contact details are not part of the deal.`);
    }
  } catch { /* covered by check 1 */ }
}
if (!failed) ok(`it publishes no contact details (checked ${FORBIDDEN.length} field names)`);

// ── 3. every recorded speaker can actually be named ───────────────────────
// A row with no name is dropped by event.html on purpose — printing "Member"
// under a photo is not a credit. Dropping it is only acceptable because this
// says so out loud.
if (rows) {
  const nameless = rows.filter((r) => !r.full_name || !String(r.full_name).trim());
  if (nameless.length) {
    fail(`${nameless.length} speaker row(s) have no name on their profile, so the event page drops them:\n` +
         nameless.map((r) => `          event ${r.event_id} slot ${r.slot} — user ${r.user_id}`).join("\n") +
         `\n          Ask them to fill in their name, or remove the credit.`);
  } else {
    ok("every recorded speaker has a name to be credited with");
  }

  // ── 4. nobody has more than three ──────────────────────────────────────
  // The unique (event_id, slot) constraint should make this impossible. It is
  // asserted anyway: constraints get dropped by later migrations, and the
  // layout on the event page is built for three.
  const per = {};
  rows.forEach((r) => { per[r.event_id] = (per[r.event_id] || 0) + 1; });
  const over = Object.entries(per).filter(([, n]) => n > 3);
  if (over.length) {
    fail(`event(s) with more than three speakers: ${over.map(([id, n]) => `${id} (${n})`).join(", ")}.\n          The slot constraint from 0080 is gone.`);
  } else {
    ok("no event has more than three speakers");
  }
}

// ── 5. the page still drops nameless speakers ─────────────────────────────
// Check 3 is only safe while this filter exists. If someone removes it, the
// failure mode goes back to "Member" appearing on a public page.
{
  const src = readFileSync(join(ROOT, "event.html"), "utf8");
  const fn = src.slice(src.indexOf("function speakersHtml"), src.indexOf("function galleryHtml"));
  if (!/\.filter\(/.test(fn) || !/full_name/.test(fn)) {
    fail(`event.html speakersHtml no longer filters out nameless speakers.\n          A speaker with a blank profile name will render as an empty or placeholder card.`);
  } else {
    ok("event.html still drops speakers it cannot name");
  }
}

console.log(failed ? `\n  ${failed} problem(s).` : "\n  speakers: clean.");
process.exit(failed ? 1 : 0);
