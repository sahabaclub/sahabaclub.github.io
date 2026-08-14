// check-event-reminders.mjs
// ------------------------------------------------------------
//   node tools/check-event-reminders.mjs
//
// The two-hour event reminder (0065) spans four files and a column, and every
// join between them is a bare string that nothing compiles:
//
//   0065 sweep            emits kind `event_starting_soon`
//   0044 notification_kinds  must still give that kind the `email` channel
//   send-notification-emails maps that kind to template `event_reminder`
//   send-transactional-email must HAVE that template, and send it from events@
//
// Break any one of those and the reminder does not error — it silently sends
// the wrong thing, from the wrong address, or nothing at all.
//
// ============================================================
// ⚠ AND THE PART THAT IS NOT ABOUT CODE AT ALL
// ============================================================
//
// `events.starts_at` is what the sweep fires on, and NOTHING IN THE PRODUCT
// WRITES IT — not the admin events form, not the import-event AI importer.
// Measured 13 Aug 2026: 39 upcoming published events, 0 with a start time.
//
// So this checker also asks the LIVE database how many upcoming events have
// one, and FAILS while the answer is none. That is not pedantry. A reminder
// that cannot fire looks exactly like a reminder that has nothing to do, and
// this project has already shipped three jobs that existed, documented their
// own cron call, and never once ran. Making the silence loud is the only thing
// that distinguishes the two.
//
// ⚠ IF THIS FAILS ON `starts_at`, NO CODE IS BROKEN. Somebody needs to fill the
// column in. Do not "fix" it by deleting the check.
//
// Reads the site's publishable key — the same anon read any visitor makes, no
// secret involved. Skips (does not fail) when the network is unavailable.
//
// ⚠ Self-tests at the end, per this project's rule that a checker never seen to
// fail is a checker nobody should trust.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const SUPABASE_URL = "https://sobxhcsgtimtiqtvqbag.supabase.co";
const PUBLISHABLE = "sb_publishable_uYzve3z4wfLF_-9fTH67Og_PJ6EhHm4";

const FILES = {
  // ⚠ 0067, NOT 0065. Both define sweep_event_reminders() and the later one is
  // what the database actually runs — asserting against 0065 would pass happily
  // against a definition that has been replaced.
  sweep: read("supabase/migrations/0067_reminder_speaks_the_event_s_own_zone.sql"),
  kinds: read("supabase/migrations/0044_notification_core.sql"),
  sender: read("supabase/functions/send-notification-emails/index.ts"),
  mailer: read("supabase/functions/send-transactional-email/index.ts"),
  // The other half: something has to be able to WRITE a start time, or the
  // chain above is a machine with no fuel. 0066 and its two callers.
  derive: read("supabase/migrations/0066_event_start_time_is_enterable.sql"),
  form: read("app/admin/events.html"),
  importer: read("supabase/functions/import-event/index.ts"),
  css: read("app/admin/admin.css"),
};

// ---- The four sides still agree -------------------------------------------

function runWiring(f, report) {
  // The sweep
  report("the sweep fires two hours ahead",
    /interval '2 hours 15 minutes'/.test(f.sweep),
    "the lead time is not the two hours Ahmed asked for");
  report("ONLY members who said they are going",
    /reg\.status = 'registered'/.test(f.sweep),
    "the reminder would go to people who never confirmed");
  report("an event with no start time is skipped, not guessed",
    /e\.starts_at is not null/.test(f.sweep),
    "a guessed time zone mails the wrong hour in the club's own voice");
  report("the link goes to the event's own page",
    /'\/event\.html\?e=' \|\| r\.slug/.test(f.sweep),
    "a reminder landing on the events list wasted the click");
  report("the time is rendered in the EVENT's own zone, and named",
    /at time zone v_zone/.test(f.sweep) && /split_part\(v_zone, '\/', -1\)/.test(f.sweep),
    "the club's zone tells a Cairo attendee an hour later than the event's own page does");
  report("a missing zone falls back to the club, never to UTC",
    /coalesce\(nullif\(r\.time_zone, ''\), 'Asia\/Dubai'\)/.test(f.sweep),
    "to_char with a null zone renders the session zone, which is UTC under pg_cron");
  report("the dedupe key is unchanged from 0045",
    /'event-soon:' \|\| r\.event_id::text/.test(f.sweep),
    "changing it re-reminds anyone already reminded under the old rule");

  // The kind still carries email
  const kindRow = (f.kinds.match(/\('event_starting_soon'[\s\S]{0,400}?\)/) ?? [""])[0];
  report("the kind still has the email channel",
    /email/.test(kindRow),
    "0051's email_queue only picks up kinds whose default_channels include email");

  // The routing
  report("the sender maps the kind to the event template",
    /event_starting_soon:\s*"event_reminder"/.test(f.sender));
  report("and still routes everything else to the generic one",
    /TEMPLATE_BY_KIND\[row\.kind\] \?\? "notification"/.test(f.sender),
    "a kind missing from the map must get a template, not silence");
  report("THE ROUTING MAP IS NOT A SECOND RECIPIENT FILTER",
    /email_queue/.test(f.sender),
    "who gets mailed must still be decided in one place");

  // The template and its sender
  report("the template exists",
    /template === "event_reminder"/.test(f.mailer));
  report('"event_reminder" is a declared template name',
    /\|\s*"event_reminder"/.test(f.mailer));
  report("IT SENDS FROM events@sahabaclub.com",
    /event_reminder:\s*EVENTS_FROM/.test(f.mailer) &&
    /events@sahabaclub\.com/.test(f.mailer),
    "Ahmed asked for this one to come from the events address");
  report("the from line is chosen per template, with a fallback",
    /FROM_BY_TEMPLATE\[template as TemplateName\] \?\? RESEND_FROM/.test(f.mailer),
    "adding a template must never silently change who existing mail is from");
  // Scoped to the template's own block rather than the whole file — the
  // `notification` template has the identical guard, so a file-wide search
  // would pass while this template trusted anything it was handed.
  const block = f.mailer.slice(f.mailer.indexOf('template === "event_reminder"'));
  const body = block.slice(0, block.indexOf("// \"welcome\""));
  report("the reminder's link is validated, not trusted",
    body !== "" && /safePath/.test(body) && /test\(rawHref\)/.test(body),
    "this link carries the club's own DKIM signature");

  // ---- and something can actually put a start time in ----

  report("starts_at is DERIVED by a trigger, in one place",
    /events_set_starts_at_trg/.test(f.derive) &&
    /at time zone new\.time_zone/.test(f.derive),
    "three callers doing their own time-zone arithmetic disagree in three ways");
  report("clearing the local time clears the instant",
    /new\.starts_at := null/.test(f.derive),
    "an event whose time was deleted would keep reminding people at the old hour");
  report("an unknown time zone is refused, not silently treated as UTC",
    /pg_timezone_names/.test(f.derive));

  report("the admin form can set a start time and a zone",
    /id="f-start"/.test(f.form) && /id="f-tz"/.test(f.form));
  report("the form SAVES them",
    /start_time_local: F\.start\.value/.test(f.form) && /time_zone: F\.tz\.value/.test(f.form));
  report("the form does NOT send the derived column",
    !/starts_at:/.test(f.form),
    "starts_at is trigger-owned; writing it from here would be overwritten and misleading");
  report("an unlisted zone is added rather than silently becoming Dubai",
    /function setZone/.test(f.form) && /F\.tz\.add\(new Option/.test(f.form),
    "assigning an absent value to a <select> leaves it on the first option");

  report("the importer extracts a start time and a zone",
    /start_time_local: \{ type: "string"/.test(f.importer) &&
    /time_zone: \{ type: "string"/.test(f.importer));
  report("and both are in the schema's required list",
    /required: \[[^\]]*"start_time_local"[^\]]*"time_zone"/.test(f.importer),
    "OpenAI strict mode needs every property required or the call is rejected");
  report("A HALF-READ TIME IS DISCARDED, NOT CLIPPED",
    /\^\(\[01\]\\d\|2\[0-3\]\):\[0-5\]\\d\$/.test(f.importer),
    "clipping '6:30 PM' to five characters yields '6:30 ' and mails the wrong hour");
  report("the importer hands both back to the form",
    /start_time_local: evt\.start_time_local/.test(f.importer) &&
    /time_zone: evt\.time_zone/.test(f.importer));
  report("THE ZONE IS LIFTED FROM THE PAGE, NOT INFERRED",
    /const statedZone = tzMatch/.test(f.importer) &&
    /Stated time zone \(IANA, taken from the page\)/.test(f.importer),
    "schema.org gives only an offset, and +03:00 is Cairo, Riyadh, Nairobi and Moscow alike");

  // ---- the backfill panel, which no test can click ----
  //
  // ⚠ These are static on purpose and it is a real limitation: the panel lives
  // behind a staff session, so nothing here proves it works — only that its
  // invariants are still written down in code. Said plainly rather than left to
  // look like coverage.
  report("the backfill panel exists",
    /id="ad-st-back"/.test(f.form) && /function startTimeGaps/.test(f.form));
  report("it offers only UPCOMING events with a source link",
    /e\.event_date >= today && !e\.starts_at && e\.register_link/.test(f.form),
    "a past event's start time changes nothing and a model call would be wasted");
  report("APPLYING WRITES ONLY THE TWO COLUMNS",
    /update\(\{ start_time_local: f\.start_time_local, time_zone: f\.time_zone \}\)/.test(f.form),
    "an importer read is not a mandate to rewrite an event somebody edited by hand");
  report("nothing is written without a press",
    !/stRead[\s\S]{0,800}?\.update\(/.test(f.form),
    "reading must propose, not save");
  report("reads are sequential, not a burst",
    !/Promise\.all\([\s\S]{0,200}?stRead/.test(f.form),
    "thirty concurrent reads is a burst at somebody else's site and at OpenAI");
  report("the missing count ignores the search filter",
    /const missing = startTimeGaps\(\)/.test(f.form),
    "counting the filtered rows would hide the gap behind a search box");

  // ⚠ THE GAP THAT REOPENED THE SAME DAY IT WAS CLOSED. On 14 Aug, hours after
  // 0068 gave all 49 events a start time, a new one arrived with time_label
  // "1:00 AM" and Starts at blank. Backfilling rows does not stop that; the
  // form has to say something at the moment it happens.
  report("SAVING A STATED HOUR WITH NO START TIME IS INTERRUPTED",
    /function statedHourButNoStartTime/.test(f.form) &&
    /\\d\\s\*\[:\.\]\\s\*\\d/.test(f.form),
    "an event with a time on the label and none in the field gets no reminder, silently");
  report("and it interrupts rather than blocks",
    /if \(!ok\) return;/.test(f.form),
    "a hard refusal teaches people to type something wrong to get past it, and a " +
    "wrong start time mails everybody at the wrong hour");

  // ⚠ THE ONE THAT ALMOST SHIPPED WRONG. Caught on the first live read, 14 Aug:
  // the importer returns "" for a zone the page never states, the panel
  // defaulted it to the club's zone, and the row showed it as if it had been
  // found. 49 events would have been stamped Dubai on one press, an Egyptian
  // online meetup among them.
  report("AN ASSUMED ZONE IS RECORDED AS ASSUMED",
    /zoneAssumed: !d\.draft\.time_zone/.test(f.form),
    "a defaulted zone that looks like a found one is a guess wearing evidence's clothes");
  report("and it is visible in the row",
    /ad-st-assumed/.test(f.form) && /ad-st-assumed/.test(f.css),
    "the caveat has to be on screen, not just in the data");
  report("BULK APPLY REFUSES AN ASSUMED ZONE",
    /const ready = all\.filter\(e => !stFound\[e\.id\]\.zoneAssumed\)/.test(f.form),
    "a guess applied fifty at a time is how every Egyptian event ends up an hour out");
}

// ---- The column the whole thing fires on ----------------------------------

async function runData(rows, report) {
  const withStart = rows.filter((r) => r.starts_at).length;
  console.log(`        (${rows.length} upcoming published events, ${withStart} with a start time)`);
  report("SOME UPCOMING EVENT HAS A START TIME",
    rows.length === 0 || withStart > 0,
    "0 of " + rows.length + " upcoming events have `starts_at`, so the sweep matches\n" +
    "        nothing and this reminder sends ZERO emails, silently.\n" +
    "        ⚠ NO CODE IS BROKEN, and this is not a checker to delete. Since 0066 the\n" +
    "        admin form and the AI importer can both set a start time — but the events\n" +
    "        that already existed still have none, and 0066 deliberately does not\n" +
    "        backfill them (parsing `time_label` would guess an hour AND a zone).\n" +
    "        This clears as staff open those events and fill in Starts at.");
}

async function fetchEvents() {
  const url = `${SUPABASE_URL}/rest/v1/events` +
    `?select=slug,event_date,starts_at&is_published=eq.true` +
    `&event_date=gte.${new Date().toISOString().slice(0, 10)}&limit=500`;
  const res = await fetch(url, { headers: { apikey: PUBLISHABLE } });
  if (!res.ok) throw new Error(`REST ${res.status}`);
  return await res.json();
}

// ---- Run -------------------------------------------------------------------

let failed = 0;
const report = (label, ok, detail) => {
  if (ok) { console.log("  ok    " + label); return; }
  failed++;
  console.log("  FAIL  " + label + (detail ? "\n        " + detail : ""));
};

console.log("\nthe two-hour event reminder — the four sides agree\n");
runWiring(FILES, report);

console.log("\nand the column it fires on\n");
let liveRows = null;
try {
  liveRows = await fetchEvents();
} catch (e) {
  // Offline is not a failure. A checker that goes red on a train is a checker
  // people start skipping, and this one has something worth saying.
  console.log("  skip  live events unreachable (" + e.message + ") — data check not run");
}
if (liveRows) await runData(liveRows, report);

// ---- Self-test -------------------------------------------------------------
console.log("\nself-test — the checks must fail when the chain is broken\n");

function mustCatch(name, run1, expectHit) {
  const hits = [];
  try { run1((l, ok) => { if (!ok) hits.push(l); }); } catch (e) { hits.push("threw: " + e.message); }
  if (hits.some((h) => h.includes(expectHit))) {
    console.log('  ok    ' + name + ' → caught by "' + expectHit + '"');
  } else {
    failed++;
    console.log("  FAIL  " + name + " went UNNOTICED — this checker cannot be trusted");
  }
}

// The regression that would mail people who never said they were going.
mustCatch("the registered-only filter dropped",
  (r) => runWiring({ ...FILES, sweep: FILES.sweep.replace(/reg\.status = 'registered'/g, "true") }, r),
  "ONLY members who said they are going");

// "One template is simpler" — and the reminder goes out from members@ again.
mustCatch("the kind stops routing to the event template",
  (r) => runWiring({ ...FILES, sender: FILES.sender.replace(/event_starting_soon:\s*"event_reminder"/, "") }, r),
  "the sender maps the kind to the event template");

// The sender address quietly reverting.
mustCatch("the events@ sender removed",
  (r) => runWiring({ ...FILES, mailer: FILES.mailer.replace(/event_reminder:\s*EVENTS_FROM/, "") }, r),
  "IT SENDS FROM events@sahabaclub.com");

// Somebody "tidying" the zone conversion away, which reads as a UTC clock time.
// The regression this migration exists to prevent: back to the club's zone, so
// a Cairo event's reminder reads an hour later than the event's own page.
mustCatch("the reminder reverts to the club's zone",
  (r) => runWiring({ ...FILES, sweep: FILES.sweep.replace(/at time zone v_zone/g, "at time zone 'Asia/Dubai'") }, r),
  "the time is rendered in the EVENT's own zone, and named");

mustCatch("the null-zone fallback removed",
  (r) => runWiring({ ...FILES, sweep: FILES.sweep.replace(/coalesce\(nullif\(r\.time_zone, ''\), 'Asia\/Dubai'\)/, "r.time_zone") }, r),
  "a missing zone falls back to the club, never to UTC");

// The form quietly writing the derived column, which reads as working and is not.
mustCatch("the form starts writing starts_at itself",
  (r) => runWiring({ ...FILES, form: FILES.form + "\n  starts_at: F.start.value,\n" }, r),
  "the form does NOT send the derived column");

// The clamp loosened to a plain clip — "6:30 PM" becomes "6:30 " and the
// reminder goes out at the wrong hour.
mustCatch("the importer's time clamp loosened to a clip",
  (r) => runWiring({ ...FILES, importer: FILES.importer.replace(/\^\(\[01\]\\d\|2\[0-3\]\):\[0-5\]\\d\$/, "^.*$") }, r),
  "A HALF-READ TIME IS DISCARDED, NOT CLIPPED");

// The zone picker losing its unknown-value guard.
mustCatch("setZone removed",
  (r) => runWiring({ ...FILES, form: FILES.form.replace(/function setZone/g, "function unusedZone") }, r),
  "an unlisted zone is added rather than silently becoming Dubai");

mustCatch("the page-stated zone extraction removed",
  (r) => runWiring({ ...FILES, importer: FILES.importer.replace(/const statedZone = tzMatch/, "const x = tzMatch") }, r),
  "THE ZONE IS LIFTED FROM THE PAGE, NOT INFERRED");

// The regression that nearly shipped: a defaulted zone shown as a found one.
mustCatch("an assumed zone stops being marked",
  (r) => runWiring({ ...FILES, form: FILES.form.replace(/zoneAssumed: !d.draft.time_zone/, "") }, r),
  "AN ASSUMED ZONE IS RECORDED AS ASSUMED");

mustCatch("bulk apply stops excluding assumed zones",
  (r) => runWiring({ ...FILES, form: FILES.form.replace(
    "const ready = all.filter(e => !stFound[e.id].zoneAssumed)", "const ready = all") }, r),
  "BULK APPLY REFUSES AN ASSUMED ZONE");

mustCatch("the stated-hour warning removed",
  (r) => runWiring({ ...FILES, form: FILES.form.replace(/function statedHourButNoStartTime/, "function unusedGuard") }, r),
  "SAVING A STATED HOUR WITH NO START TIME IS INTERRUPTED");

// The backfill quietly turning into an auto-apply.
mustCatch("the backfill writes a whole event instead of two columns",
  (r) => runWiring({ ...FILES, form: FILES.form.replace(
    /update\(\{ start_time_local: f\.start_time_local, time_zone: f\.time_zone \}\)/,
    "update(payload)") }, r),
  "APPLYING WRITES ONLY THE TWO COLUMNS");

// The count hiding behind the search box.
mustCatch("the missing count computed from filtered rows",
  (r) => runWiring({ ...FILES, form: FILES.form.replace("const missing = startTimeGaps()", "const missing = rows") }, r),
  "the missing count ignores the search filter");

// The kind losing its email channel — the reminder becomes in-app only, silently.
mustCatch("the kind loses the email channel",
  (r) => runWiring({ ...FILES, kinds: FILES.kinds.replace(/\('event_starting_soon'[\s\S]{0,400}?\)/, "('event_starting_soon','dashboard','x','y','{inapp}',true,1)") }, r),
  "the kind still has the email channel");

// And the data check itself must be able to fail.
{
  const hits = [];
  await runData([{ starts_at: null }, { starts_at: null }], (l, ok) => { if (!ok) hits.push(l); });
  if (hits.some((h) => h.includes("SOME UPCOMING EVENT HAS A START TIME"))) {
    console.log('  ok    events with no start time → caught by "SOME UPCOMING EVENT HAS A START TIME"');
  } else {
    failed++;
    console.log("  FAIL  the starts_at check cannot fail — it proves nothing");
  }
}

console.log("\n" + (failed ? failed + " FAILED" : "all checks passed") + "\n");
// ⚠ `process.exitCode`, not `process.exit()`. This file makes a fetch, and
// exiting hard while the socket is still open trips a libuv assertion on
// Windows — which prints a C++ crash after a clean report and looks like the
// checker itself is broken. Setting the code lets Node drain and exit.
process.exitCode = failed ? 1 : 0;
