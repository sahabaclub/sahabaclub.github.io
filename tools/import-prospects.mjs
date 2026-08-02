#!/usr/bin/env node
// import-prospects.mjs
// ------------------------------------------------------------
// Runs locally, on a staff machine. Never deployed, never scheduled, never
// called from the site. It reads the SharePoint harvest, asks the
// `build-prospect-profile` Edge Function to compose each person's profile, and
// upserts the results into `prospect_profiles` (migration 0027).
//
//   node tools/import-prospects.mjs --harvest <path>            # dry run
//   node tools/import-prospects.mjs --harvest <path> --write    # writes
//
// No dependencies and no package.json: this repo has neither, and adding an
// npm tree for one script that runs a few times in its life is not worth the
// supply chain. Needs Node 18 or newer for global `fetch`.
//
// ============================================================
// The harvest file, and why its path is not written down here
// ============================================================
//
// The harvest holds a **mobile number for all 134 people**, plus their personal
// email addresses. **This repository is public.** So the file lives outside the
// working copy, and this script takes its location as an argument rather than
// defaulting to it — a default would publish the path to the personal data of
// 134 people to anyone who reads this file on GitHub, which is a smaller
// mistake than committing the data but is still a mistake.
//
// Nothing read from that file is ever written to disk by this script, and the
// fields it forwards to the Edge Function are an allowlist. `mobile` and
// `photo_filenames` are not on it. The function applies the same allowlist
// again on arrival, so a key added to the harvest later cannot leak through
// either side by being forgotten in one of them.
//
// ============================================================
// The service-role key
// ============================================================
//
// Read from `SUPABASE_SERVICE_ROLE_KEY` in the environment. It is never
// hardcoded, never printed, never put in a filename, and never written to a
// file. It bypasses RLS entirely — a copy of it in a shell history or a log is
// a copy of the whole database.
//
// ============================================================
// Three properties this script has to have, and how it gets them
// ============================================================
//
// **Nothing is published.** `is_published` is not in the upsert payload at all.
// Sending `false` would look safer and be worse: on a re-run it would silently
// un-publish every row a human had reviewed and published. Leaving the column
// out means the importer cannot change it in either direction. Same for
// `claimed_by`, `claimed_at` and `created_at`.
//
// **A human edit is never clobbered.** Each row carries a fingerprint of the
// content this script last wrote, under `sources._meta`. On a re-run the
// fingerprint is recomputed from the row as it now stands; if it does not
// match, somebody changed the row after the import and it is left alone and
// reported. This does not depend on `updated_at` being maintained — 0027
// creates no `set_updated_at` trigger on this table, so a dashboard edit would
// not bump it, and an idempotency check built on that column alone would
// quietly fail open. `claimed_by is not null` and `is_published = true` are
// checked as well: both mean a person has been involved.
//
// **It resumes.** Every skip decision above is made from a single up-front
// SELECT, before any model call. A row that already exists with a matching
// fingerprint is "done" and is not rebuilt, so a run that died at person 60 of
// 87 re-runs as 27 people, not 87. One person failing never stops the rest:
// failures are collected and reported at the end, and because a failed person
// has no row, the next run picks them up automatically.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// ============================================================
// Arguments
// ============================================================

const USAGE = `
import-prospects — compose and import prospect profiles (migration 0027)

  node tools/import-prospects.mjs --harvest <path>            dry run
  node tools/import-prospects.mjs --harvest <path> --write    commit

Required environment (never pass these as arguments):
  SUPABASE_URL                 project URL
  SUPABASE_SERVICE_ROLE_KEY    service role key; bypasses RLS, keep it out of files

Options:
  --harvest <path>   the harvest JSON. Also read from SC_HARVEST_FILE.
                     Deliberately not defaulted: this repo is public and that
                     file holds personal data for 134 people.
  --write            actually insert/update. Without it nothing is written.
  --rebuild          re-compose rows that already exist and are untouched.
                     Rows a human edited, published or claimed are still
                     skipped; this flag does not override that.
  --only <mailbox>   restrict to one person. Repeatable.
  --limit <n>        process at most n people this run.
  --concurrency <n>  parallel builds, 1-4. Default 1.
  --pace <ms>        wait this long between builds, from the start. Default 0.
                     The run raises this on its own when it is rate-limited;
                     set it if you already know the account is tight.
  --show-text        print the composed headline and bio for review.
                     Off by default so a dry run does not fill a terminal
                     with other people's text.
  -h, --help         this.

is_published is never set by this tool, in either direction. Publishing is a
separate, deliberate step.
`;

const argv = process.argv.slice(2);
const flags = {
  harvest: takeValue("--harvest") ?? process.env.SC_HARVEST_FILE ?? "",
  write: has("--write"),
  rebuild: has("--rebuild"),
  showText: has("--show-text"),
  limit: Number(takeValue("--limit") ?? "0") || 0,
  concurrency: Math.min(Math.max(Number(takeValue("--concurrency") ?? "1") || 1, 1), 4),
  pace: Math.max(Number(takeValue("--pace") ?? "0") || 0, 0),
  only: takeAll("--only").map((s) => s.toLowerCase()),
  help: has("--help") || has("-h"),
};

if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

fatalUnless(flags.harvest, "No harvest file. Pass --harvest <path> or set SC_HARVEST_FILE.\nIt is deliberately not defaulted: this repository is public and that file holds personal data.");
fatalUnless(SUPABASE_URL, "SUPABASE_URL is not set.");
fatalUnless(SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY is not set. Export it for this shell only; do not put it in a file.");

// The one line that says which mode this is, printed before anything happens
// rather than after, so an operator who meant to dry-run finds out now.
console.log(flags.write
  ? "MODE: WRITE — rows will be inserted and updated in prospect_profiles."
  : "MODE: dry run — nothing will be written. Add --write to commit.");
// Said plainly because "dry run" usually implies "free". It is not: composing
// is the expensive half and it happens either way — there is no way to show
// what would be written without writing it first, somewhere.
if (!flags.write) console.log("      (a dry run still composes, so it still calls the model and still costs)");
console.log(`Target: ${SUPABASE_URL}`);
console.log("");

// ============================================================
// Load the harvest
// ============================================================

let harvest;
try {
  harvest = JSON.parse(readFileSync(flags.harvest, "utf8"));
} catch (err) {
  fatal(`Could not read the harvest at ${flags.harvest}: ${err.message}`);
}
const people = Array.isArray(harvest?.people) ? harvest.people : [];
fatalUnless(people.length, "The harvest has no `people` array.");

console.log(`Harvest: ${people.length} people, generated ${harvest.generated_utc ?? "(no timestamp)"}`);
if (harvest.profileable != null) {
  console.log(`Harvest's own expectation: ${harvest.profileable} profileable, ${harvest.no_linkedin_no_text} with neither a LinkedIn nor self-submitted text.`);
}
console.log("");

// Only these keys leave this machine. `mobile` and `photo_filenames` are
// absent on purpose — see the header. `teams`, `roles` and `is_team_creator`
// are absent because the function will not use them and sending them would
// invite a future version to.
const FORWARD = [
  "ms365_mailbox", "rounds", "names", "personal_emails",
  "linkedin_url", "linkedin_raw_invalid", "headlines", "skills",
  "current_position", "current_company", "country", "country_of_residence",
];

// Columns the upsert is allowed to touch. Anything not here keeps whatever the
// database already has. `is_published`, `claimed_by`, `claimed_at` and
// `created_at` are excluded and must stay excluded.
const WRITABLE = [
  "ms365_mailbox", "email", "full_name", "headline", "bio", "avatar_url",
  "city", "country", "industry", "company", "position", "years_experience",
  "skills", "interests", "links", "work_history",
  "sources", "built_at", "built_model", "updated_at",
];

// The content a human might edit. The fingerprint is taken over exactly these,
// so a change to any of them is detected and a change to `built_at` is not.
const FINGERPRINTED = [
  "email", "full_name", "headline", "bio", "avatar_url", "city", "country",
  "industry", "company", "position", "years_experience", "skills",
  "interests", "links", "work_history",
];

const TOOL_ID = "tools/import-prospects.mjs@1";

// ============================================================
// Pacing, and knowing when to stop
// ============================================================
//
// Everything in this section is declared here rather than down in "Pieces",
// for the same reason `sleep` is a function declaration: the very next thing
// this file does is a top-level `await selectExisting()`, whose retry path
// calls `backoffDelayMs`, which reads these constants. A `const` at the bottom
// of the file would still be in its temporal dead zone at that moment, and the
// first network hiccup of the run would raise a ReferenceError instead of
// retrying — which is the exact bug the `sleep` comment was written about.
//
// ---- The retry budget ----
//
// Deliberately much larger than the function's own. `build-prospect-profile`
// retries inside one invocation and so is bounded by an Edge Function's wall
// clock — seconds. This script is a local process with 29 people to get
// through and nothing waiting on it, so it can afford minutes, and a rate
// limit that outlives the function's budget arrives here as a 429 with
// `Retry-After` precisely so that this layer can wait it out.
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 60_000;
const PERSON_DEADLINE_MS = 240_000;
const PERSON_RESERVE_MS = 30_000;

// ---- Adaptive pacing ----
//
// The run that prompted all this failed 29 of 87 and then, on a second run,
// 29 again — a different 29. Nothing was wrong with the data. The account's
// rate limit was simply lower than the speed this script asks for, and the
// script's only response was to hammer, fail, and report a number.
//
// So a rate limit now slows the whole run, not just the person who hit it:
//
//   * `cooldownUntil` is shared. When OpenAI says "wait 20 seconds", every
//     worker waits, because the limit is per account, not per request. One
//     worker sleeping while three others keep firing is the same limit hit
//     three more times.
//   * `delayMs` ratchets up on each rate limit and decays only after a run of
//     clean successes, so the run settles at a speed the account tolerates
//     instead of oscillating between too fast and stopped.
const PACE_STEP_MS = 1_500;
const PACE_MAX_MS = 30_000;
const PACE_DECAY = 0.8;
const PACE_CLEAN_RUN = 5; // consecutive successes before easing off again

// Codes that mean every remaining person fails identically. All of them are one
// operator action away from fixed, and none of them is fixed by waiting.
const FATAL_CODES = new Set([
  "quota_exhausted",
  "ai_credentials",
  "ai_unconfigured",
  "model_not_configured",
  "not_configured",
  "not_allowed",
  "not_signed_in",
]);

// One line per cause saying what to actually do. Written here rather than in
// the function because these are instructions to whoever is running this
// script, and the function's `error` is written for the person the profile
// describes.
const REMEDY = {
  rate_limited: () =>
    `OpenAI is throttling this account, not rejecting the data. Re-run — it resumes at exactly these people. ` +
    `Slower helps: --concurrency 1 --pace ${Math.max(pacer.delayMs, 5000)}.`,
  quota_exhausted:
    "The OpenAI account is out of credit. Top it up; nothing will succeed until then.",
  ai_credentials:
    "OPENAI_API_KEY in the Supabase Edge Function secrets is wrong or revoked. Re-running will not help.",
  ai_unconfigured:
    "OPENAI_API_KEY is not set in the Supabase Edge Function secrets.",
  model_not_configured:
    "OPENAI_MODEL names a model this account cannot use. Set it to one it can.",
  not_configured:
    "The function has no SUPABASE_SERVICE_ROLE_KEY of its own — check its secrets.",
  not_allowed:
    "The function refused this caller. Check SUPABASE_SERVICE_ROLE_KEY in this shell matches the project.",
  not_signed_in:
    "The function did not accept the bearer token. Check SUPABASE_SERVICE_ROLE_KEY in this shell.",
  upstream_error: "OpenAI failed to answer. Transient — re-run.",
  upstream_timeout: "OpenAI took too long. Transient — re-run.",
  upstream_unreachable: "The function could not reach OpenAI. Transient — re-run.",
  upstream_bad_response: "OpenAI answered with nothing usable. Transient — re-run.",
  model_refused:
    "The model declined this person's text. Not transient: look at what they wrote.",
  output_truncated:
    "The model ran out of output tokens before finishing, and already retried once at a higher ceiling. " +
    "This is a config value, not this person's data: on the Responses API the reasoning tokens come out of " +
    "the SAME max_output_tokens budget as the answer, so the ceiling is mostly spent before any JSON is " +
    "written. Raise MAX_OUTPUT_TOKENS_RETRY in supabase/functions/build-prospect-profile (and redeploy), or " +
    "lower REASONING_EFFORT there. Re-running at the same settings will only sometimes help — the spend " +
    "varies per call, which is why it fails for different people each run.",
  content_filtered:
    "The model's own filter stopped it partway through. Not a token ceiling and not transient: " +
    "look at what this person wrote.",
  upstream_rejected_request:
    "OpenAI rejected the request the function sent. A bug in build-prospect-profile.",
  sources_audit_failed:
    "The function composed a field it could not attribute and refused to return it. A bug — do not re-run until it is understood.",
  internal_error: "An unhandled error inside build-prospect-profile. A bug.",
  http_error:
    "The function answered with a status but no `code`, so this script could not classify it — " +
    "an older deployment of build-prospect-profile, or a platform error page in front of it.",
  network_error: "The request never completed. Check the network and the project URL.",
  upsert_failed:
    "Composing worked; the database write did not. The message above is PostgREST's own — " +
    "check migration 0027 is applied and that the payload matches the columns it defines.",
  unknown: "Not classified. The message above is all there is; treat it as a bug in this script.",
};

const stop = { reason: "", message: "" };

const pacer = {
  delayMs: flags.pace,
  cooldownUntil: 0,
  rateLimited: 0,
  clean: 0,

  // Called before each build. Honours the shared cooldown first — that is the
  // whole run holding still — and then the current pace.
  async waitTurn() {
    const remaining = this.cooldownUntil - Date.now();
    if (remaining > 0) await sleep(remaining);
    if (this.delayMs > 0) await sleep(this.delayMs);
  },

  // A rate limit anywhere slows everything. `retryAfterMs` is OpenAI's own
  // figure, forwarded by the function; without one, a step up is the best
  // guess available.
  rateLimit(retryAfterMs) {
    this.rateLimited++;
    this.clean = 0;
    this.delayMs = Math.min(
      Math.max(this.delayMs + PACE_STEP_MS, Math.min(retryAfterMs ?? 0, PACE_MAX_MS)),
      PACE_MAX_MS,
    );
    if (retryAfterMs) {
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + retryAfterMs);
    }
  },

  // Ease off only after a clean run, and never below what the operator asked
  // for on the command line.
  succeeded() {
    this.clean++;
    if (this.clean >= PACE_CLEAN_RUN && this.delayMs > flags.pace) {
      this.clean = 0;
      this.delayMs = Math.max(flags.pace, Math.floor(this.delayMs * PACE_DECAY));
    }
  },
};

// ============================================================
// What is already there
// ============================================================

let existing;
try {
  existing = await selectExisting();
} catch (err) {
  fatal(`Could not read prospect_profiles: ${err.message}\nIs migration 0027 applied?`);
}
console.log(`Already in prospect_profiles: ${existing.size} rows.`);
console.log("");

// ============================================================
// Decide, per person, before spending anything
// ============================================================

const queue = [];
const skipped = { noRow: [], claimed: [], published: [], edited: [], done: [] };

for (const raw of people) {
  const mailbox = String(raw?.ms365_mailbox ?? "").trim().toLowerCase();
  if (!mailbox) continue;
  if (flags.only.length && !flags.only.includes(mailbox)) continue;

  const row = existing.get(mailbox);
  if (row) {
    const who = { mailbox, name: row.full_name ?? "" };
    if (row.claimed_by) { skipped.claimed.push(who); continue; }
    if (row.is_published) { skipped.published.push(who); continue; }
    if (row.sources?._meta?.fingerprint && row.sources._meta.fingerprint !== fingerprint(row)) {
      skipped.edited.push(who);
      continue;
    }
    if (!flags.rebuild) { skipped.done.push(who); continue; }
  }
  queue.push(raw);
}

const work = flags.limit ? queue.slice(0, flags.limit) : queue;

console.log(`To process: ${work.length}${flags.limit && queue.length > flags.limit ? ` (of ${queue.length}, --limit applied)` : ""}`);
if (skipped.done.length)      console.log(`  already built, untouched : ${skipped.done.length} (resume; --rebuild to redo)`);
if (skipped.edited.length)    console.log(`  edited by a human        : ${skipped.edited.length} (left alone)`);
if (skipped.published.length) console.log(`  published                : ${skipped.published.length} (left alone)`);
if (skipped.claimed.length)   console.log(`  claimed by a member      : ${skipped.claimed.length} (left alone)`);
console.log("");

// ============================================================
// Build and (maybe) write
// ============================================================

const built = [];
const failures = [];
const notAttempted = [];
let done = 0;

await runPool(work, flags.concurrency, async (raw) => {
  const mailbox = String(raw.ms365_mailbox).toLowerCase();

  // A run that has hit a wall stops asking. When the key is wrong or the
  // account is out of credit, every remaining person fails identically — 29
  // more round trips, 29 more identical lines in the report, and a longer wait
  // before the operator sees the one sentence that matters. They are recorded
  // as not attempted, which is honest and costs nothing: nobody has a row, so
  // the next run picks up exactly them, the same as any other failure.
  try {
    if (stop.reason) {
      notAttempted.push({ mailbox });
      return;
    }

    await pacer.waitTurn();
    const result = await buildOne(raw);
    pacer.succeeded();

    if (result.skipped) {
      // Ahmed's rule, decided in the function so there is one copy of it.
      // Reported by name below so the count can be checked against the
      // harvest's own figure for people with neither a LinkedIn nor any
      // self-submitted text.
      skipped.noRow.push({ mailbox, name: result.full_name ?? "" });
      return;
    }

    const payload = toPayload(result.row);
    if (flags.write) {
      await upsert(payload);
    }
    built.push({ mailbox, row: payload, usedModel: result.usedModel });
  } catch (err) {
    // `err.code` is the function's own classification, read out of the
    // response body rather than inferred from the status. Keeping it on the
    // failure record — instead of flattening everything into one string — is
    // what lets the report below group by cause and say what to do about it.
    const code = err?.code ?? "unknown";
    failures.push({
      mailbox,
      code,
      status: err?.status ?? 0,
      attempts: err?.attempts ?? 1,
      message: String(err?.message ?? err),
    });
    if (FATAL_CODES.has(code) && !stop.reason) {
      stop.reason = code;
      stop.message = String(err?.message ?? err);
      console.error(`\n  STOPPING: ${stop.message}\n  (${code} — every remaining person would fail the same way)\n`);
    }
  } finally {
    done++;
    if (done % 10 === 0 || done === work.length) {
      process.stderr.write(`  ...${done}/${work.length}\n`);
    }
  }
});

// ============================================================
// Report
// ============================================================

console.log("");
console.log("============================================================");
console.log(flags.write ? "WRITTEN" : "WOULD WRITE (dry run)");
console.log("============================================================");
console.log(`Rows: ${built.length}`);
console.log(`  with a bio      : ${built.filter((b) => b.row.bio).length}`);
console.log(`  with a headline : ${built.filter((b) => b.row.headline).length}`);
console.log(`  with skills     : ${built.filter((b) => (b.row.skills ?? []).length).length}`);
console.log(`  with a LinkedIn : ${built.filter((b) => b.row.links?.linkedin).length}`);
console.log(`  composed by a model : ${built.filter((b) => b.usedModel).length} (the rest are straight transcriptions of source values)`);
console.log(`  is_published    : not set by this tool, in either direction`);

// The invariants 0027 asks about, checked here rather than assumed, so a dry
// run answers them before anything reaches the database.
const noSource = built.filter((b) => b.row.bio && !b.row.sources?.bio);
const invented = built.filter((b) => b.row.city != null || b.row.years_experience != null);
console.log("");
console.log(`Bios with no entry in sources : ${noSource.length}  (must be 0)`);
console.log(`Rows with a city or years_experience : ${invented.length}  (must be 0)`);
if (noSource.length || invented.length) process.exitCode = 1;

console.log("");
console.log("------------------------------------------------------------");
console.log(`NO PROFILE — neither a LinkedIn nor anything they wrote: ${skipped.noRow.length}`);
console.log("------------------------------------------------------------");
console.log("These people get no row at all. Listed by name so the count can be");
console.log("checked against the harvest rather than taken on trust.");
for (const s of [...skipped.noRow].sort((a, b) => a.mailbox.localeCompare(b.mailbox))) {
  console.log(`  ${s.name || "(no name in source)"}  <${s.mailbox}>`);
}
if (harvest.no_linkedin_no_text != null && !flags.only.length && !flags.limit) {
  const match = skipped.noRow.length === harvest.no_linkedin_no_text;
  console.log("");
  // This comparison holds on every full run, not only the first. Somebody with
  // no signal never gets a row, so they are never "already done" and are
  // re-examined every time — which costs one cheap function call each and no
  // model call at all, and is worth it to keep the gate in exactly one place.
  console.log(`Harvest says ${harvest.no_linkedin_no_text}; this run skipped ${skipped.noRow.length}. ${match ? "Agrees." : "DOES NOT AGREE — investigate before writing."}`);
}

for (const [label, listing] of [
  ["Left alone — a human edited them since the import", skipped.edited],
  ["Left alone — already published", skipped.published],
  ["Left alone — already claimed by a member", skipped.claimed],
]) {
  if (!listing.length) continue;
  console.log("");
  console.log(`${label}: ${listing.length}`);
  for (const s of listing) console.log(`  ${s.name || ""}  <${s.mailbox}>`);
}

// ============================================================
// Why it failed, not that it failed
// ============================================================
//
// The previous version of this block printed `HTTP 500` and nothing else, for
// every one of 29 failures, because the retry helper threw on the status code
// before anybody read the body — where the function had written the actual
// reason. That cost two blind re-runs. What follows is the same list with the
// reason attached: the cause, grouped, with the one thing to do about it, and
// then the individual lines.
if (failures.length) {
  console.log("");
  console.log("------------------------------------------------------------");
  console.log(`FAILED: ${failures.length}${stop.reason ? " — the run stopped early" : " — the rest of the run completed"}`);
  console.log("------------------------------------------------------------");

  const byCode = new Map();
  for (const f of failures) {
    if (!byCode.has(f.code)) byCode.set(f.code, []);
    byCode.get(f.code).push(f);
  }
  for (const [code, listing] of [...byCode.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log("");
    console.log(`  ${code} — ${listing.length}`);
    console.log(`    ${listing[0].message}`);
    const hint = REMEDY[code];
    if (hint) console.log(`    → ${typeof hint === "function" ? hint() : hint}`);
    for (const f of listing) {
      console.log(`      <${f.mailbox}>  ${f.attempts} attempt${f.attempts === 1 ? "" : "s"}, last status ${f.status || "none"}`);
    }
  }

  if (notAttempted.length) {
    console.log("");
    console.log(`  not attempted — the run stopped first: ${notAttempted.length}`);
  }

  console.log("");
  console.log("These people have no row, so re-running this command picks up");
  console.log("exactly them and nobody else.");
  process.exitCode = 1;
}

if (pacer.rateLimited) {
  console.log("");
  console.log(`Rate limited ${pacer.rateLimited} time(s); the run slowed itself to ${pacer.delayMs}ms between builds.`);
  console.log(`Start the next run with --pace ${pacer.delayMs} to begin at that speed instead of finding it again.`);
}

if (flags.showText) {
  console.log("");
  console.log("------------------------------------------------------------");
  console.log("COMPOSED TEXT (--show-text)");
  console.log("------------------------------------------------------------");
  for (const b of built) {
    console.log(`  <${b.mailbox}>  ${b.row.full_name}`);
    if (b.row.headline) console.log(`    headline: ${b.row.headline}`);
    if (b.row.bio) console.log(`    bio     : ${b.row.bio}`);
    if (b.row.position || b.row.company) console.log(`    role    : ${[b.row.position, b.row.company].filter(Boolean).join(" @ ")}`);
    if ((b.row.skills ?? []).length) console.log(`    skills  : ${b.row.skills.join(", ")}`);
    if (b.row.links?.linkedin) console.log(`    linkedin: ${b.row.links.linkedin}`);
  }
}

if (!flags.write) {
  console.log("");
  console.log("Nothing was written. Re-run with --write to commit.");
  console.log("Rows land with is_published = false; publishing is a separate, deliberate step.");
}

// ============================================================
// Pieces
// ============================================================

// One person, forwarded field by field. `mobile` cannot reach the network from
// here because it is not in FORWARD, and could not be used if it did because
// the function allowlists on arrival too.
async function buildOne(raw) {
  const person = {};
  for (const k of FORWARD) if (raw[k] !== undefined) person[k] = raw[k];

  const startedAt = Date.now();
  let attempt = 0;

  for (;;) {
    attempt++;
    let failure;

    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/build-prospect-profile`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ person }),
      });

      // The body is read on every path, success or not. This is the line whose
      // absence caused the whole problem: the old code threw on `res.status`
      // from inside the retry helper and never looked at what the function had
      // said, so "rate_limited" — written, returned, and sitting right there
      // in the payload — was invisible at both layers.
      const data = await res.json().catch(() => null);

      if (res.ok && data && !data.error) return data;
      failure = readFunctionError(res, data);
    } catch (err) {
      // Never reached the function at all. Distinguished from every status
      // above because the remedy is different: this is the network or the
      // project URL, not anything the function decided.
      failure = buildFailure({
        code: "network_error",
        status: 0,
        message: `The request never completed: ${String(err?.message ?? err)}`,
        retryable: true,
        retryAfterMs: null,
      });
    }

    failure.attempts = attempt;
    if (failure.code === "rate_limited") pacer.rateLimit(failure.retryAfterMs);

    const plan = planRetry({
      attempt,
      maxAttempts: RETRY_MAX_ATTEMPTS,
      elapsedMs: Date.now() - startedAt,
      deadlineMs: PERSON_DEADLINE_MS,
      reserveMs: PERSON_RESERVE_MS,
      retryable: failure.retryable,
      retryAfterMs: failure.retryAfterMs,
      rand: Math.random,
    });

    if (!plan.retry) throw failure;

    process.stderr.write(
      `  retrying <${String(raw.ms365_mailbox).toLowerCase()}> in ${Math.round(plan.delayMs / 100) / 10}s (${failure.code}, attempt ${attempt} of ${RETRY_MAX_ATTEMPTS})\n`,
    );
    await sleep(plan.delayMs);
  }
}

// Everything a non-2xx from the function means, read out of the body first and
// off the status only as a fallback. `lib/profile-form.js` does exactly this on
// the browser side — `error.context.json()` for the function's own wording,
// then a status-by-status fallback — and the reasoning is the same here: the
// function knows what happened and this script does not, so anything it wrote
// beats anything that could be inferred out here.
//
// `code` is trusted when present because the function is the only thing that
// answers on this path and it sets one on every failure. Where it is absent —
// an older deployment, or a platform error page from in front of the function
// — the status is used, which is what the status is for.
function readFunctionError(res, data) {
  const status = res.status;
  const fromBody = data && typeof data === "object" ? data : {};

  // `Retry-After` twice over: the header for anything that speaks HTTP, and
  // the body field for the case where a proxy stripped it. Whichever is
  // present, the number is OpenAI's own and beats our backoff curve.
  const headerRetry = Number(res.headers?.get?.("retry-after") ?? "");
  const bodyRetry = Number(fromBody.retry_after ?? NaN);
  const retryAfterMs = Number.isFinite(bodyRetry) && bodyRetry > 0
    ? bodyRetry * 1000
    : Number.isFinite(headerRetry) && headerRetry > 0
    ? headerRetry * 1000
    : null;

  if (fromBody.code) {
    return buildFailure({
      code: String(fromBody.code),
      status,
      message: String(fromBody.error ?? `build-prospect-profile ${status}`),
      // The function decides this, not the status: `quota_exhausted` and
      // `rate_limited` are both HTTP 429 from OpenAI's side and only one of
      // them is worth trying again.
      retryable: fromBody.retryable === true,
      retryAfterMs,
    });
  }

  const retryable = status === 429 || status === 408 || status >= 500;
  return buildFailure({
    code: status === 429 ? "rate_limited" : "http_error",
    status,
    message: fromBody.error
      ? String(fromBody.error)
      : `build-prospect-profile answered ${status} with no readable body`,
    retryable,
    retryAfterMs,
  });
}

function buildFailure({ code, status, message, retryable, retryAfterMs }) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.retryable = retryable;
  err.retryAfterMs = retryAfterMs;
  err.attempts = 1;
  return err;
}

// ---- The same two decisions the function makes, with a longer budget ----
//
// Kept structurally identical to `planRetry`/`backoffDelayMs` in
// `supabase/functions/build-prospect-profile/index.ts` on purpose: two layers
// backing off on different curves, with different opinions about what is
// transient, is how a retry storm gets built. Only the constants differ, and
// they differ because one layer is inside a wall-clock-limited invocation and
// this one is not.
function planRetry(opts) {
  if (!opts.retryable) return { retry: false, delayMs: 0, reason: "not_retryable" };
  if (opts.attempt >= opts.maxAttempts) {
    return { retry: false, delayMs: 0, reason: "attempts_exhausted" };
  }
  const delayMs = backoffDelayMs(opts.attempt, opts.retryAfterMs, opts.rand);
  if (opts.elapsedMs + delayMs + opts.reserveMs > opts.deadlineMs) {
    return { retry: false, delayMs, reason: "budget_exhausted" };
  }
  return { retry: true, delayMs, reason: "retry" };
}

// Exponential with equal jitter — half the window fixed, half random — so four
// workers that were rate-limited by the same response do not come back in
// lockstep. A `Retry-After` wins outright when it is longer: it is the only
// number in play that came from the service doing the limiting.
function backoffDelayMs(attempt, retryAfterMs, rand) {
  const window = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
  const jittered = Math.round(window / 2 + rand() * (window / 2));
  return Math.max(jittered, retryAfterMs ?? 0);
}

// The row as it will be sent to PostgREST: the writable columns only, plus the
// bookkeeping this script owns. `sources` gets a `_meta` key alongside the
// per-field provenance entries the function produced. The underscore keeps it
// out of the way of 0027's checks, which ask `sources ? 'bio'` and friends —
// no column is ever named `_meta`, so the two namespaces cannot collide.
function toPayload(row) {
  const out = {};
  for (const k of WRITABLE) if (row[k] !== undefined) out[k] = row[k];
  out.updated_at = out.built_at ?? new Date().toISOString();
  out.sources = {
    ...(row.sources ?? {}),
    _meta: {
      tool: TOOL_ID,
      built_at: out.built_at,
      // Computed last, over the payload as it will be stored. Recomputing this
      // from the row on a later run is how a human edit is detected.
      fingerprint: null,
    },
  };
  out.sources._meta.fingerprint = fingerprint(out);
  return out;
}

// A stable hash of the content fields. Key order is fixed by FINGERPRINTED and
// nested objects are serialised with sorted keys, so the same content always
// hashes the same way whether it came from this script or back out of
// PostgREST.
function fingerprint(row) {
  const canon = FINGERPRINTED.map((k) => [k, canonical(row[k] ?? null)]);
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 32);
}

function canonical(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === "object") {
    return Object.keys(v).sort().map((k) => [k, canonical(v[k])]);
  }
  return v;
}

async function selectExisting() {
  const cols = ["ms365_mailbox", "is_published", "claimed_by", "built_at", "updated_at", "sources", ...FINGERPRINTED];
  const res = await withRetry(() =>
    fetch(`${SUPABASE_URL}/rest/v1/prospect_profiles?select=${cols.join(",")}`, {
      headers: restHeaders(),
    })
  );
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  const rows = await res.json();
  return new Map(rows.map((r) => [String(r.ms365_mailbox).toLowerCase(), r]));
}

// Upsert on the unique key 0027 defines. `merge-duplicates` updates only the
// columns present in the payload, which is what keeps `is_published` and
// `claimed_by` out of reach — they are not sent, so they are not touched.
async function upsert(payload) {
  const res = await withRetry(() =>
    fetch(`${SUPABASE_URL}/rest/v1/prospect_profiles?on_conflict=ms365_mailbox`, {
      method: "POST",
      headers: {
        ...restHeaders(),
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(payload),
    })
  );
  if (!res.ok) {
    // Given a code like every other failure so the report can group it and
    // say what to do. Without one it lands in the "unknown" bucket, which is
    // the same not-quite-an-answer the old `HTTP 500` was.
    throw buildFailure({
      code: "upsert_failed",
      status: res.status,
      message: `The row was composed but PostgREST refused the write: ${(await res.text()).slice(0, 300)}`,
      retryable: false,
      retryAfterMs: null,
    });
  }
}

function restHeaders() {
  return {
    "apikey": SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
  };
}

// Retries the transient things only: rate limits, gateway errors, and network
// resets. A 400 or a 403 is an answer, not a hiccup, and repeating it three
// times only makes the log longer.
//
// PostgREST only — `buildOne` no longer comes through here, because "retry on
// the status code" is exactly the behaviour that hid 29 rate limits behind
// `HTTP 500`. What is left is the two calls where the status genuinely is the
// whole answer, and even those now carry the body: a PostgREST error names the
// column or the constraint, and `HTTP 400` on its own has sent people looking
// at the wrong table before.
async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fn();
      if (res.status === 429 || res.status >= 500) {
        const detail = await res.text().catch(() => "");
        lastErr = new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
        const retryAfter = Number(res.headers?.get?.("retry-after") ?? "");
        await sleep(backoffDelayMs(
          i + 1,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
          Math.random,
        ));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      await sleep(backoffDelayMs(i + 1, null, Math.random));
    }
  }
  throw lastErr ?? new Error("request failed");
}

// A tiny worker pool. One at a time by default: the OpenAI call inside the
// function is the slow part and 87 of them is a few minutes, which is not worth
// risking a rate limit over. --concurrency raises it, capped at 4.
async function runPool(items, size, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// A declaration, not `const sleep = …`. The first thing this script does is a
// top-level `await selectExisting()`, which runs long before this line is
// reached — so an arrow function assigned to a const would still be in its
// temporal dead zone, and the very first network retry would fail with a
// ReferenceError instead of retrying.
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function has(name) { return argv.includes(name); }

function takeValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
}

function takeAll(name) {
  const out = [];
  argv.forEach((a, i) => { if (a === name && argv[i + 1]) out.push(argv[i + 1]); });
  return out;
}

function fatal(msg) { console.error(`\n${msg}\n`); process.exit(1); }
function fatalUnless(cond, msg) { if (!cond) fatal(msg); }
