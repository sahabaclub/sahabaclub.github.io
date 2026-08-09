// Sahaba Club — PromptArena results dashboard (staff only)
// ============================================================================
// Ahmed's ask, in his words: "one unified dashboard showing the results, and you
// can relate the users to the current club members, whoever belongs to the club,
// link that; if new, use the data for the marketing and outreach with hot topic
// is the previous engagement."
//
// So: live practice play and all six historical Microsoft Forms events on one
// screen, players matched to members where they are members, and the unmatched
// ones surfaced as outreach candidates with their prior engagement attached.
//
// ⚠ THIS PAGE SHOWS PERSONAL EMAIL ADDRESSES AND MOBILE NUMBERS belonging to 152
// people who never signed up to this website. That is legitimate for staff doing
// outreach and it is the reason the page exists — and it is also why every
// route into that data carries `public.is_staff()` INSIDE the database view.
// `lib/admin-guard.js` says it about itself and it is worth repeating: the guard
// in the browser is a courtesy, not the boundary. See the header of
// `tools/promptarena-dashboard/0030_promptarena_admin_views.proposed.sql`.
//
// ============================================================================
// Which roles count as "not a competitor"
// ============================================================================
//
// A `function` declaration, not a `const` arrow: declarations hoist, so this is
// callable from anywhere in the module regardless of where it sits. A `const`
// here would sit in the temporal dead zone for any call above it — the exact
// trap tools/check-dead-zone.mjs exists to catch.
//
// ⚠ `global_admin` belongs in this list. 0054 renamed Ahmed's role and three
// separate role comparisons in the client were left reading `=== "admin"`,
// which quietly hid the Admin link from the only person who has it. Three
// copies of the same list is how that happened, so there is now one.
function isStaffRole(role) {
  return role === "staff" || role === "admin" || role === "global_admin";
}

// ============================================================================
// Why this file exists separately from the page
// ============================================================================
//
// Every function here is pure or takes its data as an argument, and `buildModel`
// and `renderDashboard` are exported. That is not architecture for its own sake:
// the six legacy events have not been imported yet and the two tables are empty,
// so the only way to know whether this page renders a real dataset correctly is
// to hand it one. The harness that does so drives these exports directly against
// the page's own markup. If the rendering lived inside the page's module script
// behind a `requireStaff("promptarena")` call, none of it could be exercised without a staff
// session against production data.
//
// ============================================================================
// The rules this file will not break
// ============================================================================
//
//   1. **A null score is "not attempted" and never renders as 0.** It renders as
//      an em dash with the word "not attempted" attached. There is exactly ONE
//      genuine zero in all 556 legacy submissions and it is a real verdict.
//   2. **No stored total is ever read.** Every total is summed from round
//      scores. 53 players' stored `TotalScore` reads 0 while their rounds sum to
//      12–36.
//   3. **Rows flagged `invalid_reason` are never shown and never counted.** All
//      48 round-5 rows in the two long-format events copy the same player's
//      round-4 verdict byte for byte.
//   4. **`july18` is never given a date.** Its rows span July 2025 to July 2026
//      because the Forms list was left open and reused; `is_single_day` is false
//      and the UI renders a range or nothing.
//   5. **An unreachable source never renders as a zero.** Blocked, missing,
//      empty and error are four different states and the page says which.
//   6. **Everything player-written is escaped.** Prompts came from a room full
//      of people and the questions came from Microsoft Forms.

import { escapeHtml } from "../../lib/admin-guard.js?v=16538a1b6f";

// ============================================================================
// What the six events were measured to contain
// ============================================================================
//
// ⚠ These are NOT results and are never rendered as if they were. They are the
// measurement written up at `C:\sctools\promptarena-data\README.md`, taken from
// the six source workbooks, and they are on this page for exactly one purpose:
// to be compared against what the import actually produced. An import that lands
// 26 scored players instead of 86 is a catastrophe that looks like a working
// dashboard, and the only thing that catches it is knowing the number beforehand.
//
// Nothing here is personal data. Counts, means and event slugs only — the
// directory those numbers came from holds un-redacted names, addresses and
// mobile numbers for 152 people and must never be copied into this repository,
// which is public.
export const MEASURED = {
  events: 6,
  playerRows: 159,
  people: 152,
  submissions: 556,
  clubMailboxPeople: 39,
  clubMailboxRows: 40,
  personalDomainPeople: 113,
  peoplePlayingTwoEvents: 1,
  invalidRound5Rows: 48,
  // 556 played rounds minus the 48 whose verdict was copied. Every one of the
  // remaining 508 carries a real mark: the measurement found no submission
  // anywhere with a prompt and no score.
  expectedMarks: 508,
  genuineZeros: 1,
  arabicSubmissions: 63,
  arabicMean: 5.6,
  latinMean: 4.87,
  overallMean: 4.95,
  expectedScoredSegment: 86,
  expectedRegisteredOnly: 33,

  // Per event, from the source workbooks. `mean` is over every exported row
  // INCLUDING the 48 round-5 artefacts, because that is what was measured; the
  // dashboard says so wherever it shows one.
  byEvent: {
    "july18":           { players: 31, submissions: 256, mean: 4.93 },
    "december-eh4":     { players: 9,  submissions: 38,  mean: 5.39 },
    "aicd":             { players: 24, submissions: 81,  mean: 4.93 },
    "ai-skills-fest":   { players: 10, submissions: 20,  mean: 4.9 },
    "aug30-public":     { players: 16, submissions: 54,  mean: 4.89 },
    "cairo-aws-techup": { players: 69, submissions: 107, mean: 4.91 },
  },
};

// The caveat that must appear beside this event's numbers, wherever they appear.
// Keyed by slug, matched loosely because the importer picks the slugs.
const EVENT_CAVEATS = {
  "july18": [
    "This is not one event. Its 256 rows span 18 Jul 2025 to 14 Jul 2026 because the Forms list was left open and reused — 177 rows in July 2025, then a trickle across twelve months. Every figure on this row is really a figure for everything that ever hit that link. Do not quote a date for it.",
    "One staff account produced 53 of the 256 submissions, including 26 separate attempts at round 1. It distorts any ranking and the round-1 statistics in particular. It is excluded from the player rankings on this page and shown as excluded.",
    "41 round-5 rows here copy the player's round-4 score and comment byte for byte. They are excluded from every count on this page.",
  ],
  "december-eh4": [
    "7 round-5 rows here copy the player's round-4 score and comment byte for byte. They are excluded from every count on this page.",
  ],
  "cairo-aws-techup": [
    "The source's stored TotalScore reads 0 for 42 players whose round scores really sum to 2–27. Nothing on this page reads that column; every total is recomputed from the round scores.",
    "238 of 238 zero cells in the export are rounds nobody attempted, not marks. No played round in this event scored 0.",
    "65 rows fall on 16 Sep 2025 and 2 on the 17th, then one stray in January 2026 and one in February. The date range is wider than the event was.",
  ],
  "aug30-public": [
    "The source's stored TotalScore reads 0 for 11 players whose round scores really sum to 12–36. Nothing on this page reads that column.",
    "26 of 26 zero cells in the export are rounds nobody attempted. No played round in this event scored 0.",
    "The file name says 30 August; every row in it is dated the 29th. Unresolved — both are recorded as they are.",
  ],
  "aicd": [
    "All five 10s in the whole dataset are in this event, and none of them carries a judge comment — nothing on record explains what earns one.",
  ],
  "ai-skills-fest": [
    "The single genuine zero in all 556 submissions is here: a 1,400-character, well-structured round-2 prompt scored 0 with no comment. That is a judge failure, not a verdict, and it is the one 0 on this page that is a real mark.",
  ],
};

// Findings from `calibration.json` — 294 judged rows from the two events that
// recorded what the judge said. Measured, not inferred, and about the OLD judge:
// the live arena's judge is a different thing and is measured separately below.
const LEGACY_JUDGE_FINDINGS = [
  {
    headline: "The judge was applying two rubrics under one number",
    detail:
      "52 of 294 comments score the prompt on whether it looks machine-written rather than on whether it is a good prompt. Those rows average 2.94 against 5.43 for everything else, which directly contradicts the rest of the rubric — it rewards detail and specificity. The cleanest proof is one player, five minutes apart: a polished 621-character image prompt scored 3 (\u201creads AI-like due to perfect grammar and structure\u201d), and their rougher 470-character rewrite of it scored 7. If AI authorship matters it needs its own flag, never folded into the quality score.",
    severity: "bad",
  },
  {
    headline: "Round 5 was never judged",
    detail:
      "All 48 round-5 rows across the two commented events carry a score and comment byte-identical to the same player's round 4, while the round-5 question and prompt are different — 41 of 41 and 7 of 7. No other round pair shares a single comment. Excluded from every number on this page.",
    severity: "bad",
  },
  {
    headline: "Near-identical prompts scored three or more apart",
    detail:
      "11 pairs on the same question. A broken three-word fragment scored 4 against a complete on-task sentence scored 3; an identical one-line prompt scored 1 for one player and 5 for two others.",
    severity: "warn",
  },
  {
    headline: "No rule for the most obvious failure mode",
    detail:
      "7 submissions that are the challenge question pasted straight back were scored 1, 3 and 5. Two identical echoes of the same question got 1 and 5.",
    severity: "warn",
  },
  {
    headline: "The judge leaked its own prompt template to players",
    detail:
      "14 comments end with a literal \u201cHis/her name: \u2026\u201d clause. A further 66 address the player by the alias they typed at signup, which for many is a placeholder — one player is coached by the name \u201cStar Wars\u201d, another as \u201css\u201d.",
    severity: "warn",
  },
  {
    headline: "Non-English answers did not score worse",
    detail:
      "63 of 556 submissions are in Arabic script and average 5.60 against 4.87 for Latin-only. Detection is by Unicode range only, so that 63 is a floor — Arabic written in Latin letters is counted as English here. The judge wrote its comments in English regardless, and at least one Arabic submission was told to \u201cconsider using English for broader understanding\u201d while being scored normally.",
    severity: "ok",
  },
  {
    headline: "The dip at 5 is in all six events",
    detail:
      "The pooled distribution piles at 4, dips at 5 and rebounds at 6. Every one of the six has fewer 5s than 4s. The rebound at 6 and the second bump at 9 appear only in the two commented events, so the tri-modal shape belongs to that judge configuration and not to PromptArena generally.",
    severity: "info",
  },
];

// ============================================================================
// Reading the data
// ============================================================================
//
// Eight sources, and the page has to be honest about all four ways one can fail.
// PostgREST distinguishes them if you look:
//
//   missing   the view does not exist — PGRST205, or 42P01 from Postgres.
//             Today this is the answer for everything in the proposed 0030.
//   blocked   the object exists and this role has no grant on it — 42501, or
//             PGRST301 when the JWT is not what the row filter wanted.
//   empty     the query worked and returned nothing. The legacy tables are in
//             this state right now: 0029 is applied, the import has not run.
//   error     anything else, shown verbatim rather than swallowed.
//
// Collapsing these into "no rows" is the single most damaging thing this file
// could do, because "nobody matched a member" and "you were not allowed to ask"
// look identical once they are both a zero.

// Exported so the harness can drive `renderDashboard` with fixtures shaped like
// real query results rather than guessing at the keys.
//
// ⚠ EVERY SPEC MUST CARRY AN `order`, AND IT MUST BE A TOTAL KEY.
// `fetchAll` below walks these in pages of 1,000 with OFFSET/LIMIT
// (`.range(from, from + PAGE - 1)`). SQL gives an OFFSET no defined order
// unless the query has an ORDER BY, so without one the second page is not
// "the rows after the first page" — it is whatever the planner returned that
// time. Some rows come back twice and some never come back at all, and on a
// page whose entire purpose is counting submissions and players that is a
// wrong number with nothing to notice it by.
//
// It is invisible today only because every one of these is under 1,000 rows,
// which is exactly how it would ship and then go wrong later, quietly, on the
// first table that grows. `promptarena_submissions` grows without limit.
//
// This is the same defect migration 0028 paid for with `sort_id`; the fix is
// the same shape. The chosen column must be unique across the whole result —
// `id` for the base tables, the view's own key where the view aggregates.
export const SOURCE_SPECS = [
  {
    key: "submissions",
    name: "Live practice submissions",
    table: "promptarena_submissions",
    columns: "id,user_id,challenge_id,judge_status,score,judge_model,judge_version,judge_error,rubric_scores,submitted_at,judged_at",
    order: "id",
    granted: true,
    note: "Granted to authenticated in 0029; staff read every row through the \u201cstaff read\u201d policy.",
  },
  {
    key: "challenges",
    name: "Challenge deck",
    table: "promptarena_challenge_deck",
    columns: "id,title,difficulty,domain,target_audience,creativity,created_at",
    order: "id",
    granted: true,
    note: "Active challenges only, and no rubric — the deck's column list is the boundary and this page has no business behind it.",
  },
  {
    key: "legacyEvents",
    name: "The six legacy events",
    table: "promptarena_legacy_event_summary",
    columns: "id,slug,name,held_on,date_last,is_single_day,has_judge_comments,judging_note,player_count,submission_count,scored_count,invalid_count",
    order: "id",
    granted: true,
    note: "Counts only, no people. The one legacy route 0029 grants.",
  },
  {
    key: "calibration",
    name: "Judge calibration",
    table: "promptarena_challenge_calibration_staff",
    columns: "*",
    // One row per challenge, and the view renames `c.id` on the way out.
    order: "challenge_id",
    granted: false,
    note: "0029 builds promptarena_challenge_calibration and grants it to nobody. Without the staff wrapper this page recomputes what it can from submissions — everything except completion_rate, which needs times_served.",
  },
  {
    key: "legacyScores",
    name: "Legacy round scores",
    table: "promptarena_legacy_submission_validity",
    columns: "id,player_id,event_id,round_number,score,invalid_reason,matches_round5_artefact",
    order: "id",
    granted: false,
    note: "Needed for the legacy half of the score distribution. The underlying table has RLS on and no policy at all.",
  },
  {
    key: "legacyPlayers",
    name: "Legacy players and member matching",
    table: "promptarena_legacy_player_directory",
    columns: "*",
    // One row per legacy player ROW (159 of them, 152 people), keyed on the
    // underlying `promptarena_legacy_players.id` renamed to `player_id`.
    order: "player_id",
    granted: false,
    note: "This is the \u201clink that\u201d half of the ask. It carries contact details, so it must be staff-gated inside the database, not here.",
  },
  {
    key: "outreach",
    name: "Outreach segments",
    table: "promptarena_outreach_candidates",
    columns: "*",
    // The view is `select distinct on (email_key) …`, so `email_key` is unique
    // across the whole result by construction — one row per person.
    order: "email_key",
    granted: false,
    note: "Mirrors tools/promptarena-campaign/stage-campaign.sql so the dashboard and the campaign cannot disagree about who would be mailed.",
  },
  {
    key: "profiles",
    name: "Member profiles",
    table: "profiles",
    columns: "user_id,full_name,role,show_in_promptarena_ranking",
    order: "user_id",
    granted: true,
    note: "Names the live players and identifies the staff accounts that have to come out of any ranking.",
  },
];

function classifyError(error) {
  if (!error) return null;
  const code = String(error.code || "");
  const msg = String(error.message || "");
  if (code === "PGRST205" || code === "42P01" || /does not exist|schema cache/i.test(msg)) {
    return "missing";
  }
  if (code === "42501" || code === "PGRST301" || /permission denied|not authorized|JWT/i.test(msg)) {
    return "blocked";
  }
  return "error";
}

// PostgREST caps a response, so anything that could exceed one page is walked.
// The cap is real rather than notional — 556 legacy submissions is nothing, but
// live practice submissions grow without limit and a dashboard that silently
// shows the first thousand of them is a dashboard that lies quietly.
const PAGE = 1000;
const MAX_ROWS = 50000;

async function fetchAll(supabase, spec) {
  // ⚠ Refused rather than silently paged unordered. A spec with no `order` is
  // the defect described above, and the only way to keep it from coming back
  // is to make it impossible to add a source without one. This surfaces as a
  // named source in the "where the numbers came from" panel rather than as a
  // count that is quietly wrong.
  if (!spec.order) {
    return {
      status: "error",
      detail: "This source has no `order` in SOURCE_SPECS. Paging it would use OFFSET with no " +
        "ORDER BY, which has no defined row order past the first page — some rows would be " +
        "counted twice and others dropped. Give the spec a total key.",
      rows: [],
    };
  }

  const rows = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const q = supabase.from(spec.table).select(spec.columns)
      .order(spec.order, { ascending: true })
      .range(from, from + PAGE - 1);
    const { data, error } = await q;
    if (error) return { status: classifyError(error), detail: error.message, rows: [] };
    rows.push.apply(rows, data || []);
    if (!data || data.length < PAGE) {
      return { status: rows.length ? "ok" : "empty", detail: "", rows: rows, truncated: false };
    }
  }
  return { status: "ok", detail: "", rows: rows, truncated: true };
}

export async function loadSources(supabase) {
  const out = {};
  const results = await Promise.all(SOURCE_SPECS.map(s => fetchAll(supabase, s)));
  SOURCE_SPECS.forEach(function (spec, i) {
    out[spec.key] = Object.assign({ spec: spec }, results[i]);
  });
  return out;
}

// ============================================================================
// Turning eight query results into one model
// ============================================================================

const NBSP = "\u00a0";

function num(n) {
  if (n === null || n === undefined || (typeof n === "number" && !isFinite(n))) return "\u2014";
  return Number(n).toLocaleString("en-GB");
}
function dec(n, places) {
  if (n === null || n === undefined || n === "" || !isFinite(Number(n))) return "\u2014";
  return Number(n).toFixed(places === undefined ? 2 : places);
}
function pct(n) {
  if (n === null || n === undefined || !isFinite(Number(n))) return "\u2014";
  return (Number(n) * 100).toFixed(1) + "%";
}
function monthKey(iso) {
  return String(iso || "").slice(0, 7);
}
function monthLabel(ym) {
  const parts = String(ym).split("-");
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
  if (isNaN(d)) return ym;
  return d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
}
function shortDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ⚠ The one date rule on this page. `is_single_day = false` means the source
// list was reused over months, so there is no day to print — printing one tells
// most of july18's players they played on a day they did not.
function eventDateLabel(ev) {
  if (!ev.held_on && !ev.date_last) return { text: "no date recorded", doubt: false };
  if (ev.is_single_day) return { text: shortDate(ev.held_on), doubt: false };
  return {
    text: shortDate(ev.held_on) + NBSP + "\u2013" + NBSP + shortDate(ev.date_last),
    doubt: true,
  };
}

function caveatsFor(slug) {
  const key = String(slug || "").toLowerCase();
  const hit = Object.keys(EVENT_CAVEATS).find(k => key.indexOf(k) !== -1 || k.indexOf(key) !== -1);
  return hit ? EVENT_CAVEATS[hit] : [];
}

export function buildModel(sources) {
  const model = { sources: sources, warnings: [] };

  // ---- live practice -----------------------------------------------------
  const subs = sources.submissions.rows || [];
  const challenges = new Map();
  (sources.challenges.rows || []).forEach(c => challenges.set(c.id, c));
  const profiles = new Map();
  (sources.profiles.rows || []).forEach(p => profiles.set(p.user_id, p));

  const live = {
    status: sources.submissions.status,
    truncated: !!sources.submissions.truncated,
    total: subs.length,
    judged: 0,
    pending: 0,
    failed: 0,
    scoreSum: 0,
    scoreN: 0,
    histogram: new Array(11).fill(0),
    byMonth: new Map(),
    players: new Map(),
    byChallenge: new Map(),
    byJudge: new Map(),
    judgeErrors: [],
  };

  subs.forEach(function (s) {
    if (s.judge_status === "judged") live.judged++;
    else if (s.judge_status === "failed") live.failed++;
    else live.pending++;

    // ⚠ `score != null`, not `score`. A genuine 0 is falsy and would vanish from
    // the mean, the histogram and every count on the page.
    const scored = s.judge_status === "judged" && s.score !== null && s.score !== undefined;
    if (scored) {
      live.scoreSum += Number(s.score);
      live.scoreN++;
      const b = Math.max(0, Math.min(10, Math.round(Number(s.score))));
      live.histogram[b]++;
    }

    const ym = monthKey(s.submitted_at);
    if (ym) live.byMonth.set(ym, (live.byMonth.get(ym) || 0) + 1);

    let p = live.players.get(s.user_id);
    if (!p) {
      const prof = profiles.get(s.user_id) || null;
      p = {
        userId: s.user_id,
        name: prof ? prof.full_name : null,
        role: prof ? prof.role : null,
        optedIn: prof ? !!prof.show_in_promptarena_ranking : false,
        attempts: 0, judged: 0, sum: 0, best: null, challenges: new Set(), lastAt: null,
      };
      live.players.set(s.user_id, p);
    }
    p.attempts++;
    if (scored) {
      p.judged++;
      p.sum += Number(s.score);
      p.best = p.best === null ? Number(s.score) : Math.max(p.best, Number(s.score));
      p.challenges.add(s.challenge_id);
    }
    const at = s.judged_at || s.submitted_at;
    if (at && (!p.lastAt || at > p.lastAt)) p.lastAt = at;

    let c = live.byChallenge.get(s.challenge_id);
    if (!c) {
      c = { id: s.challenge_id, attempts: 0, completions: 0, sum: 0, scores: [], players: new Set(), hist: {} };
      live.byChallenge.set(s.challenge_id, c);
    }
    c.attempts++;
    c.players.add(s.user_id);
    if (scored) {
      c.completions++;
      c.sum += Number(s.score);
      c.scores.push(Number(s.score));
      const k = String(Math.round(Number(s.score)));
      c.hist[k] = (c.hist[k] || 0) + 1;
    }

    if (s.judge_status === "failed" && s.judge_error) {
      live.judgeErrors.push({ id: s.id, error: s.judge_error, at: s.submitted_at });
    }

    const jk = (s.judge_model || "unrecorded") + " " + (s.judge_version || "");
    let j = live.byJudge.get(jk);
    if (!j) { j = { key: jk, model: s.judge_model, version: s.judge_version, n: 0, sum: 0, scored: 0, failed: 0, first: null, last: null }; live.byJudge.set(jk, j); }
    j.n++;
    if (scored) { j.sum += Number(s.score); j.scored++; }
    if (s.judge_status === "failed") j.failed++;
    const jat = s.judged_at || s.submitted_at;
    if (jat) {
      if (!j.first || jat < j.first) j.first = jat;
      if (!j.last || jat > j.last) j.last = jat;
    }
  });

  live.mean = live.scoreN ? live.scoreSum / live.scoreN : null;
  live.playerCount = live.players.size;
  // Staff and admin accounts exercising the game are not competitors. Same
  // reasoning the legacy half applies to the account that produced 53 of one
  // event's 256 submissions: kept and flagged, never silently deleted.
  live.staffPlayerCount = Array.from(live.players.values())
    .filter(p => isStaffRole(p.role)).length;

  model.live = live;

  // ---- the six legacy events --------------------------------------------
  const evRows = (sources.legacyEvents.rows || []).slice();
  evRows.sort(function (a, b) { return String(a.held_on || "") < String(b.held_on || "") ? -1 : 1; });

  const legacy = {
    status: sources.legacyEvents.status,
    events: evRows.map(function (e) {
      const expected = MEASURED.byEvent[String(e.slug || "").toLowerCase()] || null;
      const notAttempted = Math.max(
        0,
        Number(e.submission_count || 0) - Number(e.scored_count || 0) - Number(e.invalid_count || 0)
      );
      return {
        id: e.id,
        slug: e.slug,
        name: e.name,
        date: eventDateLabel(e),
        isSingleDay: !!e.is_single_day,
        hasComments: !!e.has_judge_comments,
        note: e.judging_note,
        players: Number(e.player_count || 0),
        submissions: Number(e.submission_count || 0),
        scored: Number(e.scored_count || 0),
        invalid: Number(e.invalid_count || 0),
        notAttempted: notAttempted,
        expected: expected,
        caveats: caveatsFor(e.slug),
      };
    }),
  };
  legacy.playerRows = legacy.events.reduce((a, e) => a + e.players, 0);
  legacy.submissions = legacy.events.reduce((a, e) => a + e.submissions, 0);
  legacy.scored = legacy.events.reduce((a, e) => a + e.scored, 0);
  legacy.invalid = legacy.events.reduce((a, e) => a + e.invalid, 0);
  legacy.notAttempted = legacy.events.reduce((a, e) => a + e.notAttempted, 0);

  // Per-round legacy scores, if the staff view exists. Without it the legacy
  // half of the score distribution is not "zero" — it is unavailable, and the
  // histogram says so instead of drawing an empty legacy series.
  const lscores = sources.legacyScores.rows || [];
  if (sources.legacyScores.status === "ok") {
    const hist = new Array(11).fill(0);
    let sum = 0, n = 0, excluded = 0, unattempted = 0, flagMismatch = 0;
    lscores.forEach(function (r) {
      const invalid = r.invalid_reason !== null && r.invalid_reason !== undefined;
      if (invalid !== !!r.matches_round5_artefact) flagMismatch++;
      if (invalid || r.matches_round5_artefact) { excluded++; return; }
      if (r.score === null || r.score === undefined) { unattempted++; return; }
      const b = Math.max(0, Math.min(10, Math.round(Number(r.score))));
      hist[b]++; sum += Number(r.score); n++;
    });
    legacy.histogram = hist;
    legacy.scoreN = n;
    legacy.mean = n ? sum / n : null;
    legacy.excludedRows = excluded;
    legacy.unattemptedRows = unattempted;
    legacy.flagMismatch = flagMismatch;
    if (flagMismatch > 0) {
      model.warnings.push(
        flagMismatch + " legacy rows disagree between the stored invalid_reason flag and the " +
        "round-5 artefact test. Both are applied, so no fabricated verdict is being counted \u2014 " +
        "but the importer and 0029 have drifted apart and that needs looking at."
      );
    }
  } else {
    legacy.histogram = null;
  }

  // ---- people, matching and outreach -------------------------------------
  const players = sources.legacyPlayers.rows || [];
  const people = {
    status: sources.legacyPlayers.status,
    rows: players,
    distinct: new Set(players.map(p => p.email_key || p.player_id)).size,
    member: 0, prospect: 0, unmatched: 0,
    clubMailbox: 0, demoAccounts: 0, wroteArabic: 0,
  };
  players.forEach(function (p) {
    if (p.match_state === "member") people.member++;
    else if (p.match_state === "prospect") people.prospect++;
    else people.unmatched++;
    if (p.is_club_mailbox) people.clubMailbox++;
    if (p.is_demo_account) people.demoAccounts++;
    if (p.wrote_in_arabic) people.wroteArabic++;
  });
  model.people = people;

  const cand = sources.outreach.rows || [];
  const EXCLUSIONS = [
    ["excl_no_contact_row", "No marketing_contacts row", "campaign_recipients.contact_id is a NOT NULL foreign key, so there is no route to mail them at all until a contact row is created. That is a decision, not plumbing \u2014 stage-campaign.sql Part 5."],
    ["excl_unsubscribed", "Unsubscribed", "They asked not to be mailed."],
    ["excl_bounced", "Bounced before", "Mailing a known bounce is what costs the sending domain."],
    ["excl_test", "Test record", "Flagged is_test in marketing_contacts."],
    ["excl_invalid_email", "Address marked invalid", "email_valid is false on their contact row."],
    ["excl_member", "Already has an account", "Linked legacy row, linked contact row, or an account under the same address. They need the other letter \u2014 the one that says their rating is already on their dashboard."],
    ["excl_club_mailbox", "Has a club mailbox", "@sahabaclub.com is provisioned by the club, so they are one of us. This removes both long-format events entirely \u2014 every one of their players is at that domain."],
    ["excl_demo_account", "Demo or staff account", "More than 15 rounds in one event. This is the account that produced 53 of july18's 256 submissions."],
  ];
  const outreach = {
    status: sources.outreach.status,
    rows: cand,
    total: cand.length,
    scored: cand.filter(c => c.segment === "scored").length,
    registeredOnly: cand.filter(c => c.segment === "registered_only").length,
    wroteButUnscored: cand.filter(c => !c.segment).length,
    mailable: cand.filter(c => c.would_be_mailed).length,
    exclusions: EXCLUSIONS.map(function (e) {
      return { key: e[0], label: e[1], why: e[2], n: cand.filter(c => !!c[e[0]]).length };
    }),
  };
  outreach.mailableScored = cand.filter(c => c.would_be_mailed && c.segment === "scored").length;
  outreach.mailableRegistered = cand.filter(c => c.would_be_mailed && c.segment === "registered_only").length;
  model.outreach = outreach;

  // ⚠ The check stage-campaign.sql asks for by name: "if that number is large,
  // the import nulled real scores and this campaign should not go out".
  if (outreach.status === "ok" && outreach.wroteButUnscored > 10) {
    model.warnings.push(
      outreach.wroteButUnscored + " people wrote prompts and have no score at all. The measurement " +
      "says that should be close to zero, and a large number here means the import nulled real " +
      "scores \u2014 most likely by acting on the refuted \u201ctwo events were never judged\u201d premise. " +
      "Do not send the return campaign until this is explained."
    );
  }

  // ⚠ The alarm that has to be loud, because the failure it catches is silent.
  //
  // If the row count matches the measurement, every one of those rows is a
  // round somebody played — and the measurement found no played round anywhere
  // with a prompt and no score. So a shortfall in marks against 508 is not a
  // quirk of the export: it is real marks having been nulled on the way in,
  // which is exactly what obeying the refuted "two events were never judged"
  // premise does. It costs roughly 60 people their result and it renders as a
  // perfectly healthy-looking dashboard.
  if (legacy.status === "ok"
      && legacy.submissions === MEASURED.submissions
      && legacy.scored < MEASURED.expectedMarks) {
    model.warnings.push(
      "The six events imported all " + MEASURED.submissions + " rounds but only " +
      num(legacy.scored) + " marks, against " + MEASURED.expectedMarks + " measured in the source " +
      "workbooks (" + MEASURED.submissions + " played rounds less the " + MEASURED.invalidRound5Rows +
      " copied round-5 verdicts). " + num(MEASURED.expectedMarks - legacy.scored) + " real marks are " +
      "missing. The likeliest cause is an importer acting on the refuted claim that Aug 30 and Cairo " +
      "AWS TechUp were never judged and nulling their scores. Do not send the return campaign, and do " +
      "not quote a number off this page, until this is explained."
    );
  }

  model.legacy = legacy;
  return model;
}

// ============================================================================
// Rendering
// ============================================================================

function el(id) { return document.getElementById(id); }
function set(id, html) { const n = el(id); if (n) n.innerHTML = html; }

// The four unreadable states, in one place, so no section invents its own way
// of saying "there is nothing here".
function unavailable(src, whatFor) {
  const s = src.status;
  const spec = src.spec;
  if (s === "empty") {
    return '<div class="ad-empty"><strong>Nothing imported yet.</strong><br>' +
      "<span style=\"font-size:13px\">" + escapeHtml(spec.name) + " is readable and returned no rows. " +
      "The six events have not been imported; 0029 is applied but the tables are empty. " +
      "This is an empty database, not a result.</span></div>";
  }
  if (s === "missing") {
    return '<div class="ad-empty"><strong>' + escapeHtml(whatFor) + " needs a database view that does not exist yet.</strong><br>" +
      '<span style="font-size:13px">Missing: <code class="pa-code">public.' + escapeHtml(spec.table) + "</code>. " +
      escapeHtml(spec.note) + ' The proposed definition is in <code class="pa-code">tools/promptarena-dashboard/0030_promptarena_admin_views.proposed.sql</code>, ' +
      "which is deliberately not a migration and has not been applied.</span></div>";
  }
  if (s === "blocked") {
    return '<div class="ad-empty"><strong>Refused by the database.</strong><br>' +
      '<span style="font-size:13px"><code class="pa-code">public.' + escapeHtml(spec.table) + "</code> exists, and this account may not read it. " +
      "That is the database enforcing staff access, not the page. " + escapeHtml(src.detail || "") + "</span></div>";
  }
  return '<div class="ad-empty"><strong>Query failed.</strong><br><span style="font-size:13px">' +
    escapeHtml(spec.table) + ": " + escapeHtml(src.detail || "unknown error") + "</span></div>";
}

function statusPill(s) {
  if (s === "ok") return '<span class="ad-pill ok">reading</span>';
  if (s === "empty") return '<span class="ad-pill muted">empty</span>';
  if (s === "missing") return '<span class="ad-pill warn">not created</span>';
  if (s === "blocked") return '<span class="ad-pill danger">no access</span>';
  return '<span class="ad-pill danger">error</span>';
}

function renderSources(model) {
  const html = SOURCE_SPECS.map(function (spec) {
    const src = model.sources[spec.key];
    const n = (src.rows || []).length;
    return '<div class="pa-source">' +
      '<div class="pa-source-top">' + statusPill(src.status) +
      '<span class="pa-source-name">' + escapeHtml(spec.name) + "</span>" +
      (src.status === "ok" ? '<span class="ad-cell-dim">' + num(n) + (src.truncated ? "+" : "") + " rows</span>" : "") +
      "</div>" +
      '<div class="pa-source-note"><code class="pa-code">' + escapeHtml(spec.table) + "</code><br>" +
      escapeHtml(spec.note) + "</div>" +
      "</div>";
  }).join("");
  set("pa-sources", html);
}

function tile(label, value, halves, sub, unknown) {
  return '<div class="pa-tile">' +
    '<div class="pa-tile-label">' + escapeHtml(label) + "</div>" +
    '<div class="pa-tile-value' + (unknown ? " is-unknown" : "") + '">' + value + "</div>" +
    (halves && halves.length
      ? '<div class="pa-tile-split">' + halves.map(h =>
          '<span class="pa-tile-half"><span class="pa-src ' + h.cls + '">' + escapeHtml(h.tag) + "</span> <b>" + h.value + "</b></span>"
        ).join("") + "</div>"
      : "") +
    (sub ? '<div class="pa-tile-sub">' + sub + "</div>" : "") +
    "</div>";
}

function renderOverview(model) {
  const live = model.live;
  const legacy = model.legacy;
  const people = model.people;

  const legacyKnown = legacy.status === "ok";
  const peopleKnown = people.status === "ok";

  const playersValue = peopleKnown
    ? num(live.playerCount + people.distinct)
    : (live.status === "ok" ? num(live.playerCount) + " + ?" : "?");

  const tiles = [
    tile("People who have played", playersValue,
      [
        { cls: "is-live", tag: "live", value: live.status === "ok" ? num(live.playerCount) : "\u2014" },
        { cls: "is-legacy", tag: "events", value: peopleKnown ? num(people.distinct) : "not readable" },
      ],
      peopleKnown
        ? "Deduplicated on lowercased email. Only one person in the six events played more than one of them."
        : "The measurement says 152 distinct people across the six events. This tile cannot confirm it until the player directory is readable.",
      !peopleKnown),

    tile("Submissions", num((live.status === "ok" ? live.total : 0) + (legacyKnown ? legacy.submissions : 0)),
      [
        { cls: "is-live", tag: "live", value: live.status === "ok" ? num(live.total) : "\u2014" },
        { cls: "is-legacy", tag: "events", value: legacyKnown ? num(legacy.submissions) : "\u2014" },
      ],
      "Legacy counts every exported round including those flagged invalid; the marks are counted separately below."),

    tile("Marks that exist", num((live.scoreN || 0) + (legacyKnown ? legacy.scored : 0)),
      [
        { cls: "is-live", tag: "live", value: num(live.scoreN || 0) },
        { cls: "is-legacy", tag: "events", value: legacyKnown ? num(legacy.scored) : "\u2014" },
      ],
      "A round nobody attempted has <em>no mark</em>, not a zero. " +
      (legacyKnown ? num(legacy.notAttempted) + " legacy rounds were never attempted and " +
        num(legacy.invalid) + " carry a fabricated verdict; neither is counted here." : "")),

    tile("Mean score", live.mean !== null ? dec(live.mean, 2) : (legacyKnown && legacy.mean != null ? dec(legacy.mean, 2) : "\u2014"),
      [
        { cls: "is-live", tag: "live", value: live.mean !== null ? dec(live.mean, 2) : "\u2014" },
        { cls: "is-legacy", tag: "events", value: legacy.mean != null ? dec(legacy.mean, 2) : "not readable" },
      ],
      "Out of 10. The six events measured 4.95 overall, all six means inside a 0.5-point band \u2014 which is the strongest evidence that one configured judge scored all of them."),

    tile("Events", num((legacyKnown ? legacy.events.length : 0)) + (live.status === "ok" ? " + always-on" : ""),
      [
        { cls: "is-legacy", tag: "events", value: legacyKnown ? num(legacy.events.length) : "\u2014" },
        { cls: "is-live", tag: "live", value: "practice mode" },
      ],
      "Six Microsoft Forms rounds, plus the practice mode that never ends."),

    tile("Waiting on the judge", num(live.pending + live.failed),
      [
        { cls: "is-live", tag: "pending", value: num(live.pending) },
        { cls: "is-live", tag: "failed", value: num(live.failed) },
      ],
      live.failed > 0
        ? '<strong style="color:var(--ad-danger)">' + num(live.failed) + " judge failures.</strong> A failed attempt stays visible to the member as unjudged and can be retried by the service role."
        : "No judge failures on record."),
  ].join("");

  set("pa-tiles", tiles);

  // ---- score distribution ------------------------------------------------
  const liveH = live.histogram;
  const legH = legacy.histogram;
  const max = Math.max(1, ...liveH, ...(legH || [0]));
  let bars = "";
  for (let i = 0; i <= 10; i++) {
    const l = liveH[i], g = legH ? legH[i] : 0;
    const total = l + g;
    bars += '<div class="pa-hist-col' + (i === 0 ? " is-zero" : "") + '">' +
      '<div class="pa-hist-n">' + (total ? num(total) : "") + "</div>" +
      '<div class="pa-hist-bars" style="height:' + Math.round((total / max) * 118) + 'px">' +
        (g ? '<div class="pa-hist-bar is-legacy" style="flex:' + g + '"></div>' : "") +
        (l ? '<div class="pa-hist-bar is-live" style="flex:' + l + '"></div>' : "") +
      "</div>" +
      '<div class="pa-hist-x">' + i + "</div>" +
      "</div>";
  }
  set("pa-hist", bars);
  set("pa-hist-legend",
    '<div class="pa-legend">' +
      '<span><span class="pa-swatch is-live"></span> Live practice (' + num(live.scoreN) + " marks)</span>" +
      '<span><span class="pa-swatch is-legacy"></span> Six events (' +
        (legH ? num(legacy.scoreN) + " marks" : "not readable \u2014 needs the legacy round-score view") + ")</span>" +
    "</div>");

  set("pa-hist-caveat",
    caveat("The 0 column is a mark, not an absence.",
      "A round nobody attempted has a null score and appears in no column here. There is exactly one genuine zero in all 556 legacy submissions \u2014 a strong round-2 prompt in AI Skills Fest that the judge scored 0 with no comment. " +
      (legH ? num(legacy.unattemptedRows) + " unattempted legacy rounds and " + num(legacy.excludedRows) + " rows with a fabricated verdict are excluded from this chart." : "")));

  // ---- activity over time ------------------------------------------------
  const months = Array.from(live.byMonth.keys()).sort();
  if (!months.length) {
    set("pa-activity", '<div class="ad-empty">No live practice submissions yet, so there is no activity to plot. ' +
      "The six events are shown as a range on the Events tab; they carry one registration timestamp per player, not a play time, so they cannot be plotted as activity.</div>");
  } else {
    const maxM = Math.max(...months.map(m => live.byMonth.get(m)));
    const cols = months.map(function (m) {
      const n = live.byMonth.get(m);
      return '<div class="pa-spark-col" title="' + escapeHtml(monthLabel(m) + ": " + n + " submissions") + '">' +
        '<div class="pa-spark-bar" style="height:' + Math.round((n / maxM) * 96) + 'px"></div></div>';
    }).join("");
    set("pa-activity",
      '<div class="pa-spark">' + cols + "</div>" +
      '<div class="pa-spark-axis"><span>' + escapeHtml(monthLabel(months[0])) + "</span>" +
      "<span>" + num(live.total) + " live submissions, peak " + num(maxM) + " in a month</span>" +
      "<span>" + escapeHtml(monthLabel(months[months.length - 1])) + "</span></div>");
  }
}

function caveat(strongText, rest, kind) {
  return '<div class="pa-caveat' + (kind === "info" ? " is-info" : "") + '">' +
    '<span class="pa-caveat-mark" aria-hidden="true">' + (kind === "info" ? "i" : "!") + "</span>" +
    "<span><strong>" + escapeHtml(strongText) + "</strong> " + rest + "</span></div>";
}

function renderEvents(model) {
  const legacy = model.legacy;
  if (legacy.status !== "ok") {
    set("pa-events", unavailable(model.sources.legacyEvents, "The per-event breakdown"));
    set("pa-recon", "");
    return;
  }

  const rows = legacy.events.map(function (e) {
    const caveatCount = e.caveats.length;
    const dateCell = e.date.doubt
      ? '<span class="pa-doubt" title="This event has no single date. The source list was reused over months, so this is a range of row timestamps, not the day it was held.">' +
        escapeHtml(e.date.text) + '</span><span class="pa-doubt-mark">!</span>'
      : escapeHtml(e.date.text || "\u2014");

    const expected = e.expected;
    const playersOff = expected && expected.players !== e.players;
    const subsOff = expected && expected.submissions !== e.submissions;

    return "<tr>" +
      '<td class="ad-cell-strong">' + escapeHtml(e.name || e.slug) +
        '<div class="ad-cell-dim"><code class="pa-code">' + escapeHtml(e.slug) + "</code></div></td>" +
      "<td>" + dateCell +
        (e.isSingleDay ? "" : '<div class="ad-cell-dim">not a single day</div>') + "</td>" +
      '<td class="ad-num">' + num(e.players) +
        (playersOff ? '<div class="pa-recon-bad" style="font-size:11.5px">expected ' + num(expected.players) + "</div>" : "") + "</td>" +
      '<td class="ad-num">' + num(e.submissions) +
        (subsOff ? '<div class="pa-recon-bad" style="font-size:11.5px">expected ' + num(expected.submissions) + "</div>" : "") + "</td>" +
      '<td class="ad-num">' + num(e.scored) + "</td>" +
      '<td class="ad-num pa-null" title="Rounds nobody attempted. These have no score at all and must never be read as zeros.">' +
        (e.notAttempted ? num(e.notAttempted) : "\u2014") + "</td>" +
      '<td class="ad-num">' + (e.invalid
        ? '<span class="ad-pill danger">' + num(e.invalid) + " excluded</span>"
        : '<span class="ad-cell-dim">none</span>') + "</td>" +
      "<td>" + (e.hasComments
        ? '<span class="ad-pill ok">yes</span>'
        : '<span class="ad-pill muted" title="This export format has no comment column at all, so a missing comment says nothing about the player\'s round.">no column</span>') + "</td>" +
      "<td>" + (caveatCount
        ? '<span class="ad-pill warn">' + caveatCount + " caveat" + (caveatCount > 1 ? "s" : "") + "</span>"
        : '<span class="ad-cell-dim">\u2014</span>') + "</td>" +
      "</tr>" +
      (caveatCount || e.note
        ? '<tr><td colspan="9" style="padding-top:0">' +
          (e.note ? caveat("From the import:", escapeHtml(e.note), "info") : "") +
          e.caveats.map((c, i) => caveat(
            i === 0 ? "Read this before quoting a number on this event." : "And:",
            escapeHtml(c))).join("") +
          "</td></tr>"
        : "");
  }).join("");

  set("pa-events",
    caveat("All six events were judged.",
      "An earlier brief claimed two of them never were and that every score in them is 0. That was measured against the six workbooks and refuted. Every 0 in those two events is a round nobody attempted \u2014 26 of 26 and 238 of 238 \u2014 and no played round in either scored 0. Acting on the old premise destroys roughly 60 real people's real marks.") +
    caveat("No total on this page comes from the source's own total column.",
      "53 players' stored <code class=\"pa-code\">TotalScore</code> reads 0 while their round scores really sum to 12\u201336. Every total here is summed from the round scores.") +
    '<div class="ad-tablewrap"><table class="ad-table">' +
    "<thead><tr><th>Event</th><th>Dates</th><th class=\"ad-num\">Players</th><th class=\"ad-num\">Rounds</th>" +
    "<th class=\"ad-num\">Marks</th><th class=\"ad-num\">Not attempted</th><th class=\"ad-num\">Invalid</th>" +
    "<th>Judge comments</th><th>Caveats</th></tr></thead><tbody>" + rows + "</tbody></table></div>");

  // ---- reconciliation ----------------------------------------------------
  const checks = [
    ["Events", legacy.events.length, MEASURED.events],
    ["Player rows", legacy.playerRows, MEASURED.playerRows],
    ["Submissions (all exported rounds)", legacy.submissions, MEASURED.submissions],
    ["Rows with a fabricated round-5 verdict", legacy.invalid, MEASURED.invalidRound5Rows],
    ["Marks, after excluding those 48", legacy.scored, MEASURED.expectedMarks],
  ];
  if (model.people.status === "ok") checks.push(["Distinct people", model.people.distinct, MEASURED.people]);
  if (model.people.status === "ok") checks.push(["People on a club mailbox", model.people.clubMailbox, MEASURED.clubMailboxRows]);
  if (model.outreach.status === "ok") {
    // ⚠ Both of these are AFTER exclusions, because that is what the ~86 and
    // ~33 in stage-campaign.sql are counts of. Comparing a pre-exclusion figure
    // against them would report a healthy import as broken every time.
    checks.push(["Scored, and mailable after exclusions", model.outreach.mailableScored, MEASURED.expectedScoredSegment]);
    checks.push(["Registered only, and mailable after exclusions", model.outreach.mailableRegistered, MEASURED.expectedRegisteredOnly]);
  }

  const reconRows = checks.map(function (c) {
    const actual = c[1], expect = c[2];
    const empty = actual === 0;
    const ok = actual === expect;
    return "<tr>" +
      "<td>" + escapeHtml(c[0]) + "</td>" +
      '<td class="ad-num">' + num(expect) + "</td>" +
      '<td class="ad-num">' + (empty ? '<span class="pa-recon-wait">nothing imported</span>' : num(actual)) + "</td>" +
      "<td>" + (empty
        ? '<span class="ad-pill muted">waiting</span>'
        : ok ? '<span class="ad-pill ok">matches</span>'
             : '<span class="ad-pill danger">off by ' + num(Math.abs(actual - expect)) + "</span>") + "</td>" +
      "</tr>";
  }).join("");

  set("pa-recon",
    caveat("These are not results.",
      "The expected column is the measurement taken from the six source workbooks before any of this was imported (written up at <code class=\"pa-code\">C:\\sctools\\promptarena-data\\README.md</code>). It is here so a broken import is visible immediately \u2014 an import that lands 26 scored players instead of 86 looks exactly like a working dashboard otherwise.", "info") +
    '<div class="ad-tablewrap"><table class="ad-table"><thead><tr><th>Check</th>' +
    '<th class="ad-num">Measured from source</th><th class="ad-num">In the database</th><th>Verdict</th>' +
    "</tr></thead><tbody>" + reconRows + "</tbody></table></div>");
}

function renderPeople(model, opts) {
  const people = model.people;
  if (people.status !== "ok") {
    set("pa-match", unavailable(model.sources.legacyPlayers, "Matching players to members"));
    set("pa-match-tiles", "");
    return;
  }

  set("pa-match-tiles",
    '<div class="pa-segs">' +
    '<div class="pa-seg"><div class="pa-seg-n">' + num(people.member) + "</div>" +
      '<div class="pa-seg-t">Already club members</div>' +
      '<div class="pa-seg-d">Linked on import, or they signed up later with the same address. Three routes are checked, because any one alone leaves a hole.</div></div>' +
    '<div class="pa-seg"><div class="pa-seg-n">' + num(people.prospect) + "</div>" +
      '<div class="pa-seg-t">Have a prospect profile</div>' +
      '<div class="pa-seg-d">The club has already written them up (0027) but they have never claimed it.</div></div>' +
    '<div class="pa-seg is-target"><div class="pa-seg-n">' + num(people.unmatched) + "</div>" +
      '<div class="pa-seg-t">Neither \u2014 outreach</div>' +
      '<div class="pa-seg-d">No account, no prospect profile. Their prior engagement is the hook; see the Outreach tab.</div></div>' +
    "</div>");

  const showDemo = opts && opts.includeDemo;
  const rows = people.rows
    .slice()
    .sort(function (a, b) { return (b.total_score || 0) - (a.total_score || 0); })
    .filter(function (p) { return showDemo || !p.is_demo_account; })
    .map(function (p) {
      const pill = p.match_state === "member"
        ? '<span class="ad-pill ok">member</span>'
        : p.match_state === "prospect"
          ? '<span class="ad-pill tier-standard">prospect</span>'
          : '<span class="ad-pill warn">not with us</span>';
      return "<tr>" +
        '<td class="ad-cell-strong">' + escapeHtml(p.full_name || "(no name)") +
          (p.is_demo_account ? ' <span class="ad-pill danger" title="More than 15 rounds in one event \u2014 a demo or staff account, not a guest. Excluded from rankings.">demo</span>' : "") +
          (p.is_club_mailbox ? ' <span class="ad-pill muted">club mailbox</span>' : "") + "</td>" +
        '<td class="pa-contact">' + escapeHtml(p.email || "\u2014") +
          (p.mobile ? '<br><span class="ad-cell-dim">' + escapeHtml(p.mobile) + "</span>" : "") + "</td>" +
        "<td>" + pill +
          (p.matched_member_name ? '<div class="ad-cell-dim">' + escapeHtml(p.matched_member_name) + "</div>" : "") + "</td>" +
        '<td class="ad-cell-dim">' + escapeHtml(p.event_name || p.event_slug || "\u2014") + "</td>" +
        '<td class="ad-num">' + num(p.rounds_played) + "</td>" +
        '<td class="ad-num">' + (p.scored_rounds > 0 ? dec(p.total_score, 1) : '<span class="pa-null" title="No mark exists. They registered and wrote nothing \u2014 this is not a zero.">no mark</span>') + "</td>" +
        '<td class="ad-num">' + (p.best_score === null || p.best_score === undefined ? '<span class="pa-null">\u2014</span>' : dec(p.best_score, 1)) + "</td>" +
        "<td>" + (p.wrote_in_arabic ? '<span class="ad-pill muted">Arabic</span>' : "") + "</td>" +
        "</tr>";
    }).join("");

  set("pa-match",
    caveat("Every number in this table is recomputed from the round scores.",
      "The stored total is 0 for 53 of these people and it is wrong for all 53. Round-5 rows carrying a copied verdict are excluded, so a total here can be lower than the source's.") +
    (people.demoAccounts && !showDemo
      ? caveat(num(people.demoAccounts) + " demo or staff account" + (people.demoAccounts > 1 ? "s are" : " is") + " hidden.",
          "More than 15 rounds in a single event. One of them produced 53 of july18's 256 submissions including 26 attempts at round 1, which distorts any ranking. Tick the box above to show them.")
      : "") +
    '<div class="ad-tablewrap"><table class="ad-table"><thead><tr>' +
    "<th>Player</th><th>Contact</th><th>With us?</th><th>Event</th>" +
    '<th class="ad-num">Rounds</th><th class="ad-num">Total</th><th class="ad-num">Best</th><th>Language</th>' +
    "</tr></thead><tbody>" + (rows || '<tr><td colspan="8" class="ad-empty">No players.</td></tr>') + "</tbody></table></div>");
}

function renderOutreach(model) {
  const o = model.outreach;
  if (o.status !== "ok") {
    set("pa-outreach", unavailable(model.sources.outreach, "The outreach list"));
    set("pa-outreach-tiles", "");
    return;
  }

  set("pa-outreach-tiles",
    '<div class="pa-segs">' +
    '<div class="pa-seg is-target"><div class="pa-seg-n">' + num(o.mailableScored) + "</div>" +
      '<div class="pa-seg-t">Scored \u2014 would be mailed</div>' +
      '<div class="pa-seg-d">They played and have a real mark. Their own number goes in the subject line: \u201cYou scored N in PromptArena. Beat it?\u201d ' +
      num(o.scored) + " have a score before exclusions.</div></div>" +
    '<div class="pa-seg is-target"><div class="pa-seg-n">' + num(o.mailableRegistered) + "</div>" +
      '<div class="pa-seg-t">Registered only \u2014 would be mailed</div>' +
      '<div class="pa-seg-d">They took a seat and wrote nothing. Their letter claims no score and no turn, because neither exists. ' +
      num(o.registeredOnly) + " qualify before exclusions.</div></div>" +
    '<div class="pa-seg"><div class="pa-seg-n">' + num(o.wroteButUnscored) + "</div>" +
      '<div class="pa-seg-t">Wrote, but has no mark</div>' +
      '<div class="pa-seg-d">In neither segment on purpose \u2014 they would have to be told a number we do not have. If this is large, the import nulled real scores.</div></div>' +
    "</div>");

  const exclRows = o.exclusions.map(function (e) {
    return '<div class="pa-excl-row"><div>' + escapeHtml(e.label) +
      '<div class="pa-excl-why">' + escapeHtml(e.why) + "</div></div>" +
      '<div class="pa-excl-n">' + num(e.n) + "</div></div>";
  }).join("");

  const rows = o.rows
    .slice()
    .sort(function (a, b) {
      if (a.would_be_mailed !== b.would_be_mailed) return a.would_be_mailed ? -1 : 1;
      return (b.total_score || 0) - (a.total_score || 0);
    })
    .map(function (c) {
      const why = o.exclusions.filter(e => !!c[e.key]).map(e => e.label);
      // ⚠ The hook Ahmed asked for: "hot topic is the previous engagement".
      // Rendered as the sentence it is, from that person's own rows, so nobody
      // has to reconstruct it from four columns.
      const hook = c.segment === "scored"
        ? "Played " + (c.rounds_played === 1 ? "one round" : c.rounds_played + " rounds") +
          " at " + (c.event_name || "one of our events") + " and scored " + dec(c.total_score, 1) +
          (c.best_score != null ? ", best round " + dec(c.best_score, 1) + "/10" : "") + "."
        : c.segment === "registered_only"
          ? "Registered at " + (c.event_name || "one of our events") + " and never got a prompt in. Nothing to defend."
          : "Wrote " + c.rounds_played + " prompt" + (c.rounds_played === 1 ? "" : "s") + " and has no mark on record.";
      return "<tr>" +
        '<td class="ad-cell-strong">' + escapeHtml(c.full_name || c.contact_full_name || "(no name)") + "</td>" +
        '<td class="pa-contact">' + escapeHtml(c.email || "\u2014") + "</td>" +
        "<td>" + (c.segment
          ? '<span class="ad-pill ' + (c.segment === "scored" ? "tier-premium" : "tier-standard") + '">' + escapeHtml(c.segment) + "</span>"
          : '<span class="ad-pill muted">neither</span>') + "</td>" +
        '<td class="ad-cell-dim">' + escapeHtml(hook) + "</td>" +
        "<td>" + (c.would_be_mailed
          ? '<span class="ad-pill ok">would be mailed</span>'
          : '<span class="ad-pill muted">excluded</span><div class="ad-cell-dim">' + escapeHtml(why.join(", ") || "no segment") + "</div>") + "</td>" +
        "</tr>";
    }).join("");

  set("pa-outreach",
    caveat("This screen sends nothing and cannot.",
      "It shows what <code class=\"pa-code\">tools/promptarena-campaign/stage-campaign.sql</code> would target, using that file's own segment and exclusion definitions rather than a second set that could drift from it. Staging drafts and approving them happens on the Campaigns screen, one letter at a time, and nothing is ever created already approved.") +
    '<h3 style="font-size:14px;margin:18px 0 8px">Why the list is smaller than the guest list</h3>' +
    '<div class="pa-excl">' + exclRows + "</div>" +
    '<h3 style="font-size:14px;margin:22px 0 8px">' + num(o.total) + " people, " + num(o.mailable) + " of them mailable</h3>" +
    '<div class="ad-tablewrap"><table class="ad-table"><thead><tr>' +
    "<th>Person</th><th>Contact</th><th>Segment</th><th>Their prior engagement</th><th>Campaign</th>" +
    "</tr></thead><tbody>" + (rows || '<tr><td colspan="5" class="ad-empty">Nobody.</td></tr>') + "</tbody></table></div>");
}

function renderJudge(model) {
  const live = model.live;
  const calib = model.sources.calibration;
  const challenges = new Map();
  (model.sources.challenges.rows || []).forEach(c => challenges.set(c.id, c));

  // Prefer the database's own definition. Fall back to recomputing from
  // submissions when the staff wrapper does not exist — with completion_rate
  // left explicitly unknown, because it needs `times_served`, which no client
  // role can read and which cannot be derived from submissions at all.
  let rows, derived;
  if (calib.status === "ok") {
    derived = false;
    rows = calib.rows.map(function (c) {
      return {
        title: c.title, difficulty: c.intended_difficulty, domain: c.domain,
        attempts: c.attempts, completions: c.completions, players: c.distinct_players,
        avg: c.avg_score, spread: c.score_spread, min: c.min_score, max: c.max_score,
        completionRate: c.completion_rate, active: c.is_active,
      };
    });
  } else {
    derived = true;
    rows = Array.from(live.byChallenge.values()).map(function (c) {
      const ch = challenges.get(c.id) || {};
      const mean = c.completions ? c.sum / c.completions : null;
      let spread = null;
      if (c.completions > 1) {
        const v = c.scores.reduce((a, s) => a + (s - mean) * (s - mean), 0) / c.scores.length;
        spread = Math.sqrt(v);
      }
      return {
        title: ch.title || "(challenge no longer in the deck)",
        difficulty: ch.difficulty, domain: ch.domain,
        attempts: c.attempts, completions: c.completions, players: c.players.size,
        avg: mean, spread: spread,
        min: c.scores.length ? Math.min.apply(null, c.scores) : null,
        max: c.scores.length ? Math.max.apply(null, c.scores) : null,
        completionRate: null, active: !!challenges.get(c.id),
      };
    });
  }

  rows.sort(function (a, b) { return (b.attempts || 0) - (a.attempts || 0); });

  // ⚠ The thresholds, and why they are these numbers rather than round ones.
  //
  //   MIN_MARKS  Five. Below that a "mean" is one person having a good day, and
  //              a dashboard that calls a challenge too hard off two marks will
  //              get a challenge retired that was never measured.
  //
  //   SPREAD     2.87 is the standard deviation of a uniform 1–10 distribution.
  //              At or above it the marks are not clustering around a mean at
  //              all — they sit at both ends, which is what one rubric applied
  //              two different ways looks like. Anything lower would fire on
  //              everything: the six legacy events measured 2.05–2.61 and were
  //              scored by one judge on a fixed scale.
  const MIN_MARKS = 5;
  const SPREAD_UNIFORM = 2.87;

  function verdict(r) {
    const flags = [];
    if (!r.completions) return ['<span class="ad-cell-dim">no marks yet</span>'];
    if (r.completions < MIN_MARKS) {
      return ['<span class="ad-cell-dim">too few marks to say (' + r.completions + ")</span>"];
    }
    if (r.avg !== null && r.avg >= 8) flags.push('<span class="ad-pill warn">may be too easy</span>');
    if (r.avg !== null && r.avg <= 3) flags.push('<span class="ad-pill warn">may be too hard</span>');
    if (r.spread !== null && r.spread >= SPREAD_UNIFORM) {
      flags.push('<span class="ad-pill danger" title="A spread this wide is wider than a uniform 1–10 distribution: the marks sit at both ends rather than around a mean. A mean of 5 made of fives and a mean of 5 made of ones and nines are different challenges, and only one of them is calibrated.">judging looks inconsistent</span>');
    }
    if (r.completionRate !== null && r.completionRate !== undefined && r.completionRate < 0.4) {
      flags.push('<span class="ad-pill warn">people walk away from it</span>');
    }
    if (r.difficulty && r.avg !== null) {
      // Intended difficulty runs 1 easiest .. 5 hardest. If the hardest
      // challenges are scoring like the easiest, the difficulty label is
      // decorative and the generator is not being told anything true.
      if (r.difficulty >= 4 && r.avg >= 7) flags.push('<span class="ad-pill warn">easier than labelled</span>');
      if (r.difficulty <= 2 && r.avg <= 4) flags.push('<span class="ad-pill warn">harder than labelled</span>');
    }
    return flags.length ? flags : ['<span class="ad-pill ok">looks calibrated</span>'];
  }

  const body = rows.map(function (r) {
    return "<tr>" +
      '<td class="ad-cell-strong">' + escapeHtml(r.title) +
        (r.active === false ? ' <span class="ad-pill muted">retired</span>' : "") +
        (r.domain ? '<div class="ad-cell-dim">' + escapeHtml(r.domain) + "</div>" : "") + "</td>" +
      '<td class="ad-num">' + (r.difficulty || "\u2014") + "</td>" +
      '<td class="ad-num">' + num(r.attempts) + "</td>" +
      '<td class="ad-num">' + num(r.completions) + "</td>" +
      '<td class="ad-num">' + num(r.players) + "</td>" +
      '<td class="ad-num">' + (r.avg === null || r.avg === undefined ? '<span class="pa-null">\u2014</span>' : dec(r.avg, 2)) + "</td>" +
      '<td class="ad-num">' + (r.spread === null || r.spread === undefined ? '<span class="pa-null">\u2014</span>' : dec(r.spread, 2)) + "</td>" +
      '<td class="ad-num">' + (r.completionRate === null || r.completionRate === undefined
        ? '<span class="pa-null" title="Needs times_served, which is only on the challenges table and readable by no client role.">not available</span>'
        : pct(r.completionRate)) + "</td>" +
      "<td>" + verdict(r).join(" ") + "</td>" +
      "</tr>";
  }).join("");

  const judgeRuns = Array.from(live.byJudge.values()).sort((a, b) => b.n - a.n).map(function (j) {
    return "<tr>" +
      '<td class="ad-cell-strong">' + escapeHtml(j.model || "not recorded") +
        (j.version ? '<div class="ad-cell-dim">' + escapeHtml(j.version) + "</div>" : "") + "</td>" +
      '<td class="ad-num">' + num(j.n) + "</td>" +
      '<td class="ad-num">' + (j.scored ? dec(j.sum / j.scored, 2) : '<span class="pa-null">\u2014</span>') + "</td>" +
      '<td class="ad-num">' + (j.failed ? '<span class="ad-pill danger">' + num(j.failed) + "</span>" : "0") + "</td>" +
      '<td class="ad-cell-dim">' + escapeHtml((shortDate(j.first) || "\u2014") + " \u2013 " + (shortDate(j.last) || "\u2014")) + "</td>" +
      "</tr>";
  }).join("");

  set("pa-calib",
    (derived
      ? caveat("Recomputed here, not read from the database's own definition.",
          "<code class=\"pa-code\">promptarena_challenge_calibration</code> exists in 0029 and is granted to no client role, so this page cannot read it. Everything below is recomputed from submissions and agrees with it by construction \u2014 except <em>completion rate</em>, which needs <code class=\"pa-code\">times_served</code>. Being shown a challenge and walking away leaves no submission row, so that number cannot be recovered from anything else. Apply the staff wrapper in <code class=\"pa-code\">tools/promptarena-dashboard/</code> to get it.")
      : caveat("Read from <code class=\"pa-code\">promptarena_challenge_calibration</code>.", "Nothing on this table is recomputed here.", "info")) +
    (rows.length
      ? '<div class="ad-tablewrap"><table class="ad-table"><thead><tr>' +
        '<th>Challenge</th><th class="ad-num" title="1 easiest, 5 hardest \u2014 what the generator intended.">Intended</th>' +
        '<th class="ad-num">Attempts</th><th class="ad-num">Marks</th><th class="ad-num">Players</th>' +
        '<th class="ad-num">Mean</th><th class="ad-num" title="Population standard deviation of the marks.">Spread</th>' +
        '<th class="ad-num">Finished</th><th>Signal</th>' +
        "</tr></thead><tbody>" + body + "</tbody></table></div>"
      : '<div class="ad-empty">No live practice submissions yet, so there is nothing to calibrate against. ' +
        "The challenge deck holds " + num(challenges.size) + " active challenge" + (challenges.size === 1 ? "" : "s") + ".</div>"));

  set("pa-judgeruns", judgeRuns
    ? '<div class="ad-tablewrap"><table class="ad-table"><thead><tr>' +
      '<th>Judge</th><th class="ad-num">Submissions</th><th class="ad-num">Mean given</th>' +
      '<th class="ad-num">Failures</th><th>Active</th>' +
      "</tr></thead><tbody>" + judgeRuns + "</tbody></table></div>"
    : '<div class="ad-empty">No judged submissions yet. Once there are, this is where "the judge got harsher in March" becomes answerable rather than a feeling.</div>');

  set("pa-legacy-judge",
    caveat("Measured from the source workbooks, not from this database.",
      "294 judged rows from the two events that recorded what the judge said \u2014 the only two of the six with a comment column. These are findings about the <em>old</em> Forms judge. The live arena's judge is a different thing and is measured in the table above.", "info") +
    LEGACY_JUDGE_FINDINGS.map(function (f) {
      const pill = f.severity === "bad" ? '<span class="ad-pill danger">defect</span>'
        : f.severity === "warn" ? '<span class="ad-pill warn">inconsistent</span>'
        : f.severity === "ok" ? '<span class="ad-pill ok">holds up</span>'
        : '<span class="ad-pill muted">shape</span>';
      return '<div style="padding:12px 0;border-bottom:1px solid var(--ad-line)">' +
        '<div style="display:flex;gap:9px;align-items:baseline;flex-wrap:wrap;margin-bottom:5px">' +
        pill + '<strong style="font-size:13.5px">' + escapeHtml(f.headline) + "</strong></div>" +
        '<div style="font-size:12.5px;color:var(--ad-text-2);line-height:1.6">' + escapeHtml(f.detail) + "</div></div>";
    }).join(""));
}

function renderPlayers(model, opts) {
  const live = model.live;
  const showStaff = opts && opts.includeStaff;
  const list = Array.from(live.players.values())
    .filter(p => showStaff || !isStaffRole(p.role))
    .filter(p => p.judged > 0)
    .sort((a, b) => (b.sum / b.judged) - (a.sum / a.judged))
    .slice(0, 50);

  if (!list.length) {
    // "empty" is a fact about the database, not a failure to report as one.
    set("pa-players",
      live.status === "ok" || live.status === "empty"
        ? '<div class="ad-empty">No judged live practice submissions yet.</div>'
        : unavailable(model.sources.submissions, "The live player ranking"));
    return;
  }

  const rows = list.map(function (p, i) {
    return "<tr>" +
      '<td class="ad-num">' + (i + 1) + "</td>" +
      '<td class="ad-cell-strong">' + escapeHtml(p.name || "(no profile name)") +
        (isStaffRole(p.role) ? ' <span class="ad-pill role-' + escapeHtml(p.role) + '">' + escapeHtml(p.role) + "</span>" : "") +
        (p.optedIn ? "" : ' <span class="ad-pill muted" title="They have not opted into the public leaderboard. This is the staff view; the member-facing leaderboard shows only people who said yes.">hidden publicly</span>') + "</td>" +
      '<td class="ad-num">' + dec(p.sum / p.judged, 2) + "</td>" +
      '<td class="ad-num">' + num(p.challenges.size) + "</td>" +
      '<td class="ad-num">' + num(p.judged) + "</td>" +
      '<td class="ad-num">' + (p.best === null ? '<span class="pa-null">\u2014</span>' : num(p.best)) + "</td>" +
      '<td class="ad-cell-dim">' + escapeHtml(shortDate(p.lastAt) || "\u2014") + "</td>" +
      "</tr>";
  }).join("");

  set("pa-players",
    (live.staffPlayerCount && !showStaff
      ? caveat(num(live.staffPlayerCount) + " staff or admin account" + (live.staffPlayerCount > 1 ? "s are" : " is") + " hidden from this ranking.",
          "The same rule the legacy half applies to the account that produced 53 of july18's 256 submissions: kept and flagged, never deleted, and never allowed to sit at the top of a table of members. Tick the box above to show them.")
      : "") +
    caveat("This is a staff view of everyone, including members who chose not to be ranked publicly.",
      "The member-facing leaderboard ranks only people who opted in, and ranks them <em>after</em> the filter so the numbering carries no information about anybody who said no. Do not publish this table.", "info") +
    '<div class="ad-tablewrap"><table class="ad-table"><thead><tr>' +
    '<th class="ad-num">#</th><th>Member</th><th class="ad-num">Rating</th><th class="ad-num">Challenges</th>' +
    '<th class="ad-num">Judged attempts</th><th class="ad-num">Best</th><th>Last played</th>' +
    "</tr></thead><tbody>" + rows + "</tbody></table></div>");
}

export function renderDashboard(model, opts) {
  opts = opts || {};
  renderSources(model);
  renderOverview(model);
  renderEvents(model);
  renderPeople(model, opts);
  renderOutreach(model);
  renderJudge(model);
  renderPlayers(model, opts);

  const warn = model.warnings.length
    ? model.warnings.map(w => '<div class="ad-msg err">' + escapeHtml(w) + "</div>").join("")
    : "";
  set("pa-warnings", warn);

  // Tab counts, so the shape of the data is visible before anything is clicked.
  const counts = {
    "pa-tab-events": model.legacy.status === "ok" ? model.legacy.events.length : null,
    "pa-tab-people": model.people.status === "ok" ? model.people.distinct : null,
    "pa-tab-outreach": model.outreach.status === "ok" ? model.outreach.mailable : null,
  };
  Object.keys(counts).forEach(function (id) {
    const n = el(id);
    if (n) n.textContent = counts[id] === null ? "" : String(counts[id]);
  });
}

// Tabs. Plain buttons with aria-selected, because this is one dashboard and the
// sections are views of it rather than separate pages.
export function wireTabs() {
  const tabs = Array.from(document.querySelectorAll(".pa-tab"));
  function show(name) {
    tabs.forEach(function (t) {
      const on = t.dataset.tab === name;
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    Array.from(document.querySelectorAll("[data-panel]")).forEach(function (p) {
      p.hidden = p.dataset.panel !== name;
    });
  }
  tabs.forEach(t => t.addEventListener("click", () => show(t.dataset.tab)));
  show(tabs.length ? tabs[0].dataset.tab : "overview");
  return show;
}
