// Verification harness for the member profile page. Run from the repo root:
//   node --experimental-vm-modules tools/member-checks/check.mjs
//
// Same shape as tools/hackathons-checks/check.mjs, and for the same reason:
// none of this needs a browser, so none of it is allowed to need one.
//
//   1. loads lib/connect.js FOR REAL under a vm realm, with only
//      ./supabase-client.js swapped for a stub — so the functions under test
//      are the shipped ones, not a copy
//   2. unit-tests the pure logic the profile page now leans on: the record
//      tile's four states, the engagement total and its breakdown, and the
//      summary line's wording
//   3. links and evaluates the inline module inside app/member.html against
//      that same connect.js — which fails loudly if the page imports a name
//      the library does not export — and renders three fixtures through it,
//      then asserts on the HTML that comes out
//   4. checks the things §8 of the spec asks for that are visible in the
//      source rather than in the output
//
// The fixtures are invented. This repository is public and the real rows are
// people.

import fs from "node:fs";
import vm from "node:vm";

const REPO = new URL("../..", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1").replace(/\/$/, "");

let failures = 0;
let checks = 0;

function ok(cond, label, extra) {
  checks++;
  if (cond) return true;
  failures++;
  console.error(`  FAIL  ${label}${extra ? "\n        " + extra : ""}`);
  return false;
}
function eq(actual, expected, label) {
  return ok(actual === expected, label,
    actual === expected ? "" : `expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
}
function has(haystack, needle, label) {
  return ok(String(haystack).includes(needle), label,
    `not found: ${JSON.stringify(needle)}`);
}
function lacks(haystack, needle, label) {
  return ok(!String(haystack).includes(needle), label,
    `should not be present: ${JSON.stringify(needle)}`);
}
function section(name) { console.log(`\n== ${name}`); }

// ============================================================
// Loading the real modules
// ============================================================

// A stand-in for lib/supabase-client.js. `rows` is a table name → array map;
// a table that is absent answers like a view that was never created, which is
// the shape `wrap()` turns into `off: true`.
function fakeSupabase(rows, session) {
  function run(state) {
    const table = rows[state.table];
    if (table === undefined) {
      return { data: null, error: { code: "42P01", message: "relation does not exist" } };
    }
    let out = table.slice();
    for (const [col, op, val] of state.filters) {
      if (op === "eq") out = out.filter((r) => r[col] === val);
      if (op === "in") out = out.filter((r) => val.indexOf(r[col]) !== -1);
    }
    return state.single ? { data: out[0] || null, error: null } : { data: out, error: null };
  }

  function from(table) {
    const state = { table, filters: [], single: false };
    const b = {
      select: () => b,
      eq: (c, v) => (state.filters.push([c, "eq", v]), b),
      in: (c, v) => (state.filters.push([c, "in", v]), b),
      is: () => b,
      or: () => b,
      order: () => b,
      range: () => b,
      maybeSingle: () => ((state.single = true), b),
      single: () => ((state.single = true), b),
      then: (res, rej) => Promise.resolve(run(state)).then(res, rej),
    };
    return b;
  }

  return {
    from,
    auth: { getSession: async () => ({ data: { session: session || null } }) },
  };
}

function makeDom(search) {
  const nodes = {};
  const make = (id) => ({
    id, innerHTML: "", className: "", textContent: "", disabled: false,
    setAttribute() {}, addEventListener() {},
    classList: { add() {}, remove() {} },
  });
  nodes["member-root"] = make("member-root");
  const document_ = {
    getElementById: (id) => nodes[id] || null,
    querySelectorAll: () => [],
    documentElement: { classList: { add() {}, remove() {} } },
  };
  const window_ = {
    location: { search, pathname: "/app/member.html", replace() {} },
    addEventListener() {},
  };
  window_.window = window_;
  return { document_, window_, nodes };
}

const CONNECT_SRC = fs.readFileSync(REPO + "/lib/connect.js", "utf8");
const PAGE_SRC = fs.readFileSync(REPO + "/app/member.html", "utf8");

// The page's own module, lifted out of the HTML. There is exactly one
// <script type="module"> on the page; if that ever stops being true this
// throws rather than silently testing the wrong half.
function pageModuleSource() {
  const all = [...PAGE_SRC.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
  if (all.length !== 1) {
    throw new Error(`expected 1 module script in app/member.html, found ${all.length}`);
  }
  return all[0][1];
}

// A fresh realm per fixture. connect.js caches the signed-in user in module
// state, so reusing one instance across fixtures would answer the second
// fixture's `isMe` with the first fixture's session.
async function loadRealm({ rows, session, search }) {
  const dom = makeDom(search || "");
  const context = vm.createContext({
    console, setTimeout, clearTimeout,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    document: dom.document_, window: dom.window_,
  });

  const supabase = fakeSupabase(rows || {}, session || null);
  const stub = new vm.SyntheticModule(
    ["supabase", "SUPABASE_URL", "SUPABASE_ANON_KEY", "isConfigured"],
    function () {
      this.setExport("supabase", supabase);
      this.setExport("SUPABASE_URL", "https://example.invalid");
      this.setExport("SUPABASE_ANON_KEY", "stub");
      this.setExport("isConfigured", true);
    },
    { context }
  );

  const connect = new vm.SourceTextModule(CONNECT_SRC, {
    context, identifier: "lib/connect.js",
  });
  await connect.link((spec) => {
    // ⚠ THE ?v= STAMP IS STRIPPED BEFORE MATCHING. tools/cache-bust.mjs writes
    // `./supabase-client.js?v=<hash>` into lib/connect.js on every release, and
    // this compared the specifier exactly — so the whole file stopped linking
    // the first time the stamp changed and threw before a single assertion
    // ran. It is not in the tools/check-*.mjs glob and needs
    // --experimental-vm-modules to start, so nothing reported it: ~30
    // assertions about the exact hackathon wording were simply not running.
    if (String(spec).split("?")[0] === "./supabase-client.js") return stub;
    throw new Error("lib/connect.js imported an unexpected module: " + spec);
  });
  await connect.evaluate();

  return { context, connect, dom, stub, C: connect.namespace };
}

async function renderPage(realm) {
  const page = new vm.SourceTextModule(pageModuleSource(), {
    context: realm.context, identifier: "app/member.html",
  });
  // link() resolves every named import against the real connect.js. A name
  // the page asks for and the library does not export fails here, which is
  // the check that used to need loading the page in a browser.
  await page.link((spec) => {
    // Same ?v= stamp, same reason as the specifier above.
    const bare = String(spec).split("?")[0];
    if (bare === "../lib/connect.js") return realm.connect;
    // ⚠ The page imports the client DIRECTLY as well as through connect.js —
    // it needs it for the sessions fetch. Same stub, so both module instances
    // see the same fake rows.
    if (bare === "../lib/supabase-client.js") return realm.stub;
    throw new Error("app/member.html imported an unexpected module: " + spec);
  });
  await page.evaluate();
  // init() is an async IIFE; let its awaits settle.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  return realm.dom.nodes["member-root"].innerHTML;
}

// ============================================================
// Fixtures. Invented — this repo is public.
// ============================================================

const round = (n, extra) => Object.assign({
  slug: "eduhackai-" + n,
  name: "EduHackAI-" + n,
  round: n,
  starts_on: "2025-0" + n + "-01",
  is_mentor: false,
  is_judge: false,
  role: "Builder",
  team: "Team " + n,
  rank: null,
  is_winner: null,
}, extra || {});

const MEMBER_ID = "00000000-0000-4000-8000-00000000000a";
const OTHER_ID = "00000000-0000-4000-8000-00000000000b";

// ============================================================
// 1. The record tile's state machine
// ============================================================

const realm = await loadRealm({ rows: {} });
const C = realm.C;

section("record tile — the four states");

{
  const r = C.hackathonRecord([], null);
  eq(r.state, C.RECORD.NONE, "no rounds → state none");
  eq(r.text, "No rounds yet", "no rounds → 'No rounds yet'");
  lacks(r.text, "Never", "'Never participated' is not used — other members read this page");
}
{
  eq(C.hackathonRecord(null, null).state, C.RECORD.NONE, "null hackathons → state none");
  eq(C.hackathonRecord({ nope: 1 }, null).state, C.RECORD.NONE, "non-array hackathons → state none");
  eq(C.hackathonRecord([null, "x", 3], null).state, C.RECORD.NONE, "junk entries are dropped");
}

section("record tile — winner");

{
  const r = C.hackathonRecord([round(2, { rank: 1 })], null);
  eq(r.state, C.RECORD.WINNER, "rank 1 → winner");
  eq(r.text, "EduHackAI-2 winner", "rank 1 wording");
  eq(r.award.key, "1", "rank 1 → gold class key");
  eq(r.more, 0, "one placing → no '+n more'");
}
{
  const r = C.hackathonRecord([round(3, { rank: 2 })], null);
  eq(r.text, "EduHackAI-3 runner-up", "rank 2 wording");
  eq(r.award.key, "2", "rank 2 → silver class key");
}
{
  const r = C.hackathonRecord([round(4, { rank: 3 })], null);
  eq(r.text, "EduHackAI-4 third place", "rank 3 wording");
  eq(r.award.key, "3", "rank 3 → bronze class key");
}
{
  const r = C.hackathonRecord([round(1, { is_winner: true })], null);
  eq(r.state, C.RECORD.WINNER, "is_winner with no rank → winner");
  eq(r.text, "EduHackAI-1 winner", "is_winner with no rank wording");
  eq(r.award.key, "win", "is_winner with no rank → win key");
}
{
  const r = C.hackathonRecord([round(1, { rank: 7, is_winner: true })], null);
  eq(r.text, "EduHackAI-1 7th place", "a rank outside the podium states itself");
}

section("record tile — more than one placing");

{
  // Deliberately out of order in the input: the best placing has to win the
  // tile, not the first row the aggregate happened to return.
  const r = C.hackathonRecord([
    round(1, { rank: 3 }),
    round(2, { rank: 1 }),
    round(4, { rank: 2 }),
  ], null);
  eq(r.state, C.RECORD.WINNER, "several placings → winner");
  eq(r.text, "EduHackAI-2 winner", "the BEST placing takes the tile");
  eq(r.more, 2, "the other two are counted for '+2 more'");
  has(r.title, "1st place in EduHackAI-2", "title lists the best placing");
  has(r.title, "2nd place in EduHackAI-4", "title lists the second placing");
  has(r.title, "3rd place in EduHackAI-1", "title lists the third placing");
}

section("record tile — coach and judge");

{
  const r = C.hackathonRecord([round(3, { is_mentor: true, team: null })], null);
  eq(r.state, C.RECORD.STAFF, "a coach is not a participant");
  eq(r.text, "Coached EduHackAI-3", "coach wording");
  lacks(r.text, "Participated", "⚠ a coach must never fall through to 'Participated'");
}
{
  const r = C.hackathonRecord([round(2, { is_judge: true, team: null })], null);
  eq(r.text, "Judged EduHackAI-2", "judge wording");
  lacks(r.text, "Participated", "a judge must never fall through to 'Participated'");
}
{
  const r = C.hackathonRecord([round(2, { is_mentor: true, is_judge: true })], null);
  eq(r.text, "Coached and judged EduHackAI-2", "one round, both roles, one phrase");
}

// ⚠ A ROUND WHOSE NAME ALREADY CARRIES ITS NUMBER. Round 4 is stored as
// "EduHackAI-4 (Arabic Edition)", and roundFamily() only strips a number at
// the END of a name — so the number was appended a second time and Ahmed's
// own profile read "…(Arabic Edition)-4" for weeks. Both the single-round
// wording and the multi-round list are pinned, because the list rebuilt the
// label from family + number and reintroduced it independently.
{
  const arabic = round(4, { is_mentor: true, name: "EduHackAI-4 (Arabic Edition)" });
  const r = C.hackathonRecord([arabic], null);
  eq(r.text, "Coached EduHackAI-4 (Arabic Edition)",
    "a round named for itself is not renumbered");
  lacks(r.text, "Edition)-4", "⚠ no second round number appended");
}
{
  const r = C.hackathonRecord([
    round(1, { is_mentor: true }),
    round(2, { is_mentor: true }),
    round(3, { is_mentor: true }),
    round(4, { is_mentor: true, name: "EduHackAI-4 (Arabic Edition)" }),
  ], null);
  lacks(r.text, "Edition)-4", "⚠ nor in the multi-round list");
  has(r.text, "EduHackAI-4 (Arabic Edition)", "the Arabic edition keeps its full name");
  has(r.text, "EduHackAI-1", "…and the plain rounds are still listed");
}
{
  // The compact form must survive: it is what keeps the common case short.
  const r = C.hackathonRecord([
    round(1, { is_mentor: true }),
    round(2, { is_mentor: true }),
    round(4, { is_mentor: true }),
  ], null);
  eq(r.text, "Coached EduHackAI-1, 2, 4",
    "rounds that share a family still compact to one prefix");
}
{
  const r = C.hackathonRecord([
    round(3, { is_mentor: true }),
    round(2, { is_judge: true }),
  ], null);
  eq(r.text, "Coached EduHackAI-3 · Judged EduHackAI-2", "different rounds stay apart");
}
{
  const r = C.hackathonRecord([
    round(3, { is_mentor: true }),
    round(1, {}),
  ], null);
  eq(r.state, C.RECORD.STAFF, "coaching outranks a plain round in the tile");
  has(r.title, "Also took part in EduHackAI-1", "the round they competed in is not lost");
  has(r.title, "not as a competitor", "the title says plainly that staff did not compete");
}
{
  // The round-2 artefact the seed README flags: a coach carrying a team, and
  // therefore capable of carrying a rank. Reading a placing off it would
  // print "EduHackAI-2 winner" over somebody who coached that round.
  const r = C.hackathonRecord([round(2, { is_mentor: true, rank: 1 })], null);
  eq(r.state, C.RECORD.STAFF, "⚠ a rank on a coach's row does not make them a winner");
  eq(r.text, "Coached EduHackAI-2", "a coach with a stray rank is still 'Coached'");
}
{
  const r = C.hackathonRecord([
    round(1, { rank: 1 }),
    round(3, { is_mentor: true }),
  ], null);
  eq(r.state, C.RECORD.WINNER, "a real placing outranks coaching another round");
  has(r.title, "Involved as a coach", "…and the coaching is still in the title");
}

section("record tile — participant");

{
  const r = C.hackathonRecord([round(1)], new Map([["eduhackai-1", true]]));
  eq(r.state, C.RECORD.PARTICIPANT, "a plain round → participant");
  eq(r.text, "Participated in EduHackAI-1", "single-round wording");
}
{
  const r = C.hackathonRecord(
    [round(4), round(1), round(2)],
    new Map([["eduhackai-1", true], ["eduhackai-2", true], ["eduhackai-4", true]])
  );
  eq(r.text, "Participated in EduHackAI-1, 2, 4", "several rounds, ascending, one prefix");
}
{
  // A round the database gained after this code was written.
  const r = C.hackathonRecord([round(9)], new Map([["eduhackai-9", true]]));
  eq(r.text, "Participated in EduHackAI-9", "a new round needs no code change");
}

section("record tile — ⚠ a missing placing is UNKNOWN, never a failure");

function neverImpliesFailure(r, label) {
  const said = (r.text + " " + r.note + " " + r.title).toLowerCase();
  ok(!/\bfailed\b/.test(said), label + " — never says 'failed'");
  ok(!/did not place\b/.test(said) || said.includes("unknown"),
    label + " — any mention of not placing is qualified as unknown");
}

{
  // placings.get(slug) === false: we looked, the source has nothing.
  const r = C.hackathonRecord([round(3)], new Map([["eduhackai-3", false]]));
  eq(r.state, C.RECORD.PARTICIPANT, "an unrecorded round is still participation");
  has(r.note, "never recorded", "false → 'never recorded in the source'");
  has(r.note, "unknown, not that no team placed", "false → unknown, not a failure");
  neverImpliesFailure(r, "placings recorded=false");
}
{
  // slug absent from the Map: we could not establish it either way.
  const r = C.hackathonRecord([round(3)], new Map());
  has(r.note, "No placing is recorded", "absent → 'no placing is recorded'");
  has(r.note, "unknown, not that they didn't place", "absent → unknown, not a failure");
  neverImpliesFailure(r, "placings absent");
}
{
  // No Map at all — an unapplied migration or a failed lookup.
  const r = C.hackathonRecord([round(3)], null);
  has(r.note, "unknown", "a null Map is unknown, not 'no placing'");
  neverImpliesFailure(r, "placings null");
}
{
  // recorded === true and this team is not among them: SILENCE. A line here
  // would be exactly the implication the page refuses to make.
  const r = C.hackathonRecord([round(1)], new Map([["eduhackai-1", true]]));
  eq(r.note, "", "⚠ a round WITH recorded placings says nothing about not placing");
  eq(r.title, "", "…and adds no tooltip either");
}
{
  // Three states in one profile: one on record, one never recorded, one we
  // could not ask about. Only the two unknowns may be spoken about.
  const r = C.hackathonRecord(
    [round(1), round(3), round(4)],
    new Map([["eduhackai-1", true], ["eduhackai-3", false]])
  );
  has(r.note, "EduHackAI-3", "the never-recorded round is named");
  has(r.note, "EduHackAI-4", "the could-not-establish round is named");
  ok(r.note.indexOf("EduHackAI-1") === -1,
    "the round with placings on record is NOT named in the note", r.note);
  neverImpliesFailure(r, "mixed placings");
}

// ============================================================
// 2. The engagement total
// ============================================================

section("engagements — total and breakdown");

{
  const e = C.engagementBreakdown(
    [round(1), round(2), round(3), round(4)],
    { events_attended: 2, events_upcoming: 3 }
  );
  eq(e.total, 9, "4 rounds + 2 attended + 3 upcoming = 9");
  eq(e.title, "4 EduHackAI rounds · 2 events attended · 3 coming up",
    "breakdown reads as the spec asks");
}
{
  // ⚠ decision 3: coached and judged rounds COUNT, and the breakdown has to
  // say so, or "4 rounds" reads as four rounds competed.
  const e = C.engagementBreakdown(
    [round(1), round(2), round(3, { is_mentor: true }), round(4, { is_judge: true })],
    { events_attended: 2, events_upcoming: 3 }
  );
  eq(e.total, 9, "coach and judge rounds are counted in the total");
  eq(e.competed, 2, "…and counted separately as competed");
  eq(e.staff, 2, "…and as coached or judged");
  has(e.title, "(2 competed, 2 coached or judged)",
    "⚠ the breakdown says plainly which rounds were coached");
}
{
  const e = C.engagementBreakdown([round(1, { is_mentor: true })], { events_attended: 0, events_upcoming: 0 });
  eq(e.total, 1, "a coach-only round still counts");
  has(e.title, "1 EduHackAI round, coached or judged", "all-staff wording");
}
{
  const e = C.engagementBreakdown([round(1)], { events_attended: 1, events_upcoming: 1 });
  eq(e.total, 3, "singular case totals correctly");
  eq(e.title, "1 EduHackAI round · 1 event attended · 1 coming up", "singular wording");
}
{
  const e = C.engagementBreakdown(null, null);
  eq(e.total, 0, "no rounds and no activity → 0");
  eq(e.title, "0 events attended · 0 coming up", "…and a breakdown that still adds up");
}
{
  // ⚠ decision 4: upcoming counts, so the number can fall. The breakdown is
  // what makes that explicable — it must name the upcoming part.
  const before = C.engagementBreakdown([], { events_attended: 1, events_upcoming: 2 });
  const after = C.engagementBreakdown([], { events_attended: 1, events_upcoming: 1 });
  ok(after.total < before.total, "a cancelled event lowers the total (accepted)");
  has(after.title, "1 coming up", "…and the breakdown explains where it went");
}

// ============================================================
// 3. The summary line
// ============================================================

section("summary line");

{
  const s = C.summarise({ member_since: "2025-03-04T00:00:00Z", is_member: true }, { events_attended: 7, top_topics: ["AI"] });
  has(s, "Member of Sahaba Club since Mar 2025", "reworded summary line");
  lacks(s, "Been around since", "the old wording is gone");
}
{
  // ⚠ sinceOf() returns null for a prospect on purpose, and the new wording
  // makes that matter more: it now names the club.
  const s = C.summarise({ is_member: false, listed_since: "2026-08-01T00:00:00Z" }, { events_attended: 0, events_upcoming: 0 });
  lacks(s, "Sahaba Club since", "a prospect gets NO since-clause");
  lacks(s, "2026", "…and no date at all");
}
{
  const s = C.summarise({ is_member: true, listed_since: "2025-01-05T00:00:00Z" }, null);
  has(s, "Member of Sahaba Club since Jan 2025", "a member falls back to listed_since");
}

// ============================================================
// 4. The page itself
// ============================================================

section("app/member.html — renders through the real connect.js");

const activityRow = {
  user_id: MEMBER_ID, events_attended: 2, events_upcoming: 3,
  first_event: "2025-02-01", latest_event: "2026-06-04",
  top_topics: ["AI", "Power Platform"],
};

function memberRow(extra) {
  return Object.assign({
    user_id: MEMBER_ID,
    full_name: "Member A",
    headline: "Builds things",
    avatar_url: null,
    city: "Cairo", country: "Egypt",
    experience_level: "senior",
    industry: "Education",
    skills: ["Azure", "Power Platform"],
    interests: ["Robotics"],
    links: { site: "example.com" },
    accepts_messages: true,
    member_since: "2025-03-04T00:00:00Z",
    joined_site_at: "2026-01-09T00:00:00Z",
    followers: 12,
    following: 5,
    bio: "A paragraph about Member A.",
    years_experience: 7,
    work_history: [{ position: "Engineer", company: "Example Ltd", start: "2021-03", is_current: true }],
    hackathons: [round(2, { rank: 1 }), round(1, {}), round(3, { is_mentor: true }), round(4, {})],
  }, extra || {});
}

const teamRows = [
  { hackathon_id: "h1", rank: null, is_winner: null },
  { hackathon_id: "h2", rank: 1, is_winner: true },
];
const hackRows = [
  { id: "h1", slug: "eduhackai-1" },
  { id: "h2", slug: "eduhackai-2" },
  { id: "h3", slug: "eduhackai-3" },
  { id: "h4", slug: "eduhackai-4" },
];

{
  const r = await loadRealm({
    search: "?u=" + MEMBER_ID,
    session: { user: { id: OTHER_ID } },        // somebody else is looking
    rows: {
      member_directory: [memberRow()],
      member_activity: [activityRow],
      member_follows: [],
      hackathons: hackRows,
      hackathon_teams: teamRows,
      // ⚠ SESSION FIXTURES, ADDED AFTER THE PAGE SHIPPED WITHOUT THEM. The
      // assertion below used to read `sess === -1 || …` because there was no
      // data to render — so it passed on the absence, and went on passing
      // while app/member.html reached for an unimported `supabase` and threw
      // on every load. A fixture that cannot produce the thing under test is
      // not a fixture, it is a way of not looking.
      event_speakers_public: [
        { event_id: "ev-past", user_id: MEMBER_ID },
        { event_id: "ev-soon", user_id: MEMBER_ID },
      ],
      events: [
        { id: "ev-past", slug: "past-talk", title: "A Talk That Happened",
          event_date: "2025-06-01", recording_url: "https://example.invalid/r",
          is_published: true },
        { id: "ev-soon", slug: "soon-talk", title: "A Talk To Come",
          event_date: "2099-01-01", recording_url: null, is_published: true },
      ],
    },
  });
  const html = await renderPage(r);
  ok(html.length > 0, "the page rendered something");

  // -- the activity chips (22 Aug). Ahmed: the rounds and the sessions should
  //    be "clear icons clickable", each leading to its own page — and, after
  //    he looked at it, INSIDE the EduHackAI tile rather than in a section
  //    below it.
  //
  // ⚠ THE CONTAINMENT IS THE ASSERTION, not just the presence. They shipped
  // once as a separate block and looked, to the person who asked for them,
  // exactly like nothing had happened: the tile he was watching was unchanged
  // and the chips were a screen further down. `has(html, chip)` alone passed
  // that whole time.
  //
  // ⚠ Expressed as ORDER, not as a substring slice. The first attempt cut from
  // the tile to the first </div> after the chips — which still matches when
  // the chips are BELOW the tile, because the slice simply runs on past the
  // tile's own close. It would have passed either layout. The chips must sit
  // after the tile's summary line and before the first section that follows
  // the stats row; a separate block lands the other side of that boundary.
  {
    const at = (needle) => html.indexOf(needle);
    const line = at("cx-record-line");
    const chip = at("cx-chip-round");
    const nextBlock = (() => {
      const a = html.indexOf("cx-section", line);
      const b = html.indexOf("cx-block", line);
      const found = [a, b].filter((i) => i !== -1);
      return found.length ? Math.min(...found) : html.length;
    })();
    ok(line !== -1 && chip !== -1 && chip > line && chip < nextBlock,
      "⚠ the round chips are INSIDE the EduHackAI tile, not in a section below it");
    // ⚠ REQUIRED TO BE PRESENT, not "present or absent". The `|| sess === -1`
    // form is what let a page that never loaded a single session pass.
    const sess = at("cx-chip-session");
    ok(sess !== -1 && sess > line && sess < nextBlock,
      "⚠ the session chips render, and inside the tile");
  }
  has(html, "../event.html?e=past-talk", "a delivered session links to its event page");
  has(html, "Recording", "…and says a recording is there");
  has(html, "../event.html?e=soon-talk", "an upcoming session links to its event page");
  has(html, "Book a place", "…and offers the booking, not a recording");
  lacks(html, "cx-block cx-activity",
    "⚠ the separate Activities section is gone, not left alongside");
  has(html, '../hackathons.html#eduhackai-3',
    "⚠ a round links to its own section on the hackathons page");
  has(html, "Coached", "…tagged with what they actually did in it");
  // ⚠ Newest round first. The fixture's rounds are 2, 1, 3, 4 in that order,
  // so an unsorted render would put 2 first and this would catch it.
  ok(html.indexOf("#eduhackai-4") < html.indexOf("#eduhackai-1"),
    "…and the newest round comes first");
  // ⚠ The name is present even though a logo is also emitted: wireRoundLogos()
  // hides it only after an image really decodes, so a round with no mark still
  // reads as itself. Asserting the text is here is asserting that fallback.
  has(html, "cx-chip-fallback", "the round name is rendered as the logo's fallback");
  has(html, "assets/eduhack/round-3-dark.png", "…with the round's own mark over it");

  // -- stats row
  has(html, 'class="cx-stats cx-stats-4"', "the stats row is the rebuilt one");
  has(html, ">engagements<", "tile 2 is the engagement total");
  has(html, ">followers<", "tile 3 is followers");
  lacks(html, ">following<", "the 'following' tile is gone");
  has(html, ">7<", "tile 1 shows the real years number");
  has(html, ">years experience<", "…with the years label");
  has(html, ">9<", "4 rounds + 2 attended + 3 upcoming renders as 9");
  has(html, "4 EduHackAI rounds (3 competed, 1 coached or judged)",
    "the engagement tooltip breaks the number down and names the coached round");
  has(html, "2 events attended", "…and the attended part");
  has(html, "3 coming up", "…and the upcoming part");

  // -- record tile
  has(html, 'class="cx-stat cx-stat-record"', "tile 4 is the record tile");
  has(html, "cx-award cx-award-1", "a first place gets the gold pill");
  has(html, "cx-award-icon", "…and the existing medal icon");
  has(html, "EduHackAI-2 winner", "…and the right wording");

  // -- layout
  lacks(html, "EduHackAI involvement", "the involvement section is gone");
  lacks(html, "Member since ", "the 'Member since' meta chip is gone");
  lacks(html, "is when the club set up their", "the orphaned club/site date note is gone");
  has(html, "Member of Sahaba Club since Mar 2025", "the summary line carries the date instead");

  const order = [
    ['<p class="cx-section-title">About</p>', "About"],
    ['<p class="cx-section-title">Work history</p>', "Work history"],
    ['<p class="cx-section-title">From the events they turn up to</p>', "From the events"],
    ['<p class="cx-section-title">Skills</p>', "Skills"],
    ['<p class="cx-section-title">Interests</p>', "Interests"],
    ['<p class="cx-section-title">Links</p>', "Links"],
  ];
  let last = html.indexOf('class="cx-stats');
  ok(last !== -1, "the stats row comes before every section");
  for (const [needle, name] of order) {
    const at = html.indexOf(needle);
    ok(at > last, `section order: ${name} follows what precedes it`,
      at === -1 ? "section not rendered at all" : `at ${at}, previous at ${last}`);
    if (at > last) last = at;
  }
}

{
  // Their own profile, years of experience never filled in.
  const r = await loadRealm({
    search: "?u=" + MEMBER_ID,
    session: { user: { id: MEMBER_ID } },
    rows: {
      member_directory: [memberRow({ years_experience: null, hackathons: [] })],
      member_activity: [activityRow],
      member_follows: [],
      hackathons: hackRows,
      hackathon_teams: teamRows,
    },
  });
  const html = await renderPage(r);
  has(html, "Add your experience", "own profile, no years → an invitation to add it");
  has(html, 'href="profile.html"', "…linking to the profile form");
  has(html, "&mdash;", "…while the tile keeps its shape");
  has(html, ">No rounds yet<", "no rounds → 'No rounds yet'");
  has(html, '<a class="cx-record-text" href="../hackathons.html">',
    "…linked to the hackathons page on your own profile");
}

{
  // Another member with no years recorded: a dash, not an invitation.
  const r = await loadRealm({
    search: "?u=" + MEMBER_ID,
    session: { user: { id: OTHER_ID } },
    rows: {
      member_directory: [memberRow({ years_experience: null, hackathons: [] })],
      member_activity: [activityRow],
      member_follows: [],
      hackathons: hackRows,
      hackathon_teams: teamRows,
    },
  });
  const html = await renderPage(r);
  has(html, "&mdash;", "another member with no years → a dash");
  lacks(html, "Add your experience", "…and no invitation to edit their profile");
  has(html, ">No rounds yet<", "no rounds → 'No rounds yet'");
  lacks(html, "../hackathons.html", "…unlinked when it isn't your profile");
}

{
  // A member who honestly entered 0. Nullable column, no default — 0 is an
  // answer, not an absence.
  const r = await loadRealm({
    search: "?u=" + MEMBER_ID,
    session: { user: { id: OTHER_ID } },
    rows: {
      member_directory: [memberRow({ years_experience: 0 })],
      member_activity: [activityRow],
      member_follows: [],
      hackathons: hackRows,
      hackathon_teams: teamRows,
    },
  });
  const html = await renderPage(r);
  has(html, '<span class="cx-stat-num">0</span>', "a stated 0 renders as 0, not as a dash");
}

{
  // A prospect. ⚠ No stats row at all — and their EduHackAI record still on
  // the page, because deleting the involvement section took every word about
  // it away from the one kind of profile that is mostly made of it.
  const r = await loadRealm({
    search: "?p=p-1",
    session: { user: { id: OTHER_ID } },
    rows: {
      prospect_directory: [{
        id: "p-1", full_name: "Prospect B", headline: null, avatar_url: null,
        city: null, country: "Egypt", industry: null,
        skills: [], interests: [], links: {}, is_member: false,
        created_at: "2026-08-01T00:00:00Z",
        bio: "Written by the club.", company: null, position: null,
        years_experience: 4, work_history: [],
        hackathons: [round(2, { rank: 2 })],
      }],
      hackathons: hackRows,
      hackathon_teams: teamRows,
    },
  });
  const html = await renderPage(r);
  lacks(html, "cx-stats-4", "⚠ a prospect gets NO stats row");
  lacks(html, ">followers<", "…no follower count");
  lacks(html, ">engagements<", "…no engagement count");
  lacks(html, ">years experience<", "…and no experience tile");
  has(html, "EduHackAI-2 runner-up", "…but their record is still on the page");
  has(html, "hasn’t joined yet", "…alongside the panel that explains why");
}

// ============================================================
// 5. Source-level acceptance checks
// ============================================================

section("source");

lacks(PAGE_SRC, "function hackathonsHtml", "hackathonsHtml is deleted");
lacks(PAGE_SRC, "function hackathonHtml", "hackathonHtml is deleted");
has(PAGE_SRC, "roundsWithPlacings", "⚠ roundsWithPlacings is retained");
has(PAGE_SRC, "async function placingsFor", "⚠ placingsFor is retained");
has(PAGE_SRC, "if (!isProspect) {", "⚠ the prospect guard on the stats row is retained");

has(CONNECT_SRC, 'PROFILE_ONLY_COLUMNS = "bio, years_experience"',
  "years_experience is in PROFILE_ONLY_COLUMNS");
// ⚠ ASSERTS THE INTENT, NOT THE EXACT STRING. This pinned the literal
// `"work_history, hackathons, joined_site_at"` and so went stale the moment
// 0075 deliberately added role, tier and open_to to the retry group on 19 Aug
// — a change its own comment in lib/connect.js explains at length. It read as
// a real regression when the file was finally able to run again. What actually
// matters is that years_experience is in the always-asked set and NOT in the
// group that is allowed to be dropped, because the profile prints a bare
// number and a missing one renders as blank rather than as an error.
ok(/const PROFILE_COLUMNS =\s*\n?\s*"[^"]*";/.test(CONNECT_SRC),
  "PROFILE_COLUMNS is still a single string literal");
ok(!/const PROFILE_COLUMNS =\s*\n?\s*"[^"]*years_experience[^"]*";/.test(CONNECT_SRC),
  "…and years_experience is NOT in the 0023 retry group");
lacks(CONNECT_SRC, '"Been around since "', "the old summary wording is gone");

const CSS = fs.readFileSync(REPO + "/styles.css", "utf8");
// connect.css is linked AFTER styles.css, so every rule here that also has an
// answer over there must win on specificity rather than on order.
has(CSS, ".cx-stats.cx-stats-4", "the grid rule is doubled so it beats .cx-stats in connect.css");
has(CSS, ".cx-stats .cx-stat-record", "the record tile is doubled so it beats .cx-stat in connect.css");
ok(!/^\.cx-stat-record\s*\{/m.test(CSS),
  "…and no single-class .cx-stat-record rule is left to lose the tie");

// ============================================================

console.log(`\n${checks} check(s) run.`);
if (failures) {
  console.error(`${failures} FAILED.`);
  process.exit(1);
}
console.log("All member-profile checks passed.");
