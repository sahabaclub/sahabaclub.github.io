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

  // ── 3b. a guest is never linkable ──────────────────────────────────────
  // 0082 lets a speaker be a plain name with no account. Such a row has no
  // profile to open, so a link on it would be a dead end — and the check is
  // here rather than trusted to the view because `is_linkable` is a computed
  // column that a later migration could widen without anyone noticing.
  {
    const bad = rows.filter((r) => !r.user_id && r.is_linkable);
    if (bad.length) {
      fail(`${bad.length} guest speaker(s) are marked linkable but have no profile:\n` +
           bad.map((r) => `          event ${r.event_id} slot ${r.slot} — ${r.full_name}`).join("\n") +
           `\n          The event page will link them to a profile that does not exist.`);
    } else {
      ok("guest speakers are named but never linked");
    }
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

// ── 6. the same person is not named twice on one page ────────────────────
// `presenter` is free text that predates the speakers table. Where it names
// somebody who is now credited as a speaker, the flat text row is dropped in
// favour of the card — and the drop depends on LAST_SPEAKERS already being
// populated when render() runs. Both halves are asserted: the suppression
// itself, and the ordering that makes it work. The gallery panel shipped
// broken in exactly this way on 22 Aug — a gate that read state a `.then()`
// had not filled in yet.
{
  const src = readFileSync(join(ROOT, "event.html"), "utf8");
  if (!/presenterIsCredited/.test(src)) {
    fail(`event.html no longer suppresses a Presenter row that duplicates a speaker.\n          The same person appears twice on the page, once linked and once not, and reads as two people.`);
  } else {
    // ⚠ NOT indexOf("LAST_SPEAKERS = ") — that matches the `var LAST_SPEAKERS
    // = []` declaration at the top of the file, which every render call comes
    // after, so the comparison below could never fail. It was written that way
    // first and passed a deliberate sabotage. Anchor on the assignment from
    // the fetch result instead.
    const assigned = src.indexOf("LAST_SPEAKERS = spkRes");
    const renders = [...src.matchAll(/(?<!function )\brender\(event\b/g)].map((m) => m.index);
    if (assigned === -1 || !renders.length) {
      fail(`could not locate the LAST_SPEAKERS assignment or the render(event…) call in event.html.\n          The ordering below cannot be checked, so treat the suppression as UNVERIFIED.`);
    } else if (renders.some((i) => i < assigned)) {
      fail(`event.html renders the event before LAST_SPEAKERS is assigned.\n          The Presenter row will duplicate the speaker card on first paint.`);
    } else {
      ok("a presenter who is also a credited speaker is named once, after speakers load");
    }
  }
}

console.log(failed ? `\n  ${failed} problem(s).` : "\n  speakers: clean.");
process.exit(failed ? 1 : 0);
