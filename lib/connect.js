// Sahaba Club — Connect: members reading other members
// ------------------------------------------------------------
// One module for everything the three Connect pages need, so the rules about
// *what may be read about another person* live in one file rather than being
// re-decided on each page.
//
// The rules, restated from supabase/migrations/0013_connect_and_profiles.sql:
//
//   * Another member is only ever read through `member_directory`. Nothing
//     here selects from `profiles` for anybody but the signed-in user, because
//     members hold no SELECT on that table at all — a query would fail, and if
//     it ever stopped failing it would be leaking email and phone.
//   * `member_directory` already excludes members who haven't opted in, so
//     "not found" is the correct and only answer for someone who isn't
//     discoverable. We deliberately cannot tell the difference between "no
//     such account" and "opted out", and the pages must not try.
//   * Email and phone are not in the views. Do not join them back in.
//
// Everything returns a plain `{ data, error, off }` shape. `off` is true when
// migration 0013 hasn't been applied yet, so a page can say "Connect isn't
// switched on yet" instead of rendering a stack trace.
import { supabase } from "./supabase-client.js?v=7748bdbeaa";

// ---- Failure shapes ---------------------------------------------------

// PostgREST answers a missing table two different ways depending on whether
// the schema cache has been reloaded: a Postgres 42P01, or its own PGRST205.
// A missing *column* (profiles.headline before 0013) shows up as 42703 or
// PGRST204. Treat the lot as "the migration hasn't run", because from a
// member's point of view they mean the same thing.
export function isMissingSchema(error) {
  if (!error) return false;
  const code = String(error.code || "");
  if (code === "42P01" || code === "42703") return true;
  if (code === "PGRST205" || code === "PGRST204") return true;
  const msg = String(error.message || "");
  return /schema cache|does not exist|Could not find the (table|column)/i.test(msg);
}

function wrap(res) {
  if (res.error && isMissingSchema(res.error)) {
    return { data: null, error: res.error, off: true };
  }
  return { data: res.data, error: res.error || null, off: false };
}

export const CONNECT_OFF_MESSAGE =
  "Connect isn't switched on yet. The database update it needs hasn't been applied — nothing is broken on your side.";

// ---- Who am I ---------------------------------------------------------

let cachedUser = null;
let resolvedUser = false;

export async function currentUser() {
  if (resolvedUser) return cachedUser;
  const { data } = await supabase.auth.getSession();
  cachedUser = data.session ? data.session.user : null;
  resolvedUser = true;
  return cachedUser;
}

// Every Connect page is members-only. Sends signed-out visitors to the login
// page and returns null so the caller can stop.
export async function requireUser(loginPath) {
  const user = await currentUser();
  if (!user) {
    window.location.replace(loginPath || "../login.html");
    return null;
  }
  return user;
}

// ---- The directory ----------------------------------------------------

const DIRECTORY_COLUMNS =
  "user_id, full_name, headline, avatar_url, city, country, experience_level, " +
  "industry, skills, interests, links, accepts_messages, member_since, followers, following";

// Added to the view by 0023. Only the single-member page asks for them: both
// are jsonb aggregates, and a directory of a thousand cards would be paying
// for two sub-selects per row to render none of it.
// ⚠ role, tier and open_to JOIN THE RETRY GROUP DELIBERATELY (0075, 19 Aug).
// They could sit in the always-asked set — 0075 is applied — but this group is
// the one whose absence is survivable: if the view is older than the code, the
// page loses a badge and an "Open to" row instead of failing to render a
// profile at all. A newly added column belongs on the forgiving side of that
// line until it has been in place long enough to be assumed.
const PROFILE_COLUMNS =
  "work_history, hackathons, joined_site_at, role, tier, open_to";

// A paragraph is not a card-sized thing, so `bio` stays off the directory
// query — but it is most of what a profile page is for, and for a prospect
// (0027) it is nearly all of it. It has been in the view since 0013, so it
// goes with the always-there set rather than into the 0023 retry group below.
//
// `years_experience` is here for exactly that reason and not a different one.
// It is small enough for a card, but no card asks for it and the profile
// page's first stat tile is the only thing that does. It has been in
// `member_directory` since 0019 (`p.years_experience`, in the select list of
// the view that migration drops and recreates) and it survived 0023's
// redefinition of the same view, so it is not one of the columns the retry
// group exists for. Putting it there would make it the one column whose
// absence silently drops a tile from a database that has had it for eight
// migrations — the retry is for columns that might genuinely not be there yet,
// and this is not one of them.
const PROFILE_ONLY_COLUMNS = "bio, years_experience";

// One member, as everyone else sees them. `data: null` with no error means
// "not in the directory" — the page shows the same state for that as it would
// for an id that was never real.
//
// 0023 is written but not applied everywhere, so asking for its three columns
// can come back as "no such column" against a directory that is otherwise
// perfectly alive. That must not turn a working profile into "Connect isn't
// switched on yet", so a missing-schema answer is retried without them and the
// page renders the parts that do exist. Only when the plain select fails too
// is the view genuinely absent — and then the retry reports `off` by itself.
export async function getMember(userId) {
  if (!userId) return { data: null, error: null, off: false };

  const ask = (columns) =>
    supabase
      .from("member_directory")
      .select(columns)
      .eq("user_id", userId)
      .maybeSingle();

  const base = DIRECTORY_COLUMNS + ", " + PROFILE_ONLY_COLUMNS;
  const full = wrap(await ask(base + ", " + PROFILE_COLUMNS));
  if (!full.off) return full;
  return wrap(await ask(base));
}

// ---- The people who haven't joined yet --------------------------------

// 0027 keeps prospect profiles in their own table with their own lifecycle,
// and publishes them through `prospect_directory` with **the same `hackathons`
// aggregate shape** as `member_directory`. That is deliberate, and it is what
// lets the profile page and the Connect card run one renderer over both kinds
// of row instead of branching on which kind they have.
//
// The one thing a prospect does not have is a `user_id`, because they have no
// account. Anything that identifies a row therefore goes through
// `subjectKey`/`subjectHref` below rather than reaching for an id that only
// half the directory has. `getMember(userId)` is keyed on `user_id` and stays
// that way — a prospect is fetched by its own `id`, through its own function.

const PROSPECT_LIST_COLUMNS =
  "id, full_name, headline, avatar_url, city, country, industry, " +
  "skills, interests, links, is_member, created_at";

const PROSPECT_PROFILE_COLUMNS =
  PROSPECT_LIST_COLUMNS +
  ", bio, company, position, years_experience, work_history, hackathons";

// One prospect, by the id the view gives them. No column-level retry here,
// unlike `getMember`: every column below arrives with 0027 in one piece, so
// the only thing that can be missing is the whole view — which `wrap` already
// reports as `off`.
export async function getProspect(prospectId) {
  if (!prospectId) return { data: null, error: null, off: false };
  return wrap(
    await supabase
      .from("prospect_directory")
      .select(PROSPECT_PROFILE_COLUMNS)
      .eq("id", prospectId)
      .maybeSingle()
  );
}

// ---- Were this round's placings ever written down? --------------------

// A profile's `hackathons` entry with no rank is ambiguous on its own: the
// team may not have made the podium, or the round's placings may never have
// been recorded at all. Rounds 3 and 4 are the second case
// (supabase/seed/hackathons/README.md), and the difference is the one thing
// hackathons.html is most careful to spell out. Answering it for the rounds a
// single profile mentions lets the member page say "not recorded" only where
// that is true, and say nothing at all where it isn't.
//
// Returns a Map of slug → true if any team in that round has a recorded
// placing. A slug that isn't in the Map is one we couldn't establish, which
// callers must treat as unknown rather than as "no placings". Both objects are
// readable by any member — hackathons.html loads them without a session — and
// failing here is not failing the profile, so every error degrades to an empty
// Map rather than propagating.
export async function roundsWithPlacings(slugs) {
  const wanted = [...new Set((slugs || []).filter(Boolean))];
  const empty = new Map();
  if (!wanted.length) return { data: empty };

  const rounds = wrap(
    await supabase.from("hackathons").select("id, slug").in("slug", wanted)
  );
  if (rounds.off || rounds.error || !(rounds.data || []).length) return { data: empty };

  const slugById = new Map((rounds.data || []).map((r) => [r.id, r.slug]));
  const teams = wrap(
    await supabase
      .from("hackathon_teams")
      .select("hackathon_id, rank, is_winner")
      .in("hackathon_id", [...slugById.keys()])
  );
  if (teams.off || teams.error) return { data: empty };

  // Every round we resolved starts at false — "we looked, and nothing was
  // recorded" — and only rows we actually saw flip it to true.
  const found = new Map();
  slugById.forEach((slug) => found.set(slug, false));
  (teams.data || []).forEach((t) => {
    if (t.rank || t.is_winner) found.set(slugById.get(t.hackathon_id), true);
  });
  return { data: found };
}

// ---- What their EduHackAI record adds up to ---------------------------

// The profile page used to give this a section of its own: one card per round,
// with the award, the team, the self-declared roles and a paragraph about
// whether a placing was ever recorded. That section is gone and its content is
// now a single line in the stats row, which makes the *derivation* the whole
// job — one short phrase has to stand in for everything those cards said, and
// it is the phrase people screenshot.
//
// So it lives here, next to `roundsWithPlacings()` whose Map it reads, rather
// than inside the page. Nothing below touches the DOM, the network or markup:
// a `hackathons` aggregate goes in and a descriptor comes out, and
// `app/member.html` decides what a descriptor looks like. That is also what
// lets `tools/member-checks/check.mjs` test every state without a browser.

// jsonb arrives as whatever was stored, so nothing below assumes an array or
// an object per entry. Same guard `app/member.html` applies to `work_history`.
function entryList(value) {
  return Array.isArray(value)
    ? value.filter((row) => row && typeof row === "object")
    : [];
}

// Only a string or a number is renderable text; anything else is "".
function entryText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && isFinite(value)) return String(value);
  return "";
}

// A coach or a judge, by the only two flags that decide it. `role` is the
// participant's own comma-joined answer at registration and is not consulted:
// as hackathons-ui.js puts it, "AI Coach" turning up in there does not make
// somebody a coach.
function isStaffEntry(entry) {
  return entry.is_mentor === true || entry.is_judge === true;
}

const ORDINAL = { 1: "1st", 2: "2nd", 3: "3rd" };

// A podium finish, or a win recorded without one. `is_winner` outside the top
// three still counts as an award, it just has no placing to state. Exported
// because it used to live in `app/member.html` and the tile that replaced that
// section is now its only caller — one copy, not two that can drift.
export function awardOf(entry) {
  const rank = Number(entry.rank);
  const podium = rank === 1 || rank === 2 || rank === 3;
  if (podium) return { key: String(rank), label: ORDINAL[rank] + " place" };
  if (entry.is_winner === true) {
    return { key: "win", label: rank > 3 ? rank + "th place" : "Winner" };
  }
  return null;
}

// Better placings sort first; a win with no podium rank sorts last of the awards.
function awardWeight(award) {
  return award.key === "win" ? 4 : Number(award.key);
}

// "EduHackAI-4" → "EduHackAI". Taken from the stored name rather than
// hard-coded, so a round series that is renamed, or a second one that is
// added, names itself. A name with no trailing number is already the family.
function roundFamily(entry) {
  const name = entryText(entry.name);
  const m = /^(.*[^\s-])[\s-]*\d+$/.exec(name);
  if (m) return m[1];
  return name || "EduHackAI";
}

function roundName(entry) {
  const round = entryText(entry.round);
  if (round) return roundFamily(entry) + "-" + round;
  return entryText(entry.name) || "EduHackAI";
}

// Several rounds as one phrase: "EduHackAI-1, 2, 4", ascending and deduped,
// with one prefix rather than three. A round with no number keeps its own name.
function roundsLabel(entries) {
  const numbered = [];
  const plain = [];
  entries.forEach((e) => {
    const raw = entryText(e.round);
    const n = Number(raw);
    if (raw && isFinite(n)) numbered.push({ n: n, family: roundFamily(e) });
    else plain.push(entryText(e.name) || "EduHackAI");
  });

  const parts = [];
  const sorted = numbered.slice().sort((a, b) => a.n - b.n);
  const family = sorted.length ? sorted[0].family : "";
  if (sorted.length && sorted.every((x) => x.family === family)) {
    parts.push(family + "-" + [...new Set(sorted.map((x) => x.n))].join(", "));
  } else {
    const seen = new Set();
    sorted.forEach((x) => {
      const label = x.family + "-" + x.n;
      if (!seen.has(label)) { seen.add(label); parts.push(label); }
    });
  }
  [...new Set(plain)].forEach((p) => parts.push(p));
  return parts.join(", ");
}

// The four states the record tile can be in, named so the page, this file and
// the tests cannot drift on the spelling.
export const RECORD = {
  WINNER: "winner",
  STAFF: "staff",
  PARTICIPANT: "participant",
  NONE: "none",
};

const PLACING_WORD = { "1": "winner", "2": "runner-up", "3": "third place" };

function placingWord(award) {
  if (PLACING_WORD[award.key]) return PLACING_WORD[award.key];
  // `is_winner` with no podium rank, or a rank outside the top three: "7th
  // place" is already the whole phrase, "Winner" is the wording for the rest.
  return /^\d/.test(award.label) ? award.label.toLowerCase() : "winner";
}

// What this person's EduHackAI history says, in one line.
//
//   `entries`  — the `hackathons` aggregate from `member_directory` or
//                `prospect_directory`. 0027 publishes the same shape as 0023
//                on purpose, so one function serves both.
//   `placings` — the Map from `roundsWithPlacings()`, or null. THREE states,
//                and they are not two: `true` means this round's placings are
//                on record, `false` means we looked and none were written
//                down, and a slug that is absent means we could not establish
//                it. Absent is unknown, never "no placing".
//
// Returns `{ state, text, note, title, award, more, rounds }`. `award` is
// non-null only in the winner state and carries the key the page turns into a
// medal colour.
export function hackathonRecord(entries, placings) {
  const rounds = entryList(entries);
  const blank = { award: null, more: 0, note: "", title: "", rounds: rounds.length };

  // Not "Never participated". Another member is reading this page, and that
  // wording is a verdict on a person where the data only supports an absence.
  if (!rounds.length) {
    return { ...blank, state: RECORD.NONE, text: "No rounds yet" };
  }

  const staff = rounds.filter(isStaffEntry);
  const competed = rounds.filter((e) => !isStaffEntry(e));

  // Placings belong to teams, and a coach or a judge is not on one. Round 2
  // links two coaches to a team, which the seed README flags as a probable
  // data-entry artefact and hackathons-ui.js already keeps out of that team's
  // roster; reading an award off one of those rows here would print
  // "EduHackAI-2 winner" over somebody who coached that round.
  const awarded = competed
    .map((e) => ({ entry: e, award: awardOf(e) }))
    .filter((x) => x.award)
    .sort((a, b) => awardWeight(a.award) - awardWeight(b.award));

  // ---- Winner. The best placing takes the tile, the rest go in the title.
  if (awarded.length) {
    const best = awarded[0];
    const all = awarded.map((x) => x.award.label + " in " + roundName(x.entry));
    const extra = staff.length ? [staffSentence(staff)] : [];
    return {
      ...blank,
      state: RECORD.WINNER,
      text: roundName(best.entry) + " " + placingWord(best.award),
      award: best.award,
      more: awarded.length - 1,
      title: all.concat(extra).join(" · "),
    };
  }

  // ---- Coach or judge. Never "Participated": the rest of this codebase is
  // careful never to describe staff as competing, and this is the line where
  // that is easiest to lose.
  if (staff.length) {
    const also = competed.length
      ? " Also took part in " + roundsLabel(competed) + "."
      : "";
    return {
      ...blank,
      state: RECORD.STAFF,
      text: staffText(staff),
      title: staffSentence(staff) + "." + also,
    };
  }

  // ---- Participant.
  const unknown = unknownNote(competed, placings);
  return {
    ...blank,
    state: RECORD.PARTICIPANT,
    text: "Participated in " + roundsLabel(competed),
    note: unknown,
    title: unknown,
  };
}

function staffText(staff) {
  const coached = staff.filter((e) => e.is_mentor === true);
  const judged = staff.filter((e) => e.is_judge === true);
  const coachedLabel = roundsLabel(coached);
  const judgedLabel = roundsLabel(judged);
  if (coachedLabel && judgedLabel && coachedLabel === judgedLabel) {
    return "Coached and judged " + coachedLabel;
  }
  const parts = [];
  if (coachedLabel) parts.push("Coached " + coachedLabel);
  if (judgedLabel) parts.push("Judged " + judgedLabel);
  return parts.join(" · ");
}

function staffSentence(staff) {
  const coached = staff.some((e) => e.is_mentor === true);
  const judged = staff.some((e) => e.is_judge === true);
  const who = coached && judged ? "a coach and a judge" : (coached ? "a coach" : "a judge");
  return "Involved as " + who + ", not as a competitor";
}

// The one sentence this tile must never get wrong. A round whose placings were
// never recorded, and a round we could not ask about, both mean *unknown* —
// and neither may be worded as a team that failed to place. A round whose
// placings ARE on record and do not include them gets nothing said about it at
// all, which is the same silence the old section kept.
function unknownNote(competed, placings) {
  const get = placings && typeof placings.get === "function"
    ? (slug) => placings.get(slug)
    : () => undefined;

  const never = [];
  const cannot = [];
  competed.forEach((e) => {
    if (awardOf(e)) return;
    const recorded = get(entryText(e.slug));
    if (recorded === false) never.push(e);
    else if (recorded !== true) cannot.push(e);
  });

  const parts = [];
  if (never.length) {
    parts.push("Placings for " + roundsLabel(never) + " were never recorded in the " +
      "source, so none are shown. That means unknown, not that no team placed.");
  }
  if (cannot.length) {
    parts.push("No placing is recorded for " + roundsLabel(cannot) +
      ". That means unknown, not that they didn't place.");
  }
  return parts.join(" ");
}

// ---- How much of the club they have turned up for ---------------------

// One number for the stats row, and the breakdown that keeps it honest.
//
// Two things are deliberate here and both were decided rather than assumed.
// Coaching and judging rounds COUNT — they were involved — but the breakdown
// says so in words, so "4 rounds" can never be read as four rounds competed
// when two of them were coached. And upcoming events count, which means the
// number can FALL if an event is cancelled; the breakdown is what makes a
// number that went down explicable instead of alarming.
export function engagementBreakdown(entries, activity) {
  const rounds = entryList(entries);
  const staff = rounds.filter(isStaffEntry).length;
  const competed = rounds.length - staff;
  const attended = Number((activity && activity.events_attended) || 0);
  const upcoming = Number((activity && activity.events_upcoming) || 0);

  const count = (n, word) => n + " " + word + (n === 1 ? "" : "s");
  const parts = [];
  if (rounds.length) {
    let phrase = count(rounds.length, roundFamily(rounds[0]) + " round");
    if (staff && competed) {
      phrase += " (" + competed + " competed, " + staff + " coached or judged)";
    } else if (staff) {
      phrase += ", coached or judged";
    }
    parts.push(phrase);
  }
  parts.push(count(attended, "event") + " attended");
  parts.push(upcoming + " coming up");

  return {
    total: rounds.length + attended + upcoming,
    rounds: rounds.length,
    competed: competed,
    staff: staff,
    attended: attended,
    upcoming: upcoming,
    title: parts.join(" · "),
  };
}

// The whole directory, newest members first, paged so one slow query doesn't
// hold the page. Capped: past this many the page should be teaching people to
// search rather than scroll, and a browser holding every member in memory is
// not the shape of that problem.
export const DIRECTORY_CAP = 1000;
const PAGE = 200;

// A different limit for a different constraint. `PAGE` above is a row count in
// a Range header, which costs nothing to raise. `IN_BATCH` is how many ids may
// go into a `.in(...)` filter, and that is a *URL length* budget: a UUID plus
// its comma is 37 characters in the query string, so 200 ids is about 7.5KB of
// request line — already at the edge of the ~8KB Kong in front of every
// Supabase project allows, before the rest of the URL and the bearer token are
// counted. Over it, the request fails with HTTP 414 rather than returning
// fewer rows. 100 keeps a batch near 3.7KB. `lib/event-social.js` carries the
// same constant for the same reason.
const IN_BATCH = 100;

// The paging loop, shared by the three listings below so they cannot drift
// apart on what "capped" means. `build(from, to)` returns the query for one
// page; the loop stops early on a short page, which is how a directory smaller
// than the cap costs one request rather than five.
async function pageAll(build, limit) {
  const rows = [];
  for (let from = 0; from < limit; from += PAGE) {
    const res = wrap(await build(from, Math.min(from + PAGE, limit) - 1));
    if (res.off) return { data: null, error: res.error, off: true, capped: false };
    if (res.error) return { data: null, error: res.error, off: false, capped: false };
    const batch = res.data || [];
    rows.push(...batch);
    if (batch.length < PAGE) return { data: rows, error: null, off: false, capped: false };
  }
  return { data: rows, error: null, off: false, capped: true };
}

export async function listDirectory(cap) {
  return pageAll(
    (from, to) =>
      supabase
        .from("member_directory")
        .select(DIRECTORY_COLUMNS)
        .order("member_since", { ascending: false })
        // `member_since` is `coalesce(ms365_accounts.created_at,
        // profiles.created_at)`, and members provisioned in one batch share it
        // to the microsecond — so ties are the normal case here, not the edge
        // one. Postgres is free to return tied rows in a different order for
        // each OFFSET page, which shows some members twice and drops others
        // entirely. `user_id` is the view's unique key, so adding it as a last
        // sort key makes the total order deterministic and the paging honest.
        // `listProspects` below and `listConnect` further down already do this;
        // this is the one that didn't, which the comment in `listConnect`
        // admits.
        .order("user_id", { ascending: true })
        .range(from, to),
    cap || DIRECTORY_CAP
  );
}

export async function listProspects(cap) {
  return pageAll(
    (from, to) =>
      supabase
        .from("prospect_directory")
        .select(PROSPECT_LIST_COLUMNS)
        .order("full_name", { ascending: true })
        .order("id", { ascending: true })   // unique last key, so paging can't repeat a row
        .range(from, to),
    cap || DIRECTORY_CAP
  );
}

// ---- One list, ranked by how you relate to it -------------------------

// 0028's `connect_directory` is members and unclaimed prospects in one shape,
// carrying a `relevance` band of 1..8 computed against `auth.uid()`. The view
// takes no argument and there is nothing to pass it — that is the whole point,
// and 0028's header explains at length why a rank-for-arbitrary-user function
// would have been an oracle for who was on a team with whom.
const CONNECT_COLUMNS =
  "kind, member_user_id, prospect_id, is_member, full_name, headline, avatar_url, " +
  "city, country, experience_level, industry, skills, interests, links, " +
  // ⚠ `relevance` is NO LONGER SELECTED. It stopped driving the ORDER on
  // 10 Aug, and the per-card chip that was its last reader was removed on
  // 14 Aug — so nothing read it. The view still computes it; this just stops
  // fetching a band the page has no use for.
  // ⚠ `relevance` IS SELECTED AGAIN — Ahmed, 19 Aug: he asked for an "AI match"
  // sort. That band is exactly the thing: 0028's CASE scores same team, same
  // round, a staffing link, shared tags, same industry or company, same
  // country, in that order. It was dropped from this list on 14 Aug when the
  // per-card chip was removed, because nothing read it any more. Something
  // does now.
  //
  // ⚠ It is a SORT KEY and nothing else. The chip that printed a reason on
  // each card is not coming back — see 0028 for why a band is safe to publish
  // and the specific reason behind it is not.
  "accepts_messages, listed_since, followers, following, sort_id, relevance";

// The bands, named. Kept here rather than in a page because both the ordering
// and the wording have to agree with 0028's CASE, and two copies of that would
// eventually disagree.
export const RELEVANCE = {
  TEAMMATE: 1,
  SAME_ROUND: 2,
  ROUND_STAFF: 3,
  SHARED_TAGS: 4,
  SAME_WORK: 5,
  SAME_COUNTRY: 6,
  NONE_MEMBER: 7,
  NONE_PROSPECT: 8,
};

// ⚠ RELEVANCE_LABELS AND relevanceLabel() ARE GONE — Ahmed, 14 Aug: "remove the
// tag of the relation with this person, no need for it." They rendered the chip
// under each name on Connect ("Same round — coaching or judging", "Same
// country").
//
// The wording used to live here rather than in the page so that it and 0028's
// CASE could not drift apart. That argument still holds if the chip ever comes
// back: put the labels next to the band, not in a template.
//
// ⚠ And if it does come back, re-read 0028's header first. Its case for
// publishing a band at all is that every label restates something the reader
// could already read off the other person's own directory row — which stops
// being true the moment a label claims something more specific than its band.

// The ranked view's row shape, built from a `member_directory` row. Only used
// when 0028 hasn't been applied: the page then renders exactly the same cards,
// just in the old newest-first order.
//
// `relevance: null` rather than 7. Null means "nothing ranked these", which is
// a different statement from "we looked and found nothing in common", and the
// page has to be able to tell them apart or it will caption an unranked list
// as if it were a ranked one.
export function memberAsSubject(m) {
  return {
    kind: "member",
    member_user_id: m.user_id,
    prospect_id: null,
    is_member: true,
    full_name: m.full_name,
    headline: m.headline,
    avatar_url: m.avatar_url,
    city: m.city,
    country: m.country,
    experience_level: m.experience_level,
    industry: m.industry,
    skills: m.skills,
    interests: m.interests,
    links: m.links,
    accepts_messages: m.accepts_messages,
    listed_since: m.member_since,
    followers: m.followers,
    following: m.following,
    sort_id: m.user_id,
    relevance: null,
  };
}

export function prospectAsSubject(p) {
  return {
    kind: "prospect",
    member_user_id: null,
    prospect_id: p.id,
    is_member: false,
    full_name: p.full_name,
    headline: p.headline,
    avatar_url: p.avatar_url,
    city: p.city,
    country: p.country,
    experience_level: null,
    industry: p.industry,
    skills: p.skills,
    interests: p.interests,
    links: p.links,
    // Not null and not true: there is no account for a message to arrive at.
    // Any code that checks this before offering a Message button does the
    // right thing here without having to know prospects exist.
    accepts_messages: false,
    listed_since: p.created_at,
    followers: 0,
    following: 0,
    sort_id: p.id,
    relevance: null,
  };
}

// A member and a prospect are told apart by `is_member`, never by which id
// happens to be filled in — a row with both null is a bug, and a caller that
// keys on `user_id` would silently treat it as a member.
export function subjectKey(row) {
  if (!row) return "";
  return row.is_member
    ? "m:" + String(row.member_user_id || "")
    : "p:" + String(row.prospect_id || "");
}

// Where a card points. A prospect has no user id, so it cannot be `?u=` —
// member.html reads `?p=` and loads it through `getProspect` instead.
export function subjectHref(row) {
  if (!row) return "member.html";
  return row.is_member
    ? "member.html?u=" + encodeURIComponent(String(row.member_user_id || ""))
    : "member.html?p=" + encodeURIComponent(String(row.prospect_id || ""));
}

// Everyone Connect should show, best-related first.
//
// Three levels of degradation, because 0023, 0027 and 0028 are all unapplied
// in production and they will not necessarily land together:
//
//   0028 present            → one ranked list, members and prospects
//   0027 present, 0028 not  → both lists, unranked, prospects after members
//   neither                 → members only, exactly as before
//
// Only the innermost failure — `member_directory` itself missing — is
// "Connect isn't switched on yet". A missing prospect view is not worth a
// banner: the reader has no way of knowing 87 profiles were meant to be there.
export async function listConnect(cap) {
  const ranked = await pageAll(
    (from, to) =>
      supabase
        .from("connect_directory")
        .select(CONNECT_COLUMNS)
        // ⚠ MEMBERS FIRST, THEN PROSPECTS, EACH NEWEST FIRST. Ahmed,
        // 10 Aug 2026. `relevance` used to lead, which meant the order changed
        // per viewer and a member who joined this morning could sit below
        // somebody from months ago because they shared a city with you.
        //
        // ⚠ `is_member` descending, because false sorts before true and members
        // are the ones to show first. It leads for a reason measured on the
        // real table: the entire prospect import shares `2026-08-02`, so on
        // date alone two members who joined on the 1st fell below all 62
        // prospects — real people buried under an import, which is what this
        // key exists to prevent.
        //
        // ⚠ `relevance` is now GONE ENTIRELY — not ordered on, not selected,
        // not shown. This comment used to warn against dropping it from
        // CONNECT_COLUMNS "on the assumption it is now unused"; that assumption
        // became true on 14 Aug when Ahmed had the per-card chip removed, which
        // was its last reader. The view still computes the band.
        .order("is_member", { ascending: false })
        .order("listed_since", { ascending: false })
        // Not decoration. Every prospect row shares one `created_at` — one
        // import made them all — so without a unique last key the tied rows
        // can come back in a different order per page, which shows some people
        // twice and drops others. That was already true and matters MORE now:
        // the whole prospect import is one tie on `listed_since`, and it is no
        // longer broken up by `relevance`.
        .order("sort_id", { ascending: true })
        .range(from, to),
    cap || DIRECTORY_CAP
  );
  if (!ranked.off) {
    return { ...ranked, ranked: !ranked.error, prospects: !ranked.error };
  }

  const members = await listDirectory(cap);
  if (members.off || members.error) {
    return { ...members, ranked: false, prospects: false };
  }
  const rows = (members.data || []).map(memberAsSubject);

  const prospects = await listProspects(cap);
  if (!prospects.off && !prospects.error) {
    rows.push(...(prospects.data || []).map(prospectAsSubject));
  }
  return {
    data: rows,
    error: null,
    off: false,
    capped: members.capped || (prospects.capped === true),
    ranked: false,
    prospects: !prospects.off && !prospects.error,
  };
}

// ---- The live half ----------------------------------------------------

const ACTIVITY_COLUMNS =
  "user_id, events_attended, events_upcoming, first_event, latest_event, top_topics";

export async function getActivity(userId) {
  if (!userId) return { data: null, error: null, off: false };
  return wrap(
    await supabase
      .from("member_activity")
      .select(ACTIVITY_COLUMNS)
      .eq("user_id", userId)
      .maybeSingle()
  );
}

// Activity for a list of members, keyed by user_id. Members with no event
// history simply have no row in the view, so a missing key is normal and
// means zero — never an error.
export async function getActivityFor(userIds) {
  const ids = (userIds || []).filter(Boolean);
  if (!ids.length) return { data: {}, error: null, off: false };

  const byUser = {};
  for (let i = 0; i < ids.length; i += IN_BATCH) {
    const res = wrap(
      await supabase
        .from("member_activity")
        .select(ACTIVITY_COLUMNS)
        .in("user_id", ids.slice(i, i + IN_BATCH))
    );
    // Activity is a bonus, not the page. If this view is missing while the
    // directory is present, show the directory and skip the extras.
    if (res.off || res.error) return { data: {}, error: res.error, off: res.off };
    (res.data || []).forEach((row) => { byUser[row.user_id] = row; });
  }
  return { data: byUser, error: null, off: false };
}

// ---- Badge and sort data ----------------------------------------------

const META_COLUMNS = "user_id, role, tier, profile_updated_at, open_to";

/**
 * role, tier, when the profile last changed, and what they are open to —
 * keyed by user_id. 0075 added the first three to `member_directory`.
 *
 * ⚠ A SEPARATE FETCH RATHER THAN THREE MORE COLUMNS ON connect_directory,
 * which is where they would naturally live. That view is a hundred lines with
 * a UNION and four lateral joins, and CREATE OR REPLACE demands the whole
 * definition back byte-identical to append anything — a large edit with a real
 * chance of quietly changing the relevance CASE or dropping a guard, to save
 * one request. This mirrors getActivityFor above, which exists for the same
 * reason.
 *
 * ⚠ MEMBERS ONLY, and that is not a gap. Prospects have no account, so no
 * role, no tier and no profile to have updated — a missing key means "not a
 * member", which is exactly what the badge should say.
 */
export async function getDirectoryMetaFor(userIds) {
  const ids = (userIds || []).filter(Boolean);
  if (!ids.length) return { data: {}, error: null, off: false };

  const byUser = {};
  for (let i = 0; i < ids.length; i += IN_BATCH) {
    const res = wrap(
      await supabase
        .from("member_directory")
        .select(META_COLUMNS)
        .in("user_id", ids.slice(i, i + IN_BATCH))
    );
    // Same rule as activity: a badge is a bonus, the directory is the page.
    // If this fails, everyone renders without a badge rather than nobody
    // rendering at all.
    if (res.off || res.error) return { data: {}, error: res.error, off: res.off };
    (res.data || []).forEach((row) => { byUser[row.user_id] = row; });
  }
  return { data: byUser, error: null, off: false };
}

// ---- Follows ----------------------------------------------------------

// The ids the signed-in member follows, as a Set.
export async function myFollowing() {
  const user = await currentUser();
  if (!user) return { data: new Set(), error: null, off: false };
  const res = wrap(
    await supabase
      .from("member_follows")
      .select("following_id")
      .eq("follower_id", user.id)
  );
  if (res.off || res.error) return { data: new Set(), error: res.error, off: res.off };
  return { data: new Set((res.data || []).map((r) => r.following_id)), error: null, off: false };
}

export async function follow(userId) {
  const user = await currentUser();
  if (!user) return { error: "not signed in", off: false };
  const res = wrap(
    await supabase
      .from("member_follows")
      .insert({ follower_id: user.id, following_id: userId })
  );
  // Following twice is not a failure worth showing anyone — the end state is
  // the one they asked for either way.
  if (res.error && String(res.error.code) === "23505") return { error: null, off: false };
  return { error: res.error ? res.error.message : null, off: res.off };
}

export async function unfollow(userId) {
  const user = await currentUser();
  if (!user) return { error: "not signed in", off: false };
  const res = wrap(
    await supabase
      .from("member_follows")
      .delete()
      .eq("follower_id", user.id)
      .eq("following_id", userId)
  );
  return { error: res.error ? res.error.message : null, off: res.off };
}

// ---- Messages ---------------------------------------------------------

const MESSAGE_COLUMNS =
  "id, sender_id, recipient_id, body, read_at, hidden_by_sender, hidden_by_recipient, created_at";

// Everything either side of me, oldest first. RLS already restricts this to
// conversations I'm part of; the filter is here so the request is honest
// about what it wants rather than relying on the policy to trim it.
export async function loadMessages() {
  const user = await currentUser();
  if (!user) return { data: [], error: null, off: false };
  const res = wrap(
    await supabase
      .from("member_messages")
      .select(MESSAGE_COLUMNS)
      .or("sender_id.eq." + user.id + ",recipient_id.eq." + user.id)
      .order("created_at", { ascending: true })
  );
  if (res.off || res.error) return { data: [], error: res.error, off: res.off };

  // Hiding is per-side: drop the ones I hid, keep the ones they hid.
  const mine = (res.data || []).filter((m) =>
    m.sender_id === user.id ? !m.hidden_by_sender : !m.hidden_by_recipient
  );
  return { data: mine, error: null, off: false };
}

// Group a flat message list into one thread per counterpart, newest thread
// first, with the unread count from my side only.
export function groupThreads(messages, myId) {
  const threads = new Map();
  (messages || []).forEach((m) => {
    const other = m.sender_id === myId ? m.recipient_id : m.sender_id;
    let t = threads.get(other);
    if (!t) {
      t = { userId: other, messages: [], unread: 0, last: null };
      threads.set(other, t);
    }
    t.messages.push(m);
    t.last = m;
    if (m.recipient_id === myId && !m.read_at) t.unread++;
  });
  return [...threads.values()].sort(
    (a, b) => new Date(b.last.created_at) - new Date(a.last.created_at)
  );
}

export async function sendMessage(recipientId, body) {
  const user = await currentUser();
  if (!user) return { error: "not signed in", off: false };
  const text = String(body || "").trim();
  if (!text) return { error: "Nothing to send.", off: false };
  if (text.length > 4000) return { error: "That's longer than 4000 characters.", off: false };

  const res = wrap(
    await supabase
      .from("member_messages")
      .insert({ sender_id: user.id, recipient_id: recipientId, body: text })
      .select(MESSAGE_COLUMNS)
      .single()
  );
  if (res.off) return { error: null, off: true };
  if (res.error) {
    // The send policy checks the recipient is discoverable and accepts
    // messages, so a rejection here usually means they've since turned one of
    // those off. Say that, rather than showing a policy violation.
    const msg = String(res.error.message || "");
    if (/row-level security|violates/i.test(msg)) {
      return { error: "This member isn't accepting messages any more.", off: false };
    }
    return { error: msg, off: false };
  }
  return { data: res.data, error: null, off: false };
}

// Mark the messages *they* sent *me* as read. The column grant only allows
// read_at and the hidden flags, so this cannot touch anything else even by
// mistake.
export async function markRead(otherId) {
  const user = await currentUser();
  if (!user) return { error: "not signed in" };
  const res = wrap(
    await supabase
      .from("member_messages")
      .update({ read_at: new Date().toISOString() })
      .eq("recipient_id", user.id)
      .eq("sender_id", otherId)
      .is("read_at", null)
  );
  return { error: res.error ? res.error.message : null, off: res.off };
}

// Remove a conversation from MY inbox. Two updates, each touching only my own
// side's flag — the other person keeps their copy, and nothing is deleted.
export async function hideThread(otherId) {
  const user = await currentUser();
  if (!user) return { error: "not signed in" };

  const sent = wrap(
    await supabase
      .from("member_messages")
      .update({ hidden_by_sender: true })
      .eq("sender_id", user.id)
      .eq("recipient_id", otherId)
  );
  if (sent.error) return { error: sent.error.message, off: sent.off };

  const received = wrap(
    await supabase
      .from("member_messages")
      .update({ hidden_by_recipient: true })
      .eq("recipient_id", user.id)
      .eq("sender_id", otherId)
  );
  return { error: received.error ? received.error.message : null, off: received.off };
}

// ---- Deriving the one-liner -------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthYear(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d)) return "";
  return MONTHS[d.getMonth()] + " " + d.getFullYear();
}

export function joinWords(list) {
  const items = (list || []).filter(Boolean);
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

// The line under the name: "Been around since Mar 2025 · 7 events · mostly AI
// and Power Platform".
//
// Plain arithmetic on numbers the database already computed — no model call,
// so it renders with the rest of the page and costs nothing per view. It also
// means it can never say something the counts don't support, which a generated
// sentence eventually would.
// The ranked directory calls the same date `listed_since`, because the two
// kinds of row do not mean the same thing by it. Only a member's is a
// membership date; a prospect's is the day the club built a profile for
// somebody who has never been a member, and "Member since August 2026" over
// that is a false statement about a real person. So a prospect has no "since"
// at all, and the callers below say nothing rather than something wrong.
function sinceOf(row) {
  if (!row) return null;
  if (row.member_since) return row.member_since;
  if (row.is_member === false) return null;
  return row.listed_since || null;
}

export function summarise(member, activity) {
  const bits = [];
  const since = monthYear(sinceOf(member)) ||
                monthYear(activity && activity.first_event);
  // "Member of Sahaba Club since Mar 2025", not "Been around since". The date
  // is `member_since` — when the club created their account — and it stays
  // that way: `joined_site_at` would read as if a member of three years had
  // turned up last month, which is the reading 0023 introduced the second
  // column to avoid. Only the wording changed.
  //
  // Which makes `sinceOf()` below matter more, not less: this sentence now
  // names the club, so saying it over a prospect would be a false claim about
  // a real person rather than a vague one. It returns null for them on
  // purpose.
  if (since) bits.push("Member of Sahaba Club since " + since);

  const attended = Number((activity && activity.events_attended) || 0);
  const upcoming = Number((activity && activity.events_upcoming) || 0);
  if (attended > 0) {
    bits.push(attended === 1 ? "1 event" : attended + " events");
  } else if (upcoming > 0) {
    bits.push(upcoming === 1 ? "first event coming up" : upcoming + " events coming up");
  }

  const topics = (activity && activity.top_topics) || [];
  if (attended > 0 && topics.length) {
    bits.push("mostly " + joinWords(topics.slice(0, 2)));
  }

  // Someone who joined ten minutes ago and hasn't been anywhere yet. Better to
  // say so plainly than to pad it into something that sounds like a bio.
  if (!bits.length) return "New here — nothing to go on yet.";
  return bits.join(" · ");
}

// The shorter version for a directory card.
export function shortSummary(member, activity) {
  const attended = Number((activity && activity.events_attended) || 0);
  const topics = (activity && activity.top_topics) || [];
  if (attended > 0 && topics.length) {
    return (attended === 1 ? "1 event" : attended + " events") +
           " · mostly " + joinWords(topics.slice(0, 2));
  }
  if (attended > 0) return attended === 1 ? "1 event" : attended + " events";
  const since = monthYear(sinceOf(member));
  return since ? "Member since " + since : "";
}

// ---- Small shared helpers ---------------------------------------------

export function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function initialOf(name) {
  const s = String(name || "").trim();
  return s ? s.charAt(0).toUpperCase() : "?";
}

// Only http(s) links are rendered. A `javascript:` value typed into the links
// field would otherwise become a working script the moment someone clicked it.
export function safeUrl(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : "https://" + s;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch (e) {
    return null;
  }
}

export function linkLabel(key, url) {
  const named = { linkedin: "LinkedIn", github: "GitHub", site: "Website",
                  website: "Website", x: "X", twitter: "X" };
  if (named[String(key).toLowerCase()]) return named[String(key).toLowerCase()];
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (e) {
    return String(key);
  }
}

// `links` is jsonb, so it arrives as an object. Anything that isn't a usable
// http(s) link is dropped rather than rendered as a dead chip.
export function linkList(links) {
  if (!links || typeof links !== "object") return [];
  return Object.keys(links)
    .map((key) => {
      const url = safeUrl(links[key]);
      return url ? { key: key, url: url, label: linkLabel(key, url) } : null;
    })
    .filter(Boolean);
}

export function placeOf(member) {
  return [member && member.city, member && member.country].filter(Boolean).join(", ");
}

const EXPERIENCE_LABELS = {
  "student": "Student",
  "early-career": "Early career",
  "mid-career": "Mid career",
  "senior": "Senior / leadership",
};

export function experienceLabel(value) {
  if (!value) return "";
  return EXPERIENCE_LABELS[value] || String(value);
}

export function relativeTime(value) {
  if (!value) return "";
  const then = new Date(value);
  if (isNaN(then)) return "";
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.round(hours / 24);
  if (days < 7) return days + "d ago";
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
