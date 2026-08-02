// GENERATED - do not edit. Deploy-time twin of index.ts with the ../_shared/cors.ts
// import replaced by the corsHeaders object inline, and nothing else. The Supabase
// dashboard editor deploys one function directory at a time and cannot reach a
// shared parent file. Edit index.ts and regenerate; the two must stay in step.

// build-prospect-profile
// ------------------------------------------------------------
// Composes ONE `prospect_profiles` row from the material harvested out of the
// four EduHackAI SharePoint `Members` lists. It returns the row shape. It does
// not write it — `tools/import-prospects.mjs` decides what to persist, so that
// "what gets composed" and "what reaches the database" stay two separately
// reviewable decisions.
//
// ============================================================
// The rule this function exists to enforce
// ============================================================
//
// These profiles get screenshotted and sent to the people they describe, as an
// invitation. Anything invented is a false claim made to someone's face. So
// the model's job here is **transcription and tidying, not authorship**:
//
//   * it may fix capitalisation, punctuation and spacing, and join facts the
//     person themself submitted into one readable sentence;
//   * it may NOT infer a skill from a job title, infer seniority, infer an
//     employer from an email domain, or add a single adjective of praise that
//     no source supports.
//
// Instruction is not enough for that. A model told "do not invent" still
// occasionally rounds a job title up. So every rule below is *also* a check
// applied to what comes back:
//
//   * `skills` is intersected in code with the twelve values the person
//     actually ticked. The model cannot extend the list; if it tries, the
//     extra values are dropped and logged.
//   * `position` and `company` must fold to exactly the source string
//     (case/punctuation-insensitive). Anything else falls back to the source
//     verbatim — a "normalised" employer name is a different employer.
//   * `bio` must not be materially longer than the text it came from, and must
//     reuse that text's own content words. Tidying does not add material; a
//     300-character biography out of a 40-character note is invention with a
//     paraphrase on top.
//   * `city` and `years_experience` are not in the schema the model is shown,
//     because the source has neither field and a model asked for them produces
//     a plausible number. They are returned NULL, always, for everyone.
//
// ============================================================
// Two things the harvest does NOT give us, stated so nobody assumes otherwise
// ============================================================
//
// 1. **A LinkedIn URL is not a LinkedIn profile.** The harvest recorded the URL
//    the person typed into the list. It did not fetch the page, and neither
//    does this function. So a LinkedIn URL earns a person a row and a link —
//    never a sentence. If the model were allowed to "use" a LinkedIn it would
//    be writing from training data about a name it recognises, which is the
//    worst version of the failure this whole file is built to prevent.
//
// 2. **Team, round and creator facts are deliberately not passed to the model.**
//    They already reach the UI through `prospect_directory.hackathons`, and
//    `Members.IsCreator` was consciously left out of the hackathon seed (see
//    `supabase/seed/hackathons/README.md`) because no column holds it honestly.
//    Handing them to a writer invites "led the team that…" — a claim about
//    someone's standing among their peers, from a checkbox.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   OPENAI_API_KEY
//   OPENAI_MODEL                             — optional, defaults below
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// ---- inlined from ../_shared/cors.ts ----
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-5";

// ============================================================
// What "it failed" is allowed to mean
// ============================================================
//
// A live import of 87 people failed 29 times with a bare `HTTP 500`. Every one
// of them was an OpenAI 429: `askModel` threw `new Error("rate_limited")` and
// the outer catch turned every throw, of every kind, into
// `json({ error }, 500)`. Two consecutive runs then failed on *different*
// people — six that had succeeded now failed and four the reverse — which is
// the signature of a timing problem wearing a server error's clothes. Nobody
// could see that, because a 500 says "this request is broken, stop sending it"
// and a 429 says "this request is fine, send it again in a moment", and the
// caller was told the first thing about the second situation.
//
// So every failure below now carries three things, and the third is the one
// that was missing:
//
//   * a **status** the caller can act on without parsing English;
//   * a **code**, stable and machine-readable, because a sentence written for
//     a member is a sentence somebody will reword;
//   * whether it is **retryable**, decided here — at the only place that knows
//     what actually went wrong — rather than guessed from the status code by
//     each caller in turn.
//
// The triage itself is `generate-avatar`'s, kept deliberately in the same
// order (model name, credentials, rate limit, then a general fallback) so the
// two functions cannot drift into two different opinions about the same
// upstream. What is added here is the status/code/retryable trio and the
// separation of quota from rate limit: both arrive as HTTP 429 and only one of
// them ever clears on its own.
//
// Messages stay member-readable sentences. `build-prospect-profile` is called
// by staff tooling today, but the surrounding functions surface `error`
// verbatim to members (see `lib/profile-form.js` readInvokeError, which prefers
// the function's own wording over anything it could write itself), and a code
// in that slot would eventually reach somebody's screen.
//
// The whole set, so a caller can be written against it without reading the
// code — `retryable` is the column that matters, and it is not derivable from
// the status (429 appears in both halves):
//
//   code                       status  retryable  meaning
//   ------------------------   ------  ---------  --------------------------
//   rate_limited                  429  yes        OpenAI is throttling us
//   upstream_error                502  yes        OpenAI 5xx/408
//   upstream_timeout              502  yes        our own attempt timeout
//   upstream_unreachable          502  yes        the request never completed
//   upstream_bad_response         502  yes        200 with nothing usable in it
//   quota_exhausted               402  no         the OpenAI balance is spent
//   ai_unconfigured               503  no         OPENAI_API_KEY not set
//   ai_credentials                503  no         OPENAI_API_KEY rejected
//   model_not_configured          503  no         OPENAI_MODEL unusable
//   not_configured                503  no         no service-role key here
//   model_refused                 422  no         the model declined this text
//   bad_request                   400  no         the caller sent nonsense
//   not_signed_in / not_allowed   401/403  no     the caller is not staff
//   output_truncated              500  no         our token ceiling is too low
//   upstream_rejected_request     500  no         we sent OpenAI a bad request
//   sources_audit_failed          500  no         a composed field has no source
//   internal_error                500  no         an unhandled bug in here
//
// Every failure also carries `retry_after` (seconds) when OpenAI told us one,
// alongside the `Retry-After` header.
class ProfileError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  attempts = 1;

  constructor(
    code: string,
    status: number,
    message: string,
    opts: { retryable?: boolean; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
    this.status = status;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

// ============================================================
// The retry budget, and why it is this small
// ============================================================
//
// A rate limit is transient by definition, so the first place to absorb one is
// here — retrying inside the invocation costs the caller one round trip
// instead of one failed person. But an Edge Function has a wall-clock limit
// (150s on the free plan), and a function killed mid-retry is worse than one
// that answered honestly: the caller gets a dead connection instead of a 429
// it could have acted on.
//
// So the budget is bounded twice, and by wall clock rather than by attempt
// count alone:
//
//   * at most RETRY_MAX_ATTEMPTS attempts, total, per invocation;
//   * no new attempt may *start* once RETRY_DEADLINE_MS of wall clock has
//     passed, and a retry is only started if the sleep plus RETRY_RESERVE_MS
//     of room for the attempt itself still fits inside that deadline;
//   * every attempt is aborted at ATTEMPT_TIMEOUT_MS, so one hung socket
//     cannot silently consume the whole budget.
//
// Worst case is therefore an attempt starting at 50s and being aborted at 80s
// — comfortably inside 150s, with the margin left for the Supabase client
// handshake, the auth lookup and the response write.
//
// Anything needing a longer wait than that is *not* absorbed here. It is
// returned as a 429 with `Retry-After`, because a caller with a queue of 87
// people can wait 60 seconds cheaply and a function holding a socket open
// cannot. That division — seconds here, minutes in the importer — is the whole
// arrangement.
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 8_000;
const RETRY_DEADLINE_MS = 50_000;
const RETRY_RESERVE_MS = 15_000;
const ATTEMPT_TIMEOUT_MS = 30_000;

// ============================================================
// Where a value came from, in a form somebody can go and check
// ============================================================
//
// Each round is a separate SharePoint site with its own `Members` list, so a
// source string that names the site is directly resolvable:
//   https://lawauedu.sharepoint.com/sites/EduHackAI_3/Lists/Members
//
// The harvest de-duplicates values across a person's rounds, so for the nine
// people who did more than one round it is not recoverable *which* round's row
// a given note came from. Those get every site they appear in, which is the
// honest statement: it came from this person's Members row in one of these.
const ROUND_SITE: Record<number, string> = {
  1: "EduHackAI",
  2: "EduHackAI-2401",
  3: "EduHackAI_3",
  4: "EduHackAI_4",
};

// ============================================================
// The twelve skills
// ============================================================
//
// `Skills` in the source is a fixed multi-choice, not free text. Pinning the
// vocabulary here means a model that returns "Machine Learning" or "Azure AI"
// — plausible, adjacent, and not what the person ticked — is caught rather
// than published. Matching is case- and punctuation-insensitive so "azureai"
// and "Azure AI" both fold onto the real value, but nothing outside this list
// survives.
const SKILL_VOCABULARY = [
  "Power Platform",
  "AzureAI",
  "Prompt Engineering",
  "GenAI",
  "ASP.NET Core",
  "REST API Developer",
  "Testing",
  "Data Science & ML",
  "Cloud Infrastructure",
  "Python",
  "JavaScript",
  "HTML/CSS",
] as const;

// ============================================================
// The minimum-signal threshold
// ============================================================
//
// `Headline` in the source is an optional free-text Note. 88 people filled it;
// the median is 31 characters. Some of what came back is not a headline at all
// — the literal values include "HELLO", ".....", "Ope", "Exactly" and
// "I am confused." — and one person typed their own first name into it while
// another typed their country.
//
// Two separate thresholds, because the two fields fail differently:
//
//   * A **headline** is a label. "IT Manager" is ten characters and perfectly
//     good. So the headline filter only has to reject non-content: values with
//     fewer than two letters, values on the interjection list below, and
//     values that are just the person's own name or their own country repeated
//     back. Everything surviving is carried across as the person wrote it.
//
//   * A **bio** is prose, and prose is the field a model will happily
//     manufacture from a two-word label. So a bio is composed only where the
//     person actually wrote prose: after junk filtering, their note text must
//     reach BIO_MIN_CHARS characters AND BIO_MIN_WORDS words AND contain at
//     least one word of four or more letters. Below that there is nothing to
//     tidy — there is only something to expand, and expanding is authoring.
//
// 40 characters / 6 words sits just above the median deliberately. Roughly half
// the notes in this data are labels like "AI Developer" or "Solution
// Architect", and the correct outcome for those is `headline` set, `bio` NULL.
// A short profile is not a failed profile.
const BIO_MIN_CHARS = 40;
const BIO_MIN_WORDS = 6;
const BIO_MIN_LONG_WORDS = 1; // at least one word of 4+ letters

// Values that are a keystroke, a greeting or a shrug rather than an answer.
// Compared after lowercasing and trimming. Kept deliberately short: this list
// removes non-content, it is not a taste filter, and anything a person
// genuinely meant should survive it.
const NON_CONTENT = new Set([
  "hello", "hi", "hey", "hallo", "salam",
  "ok", "okay", "k", "yes", "no", "none", "nil", "n/a", "na", "nan",
  "exactly", "ope", "nothing", "nothing yet", "not yet", "no comment",
  "i am confused", "i am confused.", "confused",
  "test", "testing", "test1", "asd", "asdf", "qwerty",
  "-", ".", "..", "...", "....", ".....", "x", "xx", "xxx", "0", "1",
]);

// The same list of placeholders the hackathon seed replaced with NULL in
// `CurrentCompany`. They reappear here because this reads the raw harvest, not
// the seeded table.
const PLACEHOLDER = new Set([
  "no", "none", "-", ".", "test", "1st", "first", "lower", "self",
  "na", "n/a", "nil", "null", "nothing", "student", // "student" only as a company
]);

// ============================================================
// What the model is allowed to return
// ============================================================
//
// Note what is absent: `city`, `years_experience`, `industry`, `interests`,
// `work_history`. The source has no city, no years-of-experience, no industry
// and no dated employment history, so none of them appear here — a field a
// model is asked for is a field a model will fill. They are set NULL / empty by
// `buildRow` below and can only become non-NULL when a real source exists.
const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    headline: {
      type: ["string", "null"],
      description:
        "The person's own note, tidied: fixed capitalisation, spacing and punctuation only. Same words, same meaning, same length. Null if the note carries no meaning.",
    },
    bio: {
      type: ["string", "null"],
      description:
        "The person's own note rewritten as one or two readable sentences, adding no fact that is not already in it. Null unless the note is genuinely descriptive prose.",
    },
    position: {
      type: ["string", "null"],
      description:
        "The supplied job title with its capitalisation and spacing fixed. Never reworded, never a different title. Null if none was supplied.",
    },
    company: {
      type: ["string", "null"],
      description:
        "The supplied employer name with its capitalisation and spacing fixed. Never expanded from an abbreviation, never resolved to a company you recognise. Null if none was supplied.",
    },
    skills: {
      type: "array",
      items: { type: "string" },
      description:
        "Exactly the skills supplied in `selected_skills`, unchanged. Never add one, never rename one, never infer one from a job title.",
    },
  },
  required: ["headline", "bio", "position", "company", "skills"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT =
  `You are transcribing, not writing. You are given what one person typed into a hackathon registration form. Your output will be shown to that person as "here is the profile the club has for you", so anything you add that they did not say is a false statement made to their face.

Rules, in order of importance:

1. Add nothing. Every fact in your output must already be in the input. No inferred seniority, no inferred employer, no inferred skill, no "experienced", "passionate", "skilled", "dedicated", or any other adjective the input does not contain.
2. You may fix capitalisation, spelling, punctuation, spacing and grammar, and you may join two supplied facts into one sentence. That is the entire scope of what you may change.
3. Never infer a skill from a job title. \`skills\` must be exactly the list in \`selected_skills\`, copied across unchanged. If that list is empty, return an empty array.
4. Do not guess what an abbreviation stands for. If the employer is written "TST", it stays "TST".
5. If the note is not meaningful — a greeting, a keyboard mash, a single punctuation run, the person's own name, their country — return null for both headline and bio. Returning null is a correct answer, not a failure. Do not replace an empty note with a description of the person.
6. \`bio\` must be null unless the note is real descriptive prose. A two-word job label is a headline, not a biography. Never inflate a label into sentences.
7. Never state or imply how long someone has worked, how senior they are, where they live, or what industry they are in. You have not been told any of those things.
8. Write in the third person, plainly. No marketing language, no exclamation marks, no emoji, no hashtags, no markdown, no square-bracket placeholders.
9. Keep the person's own language. If they wrote in Arabic, the bio stays in Arabic.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Taken here rather than inside `askModel` so the retry budget is measured
  // against the invocation's own wall clock — the auth lookup and the body
  // read have already spent some of it by the time the model is called.
  const startedAt = Date.now();

  try {
    if (!SERVICE_ROLE_KEY) {
      return fail(new ProfileError("not_configured", 503, "Not configured"));
    }
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ---- Staff only ----
    //
    // Same gate as `provision-ms365`'s `diagnose` action, and checked here in
    // the function body for the same reason: this runs with the service role,
    // so RLS is bypassed and the database will not refuse anything on our
    // behalf. If this check is not made, it is not made.
    //
    // The service-role bearer is also accepted, because the only production
    // caller is `tools/import-prospects.mjs` running on a staff machine with
    // the service key in its environment — the same arrangement
    // `write-member-intro` uses for its scheduled backfill. A member's JWT can
    // never satisfy either branch.
    const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
    if (bearer !== SERVICE_ROLE_KEY) {
      const { data: userData, error: userError } = await admin.auth.getUser(bearer);
      if (userError || !userData.user) {
        return fail(new ProfileError("not_signed_in", 401, "Not signed in"));
      }
      const { data: callerProfile } = await admin
        .from("profiles")
        .select("role")
        .eq("user_id", userData.user.id)
        .maybeSingle();
      if (callerProfile?.role !== "staff" && callerProfile?.role !== "admin") {
        console.error(`non-staff user ${userData.user.id} attempted build-prospect-profile`);
        return fail(new ProfileError("not_allowed", 403, "Not allowed"));
      }
    }

    const body = await req.json().catch(() => ({}));
    const raw = body?.person;
    if (!raw || typeof raw !== "object") {
      return fail(new ProfileError("bad_request", 400, "person is required"));
    }

    // ---- Allowlist, before anything else touches the payload ----
    //
    // The harvest file also carries a mobile number for every one of the 134
    // people. Nothing here needs one, so rather than trusting the caller to
    // have stripped it, the payload is rebuilt field by field from names this
    // function knows about. A key the allowlist does not mention cannot reach
    // the model, the log, or the response — including one added to the harvest
    // later by somebody who did not read this comment.
    const person = takeAllowedFields(raw);

    if (!person.ms365_mailbox) {
      return fail(new ProfileError("bad_request", 400, "person.ms365_mailbox is required"));
    }

    const material = distil(person);

    // ---- The gate: no LinkedIn and nothing self-submitted means no row ----
    //
    // Ahmed's rule, and 0027 says why it lives in code rather than in a CHECK
    // constraint: "has something worth publishing" is a judgement about content.
    // This is that judgement, made once, here, so the importer and any future
    // caller cannot each invent their own version of it.
    //
    // Note the order: the junk filter has already run, so somebody whose only
    // contribution was "HELLO" reaches this line with nothing and is skipped —
    // exactly as if they had left the field blank, which is what they did.
    if (!material.linkedinUrl && material.noteText === "" && material.skills.length === 0) {
      return json({
        ok: true,
        skipped: true,
        reason: "no_signal",
        ms365_mailbox: person.ms365_mailbox,
        full_name: material.fullName,
      });
    }

    // ---- Composition ----
    //
    // If there is no free text at all — a LinkedIn URL and a skills tick-list,
    // say — there is nothing for a model to tidy. The row is assembled from the
    // source values directly. That is not an optimisation: a model call with
    // nothing to transcribe is a model call with nothing to do but invent, and
    // skipping it removes the risk rather than guarding against it.
    let written: Written = {
      headline: null,
      bio: null,
      position: material.position,
      company: material.company,
      skills: material.skills,
    };
    let usedModel = false;

    if (material.noteText !== "" || material.position || material.company) {
      if (!OPENAI_API_KEY) {
        console.error("OPENAI_API_KEY is not set");
        return fail(new ProfileError(
          "ai_unconfigured",
          503,
          "The AI writer isn't configured yet. Set OPENAI_API_KEY in the Edge Function secrets.",
        ));
      }
      const draft = await askModel(material, startedAt);
      written = validate(draft, material, person.ms365_mailbox);
      usedModel = true;
    }

    // `built_model` records which model wrote it — 0027 keeps the column "for
    // when one turns out to embellish". Null where no model was involved,
    // which is the truthful answer for a row assembled straight from the
    // source values, and a materially different provenance claim.
    const row = buildRow(person, material, written, usedModel ? MODEL : null);

    // ---- The provenance self-check ----
    //
    // 0027: "A populated field with no entry in `sources` is a bug: it means
    // something was written that nobody can attribute to a source." The
    // migration ships a verification query that catches it after the fact. This
    // catches it before the write, because a row that fails it must not be
    // offered to the importer at all.
    const untraceable = auditSources(row);
    if (untraceable.length) {
      console.error(
        `sources audit failed for ${person.ms365_mailbox}: populated with no source: ${untraceable.join(", ")}`,
      );
      // A genuine bug, and one that must not be retried: the same input will
      // compose the same untraceable field every time. 500 with a code that
      // says which bug it is.
      return fail(
        new ProfileError(
          "sources_audit_failed",
          500,
          "Composed a field with no source — refusing to return it",
        ),
        { fields: untraceable },
      );
    }

    return json({ ok: true, skipped: false, usedModel, model: usedModel ? MODEL : null, row });
  } catch (err) {
    // The line this whole change exists for. Before, every throw landed here
    // and became a 500 — including `new Error("rate_limited")`, which is the
    // one failure in the set that is neither our fault nor permanent. A
    // ProfileError already knows what it is; anything else genuinely is a bug
    // in this function and keeps the 500 it always had.
    if (err instanceof ProfileError) {
      console.error(`build-prospect-profile ${err.code} after ${err.attempts} attempt(s): ${err.message}`);
      return fail(err);
    }
    console.error(err);
    return fail(new ProfileError(
      "internal_error",
      500,
      String(err instanceof Error ? err.message : err),
    ));
  }
});

// One shape for every failure, so a caller can branch on `code` and never has
// to read `error` to find out what happened. `Retry-After` is a real header as
// well as a body field: the header is what a proxy or an HTTP client honours
// automatically, the body field is what survives a client that does not expose
// headers to script (a browser, without the explicit expose list below).
function fail(err: ProfileError, extra: Record<string, unknown> = {}): Response {
  const retryAfterSeconds = err.retryAfterMs === null
    ? null
    : Math.max(1, Math.ceil(err.retryAfterMs / 1000));

  const headers: Record<string, string> = {};
  if (retryAfterSeconds !== null) {
    headers["Retry-After"] = String(retryAfterSeconds);
    headers["Access-Control-Expose-Headers"] = "Retry-After";
  }

  return json({
    error: err.message,
    code: err.code,
    retryable: err.retryable,
    ...(retryAfterSeconds !== null ? { retry_after: retryAfterSeconds } : {}),
    ...extra,
  }, err.status, headers);
}

// ============================================================
// Input handling
// ============================================================

type Person = {
  ms365_mailbox: string;
  rounds: number[];
  names: string[];
  personal_emails: string[];
  linkedin_url: string;
  linkedin_raw_invalid: string;
  headlines: string[];
  skills: string[];
  current_position: string[];
  current_company: string[];
  country: string[];
  country_of_residence: string[];
};

// Deliberately absent from this list, and therefore unreachable from here:
// `mobile`, `photo_filenames`, `teams`, `roles`, `is_team_creator`.
// The first is contact detail nothing here needs. The second points at
// SharePoint attachment blobs, not URLs anything outside the tenant can fetch.
// The last three are hackathon facts that already reach the UI through
// `prospect_directory.hackathons`, and that a writer would turn into claims
// about someone's standing among their peers.
function takeAllowedFields(raw: Record<string, unknown>): Person {
  return {
    ms365_mailbox: str(raw.ms365_mailbox).toLowerCase(),
    rounds: Array.isArray(raw.rounds)
      ? raw.rounds.map((r) => Number(r)).filter((r) => Number.isFinite(r))
      : [],
    names: list(raw.names),
    personal_emails: list(raw.personal_emails),
    linkedin_url: str(raw.linkedin_url),
    linkedin_raw_invalid: str(raw.linkedin_raw_invalid),
    headlines: list(raw.headlines),
    skills: list(raw.skills),
    current_position: list(raw.current_position),
    current_company: list(raw.current_company),
    country: list(raw.country),
    country_of_residence: list(raw.country_of_residence),
  };
}

type Material = {
  fullName: string;
  nameSource: string;
  email: string | null;
  noteText: string;
  noteParts: string[];
  bioEligible: boolean;
  skills: string[];
  position: string | null;
  company: string | null;
  country: string | null;
  countryColumn: string | null;
  linkedinUrl: string | null;
  sites: string[];
};

// Everything the rest of the function reasons about, derived once, in code.
// Nothing below this point re-reads the raw harvest.
function distil(p: Person): Material {
  const sites = uniq(
    p.rounds.map((r) => ROUND_SITE[r]).filter(Boolean),
  );

  // Name. The four people spelled differently across rounds keep the spelling
  // from their most recent round — their latest self-entry, and the only
  // non-arbitrary choice available. Where the harvest could not keep names
  // parallel to rounds (six people, because identical spellings were
  // de-duplicated) the longest form is used, on the reasoning that "Sidratul
  // Hayat Khan" is more likely the full name than "Sidratul H".
  let fullName = "";
  if (p.names.length === p.rounds.length && p.names.length > 0) {
    let best = 0;
    for (let i = 1; i < p.rounds.length; i++) if (p.rounds[i] > p.rounds[best]) best = i;
    fullName = p.names[best];
  } else {
    fullName = [...p.names].sort((a, b) => b.length - a.length)[0] ?? "";
  }

  // Their own address, where the source recorded one that is not simply the
  // tenant mailbox echoed back (three people typed their @sahabaclub.com
  // address into the personal-email box).
  const email = p.personal_emails
    .map((e) => e.trim())
    .find((e) => e && e.toLowerCase() !== p.ms365_mailbox) ?? null;

  // Notes, junk-filtered. Values equal to the person's own name or their own
  // country are dropped: they are the form being misread, not a headline.
  const selfWords = new Set(
    [...p.names, ...p.country, ...p.country_of_residence]
      .map(fold)
      .filter(Boolean),
  );
  const noteParts = uniq(
    p.headlines
      .map((h) => h.trim())
      .filter((h) => h !== "")
      .filter((h) => !NON_CONTENT.has(h.toLowerCase()))
      .filter((h) => letters(h).length >= 2)
      .filter((h) => !selfWords.has(fold(h)))
      // A single character repeated is punctuation, whatever character it is.
      .filter((h) => new Set(h.replace(/\s+/g, "")).size > 1),
  );
  const noteText = noteParts.join(" — ");

  const words = noteText.split(/\s+/).filter(Boolean);
  const bioEligible = noteText.length >= BIO_MIN_CHARS &&
    words.length >= BIO_MIN_WORDS &&
    words.filter((w) => letters(w).length >= 4).length >= BIO_MIN_LONG_WORDS;

  // Position and company. The multi-round people can carry two values; the
  // most recent round's is not identifiable, so the longest is taken and the
  // source names every site — the same honest compromise as the notes.
  const position = pickValue(p.current_position, selfWords);
  const company = pickValue(p.current_company, selfWords);

  // `Country` and `Countryofresidence` are different fields with different
  // values for a quarter of these people — the pair reads as nationality
  // versus residence. `prospect_profiles` has one `country` column, so they
  // are NOT merged: residence wins, because that is what a member directory
  // means by "country", and `sources.country` records which of the two columns
  // the value actually came from. The other value is dropped rather than
  // squeezed in somewhere it would be misread. See the harvest README.
  let country: string | null = pickValue(p.country_of_residence, new Set<string>());
  let countryColumn: string | null = country ? "Members.Countryofresidence" : null;
  if (!country) {
    country = pickValue(p.country, new Set<string>());
    countryColumn = country ? "Members.Country" : null;
  }

  // Three people typed something other than a URL into the LinkedIn field —
  // an email address, and two who typed their own names. The harvest kept
  // those under `linkedin_raw_invalid`, which is read here only so that it is
  // visibly *not* used: a link that is not a link must never be published as
  // one, and an email address published as a "LinkedIn" would be a contact
  // detail leaking through a field nobody checked.
  const linkedinUrl = normaliseLinkedIn(p.linkedin_url);

  return {
    fullName,
    nameSource: `sharepoint:${sitePrefix(sites)}/Members.'First Name'+'Last Name'`,
    email,
    noteText,
    noteParts,
    bioEligible,
    skills: canonicalSkills(p.skills),
    position,
    company,
    country,
    countryColumn,
    linkedinUrl,
    sites,
  };
}

// Only a real linkedin.com URL survives. Three people in the harvest typed
// something else into that box — one an email address, two their own name —
// and none of it is repaired here. Turning a typed-in name into
// `linkedin.com/in/<that-name>` would mint a link to whichever stranger owns
// that handle and publish it as this person's, and an email address rendered
// as a "LinkedIn" is a contact detail escaping through a field nobody checked.
function normaliseLinkedIn(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}

function pickValue(values: string[], reject: Set<string>): string | null {
  const kept = values
    .map((v) => v.trim())
    .filter((v) => v !== "")
    .filter((v) => !PLACEHOLDER.has(v.toLowerCase()))
    .filter((v) => letters(v).length >= 2)
    .filter((v) => !reject.has(fold(v)))
    .sort((a, b) => b.length - a.length);
  return kept[0] ?? null;
}

// Folds each supplied skill onto the fixed vocabulary. Anything that does not
// fold onto a real value is dropped — the source is a multi-choice, so a value
// outside the twelve means the harvest or the caller has gone wrong, and the
// right response is to lose the value rather than publish an unrecognised one.
function canonicalSkills(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const hit = SKILL_VOCABULARY.find((s) => fold(s) === fold(v));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

// ============================================================
// The model call
// ============================================================

type Written = {
  headline: string | null;
  bio: string | null;
  position: string | null;
  company: string | null;
  skills: string[];
};

// Retries the transient half of the taxonomy, in-process, and gives up early
// rather than late. `startedAt` is the invocation's start, not this function's:
// the budget being protected is the Edge Function's wall clock, and it has
// already been running for the auth lookup by the time we get here.
async function askModel(m: Material, startedAt: number): Promise<Written> {
  let attempt = 0;
  for (;;) {
    attempt++;
    let failure: ProfileError;
    try {
      return await askModelOnce(m);
    } catch (err) {
      // `askModelOnce` already classifies everything it knows about — including
      // a fetch that never completed. So anything arriving here unclassified is
      // a defect in this file (a JSON.parse over a malformed body, say), and it
      // must NOT be swept into the retryable bucket: retrying a bug three times
      // is three times the cost and the same wrong answer, reported as though
      // the network were at fault.
      if (err instanceof ProfileError) {
        failure = err;
      } else {
        console.error("build-prospect-profile: unclassified failure in askModel", err);
        failure = new ProfileError(
          "internal_error",
          500,
          String(err instanceof Error ? err.message : err),
        );
      }
      failure.attempts = attempt;
    }

    const plan = planRetry({
      attempt,
      maxAttempts: RETRY_MAX_ATTEMPTS,
      elapsedMs: Date.now() - startedAt,
      deadlineMs: RETRY_DEADLINE_MS,
      reserveMs: RETRY_RESERVE_MS,
      retryable: failure.retryable,
      retryAfterMs: failure.retryAfterMs,
      rand: Math.random,
    });

    if (!plan.retry) {
      // The distinction the caller needs: we stopped because we ran out of
      // room, not because the condition cleared. A rate limit that outlives
      // our budget is still a rate limit, and it leaves here as a 429 with
      // whatever wait OpenAI asked for — the importer has minutes to spend
      // where this function has seconds.
      console.error(
        `openai attempt ${attempt} failed (${failure.code}); not retrying: ${plan.reason}`,
      );
      throw failure;
    }

    console.warn(
      `openai attempt ${attempt} failed (${failure.code}); retrying in ${plan.delayMs}ms`,
    );
    await sleep(plan.delayMs);
  }
}

// ---- Should we go again, and how long do we wait? ---------------------
//
// Pure, and separated from the loop so it can be exercised without a network:
// every input is an argument, including the clock reading and the source of
// randomness. The three ways it says no are distinguished by `reason` because
// "we gave up" and "there was nothing to gain" are different operational
// facts and one of them means raise the budget.
function planRetry(opts: {
  attempt: number;
  maxAttempts: number;
  elapsedMs: number;
  deadlineMs: number;
  reserveMs: number;
  retryable: boolean;
  retryAfterMs: number | null;
  rand: () => number;
}): { retry: boolean; delayMs: number; reason: string } {
  if (!opts.retryable) return { retry: false, delayMs: 0, reason: "not_retryable" };
  if (opts.attempt >= opts.maxAttempts) {
    return { retry: false, delayMs: 0, reason: "attempts_exhausted" };
  }

  const delayMs = backoffDelayMs(opts.attempt, opts.retryAfterMs, opts.rand);

  // The reserve is room for the attempt the sleep is *for*. Without it the
  // budget check passes at 49s, the attempt starts, and the invocation is
  // killed holding a socket — which reaches the caller as a dead connection
  // rather than as the 429 it should have been.
  if (opts.elapsedMs + delayMs + opts.reserveMs > opts.deadlineMs) {
    return { retry: false, delayMs, reason: "budget_exhausted" };
  }
  return { retry: true, delayMs, reason: "retry" };
}

// Exponential with equal jitter: half the window fixed, half random. Full
// jitter would be better still for a thundering herd, but the herd here is at
// most `--concurrency 4` and the fixed half keeps the wait from collapsing to
// nearly zero on an unlucky draw, which is the failure mode that matters when
// there are only three attempts to spend.
//
// A `Retry-After` from OpenAI wins whenever it asks for longer than we would
// have waited anyway: it is the only party that knows when the window actually
// reopens. It is deliberately NOT capped here — `planRetry` compares the
// result against the remaining budget and declines the retry if it does not
// fit, which is a more honest answer than sleeping for less than we were told
// and being refused again.
function backoffDelayMs(attempt: number, retryAfterMs: number | null, rand: () => number): number {
  const window = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
  const jittered = Math.round(window / 2 + rand() * (window / 2));
  return Math.max(jittered, retryAfterMs ?? 0);
}

// ---- What OpenAI just told us -----------------------------------------
//
// Pure: status, body text and the parsed `Retry-After` in, a classified error
// out. The order matters and is `generate-avatar`'s, with one addition —
// quota is checked before the rate limit, because OpenAI reports an exhausted
// balance as HTTP 429 with `insufficient_quota` in the body. Treated as a rate
// limit it would be retried, backed off, retried again and reported as
// "busy" forever, when the true answer is that no amount of waiting will fix
// it and somebody has to go and add credit.
function triageOpenAI(status: number, detail: string, retryAfterMs: number | null): ProfileError {
  if (/model_not_found|does not exist|unknown model/i.test(detail)) {
    return new ProfileError(
      "model_not_configured",
      503,
      "The configured AI model name isn't valid. Set OPENAI_MODEL in the Supabase Edge Function secrets to a model your account can use.",
    );
  }
  if (/insufficient_quota|billing_hard_limit|exceeded your current quota|billing_not_active/i.test(detail)) {
    return new ProfileError(
      "quota_exhausted",
      402,
      "The AI account has run out of credit. Top up the OpenAI billing account, then run this again.",
    );
  }
  if (status === 401 || status === 403 || /invalid_api_key|incorrect api key/i.test(detail)) {
    // 503, not 502. 502 would say the upstream misbehaved; a key that OpenAI
    // rejects is our own configuration being wrong, which is the same class of
    // thing as the key being absent — and that already answers 503 four lines
    // up in the handler. Two statuses for one operator action ("go and fix the
    // secret") would be a distinction with nothing behind it. `profile-form.js`
    // also already maps 503 to "isn't configured on the server yet", which is
    // exactly what this is.
    return new ProfileError(
      "ai_credentials",
      503,
      "The AI service rejected our credentials. Check OPENAI_API_KEY.",
    );
  }
  if (status === 429) {
    return new ProfileError(
      "rate_limited",
      429,
      "The AI service is rate-limiting us right now. Nothing is wrong with this person's data — try them again in a moment.",
      { retryable: true, retryAfterMs },
    );
  }
  if (status === 408 || status === 409 || status >= 500) {
    return new ProfileError(
      "upstream_error",
      502,
      `The AI service couldn't answer just now (its status was ${status}). Try again shortly.`,
      { retryable: true, retryAfterMs },
    );
  }
  if (status === 400 || status === 422) {
    // OpenAI understood us and said no. That is this function's request being
    // wrong, which is a bug here — retrying it would only produce the same
    // refusal more expensively.
    return new ProfileError(
      "upstream_rejected_request",
      500,
      "The AI service rejected the request this function sent. That is a bug here, not a problem with the data.",
    );
  }
  return new ProfileError(
    "upstream_error",
    502,
    `The AI service couldn't answer just now (its status was ${status}). Try again shortly.`,
    { retryable: true, retryAfterMs },
  );
}

// `Retry-After` is seconds or an HTTP date. OpenAI also sends
// `x-ratelimit-reset-requests` / `-tokens` as a duration string ("6m0s",
// "1.5s", "200ms"), which is often the only one present on a 429 — reading it
// is the difference between waiting the right amount and guessing.
//
// Pure: takes a lookup function and the current time, so it can be tested
// without a Response and without a clock.
function parseRetryAfterMs(get: (name: string) => string | null, nowMs: number): number | null {
  const header = (get("retry-after") ?? "").trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  }
  for (const name of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const ms = parseDurationMs((get(name) ?? "").trim());
    if (ms !== null) return ms;
  }
  return null;
}

// "6m0s", "1.5s", "200ms", "1h2m3s" → milliseconds. Anything that is not
// wholly made of duration parts returns null rather than a number built out of
// the parts it recognised: half-parsing "soon" into 0 would look like an
// instruction to retry immediately.
function parseDurationMs(v: string): number | null {
  if (!v) return null;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/gy;
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let total = 0;
  let end = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = re.exec(v)) !== null) {
    total += Number(match[1]) * unit[match[2]];
    // Recorded inside the loop, not read off `re` afterwards: a sticky regex
    // resets `lastIndex` to 0 the moment `exec` fails, which is exactly when
    // this loop ends. Reading it after the loop compares 0 against the string
    // length and rejects every well-formed duration there is.
    end = re.lastIndex;
    matched = true;
  }
  if (!matched || end !== v.length) return null;
  return Math.round(total);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function askModelOnce(m: Material): Promise<Written> {
  // Built key by key rather than passing `Material` through, so that a field
  // added to the harvest later — or to `distil` — cannot quietly start
  // appearing in prompts. `linkedin_url` is NOT here: see the header. Nor are
  // rounds, teams, country or email, none of which the model has any use for.
  const input = {
    name: m.fullName || null,
    // The person's own words, verbatim, unedited. Named "what_they_typed"
    // rather than "headline" so the model is not primed to treat a keyboard
    // mash as though it were a job title.
    what_they_typed: m.noteText || null,
    selected_skills: m.skills,
    supplied_job_title: m.position,
    supplied_employer: m.company,
    // Told plainly, because a null field and a forbidden field look identical
    // from inside a prompt and only one of them is safe to fill in.
    bio_allowed: m.bioEligible,
  };

  const bioNote = m.bioEligible
    ? "`what_they_typed` is long enough to be prose, so a bio may be composed from it — from it and from nothing else."
    : "`bio_allowed` is false. Return null for `bio`. There is not enough of the person's own writing to make sentences out of, and making sentences anyway would mean inventing their content.";

  const userPrompt = [
    "Everything known about this person is below. Nothing else is known — there is no city, no years of experience, no industry, no employment history, and no LinkedIn page content. Do not supply any of them.",
    "",
    JSON.stringify(input, null, 2),
    "",
    bioNote,
  ].join("\n");

  // One hung socket must not be allowed to spend the whole invocation: the
  // caller would get a killed connection, which carries none of the triage
  // below. Aborted attempts are retryable — a timeout is the most transient
  // thing in the set.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ATTEMPT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        instructions: SYSTEM_PROMPT,
        max_output_tokens: 1500,
        input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
        text: {
          format: {
            type: "json_schema",
            name: "prospect_profile",
            strict: true,
            schema: PROFILE_SCHEMA,
          },
        },
      }),
    });
  } catch (err) {
    const aborted = abort.signal.aborted;
    console.error("OpenAI request failed: " + String(err instanceof Error ? err.message : err));
    throw new ProfileError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      502,
      aborted
        ? "The AI service took too long to answer. Try again shortly."
        : "Couldn't reach the AI service just now. Try again shortly.",
      { retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text();
    console.error("OpenAI " + res.status + ": " + detail.slice(0, 500));
    throw triageOpenAI(
      res.status,
      detail,
      parseRetryAfterMs((n) => res.headers.get(n), Date.now()),
    );
  }

  const data = await res.json();
  const message = (data.output ?? []).find((o: { type?: string }) => o.type === "message");
  const parts = message?.content ?? [];
  if (parts.some((p: { type?: string }) => p.type === "refusal")) {
    // A judgement about this person's text, not a hiccup. Retrying asks the
    // same question again and pays for the same answer, so it is not retried
    // and it is not a 500 — nothing is broken. 422: we sent something the
    // model would not act on.
    throw new ProfileError("model_refused", 422, "The model declined this one");
  }
  if (data.status === "incomplete") {
    // Deterministic: the same input hits the same `max_output_tokens` ceiling
    // every time. A bug here (the budget is too small for this input), not a
    // transient upstream condition.
    throw new ProfileError("output_truncated", 500, "Ran out of output tokens before finishing");
  }
  const textPart = parts.find((p: { type?: string }) => p.type === "output_text");
  if (!textPart?.text) {
    // An empty 200 is the upstream misbehaving rather than refusing, and it
    // does clear on a second ask — so unlike the two above, this one is
    // retryable.
    throw new ProfileError(
      "upstream_bad_response",
      502,
      "Nothing came back from the AI service. Try again shortly.",
      { retryable: true },
    );
  }

  const parsed = JSON.parse(textPart.text);
  return {
    headline: nullable(parsed.headline),
    bio: nullable(parsed.bio),
    position: nullable(parsed.position),
    company: nullable(parsed.company),
    skills: list(parsed.skills),
  };
}

// ============================================================
// Checking what came back
// ============================================================
//
// Every rule in the prompt gets checked here. The prompt is how the model is
// asked; this is how the answer is verified. A rule that exists only in the
// prompt is a rule that holds until the day it does not.
function validate(draft: Written, m: Material, mailbox: string): Written {
  const out: Written = {
    headline: null,
    bio: null,
    position: m.position,
    company: m.company,
    skills: m.skills,
  };

  // ---- skills: intersection, not suggestion ----
  const returned = canonicalSkills(draft.skills);
  const added = returned.filter((s) => !m.skills.includes(s));
  if (added.length) {
    console.warn(`${mailbox}: model added skills not selected by the person: ${added.join(", ")} — dropped`);
  }
  out.skills = m.skills; // the person's own ticks, always, whatever came back

  // ---- position / company: same string or the source string ----
  //
  // Case, spacing and punctuation may change. Letters and digits may not. A
  // "tidied" employer whose characters differ is a different employer, and
  // "Head" expanded to "Head of Engineering" is a promotion nobody granted.
  out.position = sameSubstance(draft.position, m.position) ? draft.position : m.position;
  if (m.position && !sameSubstance(draft.position, m.position)) {
    console.warn(`${mailbox}: model altered the job title — using the source value`);
  }
  out.company = sameSubstance(draft.company, m.company) ? draft.company : m.company;
  if (m.company && !sameSubstance(draft.company, m.company)) {
    console.warn(`${mailbox}: model altered the employer name — using the source value`);
  }

  // ---- headline ----
  //
  // A headline is a tidy-up of the note, so it must stay recognisably the
  // note: no longer than it plus a little punctuation, and built out of its
  // words. Failing either check falls back to the person's own text verbatim,
  // which is always a safe answer — it is what they wrote.
  if (m.noteText) {
    const h = draft.headline;
    if (h && h.length <= Math.max(m.noteText.length + 12, 24) && sharesVocabulary(h, m.noteText, 0.6) && !hasPlaceholder(h)) {
      out.headline = h.slice(0, 200);
    } else {
      if (h) console.warn(`${mailbox}: headline drifted from the source note — using the note verbatim`);
      out.headline = m.noteParts[0].slice(0, 200);
    }
  }

  // ---- bio ----
  //
  // Below the threshold there is no bio, whatever came back. Above it, the bio
  // must be made of the note's own content words and must not be materially
  // longer than the note: tidying does not add material, so length growth is
  // the cheapest detector of invention there is. 1.25× plus 24 characters is
  // slack for joining words and punctuation, not for a new clause.
  if (!m.bioEligible) {
    if (draft.bio) {
      console.warn(`${mailbox}: model returned a bio below the minimum-signal threshold — dropped`);
    }
  } else if (draft.bio) {
    const b = draft.bio.trim();
    const budget = Math.round(m.noteText.length * 1.25) + 24;
    if (b.length > budget) {
      console.warn(`${mailbox}: bio is ${b.length} chars from a ${m.noteText.length}-char note — dropped as invented`);
    } else if (!sharesVocabulary(b, m.noteText, 0.6)) {
      console.warn(`${mailbox}: bio does not reuse the note's own words — dropped as invented`);
    } else if (hasPlaceholder(b)) {
      console.warn(`${mailbox}: bio contains an unfilled placeholder — dropped`);
    } else {
      out.bio = b;
    }
  }

  return out;
}

// True when two strings carry the same letters and digits — i.e. differ only in
// case, spacing and punctuation.
function sameSubstance(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return fold(a) === fold(b);
}

// What fraction of the candidate's content words already appear in the source.
// Short function words are ignored: they are the glue tidying is allowed to
// add, and counting them would make every sentence look derived.
function sharesVocabulary(candidate: string, source: string, minRatio: number): boolean {
  const src = new Set(tokens(source));
  const cand = tokens(candidate).filter((w) => w.length >= 4);
  if (cand.length === 0) return true; // nothing substantive claimed
  const shared = cand.filter((w) => src.has(w)).length;
  return shared / cand.length >= minRatio;
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function hasPlaceholder(s: string): boolean {
  return /\[[^\]]{2,40}\]|\{\{|\bTBD\b|\bN\/A\b/i.test(s);
}

// ============================================================
// The row, and its provenance
// ============================================================

function buildRow(p: Person, m: Material, w: Written, model: string | null) {
  const sitePart = sitePrefix(m.sites);
  const sources: Record<string, string> = {};

  const links: Record<string, string> = {};
  if (m.linkedinUrl) links.linkedin = m.linkedinUrl;

  const row = {
    ms365_mailbox: p.ms365_mailbox,
    email: m.email,
    full_name: m.fullName,
    headline: w.headline,
    bio: w.bio,

    // No source, therefore no value. The harvest has photo *filenames*, which
    // are SharePoint attachment blobs inside the tenant, not URLs anything
    // outside it can fetch — and 0027 is explicit that a prospect's avatar is
    // not copied on claim anyway, because the person never uploaded it to us.
    avatar_url: null,

    // The source has no city field. None. Not blank for some people — absent
    // for all of them. This stays null and there is no code path that sets it.
    city: null,

    country: m.country,

    // No industry column exists anywhere in the four Members lists. Deriving
    // one from an employer name is a guess dressed as data.
    industry: null,

    company: w.company,
    position: w.position,

    // The source has no years-of-experience field either, and this is the field
    // a model will fill with a confident, plausible, wrong number. It is not in
    // PROFILE_SCHEMA, it is not in the prompt, and it is null here.
    years_experience: null,

    skills: w.skills,

    // Nothing in the source is an interest. `Your Role` is a self-declared
    // build role on a team, `Skills` is already `skills`, and a note about
    // one's job is not a hobby.
    interests: [] as string[],

    links,

    // No dated employment history exists in the source — one current employer
    // and one current title, with no start date, is not a history. An entry
    // with invented dates, or with `is_current` asserted from nothing, would be
    // fabricated career data in a field the member later edits by hand.
    work_history: [] as unknown[],

    sources,
    built_at: new Date().toISOString(),
    built_model: model,

    // Never true from here. 0027 defaults it false and publishing is a separate,
    // deliberate step; the importer does not set it either.
    is_published: false,
  };

  if (row.full_name) sources.full_name = m.nameSource;
  if (row.email) sources.email = `sharepoint:${sitePart}/Members.'Personal Email'`;
  if (row.headline) sources.headline = `sharepoint:${sitePart}/Members.Note`;
  if (row.bio) sources.bio = `sharepoint:${sitePart}/Members.Note`;
  if (row.country && m.countryColumn) sources.country = `sharepoint:${sitePart}/${m.countryColumn}`;
  if (row.company) sources.company = `sharepoint:${sitePart}/Members.CurrentCompany`;
  if (row.position) sources.position = `sharepoint:${sitePart}/Members.CurrentPosition`;
  if (row.skills.length) sources.skills = `sharepoint:${sitePart}/Members.Skills`;
  if (links.linkedin) sources["links.linkedin"] = `sharepoint:${sitePart}/Members.LinkedIn`;

  return row;
}

function sitePrefix(sites: string[]): string {
  // Naming a plausible site here would be the same mistake in miniature as
  // everything else this file guards against: a provenance string that is
  // confidently wrong is worse than one that admits it does not know. Every
  // person in the harvest has at least one round, so this should never fire —
  // and if it does, it should be legible as a defect rather than resolve to
  // a URL somebody would go and check and find nothing at.
  if (sites.length === 0) return "round-not-recorded";
  if (sites.length === 1) return sites[0];
  return `{${sites.join(",")}}`;
}

// The check 0027 asks for, applied to every field and not only to `bio`.
// Returns the names of fields that carry a value nobody can trace.
function auditSources(row: ReturnType<typeof buildRow>): string[] {
  const bad: string[] = [];
  const check = (key: string, populated: boolean) => {
    if (populated && !row.sources[key]) bad.push(key);
  };
  check("full_name", !!row.full_name);
  check("email", !!row.email);
  check("headline", !!row.headline);
  check("bio", !!row.bio);
  check("country", !!row.country);
  check("company", !!row.company);
  check("position", !!row.position);
  check("skills", row.skills.length > 0);
  check("links.linkedin", !!row.links.linkedin);

  // The six fields that must be empty because no source for them exists
  // anywhere in the four Members lists. If one is ever populated, it was
  // populated by something nobody has reviewed, and it should stop the import
  // rather than reach the screen of the person it makes a claim about.
  if (row.city !== null) bad.push("city");
  if (row.years_experience !== null) bad.push("years_experience");
  if (row.industry !== null) bad.push("industry");
  if (row.avatar_url !== null) bad.push("avatar_url");
  if (row.work_history.length > 0) bad.push("work_history");
  if (row.interests.length > 0) bad.push("interests");
  return bad;
}

// ============================================================
// Small helpers
// ============================================================

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
}

function uniq(v: string[]): string[] {
  return [...new Set(v)];
}

function nullable(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
}

// Letters and digits only, lowercased — the comparison that treats "AzureAI",
// "Azure AI" and "azure-ai" as one value and "Nokia" and "Nokia Egypt" as two.
function fold(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function letters(s: string): string {
  return String(s ?? "").replace(/[^\p{L}]/gu, "");
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders },
  });
}
