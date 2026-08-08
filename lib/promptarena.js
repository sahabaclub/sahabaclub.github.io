// Sahaba Club — PromptArena
// ------------------------------------------------------------
// Every database call PromptArena makes, in one file, so the rules about what
// the client may read and write are decided once rather than per render.
//
// The rules, restated from supabase/migrations/0029_promptarena.sql:
//
//   * A member writes exactly two columns: `challenge_id` and `prompt_text`.
//     The INSERT grant is column-level and names only those. Nothing here ever
//     sends a score, a status or a judged_at — not because it would be
//     impolite, but because the grant would reject the whole row and the
//     member would lose their prompt to an error they could not act on.
//   * There is no UPDATE and no DELETE for a member. Any code that wants to
//     "fix" or "retry" a submission is asking for a service-role operation and
//     does not belong in the browser.
//   * Challenges are read through `promptarena_challenge_deck` only. The
//     table itself is unreadable and the rubric is deliberately not in the
//     view — a member who can read the marking scheme writes to the marking
//     scheme instead of to the brief.
//   * The leaderboard covers opted-in members only, and the opt-in defaults to
//     off. Nothing here flips it except a member's own click.
//
// Everything returns `{ data, error, off }`, the same shape lib/connect.js
// uses. `off` means migration 0029 has not been applied — the page then says
// so plainly instead of rendering a stack trace.
import { supabase } from "./supabase-client.js?v=637c227072";

// Not re-implemented. lib/connect.js already decides what "the migration
// hasn't run" looks like across the two PostgREST spellings and the two
// Postgres codes, and a second opinion on that in this file would eventually
// disagree with the first. Same for the HTML escape and the session lookup:
// one definition, imported.
import {
  isMissingSchema,
  currentUser,
  requireUser,
  escapeHtml,
} from "./connect.js?v=637c227072";

export { isMissingSchema, currentUser, requireUser, escapeHtml };

function wrap(res) {
  if (res.error && isMissingSchema(res.error)) {
    return { data: null, error: res.error, off: true };
  }
  return { data: res.data, error: res.error || null, off: false };
}

export const ARENA_OFF_MESSAGE =
  "PromptArena isn't switched on yet. The database update it needs hasn't been " +
  "applied — nothing is broken on your side, and nothing you've written has been lost.";

// ============================================================
// The hub: what a member has done so far
// ============================================================

// `promptarena_my_stats` is already scoped to auth.uid() inside the view, so
// there is no filter to add and no id to pass. A member who has never had a
// submission judged has NO ROW — which the view's own header calls out as
// deliberate, so that the page can say "you haven't started" rather than
// "your rating is zero". `maybeSingle` is what preserves that distinction:
// `single` would turn "new member" into an error.
const STATS_COLUMNS =
  "user_id, rating, challenges_completed, judged_attempts, highest_score, " +
  "lowest_score, current_streak, last_played_on, show_in_ranking";

export async function myStats() {
  return wrap(await supabase.from("promptarena_my_stats").select(STATS_COLUMNS).maybeSingle());
}

// ============================================================
// The leaderboard
// ============================================================

const LEADERBOARD_COLUMNS =
  "rank, user_id, full_name, avatar_url, profile_user_id, rating, " +
  "challenges_completed, highest_score";

// The board itself, best first. The view has already excluded everyone who has
// not opted in and has already numbered the survivors 1..N, so there is
// nothing to filter and nothing to rank here — doing either would be a second
// definition of a number the database has one definition of.
export async function leaderboard(limit) {
  return wrap(
    await supabase
      .from("promptarena_leaderboard")
      .select(LEADERBOARD_COLUMNS)
      .order("rank", { ascending: true })
      .limit(limit || 50)
  );
}

// Where the reader sits, if they are on the board at all. A member who has not
// opted in simply is not in the view, so `data: null` with no error is the
// normal answer and means "not listed" — never "no rank yet".
export async function myPosition() {
  const user = await currentUser();
  if (!user) return { data: null, error: null, off: false };
  return wrap(
    await supabase
      .from("promptarena_leaderboard")
      .select(LEADERBOARD_COLUMNS)
      .eq("user_id", user.id)
      .maybeSingle()
  );
}

// ============================================================
// The privacy flag
// ============================================================

// ⚠ The failure this function exists to catch. `show_in_promptarena_ranking`
// is a new column on `profiles`, and `profiles` has had its table-wide UPDATE
// grant revoked since 0002 — so the column arrives unwritable and 0029 has to
// hand the privilege back explicitly. If that grant is missing, PostgREST does
// not error: it returns 204 with zero rows changed, the toggle springs back to
// "hidden" on the next load, and the member is never told why. 0017 exists
// entirely because that happened to six other columns.
//
// So the update asks for the row back and checks it actually got one. No row
// means nothing was written, whatever the status code said.
export async function setRankingVisibility(on) {
  const user = await currentUser();
  if (!user) return { data: null, error: "not signed in", off: false };

  const res = wrap(
    await supabase
      .from("profiles")
      .update({ show_in_promptarena_ranking: Boolean(on) })
      .eq("user_id", user.id)
      .select("show_in_promptarena_ranking")
  );
  if (res.off) return { data: null, error: null, off: true };
  if (res.error) return { data: null, error: res.error.message, off: false };

  const rows = res.data || [];
  if (!rows.length) {
    // Deliberately reported as `off` rather than as an error: from the
    // member's side "the database update hasn't been applied" is exactly what
    // this is, and it is not something they can retry their way out of.
    return { data: null, error: null, off: true, silent: true };
  }
  return { data: Boolean(rows[0].show_in_promptarena_ranking), error: null, off: false };
}

// ============================================================
// The challenge deck
// ============================================================

const DECK_COLUMNS =
  "id, title, brief, difficulty, domain, target_audience, creativity, constraints, created_at";

// How many challenges the page holds in memory to choose from. The deck is
// generated and expected to grow, and a member is served one challenge at a
// time — so this is "enough to pick from without repeating", not "the bank".
export const DECK_CAP = 200;

export async function listDeck(limit) {
  return wrap(
    await supabase
      .from("promptarena_challenge_deck")
      .select(DECK_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(limit || DECK_CAP)
  );
}

// Which challenges this member has already put a prompt against. Used only to
// prefer something new — never to block a replay. Replays are allowed by
// design (0029: "each judged retry counts"), and a practice mode that refuses
// to let you try the same brief again after reading your feedback would be
// removing the single most useful thing a member can do with that feedback.
export async function myAttemptedChallengeIds() {
  const user = await currentUser();
  if (!user) return { data: new Set(), error: null, off: false };
  const res = wrap(
    await supabase
      .from("promptarena_submissions")
      .select("challenge_id")
      .eq("user_id", user.id)
      .limit(1000)
  );
  if (res.off || res.error) return { data: new Set(), error: res.error, off: res.off };
  return { data: new Set((res.data || []).map((r) => r.challenge_id)), error: null, off: false };
}

// Pick one to serve.
//
// ⚠ Serving is counted on the server. `promptarena_challenges.times_served` is
// the one stored counter in 0029 and it is writable by the service role alone,
// so a browser cannot increment it and must not pretend to. This function
// chooses what to show; when an Edge Function that serves-and-counts exists,
// it replaces this call and nothing else on the page changes.
//
// Unseen challenges first, in a random order so two members opening the page
// at the same moment do not get the same brief. Once they have all been seen,
// it falls back to the whole deck rather than refusing to deal.
export function pickChallenge(deck, options) {
  const rows = (deck || []).filter(Boolean);
  if (!rows.length) return null;
  const opts = options || {};
  const avoid = opts.avoid instanceof Set ? opts.avoid : new Set();
  const notJust = opts.notJust ? String(opts.notJust) : "";

  let pool = rows.filter((c) => !avoid.has(c.id) && c.id !== notJust);
  if (!pool.length) pool = rows.filter((c) => c.id !== notJust);
  if (!pool.length) pool = rows;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ============================================================
// Submitting
// ============================================================

export const PROMPT_MAX = 4000;
export const PROMPT_MIN = 10;

// The insert names two columns and nothing else — see the header. `user_id`
// is left off on purpose: it defaults to auth.uid() in the table, which is
// what lets the grant be this narrow.
export async function submitPrompt(challengeId, promptText) {
  const text = String(promptText == null ? "" : promptText).trim();
  if (!challengeId) return { data: null, error: "No challenge to answer.", off: false };
  if (text.length < PROMPT_MIN) {
    return { data: null, error: "Write a bit more before submitting.", off: false };
  }
  if (text.length > PROMPT_MAX) {
    return {
      data: null,
      error: "That's longer than " + PROMPT_MAX + " characters. Trim it and try again.",
      off: false,
    };
  }

  const res = wrap(
    await supabase
      .from("promptarena_submissions")
      .insert({ challenge_id: challengeId, prompt_text: text })
      .select("id, challenge_id, judge_status, submitted_at")
      .single()
  );
  if (res.off) return { data: null, error: null, off: true };
  if (res.error) {
    const msg = String(res.error.message || "");
    if (/row-level security|permission denied|violates/i.test(msg)) {
      return {
        data: null,
        error:
          "The club's database wouldn't accept that submission. Your prompt is still " +
          "in the box — nothing has been lost.",
        off: false,
      };
    }
    return { data: null, error: msg, off: false };
  }
  return { data: res.data, error: null, off: false };
}

const SUBMISSION_COLUMNS =
  "id, challenge_id, prompt_text, judge_status, score, feedback_summary, " +
  "feedback_strengths, feedback_improvements, feedback_how_to_improve, " +
  "rubric_scores, judge_error, submitted_at, judged_at";

export async function getSubmission(id) {
  if (!id) return { data: null, error: null, off: false };
  return wrap(
    await supabase
      .from("promptarena_submissions")
      .select(SUBMISSION_COLUMNS)
      .eq("id", id)
      .maybeSingle()
  );
}

export async function listMyAttempts(limit) {
  const user = await currentUser();
  if (!user) return { data: [], error: null, off: false };
  const res = wrap(
    await supabase
      .from("promptarena_submissions")
      .select(SUBMISSION_COLUMNS)
      .eq("user_id", user.id)
      .order("submitted_at", { ascending: false })
      .limit(limit || 20)
  );
  if (res.off || res.error) return { data: [], error: res.error, off: res.off };
  return { data: res.data || [], error: null, off: false };
}

// ============================================================
// Waiting for the judge
// ============================================================
//
// The client inserts the submission; the score arrives later, written by the
// judge running as the service role. So there is nothing to await — the row
// has to be watched.
//
// ⚠ THE THING THAT BREAKS NAÏVE POLLING: a hidden browser tab has its timers
// throttled hard — a `setTimeout(2000)` in a background tab typically fires
// about once a minute, and can be starved further. Three consequences are
// designed for below:
//
//   1. The give-up point is WALL CLOCK, never a poll count. A throttled tab
//      that managed four polls in three minutes has waited three minutes, and
//      one that managed forty has waited three minutes too.
//   2. The row is fetched BEFORE the deadline is tested, so a member who comes
//      back after five minutes to a finished judgement sees the result rather
//      than a timeout message about a job that is sitting there done.
//   3. Returning to the tab wakes the wait immediately instead of serving out
//      a throttled timer. `visibilitychange` fires as soon as the tab is
//      shown, which is exactly when the member is looking.
//
// And what it does when the cap is reached: it returns `waiting`, NOT an
// error. Nothing is known to have gone wrong — the submission is stored, the
// judge may still be running, and the only honest thing the UI can say is that
// it is taking longer than usual. `failed` is reported when and only when the
// row itself says `judge_status = 'failed'`.
export const JUDGE_WAIT_MS = 180000; // three minutes of wall clock
const POLL_FIRST_MS = 1500;
const POLL_MAX_MS = 8000;
const POLL_GROWTH = 1.4;

function sleepUntilVisibleOrElapsed(ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      resolve();
    };
    const onVisible = () => {
      if (!document.hidden) finish();
    };
    const timer = setTimeout(finish, ms);
    document.addEventListener("visibilitychange", onVisible);
  });
}

// `onTick({ elapsedMs, polls, status })` is called after every look at the row,
// so the UI can show real elapsed time rather than an animation pretending to
// be progress.
export async function awaitJudgement(submissionId, options) {
  const opts = options || {};
  const onTick = typeof opts.onTick === "function" ? opts.onTick : null;
  const capMs = Number(opts.timeoutMs || JUDGE_WAIT_MS);
  const started = Date.now();

  let delay = POLL_FIRST_MS;
  let polls = 0;
  let consecutiveErrors = 0;

  for (;;) {
    const res = await getSubmission(submissionId);
    polls++;
    const elapsedMs = Date.now() - started;

    if (res.off) return { status: "off", data: null, elapsedMs };

    if (res.error) {
      consecutiveErrors++;
      // A network blip while a judge is running is not a judging failure, and
      // must never be reported as one. Only a long unbroken run of them means
      // the page genuinely cannot see the row any more.
      if (consecutiveErrors >= 5) {
        return { status: "unreachable", data: null, error: res.error, elapsedMs };
      }
    } else {
      consecutiveErrors = 0;
      const row = res.data;
      if (row && row.judge_status === "judged") {
        return { status: "judged", data: row, elapsedMs };
      }
      if (row && row.judge_status === "failed") {
        return { status: "failed", data: row, elapsedMs };
      }
      if (onTick) onTick({ elapsedMs, polls, status: row ? row.judge_status : "pending" });
    }

    // Tested after the fetch, so a finished judgement always wins over the cap.
    if (elapsedMs >= capMs) {
      return { status: "waiting", data: res.data || null, elapsedMs };
    }

    await sleepUntilVisibleOrElapsed(delay);
    delay = Math.min(Math.round(delay * POLL_GROWTH), POLL_MAX_MS);
  }
}

// ============================================================
// Legacy: the six Microsoft Forms events
// ============================================================
//
// ⚠ READ THIS BEFORE CHANGING HOW A LEGACY SCORE RENDERS.
//
// The import was originally understood as "two of the six events were never
// judged, and their zeros are fake". That premise was measured and refuted:
// all six events were judged, and in the two events in question every zero is
// a round the player never attempted — no played round scored zero. The
// `was_judged` flag that expressed the old premise has been removed from 0029
// because it had no true instances, so nothing here may reach for it.
//
// The decision this file makes: **a score is shown when, and only when, that
// row carries one.** Per-row nullability, never an event-level flag.
//
// Three further facts about the export, each of which would otherwise put a
// false number in front of a real person:
//
//   * SOME ROWS CARRY A KNOWN-BAD VERDICT. All 48 round-5 rows in the two
//     long-format exports repeat the same player's round-4 score and comment
//     byte for byte — a fault in the original Forms pipeline, not 48 people
//     writing the same prompt twice. The importer stamps `invalid_reason` on
//     those rows and the view masks them; a row with a reason is never scored
//     and never counted.
//     ⚠ `invalid_reason` is the ONLY test used here. An earlier version of
//     this file keyed on `round_number === 5`, which under-reports: it is
//     right about the long-format events and blind to the wide-format ones.
//     Nor may the client re-derive the artefact test itself — the correct
//     test has three parts, and the obvious two-part version (same score,
//     same comment) condemns real marks in the wide exports, where every
//     comment is null and two nulls compare equal.
//   * A MISSING SCORE IS A ROUND NOBODY PLAYED. It is not a zero and it is not
//     a lost score. It is rendered as "not attempted".
//   * THE STORED TOTAL IS UNRELIABLE. 53 players' TotalScore reads 0 while
//     their own rounds sum to real marks. Any total shown is summed here from
//     the round scores actually present, and the stored total is never read.
//
// 63 of the submissions are in Arabic script, so every piece of legacy text
// the page renders carries dir="auto" — otherwise Arabic prompts render
// left-to-right with the punctuation thrown to the wrong end.

// The columns this section cannot render without.
const LEGACY_CORE_COLUMNS =
  "event_slug, event_name, held_on, round_number, question, prompt_text, " +
  "score, has_score, judge_comment, invalid_reason";

// Context that improves the wording but is not load-bearing. Split out so a
// view that is one revision behind degrades to a slightly plainer history
// rather than failing the whole section — the same retry `getMember` uses in
// lib/connect.js for 0023's three columns, and for the same reason: a missing
// column comes back as a schema error against a view that is otherwise alive,
// and that must not read as "the feature isn't switched on".
const LEGACY_EXTRA_COLUMNS = "date_last, is_single_day, has_judge_comments";

export async function legacyResults() {
  const ask = (columns) =>
    supabase
      .from("my_promptarena_legacy_results")
      .select(columns)
      .order("held_on", { ascending: true })
      .order("round_number", { ascending: true });

  const full = wrap(await ask(LEGACY_CORE_COLUMNS + ", " + LEGACY_EXTRA_COLUMNS));
  const res = full.off ? wrap(await ask(LEGACY_CORE_COLUMNS)) : full;
  if (res.off || res.error) return { data: [], error: res.error, off: res.off };
  return { data: res.data || [], error: null, off: false };
}

// What a single legacy round may say, decided once.
//
//   'scored'        a real mark exists — show it, including a genuine 0
//   'not-attempted' no mark, because the player did not submit this round
//   'unreliable'    the importer flagged this row's verdict as an artefact
export function legacyRoundState(row) {
  if (!row) return "not-attempted";
  if (row.invalid_reason) return "unreliable";
  if (row.score !== null && row.score !== undefined) return "scored";
  return "not-attempted";
}

// The reason codes turned into something a member can read. An unrecognised
// code still produces a true sentence rather than the raw string, because
// these are internal names and none of them is written for a reader.
const INVALID_REASONS = {
  round5_verdict_copied_from_round4:
    "The original scoring run copied the previous round’s mark and comment onto this " +
    "round for every player, so the number it recorded isn’t a real result for it.",
};

export function invalidReasonText(reason) {
  if (!reason) return "";
  return INVALID_REASONS[String(reason)] ||
    "The club found this round’s recorded mark unreliable, so it isn’t shown as a result.";
}

// Rows grouped into the events they belong to, with the totals computed here
// rather than read from anywhere. Only 'scored' rounds count toward a total,
// which is what keeps round 5 and unplayed rounds out of it.
export function groupLegacy(rows) {
  const byEvent = new Map();
  (rows || []).forEach((row) => {
    const key = row.event_slug || row.event_name || "event";
    let ev = byEvent.get(key);
    if (!ev) {
      ev = {
        slug: row.event_slug,
        name: row.event_name,
        held_on: row.held_on,
        date_last: row.date_last,
        // ⚠ Only july18 is false, because that Forms list was left open and
        // reused: its rows run from 2025-07-18 to 2026-07-14. Its `held_on` is
        // therefore the first row's date and not the date of an event, so the
        // page must not print it as one. `undefined` (the column absent) is
        // not false — it means "we weren't told", and the date is shown.
        is_single_day: row.is_single_day,
        has_judge_comments: row.has_judge_comments,
        rounds: [],
        scoredCount: 0,
        notAttempted: 0,
        unreliable: 0,
        total: 0,
        best: null,
      };
      byEvent.set(key, ev);
    }
    const state = legacyRoundState(row);
    ev.rounds.push({ ...row, state: state });
    if (state === "scored") {
      const value = Number(row.score);
      ev.scoredCount++;
      ev.total += value;
      ev.best = ev.best === null ? value : Math.max(ev.best, value);
    } else if (state === "unreliable") ev.unreliable++;
    else ev.notAttempted++;
  });

  return [...byEvent.values()].map((ev) => {
    ev.rounds.sort((a, b) => Number(a.round_number) - Number(b.round_number));
    ev.average = ev.scoredCount ? Math.round((ev.total / ev.scoredCount) * 100) / 100 : null;
    ev.total = ev.scoredCount ? Math.round(ev.total * 100) / 100 : null;
    return ev;
  });
}

// ============================================================
// Words for numbers
// ============================================================
//
// PromptArena is a practice environment, not an exam — the brief is explicit
// that a member should "feel encouraged to keep improving rather than worrying
// about making mistakes". So no band below is a verdict on the person, none of
// them uses the vocabulary of failure, and the lowest band is the one that
// says most clearly that there is somewhere to go next.

const SCORE_BANDS = [
  { min: 9, key: "sharp", label: "Sharp", line: "That is a prompt you could hand to a colleague." },
  { min: 7, key: "strong", label: "Strong", line: "Most of the way there — the notes below are the last mile." },
  { min: 5, key: "building", label: "Building", line: "The shape is right. The detail is what lifts it." },
  { min: 3, key: "drafting", label: "Drafting", line: "A first draft doing its job: it shows you what to aim at next." },
  { min: 1, key: "starting", label: "Starting out", line: "Everyone's first few land here. The feedback below is the useful part." },
];

// null for anything that isn't a real number, and that includes the shapes
// JavaScript is happiest to convert quietly: Number(null) is 0, Number("") is
// 0, Number([]) is 0, Number(false) is 0. No band's `min` is at or below 0, so
// every one of those used to fall out of the loop and land on the final
// `return` — the *lowest* band. "We have no score for this round" was being
// rendered as "Starting out", with a sentence of encouragement attached, to a
// member whose answer may never have been graded at all. That is the one
// failure mode this file's whole tone is meant to avoid: telling somebody they
// scored badly when nothing scored them.
//
// A caller now has to decide what "no score" looks like, which is right —
// "not attempted", "still grading" and "couldn't be graded" read differently
// on the page and only the caller knows which it is.
export function scoreBand(score) {
  // Only a number, or a string that is entirely a number, is a score. Anything
  // else — null, undefined, true, [], "", "  ", {} — is the absence of one,
  // and half of those coerce to 0 rather than to NaN, which is exactly how
  // this went wrong.
  let n;
  if (typeof score === "number") {
    n = score;
  } else if (typeof score === "string" && score.trim() !== "") {
    n = Number(score);
  } else {
    return null;
  }
  if (!Number.isFinite(n)) return null;
  for (let i = 0; i < SCORE_BANDS.length; i++) {
    if (n >= SCORE_BANDS[i].min) return SCORE_BANDS[i];
  }
  // A real number below every band — 0, or a negative. Genuinely the lowest
  // band: it was scored, and this is what it scored.
  return SCORE_BANDS[SCORE_BANDS.length - 1];
}

const DIFFICULTY_LABELS = ["", "Gentle", "Easy", "Standard", "Hard", "Brutal"];
export function difficultyLabel(level) {
  return DIFFICULTY_LABELS[Number(level)] || "Standard";
}

const CREATIVITY_LABELS = ["", "Tightly specified", "Mostly specified", "Balanced", "Open", "Wide open"];
export function creativityLabel(level) {
  return CREATIVITY_LABELS[Number(level)] || "Balanced";
}

export function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d)) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function elapsedLabel(ms) {
  const secs = Math.max(0, Math.round(Number(ms) / 1000));
  if (secs < 60) return secs + "s";
  const mins = Math.floor(secs / 60);
  return mins + "m " + (secs % 60) + "s";
}
