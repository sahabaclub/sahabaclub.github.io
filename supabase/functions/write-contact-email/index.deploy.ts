// GENERATED - do not edit. Deploy-time twin of index.ts with the ../_shared/cors.ts, ../_shared/ai-config.ts imports replaced by those files inline, and
// nothing else. The Supabase dashboard editor deploys one function directory at a
// time and cannot reach a shared parent file. Edit index.ts and regenerate; the
// two must stay in step.

// write-contact-email
// ------------------------------------------------------------
// Writes one email per person, using that person's own history with the club
// — the events they registered for, the ones they actually turned up to,
// where they registered from, what they were studying, whether they already
// hold a Sahaba Club mailbox.
//
// It writes drafts. It does not send. Every draft lands in
// campaign_recipients with status 'generated' and a human has to approve it
// before send-campaign will touch it. That separation is deliberate: this
// model is writing to nine hundred real people who gave us their address to
// attend an event, and a hallucinated "great to see you at EduHackAI" to
// somebody who never went is not a small mistake.
//
// Called from the admin campaigns screen in batches, because 900 sequential
// model calls will not fit in one function invocation and pretending
// otherwise just means half-finished campaigns.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   OPENAI_API_KEY
//   OPENAI_MODEL                             — optional, defaults below
//
// Since 0031 the system prompt, the model and the output ceiling can also be
// set from Admin → AI services, under the `write-contact-email` service. The
// constants below remain the floor: with nothing activated, or with the
// database unreachable, this function behaves exactly as it did before.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// ---- inlined from ../_shared/cors.ts ----
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
// ---- inlined from ../_shared/ai-config.ts ----
type AiDb = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
};

// A whole invocation reads the same configuration, and some of these functions
// loop — `promptarena-judge` drains a queue, `refresh-avatars` walks a batch,
// `write-contact-email` writes for up to 25 people. One read per invocation
// rather than one per item, without making a stale cache outlive the instance
// that made it.
//
// 60 seconds, not "for ever": Edge Function instances are reused between
// requests, so a permanent memo would mean an activated prompt taking effect
// only after the instance recycled — which is invisible, unpredictable, and
// exactly the kind of thing that gets debugged as "the save didn't work".
const CACHE_MS = 60_000;

const cache = new Map<string, { at: number; row: StoredConfig | null }>();

type StoredConfig = {
  model: string | null;
  max_output_tokens: number | null;
  parts: unknown;
  version: number | null;
  config_digest: string | null;
};

type AiDefaults = {
  model: string;
  maxOutputTokens?: number;
  parts: Record<string, unknown>;
};

type AiConfig = {
  slug: string;
  model: string;
  maxOutputTokens: number;
  parts: Record<string, unknown>;
  version: number;
  digest: string;
  // 'database' means at least one field came from a stored version. Logged by
  // some callers so a support question about a strange answer can start with
  // "which prompt produced it".
  source: "database" | "code";
};

// The one entry point. `slug` is `ai_services.slug`; `defaults` is what the
// function would have used before 0031 existed.
async function loadAiConfig(
  admin: AiDb,
  slug: string,
  defaults: AiDefaults,
): Promise<AiConfig> {
  const base: AiConfig = {
    slug,
    model: defaults.model,
    maxOutputTokens: defaults.maxOutputTokens ?? 0,
    parts: { ...defaults.parts },
    version: 0,
    digest: "",
    source: "code",
  };

  const row = await read(admin, slug);
  if (!row) return base;

  const merged: AiConfig = { ...base, parts: { ...defaults.parts } };
  let touched = false;

  const model = trimmed(row.model);
  if (model) {
    merged.model = model;
    touched = true;
  }

  // Only accepted when the caller has a ceiling at all. A service that does
  // not send `max_output_tokens` to OpenAI (the image ones) must not acquire
  // one because a row carried a number.
  if (defaults.maxOutputTokens && Number.isInteger(row.max_output_tokens) && (row.max_output_tokens as number) > 0) {
    merged.maxOutputTokens = row.max_output_tokens as number;
    touched = true;
  }

  // Part-by-part, and only keys the caller declared. A stored `parts` object
  // carrying a key this version of the function knows nothing about is
  // ignored rather than passed through — which is what makes rolling the code
  // back over a newer stored configuration safe.
  if (row.parts && typeof row.parts === "object" && !Array.isArray(row.parts)) {
    const stored = row.parts as Record<string, unknown>;
    for (const key of Object.keys(defaults.parts)) {
      if (!(key in stored)) continue;
      const fallback = defaults.parts[key];
      const value = Array.isArray(fallback)
        ? listPart(stored[key], fallback as unknown[])
        : textPart(stored[key], String(fallback ?? ""));
      if (value !== fallback) {
        merged.parts[key] = value;
        touched = true;
      }
    }
  }

  if (Number.isInteger(row.version) && (row.version as number) > 0) merged.version = row.version as number;
  merged.digest = trimmed(row.config_digest);
  merged.source = touched ? "database" : "code";
  return merged;
}

// ---- Part validation --------------------------------------------------
//
// Strict, and deliberately so. These decide whether a stored value is good
// enough to send to a paid model call in place of one that was written and
// reviewed in a source file. "Present but empty" is the single most likely
// way for a stored prompt to be wrong, and it is the one that would otherwise
// produce a silently unguided model rather than a visible error.

function textPart(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return text ? text : fallback;
}

// A list part is all-or-nothing against the code's own list. The twelve
// monthly themes and the three avatar variants are ROTAS: they are indexed by
// month and by attempt number, so a stored list of a different length does not
// mean "fewer themes", it means every index after the edit points somewhere
// different from what the code that reads it expects. Length is therefore part
// of the shape, not a preference.
function listPart(value: unknown, fallback: unknown[]): unknown[] {
  if (!Array.isArray(value)) return fallback;
  if (value.length !== fallback.length) return fallback;
  const clean = value.map((v) => (typeof v === "string" ? v.trim() : ""));
  if (clean.some((v) => !v)) return fallback;
  return clean;
}

// Convenience for callers whose parts are all plain strings.
function part(cfg: AiConfig, key: string, fallback: string): string {
  return textPart(cfg.parts[key], fallback);
}

function listOf(cfg: AiConfig, key: string, fallback: string[]): string[] {
  const value = listPart(cfg.parts[key], fallback);
  return value.map((v) => String(v));
}

// ---- The read ---------------------------------------------------------
//
// `ai_active_config` is a view over the one active version per service. It is
// read with the service role, because every caller of this file already is one
// — and because the view is staff-only, which a function's own JWT-less
// service context satisfies by bypassing RLS rather than by passing it.
async function read(admin: AiDb, slug: string): Promise<StoredConfig | null> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.row;

  try {
    const { data, error } = await admin
      .from("ai_active_config")
      .select("model, max_output_tokens, parts, version, config_digest")
      .eq("slug", slug)
      .maybeSingle();

    if (error) {
      // Logged rather than thrown. The most likely cause on a fresh
      // environment is that 0031 has not been applied yet, and a function
      // that refused to run until a migration landed would be a worse
      // outcome than one that runs on its own defaults and says so.
      console.warn(`ai-config: ${slug} unreadable (${error.message}) — using code defaults`);
      cache.set(slug, { at: Date.now(), row: null });
      return null;
    }

    const row = (data ?? null) as StoredConfig | null;
    cache.set(slug, { at: Date.now(), row });
    return row;
  } catch (err) {
    console.warn(`ai-config: ${slug} lookup failed (${String(err)}) — using code defaults`);
    cache.set(slug, { at: Date.now(), row: null });
    return null;
  }
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-5";

// The slug the admin panel stores an override under.
const AI_SLUG = "write-contact-email";

// How many people one invocation will write for. Small enough to finish
// inside the function timeout, large enough that a 900-person campaign is
// tens of clicks rather than hundreds. The screen loops until none are left.
const DEFAULT_BATCH = 8;
const MAX_BATCH = 25;

// ============================================================
// What "it failed" is allowed to mean
// ============================================================
//
// Identical in shape to `build-prospect-profile`'s `ProfileError` and
// `promptarena-judge`'s `JudgeError`, deliberately: three functions calling the
// same upstream must not hold three different opinions about what a 429 means.
// A status the caller can act on without parsing English, a stable
// machine-readable code, and whether it is retryable — decided here, at the
// only place that knows what actually went wrong, rather than guessed from the
// status by each caller in turn.
//
// `retryable` is the column that matters and it is not derivable from the
// status: 429 appears in both halves, because OpenAI reports an exhausted
// balance as a 429 with `insufficient_quota` and no amount of waiting fixes it.
//
//   code                       status  retryable  meaning
//   ------------------------   ------  ---------  --------------------------
//   rate_limited                  429  yes        OpenAI is throttling us
//   upstream_error                502  yes        OpenAI 5xx/408
//   upstream_timeout              502  yes        our own attempt timeout
//   upstream_unreachable          502  yes        the request never completed
//   upstream_bad_response         502  yes        200 with nothing usable in it
//   draft_rejected                502  yes        a draft our own checks refused
//   quota_exhausted               402  no         the OpenAI balance is spent
//   ai_unconfigured               503  no         OPENAI_API_KEY not set
//   ai_credentials                503  no         OPENAI_API_KEY rejected
//   model_not_configured          503  no         OPENAI_MODEL unusable
//   output_truncated              503  yes        our token ceiling was too low
//   model_refused                 422  no         the model declined this person
//   content_filtered              422  no         the model's own filter stopped it
//   bad_request                   400  no         the caller sent nonsense
//   not_signed_in / not_allowed   401/403  no     the caller is not staff
//   not_found                     404  no         no such campaign
//   contact_missing               410  no         the contact row is gone
//   recipient_skipped             200  no         unsubscribed, bounced, invalid
//   upstream_rejected_request     500  no         we sent OpenAI a bad request
//   internal_error                500  no         an unhandled bug in here
//
// Every failure also carries `retry_after` (seconds) when OpenAI told us one,
// alongside a real `Retry-After` header.
class EmailError extends Error {
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
    this.name = "EmailError";
    this.code = code;
    this.status = status;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

// ---- Whose problem is it: this contact's, or everybody's? -------------
//
// The distinction that decides whether the batch continues. A model that
// declined THIS person's context says nothing about the next twenty-four; a
// rejected API key, an exhausted balance or a rate limit says everything about
// them. Grinding through the rest of the batch to rediscover the same fact
// costs money, fills the review screen with two dozen identical `failed` rows
// — and, for the non-retryable half, puts those rows somewhere neither the
// default pass nor `regenerate` will ever look again.
//
// So these abort the batch and are returned to the caller with their own
// status, code and `Retry-After`. Everything else is written onto the
// recipient's own row and the loop moves on.
const BATCH_FATAL = new Set([
  "rate_limited",
  "quota_exhausted",
  "ai_unconfigured",
  "ai_credentials",
  "model_not_configured",
  "upstream_rejected_request",
  "upstream_error",
  "upstream_timeout",
  "upstream_unreachable",
  "internal_error",
]);

// ============================================================
// The retry budget
// ============================================================
//
// `build-prospect-profile`'s shape — bounded twice, and by wall clock rather
// than by attempt count alone — with the one change this function's loop forces:
// the deadline is PER RECIPIENT, not per invocation. Sharing one clock across a
// batch would mean the eighth person had no budget left to retry a rate limit
// the first person caused.
//
//   * at most RETRY_MAX_ATTEMPTS attempts per recipient;
//   * no new attempt for that recipient may *start* once RETRY_DEADLINE_MS has
//     passed since THAT RECIPIENT began, and a retry only starts if the sleep
//     plus RETRY_RESERVE_MS of room for the attempt itself still fits;
//   * every attempt is aborted at ATTEMPT_TIMEOUT_MS.
//
// ⚠ The four numbers are one piece of arithmetic. RETRY_RESERVE_MS must equal
// ATTEMPT_TIMEOUT_MS, because the reserve is room for the attempt the sleep is
// *for*; a smaller reserve lets an attempt start that cannot possibly finish.
// And RETRY_DEADLINE_MS has to exceed one full attempt plus a backoff plus a
// reserve, or the escalated retry that this whole change exists to enable could
// never fire: a truncation arriving at 15s needs 15 + 1 + 30 = 46s of headroom.
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 8_000;
const RETRY_DEADLINE_MS = 75_000;
const RETRY_RESERVE_MS = 30_000;
const ATTEMPT_TIMEOUT_MS = 30_000;

// The batch's own ceiling, and it follows from RETRY_DEADLINE_MS rather than
// being chosen independently. One recipient can legitimately occupy 75s, so a
// recipient STARTING at 60s can run to 135s — just inside the platform's 150s,
// leaving 15s for the remaining-count query, the campaign status update and the
// response write. Recipients the loop did not reach are untouched and still
// `pending`; the screen's next batch picks them up, which is only true because
// nothing is claimed up front.
const BATCH_DEADLINE_MS = 60_000;

// ============================================================
// The output token budget, and the fields that had no bound at all
// ============================================================
//
// ⚠ THE NUMBER BELOW IS DERIVED FROM THE PAYLOAD, NOT PICKED. The value it
// replaces was 2000, and 2000 is the same shape of mistake that made
// `build-prospect-profile` fail 42.9% of live calls — 50 occurrences — at a
// ceiling of 1500.
//
// **What overflows is the reasoning.** `OPENAI_MODEL` defaults to `gpt-5`, and
// on the Responses API reasoning tokens are drawn from the *same*
// `max_output_tokens` budget as the visible answer: the parameter limits
// "reasoning tokens, visible output tokens, and non-visible formatting tokens",
// and exhausting it "might occur before any visible output tokens are
// produced". A ceiling sized for the answer alone is therefore mostly, and
// sometimes entirely, spent before the first character of JSON is written.
//
// ---- The visible half, which until now was not bounded at all ---------
//
// ⚠ THIS IS THE PART THAT WAS ACTUALLY BROKEN, and it is the defect
// `promptarena-judge` was sized against too: **none of the three fields had a
// cap**. The schema below asks for a subject "under 70 characters" and the
// system prompt asks for "three or four short paragraphs", and neither was
// checked anywhere — a description is a request, not a bound. Nor does the
// database bound them: `campaign_recipients.subject` and `.body_text` are plain
// `text` columns in 0011 with no length CHECK. So there was no number to derive
// a ceiling from, and 2000 could only ever have been a guess.
//
// The three caps below are what make the sum real. They are enforced in
// `validate`, and a draft that exceeds one is rejected and rewritten rather than
// truncated: an email silently cut off mid-sentence goes to a human reviewer who
// may well approve it, and this function's entire design is that a human sees
// the truth before 900 people do.
//
//   subject              SUBJECT_MAX_CHARS                            200
//   body_text            BODY_MAX_CHARS                             4,000
//   personalisation_note NOTE_MAX_CHARS                               300
//   keys, quoting, and the blank lines between paragraphs, each
//     escaped to two characters                                      ~150
//                                                          ---------------
//                                                          ~4,650 characters
//
// ⚠ AND THEN THE LANGUAGE MULTIPLIER, which matters more here than anywhere
// else in this codebase, because this is the one function that is *told* which
// language to write in: `campaign.language` is 'en', 'ar' or 'match', and the
// system prompt's last line spells out the Arabic case. Arabic costs materially
// more tokens per character than English — call it 1.5 characters per token
// against English's ~4. So the honest visible worst case is
// 4,650 / 1.5 ≈ **3,100 tokens**, not the ~1,160 an English-only reading gives.
// A typical draft is nearer 400. The ceiling has to cover an Arabic campaign,
// because an Arabic campaign is a thing staff can select from a dropdown.
//
// ---- The reasoning half ----------------------------------------------
//
// Reasoning cost scales with how hard the task is, not with the length of the
// answer, so it is an allowance added on top rather than a multiple. ~3,900 at
// LOW effort, a modest step up from the sibling's ~3,300 for a transcription:
// the input here is larger (a brief, a verbatim must-include block, and a
// context object carrying a whole engagement history) and there are real
// distinctions to honour in it — "registered for" versus "attended" above all.
//
//   3,100 visible + 3,900 reasoning = 7,000
//
// Neither number costs anything unused — OpenAI bills tokens generated, not
// tokens permitted — so the ceiling only has to be high enough to be wrong
// rarely and cheap when it is. The retry keeps the same visible bound and stops
// rationing the reasoning: 3,100 + ~18,000.
const MAX_OUTPUT_TOKENS = 7_000;
const MAX_OUTPUT_TOKENS_RETRY = 21_000;

// ⚠ `effort: "low"`, and this is a decision rather than a default. It is
// `build-prospect-profile`'s setting and NOT `promptarena-judge`'s, and the
// test is whether the reasoning is the product:
//
//   * For the judge it is. Consistency against the calibration anchors is the
//     one quality property that judge exists to have, so buying ceiling
//     headroom by thinking less would trade away the thing being paid for.
//   * Here it is not. The product is three or four short paragraphs assembled
//     from a brief and a context object that are both already in front of the
//     model. Nothing has to be worked out; something has to be written down.
//
// The thing on this task that genuinely matters — never claiming somebody
// attended when the record says they only registered — is not left to
// deliberation either. `buildContext` phrases each engagement rather than
// dumping it ("registered for X", "attended X"), so the distinction is made in
// code before the model ever sees it, and rules 2 and 8 are checked in
// `validate` afterwards. And every draft is read by a human before it is sent,
// which is a stronger guarantee than any amount of thinking. So every reasoning
// token here is a token not available for the answer.
//
// ⚠ Sending this key at all is safe by precedent, not by assumption:
// `parse-profile-document` ships `reasoning` in production against the same
// admin-settable model this function reads. It is worth knowing that the key is
// rejected outright by NON-reasoning models, so pointing Admin → AI services at
// one would fail every call — `triageOpenAI` names this key in that message so
// the operator is sent to the right place rather than to the ceiling.
const REASONING_EFFORT = "low";

// The caps that make the sum above real, and that did not exist before. Set far
// above what the system prompt asks for — a 70-character subject, three or four
// short paragraphs, one short line — so they are a runaway guard rather than a
// formatter. A draft that hits one is logged, because it means the model stopped
// honouring the brief, not that this contact needed more words.
const SUBJECT_MAX_CHARS = 200;
const BODY_MAX_CHARS = 4_000;
const NOTE_MAX_CHARS = 300;

// Everything the model call needs that staff can now change, resolved once for
// the whole batch and then passed down.
type EmailConfig = {
  model: string;
  systemPrompt: string;
  maxOutputTokens: number;
  maxOutputTokensRetry: number;
};

const EMAIL_SCHEMA = {
  type: "object",
  properties: {
    subject: {
      type: "string",
      description:
        "Subject line, under 70 characters. Specific to this person where there is something true to be specific about. No emoji, no ALL CAPS, no 'Re:' or 'Fwd:'.",
    },
    body_text: {
      type: "string",
      description:
        "The complete email as plain text, including the greeting and the sign-off. Use blank lines between paragraphs. No markdown, no HTML, no placeholders in square brackets.",
    },
    personalisation_note: {
      type: "string",
      description:
        "One short line for the staff reviewer saying which facts about this person you used. Empty string if you used none.",
    },
  },
  required: ["subject", "body_text", "personalisation_note"],
  additionalProperties: false,
} as const;

// The naming rule is not a style preference. The club's agreement with
// Microsoft is an education one and the licence tier is not something we
// advertise; publicly it is always "Microsoft 365 Cloud Licenses". The model
// gets told plainly because it will otherwise happily repeat "A1" out of the
// context it is given.
const SYSTEM_PROMPT =
  `You write short, personal emails on behalf of Sahaba Club — a Dubai-based AI and cloud community, and a Microsoft partner. You are writing to one specific person, and you are given everything the club actually knows about them.

Rules, in order of importance:

1. Never state anything that is not in the facts you are given. Do not invent events, dates, prices, links, achievements, or a shared history that is not recorded. If the facts are thin, write a short, warm, general email — that is the correct outcome, not a failure.
2. Never write the phrase "A1", "Office 365 A1", or any licence tier name. The Microsoft licences are always and only called "Microsoft 365 Cloud Licenses".
3. Anything given to you as "must appear verbatim" must appear exactly as written, unchanged.
4. Write to a person, not to a segment. If they came to a specific event, name it. If they registered but did not attend, do not imply they were there — an invitation to come this time is the honest version.
5. Keep it short. Three or four short paragraphs at most. A reader on a phone should get the point in the first two lines.
6. No marketing throat-clearing. Do not open with "I hope this email finds you well", "In today's fast-paced world", or "We are thrilled to announce".
7. Sign off as the sender given to you. Do not add a footer, an unsubscribe line, or a postscript — those are added afterwards.
8. Do not use placeholders. If you do not know their first name, address them without one rather than writing "Hi [Name]".

Write in the language you are asked for. If asked to match the contact, use Arabic only when their own details clearly indicate they would prefer it; otherwise English.`;

// What staff have chosen, or the constants above. Never throws — see
// `_shared/ai-config.ts`.
async function resolveConfig(admin: Parameters<typeof loadAiConfig>[0]): Promise<EmailConfig> {
  const ai: AiConfig = await loadAiConfig(admin, AI_SLUG, {
    model: MODEL,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    parts: { system: SYSTEM_PROMPT },
  });

  const base = ai.maxOutputTokens || MAX_OUTPUT_TOKENS;

  return {
    model: ai.model,
    systemPrompt: part(ai, "system", SYSTEM_PROMPT),
    maxOutputTokens: base,
    // The retry ceiling is not independently settable and never was — it is
    // "stop rationing the reasoning" relative to the first attempt. Scaled from
    // whatever the base is, floored at this file's own retry value so lowering
    // the base in the panel cannot quietly remove the escape hatch, and capped
    // at what 0031's CHECK will accept (256..128000) so the two agree on what a
    // ceiling may be.
    maxOutputTokensRetry: Math.min(128_000, Math.max(MAX_OUTPUT_TOKENS_RETRY, base * 2)),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startedAt = Date.now();

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Staff only. This function reads the personal details of people who are
    // not members and spends money per call; both are reasons the check is
    // here and not merely on the page that calls it.
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData.user) {
      return fail(new EmailError("not_signed_in", 401, "Not signed in"));
    }
    const { data: callerProfile } = await admin
      .from("profiles")
      .select("role")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!callerProfile || (callerProfile.role !== "admin" && callerProfile.role !== "staff" && callerProfile.role !== "global_admin")) {
      return fail(new EmailError("not_allowed", 403, "Club staff only"));
    }

    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is not set");
      return fail(new EmailError(
        "ai_unconfigured",
        503,
        "The AI writer isn't configured yet. Set OPENAI_API_KEY in the Edge Function secrets.",
      ));
    }

    const body = await req.json().catch(() => ({}));
    const campaignId: string | undefined = body.campaignId;
    const only: string[] | undefined = body.recipientIds;
    const regenerate: boolean = body.regenerate === true;
    const batch = Math.min(Math.max(Number(body.limit) || DEFAULT_BATCH, 1), MAX_BATCH);

    if (!campaignId) return fail(new EmailError("bad_request", 400, "campaignId is required"));

    const { data: campaign, error: cErr } = await admin
      .from("campaigns")
      .select("id, name, brief, must_include, tone, language, from_name, status")
      .eq("id", campaignId)
      .maybeSingle();
    if (cErr || !campaign) return fail(new EmailError("not_found", 404, "Campaign not found"));
    if (!campaign.brief.trim()) {
      return fail(new EmailError(
        "bad_request",
        400,
        "Write the brief first — the model has nothing to work from.",
      ));
    }

    // Which drafts to write. Normally the ones not yet written; explicitly
    // chosen ones when a reviewer asks for a rewrite.
    //
    // An edited draft is never regenerated in bulk. Someone spent time on it,
    // and silently overwriting that is the kind of thing that makes people
    // stop trusting the tool.
    let q = admin
      .from("campaign_recipients")
      .select("id, contact_id, email, full_name, status, edited")
      .eq("campaign_id", campaignId)
      .limit(batch);

    if (only && only.length) {
      q = q.in("id", only);
    } else if (regenerate) {
      q = q.in("status", ["pending", "generated"]).eq("edited", false);
    } else {
      q = q.eq("status", "pending");
    }

    const { data: selected, error: rErr } = await q;
    if (rErr) return fail(new EmailError("internal_error", 500, rErr.message));

    const recipients = [...(selected ?? [])];

    // ---- Second pass: failures that said they would clear ----
    //
    // ⚠ WITHOUT THIS THE RETRYABLE HALF OF THE ERROR CONTRACT IS DECORATIVE.
    // Neither selection above looks at `failed` rows — the default pass wants
    // `pending`, `regenerate` wants `pending` or `generated` — so a recipient
    // whose draft failed for a reason that would clear on a second ask sat
    // there for ever unless a reviewer happened to pick it out by hand.
    //
    // The marker is the suffix written onto `error` below: `[<code>,
    // retryable]`, and the two must stay in step. A non-retryable failure (the
    // model declined this person, the contact row is gone) carries no such
    // suffix and is deliberately never picked up again — retrying it would
    // spend money for the same answer every batch.
    //
    // Second, after the primary selection and only with the room it left over:
    // somebody with no draft at all comes before a rewrite of one that failed.
    if (!only?.length && recipients.length < batch) {
      const { data: retryable, error: retErr } = await admin
        .from("campaign_recipients")
        .select("id, contact_id, email, full_name, status, edited")
        .eq("campaign_id", campaignId)
        .eq("status", "failed")
        .eq("edited", false)
        .like("error", "%, retryable]")
        .limit(batch - recipients.length);
      if (retErr) return fail(new EmailError("internal_error", 500, retErr.message));
      recipients.push(...(retryable ?? []));
    }

    if (!recipients.length) {
      return json({ ok: true, written: 0, failed: 0, remaining: 0, done: true });
    }

    // One round trip for all the contacts and all their engagements, rather
    // than two queries per person.
    const contactIds = recipients.map((r) => r.contact_id);
    const [contactsRes, engRes] = await Promise.all([
      admin.from("marketing_contacts")
        .select("id, full_name, first_name, email, country, city, university_or_company, occupation, tech_experience, how_heard, sahaba_mailbox, linked_user_id, engagement_count, first_seen_at, last_seen_at, notes, unsubscribed_at, bounced_at, is_test, email_valid")
        .in("id", contactIds),
      admin.from("contact_engagements")
        .select("contact_id, event_name, engagement_type, occurred_at")
        .in("contact_id", contactIds),
    ]);

    type Row = Record<string, unknown>;
    const contactById = new Map<string, Row>(
      (contactsRes.data ?? []).map((c) => [c.id as string, c as Row]),
    );
    const engByContact = new Map<string, Row[]>();
    for (const e of (engRes.data ?? []) as Row[]) {
      const key = String(e.contact_id);
      const list = engByContact.get(key) ?? [];
      list.push(e);
      engByContact.set(key, list);
    }

    let written = 0;
    let failed = 0;
    let skipped = 0;
    let retryableFailed = 0;
    let stoppedEarly = false;
    let fatal: EmailError | null = null;

    // Resolved once for the whole batch rather than per recipient: twenty-five
    // emails written in one invocation are one campaign, and a batch written
    // half on one prompt and half on another is a campaign nobody can review
    // as a whole. Never throws — see `_shared/ai-config.ts`.
    const cfg = await resolveConfig(admin);

    for (const r of recipients) {
      // Not an error. The recipients we did not reach are untouched and still
      // `pending`, and the screen's next batch picks them up — which is only
      // true because nothing is claimed up front. See BATCH_DEADLINE_MS.
      if (Date.now() - startedAt > BATCH_DEADLINE_MS) {
        stoppedEarly = true;
        break;
      }

      const contact = contactById.get(r.contact_id);
      if (!contact) {
        await markFailed(admin, r.id, new EmailError("contact_missing", 410, "Contact no longer exists"));
        failed++;
        continue;
      }

      // Last line of defence. The segment that built this list should already
      // have excluded these people, but a campaign can sit in review for a
      // week and someone can unsubscribe in the meantime — so it is checked
      // again here, at the moment of writing, and again before sending.
      if (contact.unsubscribed_at || contact.bounced_at || contact.is_test || !contact.email_valid) {
        await admin.from("campaign_recipients")
          .update({
            status: "skipped",
            error: contact.unsubscribed_at
              ? "Unsubscribed"
              : contact.bounced_at
              ? "Address previously bounced"
              : contact.is_test
              ? "Test record"
              : "Address looks invalid",
            updated_at: new Date().toISOString(),
          })
          .eq("id", r.id);
        skipped++;
        continue;
      }

      const context = buildContext(contact, engByContact.get(r.contact_id) ?? []);

      try {
        // Each recipient gets its own retry clock — see RETRY_DEADLINE_MS.
        const draft = await askModel(cfg, campaign, context, Date.now());
        await admin.from("campaign_recipients").update({
          subject: draft.subject,
          body_text: draft.body_text,
          context_used: { ...context, personalisation_note: draft.personalisation_note },
          // What actually wrote this draft, which is the point of the column —
          // since 0031 that is not necessarily what the secret says.
          model: cfg.model,
          generated_at: new Date().toISOString(),
          status: "generated",
          error: null,
          updated_at: new Date().toISOString(),
        }).eq("id", r.id);
        written++;
      } catch (err) {
        const e = asEmailError(err);
        console.error(`draft failed for ${r.id} (${e.code}, ${e.attempts} attempt${e.attempts === 1 ? "" : "s"}): ${e.message}`);

        // Everybody's problem, not this contact's. Stop, and hand the caller
        // the classified failure rather than twenty-four more rows saying the
        // same thing. This recipient is left exactly as it was, so the next
        // batch will pick it up untouched. See BATCH_FATAL.
        if (BATCH_FATAL.has(e.code)) {
          fatal = e;
          break;
        }

        await markFailed(admin, r.id, e);
        failed++;
        if (e.retryable) retryableFailed++;
      }
    }

    const { count: remaining } = await admin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "pending");

    if (campaign.status === "draft" || campaign.status === "generating") {
      await admin.from("campaigns")
        .update({
          status: (remaining ?? 0) > 0 ? "generating" : "review",
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaignId);
    }

    const counts = {
      written,
      failed,
      skipped,
      // New, and additive. `retryable_failed` is how many of `failed` said they
      // would clear on a second ask; the second pass above is what actually
      // picks them up on the next batch.
      retryable_failed: retryableFailed,
      remaining: remaining ?? 0,
      stopped_early: stoppedEarly,
      elapsed_ms: Date.now() - startedAt,
    };

    // ⚠ `done` deliberately still means "nothing is `pending`", exactly as it
    // did before. The admin screen's Generate-all button loops on it
    // (app/admin/campaigns.html), and folding retryable failures into it would
    // turn a persistent transient — a rate limit that outlasts the campaign —
    // into a loop that never terminates. The count above is how a reviewer
    // sees there is more to do; pressing Generate again is what does it.
    if (fatal) return fail(fatal, counts);

    return json({ ok: true, ...counts, done: (remaining ?? 0) === 0 });
  } catch (err) {
    console.error(err);
    return fail(asEmailError(err));
  }
});

// Anything arriving at a catch unclassified is a defect in this file, and it
// must NOT be swept into the retryable bucket: retrying a bug is the same wrong
// answer at three times the price, reported as though the network were at
// fault.
function asEmailError(err: unknown): EmailError {
  if (err instanceof EmailError) return err;
  return new EmailError("internal_error", 500, String(err instanceof Error ? err.message : err));
}

// The recipient's own row carries the same three facts the HTTP response does.
// ⚠ The `[<code>, retryable]` suffix is not decoration — it is what the second
// pass in the handler matches on with `like '%, retryable]'`. Changing this
// format means changing that query.
async function markFailed(
  admin: ReturnType<typeof createClient>,
  recipientId: string,
  err: EmailError,
): Promise<void> {
  const note = `${err.message} [${err.code}${err.retryable ? ", retryable" : ""}]`.slice(0, 500);
  await admin.from("campaign_recipients").update({
    status: "failed",
    error: note,
    updated_at: new Date().toISOString(),
  }).eq("id", recipientId);
}

// One shape for every failure, so a caller can branch on `code` and never has
// to read `error` to find out what happened. `Retry-After` is a real header as
// well as a body field: the header is what a proxy or an HTTP client honours
// automatically, the body field is what survives a client that does not expose
// headers to script (a browser, without the explicit expose list below).
function fail(err: EmailError, extra: Record<string, unknown> = {}): Response {
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

// What the model is allowed to know about this person. Built explicitly
// rather than passing the row through, so that adding a column to
// marketing_contacts later cannot quietly start leaking it into prompts —
// a date of birth and a phone number have no business in here.
function buildContext(contact: Record<string, unknown>, engagements: Array<Record<string, unknown>>) {
  const sorted = [...engagements].sort((a, b) =>
    String(a.occurred_at ?? "").localeCompare(String(b.occurred_at ?? "")));

  const TYPE_WORD: Record<string, string> = {
    registration: "registered for",
    checkin: "attended",
    voting: "voted at",
    application: "applied to",
    other: "engaged with",
  };

  return {
    first_name: contact.first_name || firstWord(contact.full_name) || null,
    full_name: contact.full_name || null,
    country: contact.country || null,
    city: contact.city || null,
    university_or_company: contact.university_or_company || null,
    occupation: contact.occupation || null,
    experience: contact.tech_experience || null,
    how_they_found_us: contact.how_heard || [],
    // Phrased rather than dumped, because "registered for X but did not
    // attend" is the distinction the model most often gets wrong, and it is
    // also the most embarrassing one to get wrong.
    history: sorted.map((e) =>
      `${TYPE_WORD[String(e.engagement_type)] ?? "engaged with"} ${e.event_name ?? "a Sahaba Club event"}` +
      (e.occurred_at ? ` (${String(e.occurred_at).slice(0, 10)})` : "")
    ),
    times_engaged: contact.engagement_count ?? 0,
    first_seen: contact.first_seen_at ? String(contact.first_seen_at).slice(0, 10) : null,
    last_seen: contact.last_seen_at ? String(contact.last_seen_at).slice(0, 10) : null,
    already_has_a_club_mailbox: !!contact.sahaba_mailbox,
    already_a_member_on_the_website: !!contact.linked_user_id,
    staff_notes: contact.notes || null,
  };
}

function firstWord(name: unknown): string | null {
  const s = String(name ?? "").trim();
  return s ? s.split(/\s+/)[0] : null;
}

type Draft = { subject: string; body_text: string; personalisation_note: string };

// ============================================================
// Asking the model
// ============================================================
//
// Retries the transient half of the taxonomy, in-process, and gives up early
// rather than late. `startedAt` is THIS RECIPIENT's start — see
// RETRY_DEADLINE_MS for why it is not the invocation's.
//
// ---- Why truncation is retried, and why it escalates ----------------------
//
// The sibling shipped `output_truncated` as non-retryable, reasoning that "the
// same input hits the same ceiling every time". That is wrong, and the evidence
// was already in its logs: two consecutive runs over the same 87 people failed
// on *different* sets — 27 then 29, six that had succeeded now failing and four
// the reverse. A deterministic ceiling cannot do that.
//
// The mechanism is the one described at MAX_OUTPUT_TOKENS: most of the budget
// goes on reasoning, reasoning length is sampled rather than fixed, and nothing
// here pins a seed (reasoning models do not honour temperature in any case). A
// contact whose total sits near the ceiling therefore fits on some draws and not
// others. Truncation is a coin flip, not a verdict on the contact.
//
// But "not deterministic" is not on its own a reason to retry: retrying the
// *same request* at the *same ceiling* is another flip at unknown odds, bought
// with latency and spend across a batch of twenty-five. So the ceiling
// escalates. Attempt one asks for `maxOutputTokens`; any attempt after a
// truncation asks for `maxOutputTokensRetry`. The retry is worth something
// because it is a different request, not because the first was unlucky.
async function askModel(
  cfg: EmailConfig,
  campaign: Record<string, unknown>,
  context: Record<string, unknown>,
  startedAt: number,
): Promise<Draft> {
  let attempt = 0;
  let ceiling = cfg.maxOutputTokens;
  for (;;) {
    attempt++;
    let failure: EmailError;
    try {
      return await askModelOnce(cfg, campaign, context, ceiling);
    } catch (err) {
      if (err instanceof EmailError) {
        failure = err;
      } else {
        console.error("write-contact-email: unclassified failure in askModel", err);
        failure = new EmailError("internal_error", 500, String(err instanceof Error ? err.message : err));
      }
      failure.attempts = attempt;
    }

    // Raise the ceiling for whatever comes next. Done before `planRetry` so
    // that it also applies when the *next* failure is a rate limit: once we
    // know this contact needs more room, every further attempt gets it.
    if (failure.code === "output_truncated") ceiling = cfg.maxOutputTokensRetry;

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
      console.error(`openai attempt ${attempt} failed (${failure.code}); not retrying: ${plan.reason}`);
      throw failure;
    }

    console.warn(
      `openai attempt ${attempt} failed (${failure.code}); retrying in ${plan.delayMs}ms at ceiling ${ceiling}`,
    );
    await sleep(plan.delayMs);
  }
}

// Pure, and separated from the loop so it can be exercised without a network:
// every input is an argument, including the clock reading and the source of
// randomness. The three ways it says no are distinguished by `reason` because
// "we gave up" and "there was nothing to gain" are different operational facts
// and one of them means raise the budget.
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
  // budget check passes at 74s, the attempt starts, and the invocation is
  // killed holding a socket — which reaches the caller as a dead connection
  // rather than as the 429 it should have been.
  if (opts.elapsedMs + delayMs + opts.reserveMs > opts.deadlineMs) {
    return { retry: false, delayMs, reason: "budget_exhausted" };
  }
  return { retry: true, delayMs, reason: "retry" };
}

// Exponential with equal jitter: half the window fixed, half random. A
// `Retry-After` from OpenAI wins whenever it asks for longer than we would have
// waited anyway — it is the only party that knows when the window actually
// reopens — and it is deliberately not capped here, because `planRetry`
// compares the result against the remaining budget and declines rather than
// sleeping for less than we were told and being refused again.
function backoffDelayMs(attempt: number, retryAfterMs: number | null, rand: () => number): number {
  const window = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
  const jittered = Math.round(window / 2 + rand() * (window / 2));
  return Math.max(jittered, retryAfterMs ?? 0);
}

// ---- What OpenAI just told us -----------------------------------------
//
// Pure: status, body text and the parsed `Retry-After` in, a classified error
// out. The order is `build-prospect-profile`'s, and the one thing worth naming
// is that **quota is checked before the rate limit**: OpenAI reports an
// exhausted balance as HTTP 429 with `insufficient_quota` in the body. Treated
// as a rate limit it would be retried, backed off, retried again and reported
// as "busy" for ever — and in a function that loops over twenty-five people,
// that is twenty-five times the backoff for a condition that no amount of
// waiting will fix. Somebody has to go and add credit.
function triageOpenAI(status: number, detail: string, retryAfterMs: number | null): EmailError {
  if (/model_not_found|does not exist|unknown model/i.test(detail)) {
    return new EmailError(
      "model_not_configured",
      503,
      // Two places the name can come from since 0031, so the sentence names
      // both rather than sending an operator to change a value that is not
      // being read.
      "The configured AI model name isn't valid. Change it under Admin → AI services → Outreach email drafting if a model is set there, or set OPENAI_MODEL in the Supabase Edge Function secrets to a model your account can use.",
    );
  }
  if (/insufficient_quota|billing_hard_limit|exceeded your current quota|billing_not_active/i.test(detail)) {
    return new EmailError(
      "quota_exhausted",
      402,
      "The AI account has run out of credit. Top up the OpenAI billing account, then generate this batch again.",
    );
  }
  if (status === 401 || status === 403 || /invalid_api_key|incorrect api key/i.test(detail)) {
    // 503 rather than 502, matching both siblings: a key OpenAI rejects is our
    // configuration being wrong, which is the same class of thing as the key
    // being absent, and that already answers 503 in the handler above.
    return new EmailError(
      "ai_credentials",
      503,
      "The AI service rejected our credentials. Check OPENAI_API_KEY.",
    );
  }
  if (status === 429) {
    return new EmailError(
      "rate_limited",
      429,
      "The AI service is rate-limiting us right now. Nothing is wrong with this campaign — generate the batch again in a moment.",
      { retryable: true, retryAfterMs },
    );
  }
  if (status === 408 || status === 409 || status >= 500) {
    return new EmailError(
      "upstream_error",
      502,
      `The AI service couldn't answer just now (its status was ${status}). Try this batch again shortly.`,
      { retryable: true, retryAfterMs },
    );
  }
  if (status === 400 || status === 422) {
    // OpenAI understood us and said no. That is this function's request being
    // wrong, which is a bug here — retrying only buys the same refusal more
    // expensively.
    //
    // The one operator-reachable way to land here is a model that is not a
    // reasoning model: `reasoning` is rejected outright by those, and the model
    // is settable both in the secret and in the panel. Named, because the
    // alternative is somebody spending an afternoon on the ceiling.
    return new EmailError(
      "upstream_rejected_request",
      500,
      "The AI service rejected the request this function sent. That is a bug here, not a problem with the campaign — unless the model chosen under Admin → AI services is not a reasoning model, in which case it is the `reasoning` parameter being refused.",
    );
  }
  return new EmailError(
    "upstream_error",
    502,
    `The AI service couldn't answer just now (its status was ${status}). Try this batch again shortly.`,
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

// "6m0s", "1.5s", "200ms", "1h2m3s" → milliseconds. Anything that is not wholly
// made of duration parts returns null rather than a number built out of the
// parts it recognised: half-parsing "soon" into 0 would look like an
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
    // this loop ends.
    end = re.lastIndex;
    matched = true;
  }
  if (!matched || end !== v.length) return null;
  return Math.round(total);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function askModelOnce(
  cfg: EmailConfig,
  campaign: Record<string, unknown>,
  context: Record<string, unknown>,
  maxOutputTokens: number,
): Promise<Draft> {
  const languageLine = campaign.language === "match"
    ? "Choose the language this person is most likely to read comfortably, based on their details."
    : campaign.language === "ar"
    ? "Write in Arabic."
    : "Write in English.";

  const userPrompt = [
    `What we want to say:\n${campaign.brief}`,
    campaign.must_include
      ? `\nMust appear verbatim, exactly as written:\n${campaign.must_include}`
      : "",
    `\nTone: ${campaign.tone}. ${languageLine}`,
    `\nSign off as: ${campaign.from_name}`,
    `\nEverything the club knows about this person (nothing else is known — do not go beyond it):\n${JSON.stringify(context, null, 2)}`,
  ].filter(Boolean).join("\n");

  // One hung socket must not spend the whole batch: twenty-four other people
  // are waiting behind this one, and the caller would get a killed connection
  // carrying none of the triage below. Aborted attempts are retryable — a
  // timeout is the most transient thing in the set.
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
        model: cfg.model,
        instructions: cfg.systemPrompt,
        // Both keys matter, and neither substitutes for the other. See
        // MAX_OUTPUT_TOKENS: the ceiling is shared with the model's own
        // reasoning tokens, so capping effort is what makes the ceiling
        // predictable, and raising the ceiling is what survives the contact
        // nobody anticipated.
        reasoning: { effort: REASONING_EFFORT },
        max_output_tokens: maxOutputTokens,
        input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
        text: {
          format: { type: "json_schema", name: "email", strict: true, schema: EMAIL_SCHEMA },
        },
      }),
    });
  } catch (err) {
    const aborted = abort.signal.aborted;
    console.error("OpenAI request failed: " + String(err instanceof Error ? err.message : err));
    throw new EmailError(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      502,
      aborted
        ? "The AI service took too long to answer. Try this batch again shortly."
        : "Couldn't reach the AI service just now. Try this batch again shortly.",
      { retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text();
    console.error("OpenAI " + res.status + ": " + detail.slice(0, 500));
    throw triageOpenAI(res.status, detail, parseRetryAfterMs((n) => res.headers.get(n), Date.now()));
  }

  const data = await res.json();
  const message = (data.output ?? []).find((o: { type?: string }) => o.type === "message");
  const parts = message?.content ?? [];

  if (parts.some((p: { type?: string }) => p.type === "refusal")) {
    // A judgement about this person's context, not a hiccup. Retrying asks the
    // same question and pays for the same answer, so it is not retried and it
    // is not a 500 — nothing is broken.
    throw new EmailError("model_refused", 422, "The model declined to write this one");
  }

  // ---- Stop here, before anything is read out of a half-written answer ----
  //
  // This check stays AHEAD of the `output_text` read, and that ordering is the
  // safety property rather than a stylistic preference. A truncated response
  // still carries an `output_text` part; it is simply cut off mid-string.
  // Parsing it would either throw on malformed JSON or — worse, and the case
  // this guards — succeed on an email whose sign-off is missing, and store it
  // as `generated`, where a reviewer skimming twenty-five drafts approves it
  // and it goes to a real person. A draft that does not exist is recoverable.
  if (data.status === "incomplete") {
    const reason = data.incomplete_details?.reason ?? "unknown";
    console.error(
      `openai returned incomplete (${reason}) at max_output_tokens=${maxOutputTokens}; ` +
        `reasoning tokens used: ${data.usage?.output_tokens_details?.reasoning_tokens ?? "unreported"} ` +
        `of ${data.usage?.output_tokens ?? "unreported"} output tokens`,
    );

    // A different condition wearing the same status. The model's own filter
    // stopped it; no ceiling is involved and raising ours would not change the
    // answer. Reported as truncation — which is what this function did before,
    // for every `incomplete` there is — it sends somebody to edit a number that
    // was never the problem. That is the exact failure this taxonomy exists to
    // prevent, so it gets its own code and is not retried.
    if (reason === "content_filter") {
      throw new EmailError(
        "content_filtered",
        422,
        "The AI service stopped partway through this one. Not a size problem — look at what this campaign asks for and at this contact's staff notes.",
      );
    }

    // Retryable, and `askModel` escalates the ceiling before going again — see
    // the comment there for why "not deterministic" alone would not justify a
    // retry. The 503 is deliberate and is the one retryable 503 in the set: if
    // the escalated attempt truncates too, the remaining action is to raise a
    // configured number, which is what every other 503 here also means.
    throw new EmailError(
      "output_truncated",
      503,
      `The AI service ran out of room mid-email (ceiling ${maxOutputTokens} tokens, shared with its own ` +
        `reasoning). Nothing is wrong with this contact. If this persists, raise the ceiling under ` +
        `Admin → AI services → Outreach email drafting (or MAX_OUTPUT_TOKENS_RETRY in write-contact-email, ` +
        `which is what the panel's value scales from), or lower REASONING_EFFORT there — re-running at the ` +
        `same settings will not reliably fix it.`,
      { retryable: true },
    );
  }

  const textPart = parts.find((p: { type?: string }) => p.type === "output_text");
  if (!textPart?.text) {
    // An empty 200 is the upstream misbehaving rather than refusing, and it
    // does clear on a second ask — so unlike the two above, this one is
    // retryable.
    throw new EmailError(
      "upstream_bad_response",
      502,
      "Nothing came back from the AI service. Try this batch again shortly.",
      { retryable: true },
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(textPart.text);
  } catch {
    throw new EmailError(
      "upstream_bad_response",
      502,
      "The AI service's answer wasn't readable. Try this batch again shortly.",
      { retryable: true },
    );
  }

  return validate(parsed);
}

// ============================================================
// Checking what came back
// ============================================================
//
// Every rule with a real-world cost gets checked here. The prompt is how the
// model is asked; this is how the answer is verified. A rule that exists only
// in the prompt is a rule that holds until the day it does not.
//
// All of these are `draft_rejected`, 502, **retryable**, and that is a change
// worth naming: they used to be bare throws that marked the recipient `failed`
// on the first bad sample. A draft that named the licence tier is not a broken
// contact and not a broken function — it is one unlucky sample, and the honest
// response to an unlucky sample is another sample. `askModel` retries at the
// SAME ceiling, which is right: nothing here says the model needed more room.
// Only `output_truncated` escalates.
function validate(parsed: Record<string, unknown>): Draft {
  const subject = String(parsed.subject ?? "").trim();
  const bodyText = String(parsed.body_text ?? "").trim();
  const note = String(parsed.personalisation_note ?? "").trim();

  if (!subject || !bodyText) {
    throw new EmailError(
      "draft_rejected",
      502,
      "The draft came back without " + (subject ? "a body" : "a subject line") + ". Writing it again.",
      { retryable: true },
    );
  }

  // Rule 2 is the one with a real-world cost if it slips through, so it is
  // checked rather than trusted. Failing here puts it in front of a reviewer
  // as an error instead of putting "Office 365 A1" in front of 900 people.
  const forbidden = /\bA1\b|office\s*365\s*a1/i;
  if (forbidden.test(subject) || forbidden.test(bodyText)) {
    throw new EmailError(
      "draft_rejected",
      502,
      "The draft named the licence tier, which is never allowed in club mail. Writing it again.",
      { retryable: true },
    );
  }
  if (/\[[A-Za-z ]+\]/.test(bodyText)) {
    throw new EmailError(
      "draft_rejected",
      502,
      "The draft came back with an unfilled placeholder in it. Writing it again.",
      { retryable: true },
    );
  }

  // ---- The three caps, which are terms in the MAX_OUTPUT_TOKENS sum ----
  //
  // Rejected rather than truncated. `promptarena-judge` caps its fields because
  // a clipped sentence of coaching is still useful; an email is not that. A
  // subject cut at 200 characters or a body cut mid-paragraph lands in the
  // review queue looking finished, and the one thing this function must never
  // do is put something in front of a reviewer that reads as complete and is
  // not. Logged as well as rejected, because hitting one of these means the
  // model stopped honouring the brief.
  for (const [field, value, max] of [
    ["subject", subject, SUBJECT_MAX_CHARS],
    ["body_text", bodyText, BODY_MAX_CHARS],
    ["personalisation_note", note, NOTE_MAX_CHARS],
  ] as Array<[string, string, number]>) {
    if (value.length > max) {
      console.warn(`write-contact-email: ${field} came back at ${value.length} chars, over the ${max} cap`);
      throw new EmailError(
        "draft_rejected",
        502,
        `The draft's ${field.replace("_", " ")} is far longer than this campaign asks for. Writing it again.`,
        { retryable: true },
      );
    }
  }

  return { subject, body_text: bodyText, personalisation_note: note };
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders },
  });
}
