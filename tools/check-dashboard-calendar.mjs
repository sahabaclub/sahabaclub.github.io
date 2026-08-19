// check-dashboard-calendar — the dashboard calendar's month navigation.
//
// ⚠ WHY THIS EXISTS. The calendar shipped with the phone view broken and it was
// reported by the member, not caught here. Two defects, both invisible on a
// desktop:
//
//   1. renderAgenda() listed EVERY month at once, so a phone showed August
//      events under a heading reading "October 2026".
//   2. stepMonth() called renderCalendar() and not paintCalendar(), so the
//      arrows redrew the grid — which is display:none below 760px — and left
//      the only view a phone can see untouched. The buttons did nothing.
//
// Both were verified as working before release. The check that "passed" asked
// whether the agenda RENDERED, and it did. Nothing asked whether it rendered
// the month the heading claimed, or whether pressing next changed it.
//
// This runs the real functions out of the page against synthetic data. It needs
// no browser, no network and no credentials.
//
// Pass a path to run against a modified copy — that is how the assertions here
// were sabotage-tested, and re-introducing either bug makes this file exit 1.
//
//   node tools/check-dashboard-calendar.mjs [path/to/dashboard.html]

import { readFileSync } from "node:fs";

const PAGE = process.argv[2] || "app/dashboard.html";
// ⚠ CRLF normalised on read: this repo has mixed line endings per file and a
// bare \n needle has silently matched nothing before, turning a check green.
const html = readFileSync(PAGE, "utf8").replace(/\r\n/g, "\n");

const main = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).find((b) => b.includes("function fromRow"));
if (!main) {
  console.error("  FAIL  could not find the dashboard's main script block");
  process.exit(1);
}

// Lift just the calendar out of the page. Everything here is pure: it reads
// CAL and writes innerHTML, so it runs under a stub document.
const WANT = [
  "var MONTHS =", "var MONTHS_LONG", "var DAYS_SHORT", "var BANDS =", "var BAND_WORD",
  "var CAL =", "function isoOf", "function chipHtml", "function renderCalendar",
  "function renderAgenda", "function paintCalendar", "function stepMonth", "function esc",
];
let src = "";
const missing = [];
for (const w of WANT) {
  const i = main.indexOf(w);
  if (i === -1) { missing.push(w); continue; }
  if (w.startsWith("function")) {
    let depth = 0, end = main.indexOf("{", i);
    for (let k = end; k < main.length; k++) {
      if (main[k] === "{") depth++;
      else if (main[k] === "}") { depth--; if (!depth) { end = k; break; } }
    }
    src += main.slice(i, end + 1) + "\n";
  } else {
    src += main.slice(i, main.indexOf("\n", main.indexOf(";", i))) + "\n";
  }
}
if (missing.length) {
  console.error("  FAIL  the calendar no longer defines: " + missing.join(", "));
  console.error("        Renaming these is fine, but update this check with them.");
  process.exit(1);
}

const els = {};
globalThis.document = {
  getElementById: (id) => (els[id] = els[id] || { id, innerHTML: "", textContent: "" }),
};
const cal = new Function(src + "return { renderCalendar, renderAgenda, paintCalendar, stepMonth, CAL };")();

cal.CAL.byDate = {
  "2026-08-01": [{ slug: "a", title: "Dubai AI Meetup DIFC", band: "saved", meta: "7:30 PM" },
                 { slug: "b", title: "Dubai AI Meetup Marina", band: "went", meta: "7 PM" }],
  "2026-08-12": [{ slug: "c", title: "HeyGen Spotlight", band: "went", meta: "6 PM" }],
  "2026-09-10": [{ slug: "d", title: "BigQuery insights", band: "rec", meta: "6 PM" }],
  "2026-10-05": [{ slug: "e", title: "AI Everything Abu Dhabi", band: "going", meta: "10 AM" }],
  "2026-10-21": [{ slug: "f", title: "NEXT Gulf", band: "saved", meta: "9 AM" }],
};

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) console.log("  ok    " + label);
  else { console.log("  FAIL  " + label + (detail ? "  — " + detail : "")); fails++; }
};

const agendaMonths = () => [...new Set(
  [...els["cal-agenda"].innerHTML.matchAll(/class="cal-day-h">([^<]+)</g)]
    .map((m) => m[1].split(" ").pop()))];
const agendaDays = () => (els["cal-agenda"].innerHTML.match(/class="cal-day-h"/g) || []).length;
const agendaChips = () => (els["cal-agenda"].innerHTML.match(/class="cal-chip /g) || []).length;

// Opens on October, the way loadEvents() does when the next "going" event is
// in October — which is exactly the state the reported bug appeared in.
cal.CAL.cursor = new Date(2026, 9, 1);
cal.paintCalendar();
check("heading names the month on screen", els["cal-title"].textContent === "October 2026", els["cal-title"].textContent);
check("agenda shows only that month", JSON.stringify(agendaMonths()) === '["Oct"]', JSON.stringify(agendaMonths()));
check("agenda shows that month's days", agendaDays() === 2, agendaDays() + " days");
check("agenda shows that month's events", agendaChips() === 2, agendaChips() + " chips");

// ⚠ THE REPORTED BUG. Below 760px the grid is hidden, so if the arrows do not
// redraw the agenda they do nothing at all as far as a member is concerned.
const before = els["cal-agenda"].innerHTML;
cal.stepMonth(-1);
check("prev/next redraws the agenda, not just the grid", els["cal-agenda"].innerHTML !== before,
      "the agenda is byte-identical after stepping a month — on a phone the buttons are dead");
check("heading follows the step", els["cal-title"].textContent === "September 2026", els["cal-title"].textContent);
check("agenda follows the step", JSON.stringify(agendaMonths()) === '["Sep"]', JSON.stringify(agendaMonths()));

cal.stepMonth(-1);
check("stepping again keeps both in step",
      els["cal-title"].textContent === "August 2026" && JSON.stringify(agendaMonths()) === '["Aug"]',
      els["cal-title"].textContent + " vs " + JSON.stringify(agendaMonths()));
check("agenda is complete for the month", agendaDays() === 2 && agendaChips() === 3,
      agendaDays() + " days, " + agendaChips() + " chips");

// An empty month has to say so. A blank panel under arrows that just moved
// reads as a page that failed to load.
cal.CAL.cursor = new Date(2026, 10, 1);
cal.paintCalendar();
check("an empty month names itself", els["cal-agenda"].innerHTML.includes("Nothing in November 2026"),
      els["cal-agenda"].innerHTML.slice(0, 60) || "(blank)");
check("an empty month draws no chips", agendaChips() === 0);

// The invariant behind both bugs: the two views must always agree on the month.
// Chips in .is-outside cells are excluded — a month grid always renders the
// adjacent days that fill the first and last weeks, and their events with them.
for (const [monthIndex, short] of [[7, "Aug"], [8, "Sep"], [9, "Oct"]]) {
  cal.CAL.cursor = new Date(2026, monthIndex, 1);
  cal.paintCalendar();
  const inMonth = els["cal-grid"].innerHTML.split('<div class="cal-cell')
    .slice(1)
    .filter((s) => !s.slice(0, s.indexOf(">")).includes("is-outside"));
  const gridChips = inMonth.join("").split('class="cal-chip ').length - 1;
  check("grid and agenda agree for " + short,
        agendaMonths()[0] === short && gridChips === agendaChips(),
        "grid " + gridChips + " vs agenda " + agendaChips() + ", agenda month " + JSON.stringify(agendaMonths()));
}

if (fails) {
  console.error("\n  " + fails + " problem(s). This is member-visible on a phone, where the grid is");
  console.error("  hidden and the agenda is the only calendar there is.");
  process.exit(1);
}
console.log("\n  calendar navigation works: both views follow the cursor, and the arrows move both.");
