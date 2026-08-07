// promptarena-challenge
// ------------------------------------------------------------
// Generates fresh practice challenges into `promptarena_challenges`. Runs as
// the service role, because 0029 says the challenge bank "is maintained by the
// service role, from an Edge Function or a SQL session" — no client role holds
// so much as SELECT on that table, and the reason is `rubric`: it is the
// marking scheme, and a member who can read it writes to the rubric instead of
// to the brief, which is the one skill this mode exists NOT to teach.
//
// ============================================================
// Why this function exists at all
// ============================================================
//
// The brief: "Questions should not be static. The AI should generate fresh
// challenges continuously. The objective is to expose members to many prompt
// engineering techniques rather than memorizing answers."
//
// The six live events show exactly what a static bank looks like. 556
// submissions were made against **19 distinct challenges behind 26 raw
// wordings**, and five of those carry half the dataset:
//
//   workout-plan 93 · futuristic-city-image 57 · career-coach-ai-fear 49 ·
//   coffee-shop-online-growth 45 · video-script-healthy-eating 45 ·
//   compare-online-vs-classroom 36
//
// Two things follow from that measurement and both are built into this
// function rather than left to the prompt:
//
//   1. **The domain spread has to be widened deliberately.** Left to itself a
//      model asked for "a prompt engineering challenge" produces another
//      marketing brief or another image prompt, because that is what the genre
//      looks like. `chooseAxes` picks the domain from a fixed wide vocabulary,
//      preferring whichever is thinnest in the bank right now — so the bank
//      fills out rather than deepening the rut it is already in.
//
//   2. **The technique has to be an axis in its own right.** "Expose members to
//      many prompt engineering techniques" is a statement about what a
//      challenge should *demand*, not about its subject. A challenge that can
//      only be met with few-shot examples teaches few-shot; twenty more image
//      briefs teach one technique twenty times. 0029 has no column for it, so
//      it is recorded in `generation_params` — which the deck view deliberately
//      omits, so a member cannot see which technique they are being tested on
//      and write to it, and which is still queryable by staff as
//      `generation_params->>'technique'`.
//
// 0029 explains why the other axes are columns rather than a `tags` array: the
// generator is asked to COVER them. "Give me a hard, constrained, creative
// brief in healthcare for a beginner audience" is a request a column can serve
// and a text array cannot, and "how many hard healthcare challenges do we have"
// is the question that stops the bank filling up with forty variations of the
// same thing. This function is the caller that asks it.
//
// ============================================================
// What it does NOT do
// ============================================================
//
// It does not serve a challenge and it does not touch `times_served`. Serving
// is a different operation with a different caller — `lib/promptarena.js`
// picks from the deck client-side today and its own comment says an Edge
// Function that serves-and-counts "replaces this call and nothing else on the
// page changes". That function does not exist yet and it is not this one:
// mixing "make more challenges" and "hand one to a member" into a single
// endpoint would put an expensive occasional job and a per-page-load job behind
// the same rate limit and the same retry budget.
//
// It also never retires a challenge. 0029 is explicit that retirement is a
// judgement made against `promptarena_challenge_calibration`, and it is not
// something to do on the way past while inserting new rows.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   OPENAI_API_KEY
//   OPENAI_MODEL                             — optional, defaults below
//
// Since 0031 the system prompt and the model can also be set from Admin → AI
// services, under the `promptarena-challenge` service. The constants below
// remain the floor. The ceiling is NOT settable there — it is computed per
// call from the batch size (see `ceilingFor`), and a single number would be
// wrong for nine batch sizes out of ten.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { loadAiConfig, part } from "../_shared/ai-config.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-5";

// Written to `promptarena_challenges.generator_version` on every row. 0029
// keeps it "in the same spirit as prospect_profiles.sources": when a challenge
// turns out to be incoherent or accidentally offensive, the first question is
// which model and which generation prompt produced it, and the answer should
// not depend on anybody remembering. ⚠ Bump it whenever the vocabularies, the
// system prompt or the validation below change.
const GENERATOR_VERSION = "2026-08-02.1";

// ⚠ And the half of that instruction a comment cannot enforce, for the same
// reason `promptarena-judge` spells out at length above its own `JUDGE_VERSION`:
// staff can change the system prompt and the model from the admin panel, and
// the person doing it is not reading this file. `generatorVersion` below
// appends 0031's content digest — computed by a database trigger over the
// stored prompt and model, not by anything here — so a challenge generated
// under an override records which override produced it. "Which prompt wrote
// this incoherent challenge" stays answerable without anybody remembering.
const AI_SLUG = "promptarena-challenge";

type ChallengeConfig = {
  model: string;
  systemPrompt: string;
  generatorVersion: string;
};

async function resolveChallengeConfig(
  admin: ReturnType<typeof createClient>,
): Promise<ChallengeConfig> {
  const ai = await loadAiConfig(admin, AI_SLUG, {
    model: MODEL,
    parts: { system: SYSTEM_PROMPT },
  });
  return {
    model: ai.model,
    systemPrompt: part(ai, "system", SYSTEM_PROMPT),
    generatorVersion: GENERATOR_VERSION + (ai.digest ? "+" + ai.digest : ""),
  };
}

// ============================================================
// What "it failed" is allowed to mean
// ============================================================
//
// The same contract as `build-prospect-profile` and `promptarena-judge`:
// status, a stable machine-readable code, and whether it is retryable — decided
// here, at the only place that knows what actually went wrong. Three functions
// calling the same upstream must not hold three different opinions about what a
// 429 means.
//
//   code                       status  retryable  meaning
//   ------------------------   ------  ---------  --------------------------
//   rate_limited                  429  yes        OpenAI is throttling us
//   upstream_error                502  yes        OpenAI 5xx/408
//   upstream_timeout              502  yes        our own attempt timeout
//   upstream_unreachable          502  yes        the request never completed
//   upstream_bad_response         502  yes        200 with nothing usable in it
//   nothing_usable                502  yes        every candidate was rejected
//   quota_exhausted               402  no         the OpenAI balance is spent
//   ai_unconfigured               503  no         OPENAI_API_KEY not set
//   ai_credentials                503  no         OPENAI_API_KEY rejected
//   model_not_configured          503  no         OPENAI_MODEL unusable
//   not_configured                503  no         no service-role key here
//   output_truncated              503  yes        our token ceiling was too low
//   model_refused                 422  no         the model declined
//   content_filtered              422  no         the model's own filter stopped it
//   bad_request                   400  no         the caller sent nonsense
//   not_signed_in / not_allowed   401/403  no     the caller is not staff
//   upstream_rejected_request     500  no         we sent OpenAI a bad request
//   write_failed                  500  no         the insert was refused
//   internal_error                500  no         an unhandled bug in here
class ChallengeError extends Error {
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
    this.name = "ChallengeError";
    this.code = code;
    this.status = status;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

// The retry budget, unchanged from `build-prospect-profile`. Bounded twice and
// by wall clock rather than attempt count alone, so a function killed mid-retry
// never reaches the caller as a dead connection instead of the 429 it could
// have acted on. See that file for the full argument.
//
// ⚠ RETRY_RESERVE_MS MUST NOT BE LESS THAN ATTEMPT_TIMEOUT_MS, and it was:
// 25,000 of reserve against a 45,000 attempt. `planRetry` describes the reserve
// as "room for the attempt the sleep is *for*", so a reserve below the longest
// an attempt may run permitted a retry to start at 25s and run to 70s — 20s
// past the 50s deadline the same block sets.
//
// `promptarena-judge` and `write-contact-email` both set reserve EXACTLY equal
// to attempt, which is the correct form. The deadline moves with it, because
// 50s of deadline against a 45s reserve leaves a retry 5s of elapsed time to
// fit inside — and one call that writes a whole batch of challenges has never
// finished in 5s, so the ceiling escalation this file's `askModel` is built
// around would never once have run. 90/45/45 is `promptarena-judge`'s shape,
// and that function has the same 45s attempt timeout as this one.
//
// Worst case is an attempt starting at 45s and being aborted at 90s, inside the
// platform's 150s with room for the bank read and the insert.
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 8_000;
const RETRY_DEADLINE_MS = 90_000;
const RETRY_RESERVE_MS = 45_000;
const ATTEMPT_TIMEOUT_MS = 45_000;

// One model call produces the whole batch. Asking for five challenges in one
// call rather than five calls is not only cheaper — it is the only way the
// model can be told "make these five different from each other", which is the
// property that matters most given what the legacy bank looks like.
const BATCH_DEFAULT = 5;
const BATCH_MAX = 10;

// ============================================================
// The output token budget
// ============================================================
//
// ⚠ This started as `1200 + 700 * count`, which was sized against the visible
// answer alone. That is the same mistake that failed 42.9% of
// `build-prospect-profile`'s live calls with `status: "incomplete"` at a ceiling
// of 1500: on the `gpt-5` family, `max_output_tokens` is shared with the model's
// own reasoning tokens — the parameter limits "reasoning tokens, visible output
// tokens, and non-visible formatting tokens", and exhausting it "might occur
// before any visible output tokens are produced".
//
// The old formula gave a batch of ten 8,200 tokens against ~5,300 of visible
// answer, leaving under 3,000 for reasoning across ten distinct challenges. It
// had not failed yet; it was one long batch away from it.
//
// ---- The visible half, per challenge, bounded by `validate` -----------
//
//   title           TITLE_MAX_CHARS                                        120
//   brief           BRIEF_MAX_CHARS                                        900
//   constraints     4 × 200 (cleanList)                                    800
//   rubric          8 integer keys                                        ~150
//   echoed axes + JSON scaffolding                                        ~180
//                                                              ---------------
//                                                            ~2,150 characters
//
// Challenges are written in English by instruction ("Write in clear, plain
// English"), so there is no Arabic multiplier here as there is in
// `promptarena-judge` — ~3.2 characters per token is the honest figure for prose
// with this much punctuation and structure. That is **~675 tokens of visible
// output per challenge**, so VISIBLE_TOKENS_EACH is 700.
//
// ---- The reasoning half ----------------------------------------------
//
// Partly fixed and partly per-challenge, which is why the formula has both
// terms. The fixed part is reading the bank's titles and the axis
// specifications; the per-challenge part is real, because "make these five
// genuinely different from each other" is work that grows with the batch.
// 8,000 fixed and 900 each is the allowance, which puts a default batch of five
// at 5 × 1,600 + 8,000 = 16,000 and a maximum batch of ten at 24,000.
//
// As in `promptarena-judge`, no `reasoning: { effort }` key is sent. Writing a
// challenge that cannot be met without a particular technique, and that is
// genuinely unlike nineteen existing ones, IS the reasoning — capping it would
// buy headroom by making the output worse. Unused ceiling costs nothing: OpenAI
// bills tokens generated, not tokens permitted.
const VISIBLE_TOKENS_EACH = 700;
const REASONING_TOKENS_EACH = 900;
const REASONING_TOKENS_FIXED = 8_000;
const REASONING_TOKENS_FIXED_RETRY = 26_000;

// One ceiling, derived. `escalated` is the second-attempt version, used after a
// truncation — see `askModel`.
function ceilingFor(count: number, escalated: boolean): number {
  const fixed = escalated ? REASONING_TOKENS_FIXED_RETRY : REASONING_TOKENS_FIXED;
  return fixed + count * (VISIBLE_TOKENS_EACH + REASONING_TOKENS_EACH);
}

// How much of the existing bank is shown to the model so it does not
// re-invent something already there. Titles only: the full briefs would be most
// of the context window at any real bank size, and a title is enough to say
// "we already have this".
const RECENT_TITLES_MAX = 150;

// ============================================================
// The generation axes
// ============================================================
//
// ⚠ DOMAINS ARE DELIBERATELY WIDER THAN THE LEGACY BANK. Every one of the 19
// historical challenges sits in a handful of consumer and creative areas —
// fitness, image generation, career advice, small-business marketing, video
// scripts, study comparisons. Nothing in healthcare, nothing in law, nothing in
// operations, nothing in accessibility, nothing in the public sector.
//
// That narrowness is not a taste problem, it is a teaching problem: a member
// who has only ever written prompts about workout plans has learned to write
// prompts about workout plans. `chooseAxes` prefers whichever of these is
// thinnest in the bank, so the spread widens on its own rather than needing
// somebody to notice.
const DOMAINS = [
  "healthcare", "legal", "finance", "education", "software_engineering",
  "data_analysis", "scientific_research", "manufacturing", "logistics",
  "agriculture", "energy", "retail", "hospitality", "real_estate",
  "human_resources", "customer_support", "journalism", "public_sector",
  "nonprofit", "marketing", "product_design", "accessibility",
  "cybersecurity", "translation", "creative_writing", "visual_art",
  "music", "gaming", "sports", "personal_productivity",
];

// Who the prompt is being written FOR — which changes what a good prompt looks
// like far more than the subject does. A brief aimed at a "child" and one aimed
// at a "regulator" reward opposite instincts.
const AUDIENCES = [
  "beginner", "child", "teenager", "student", "general_public",
  "developer", "designer", "clinician", "teacher", "executive",
  "small_business_owner", "researcher", "regulator", "journalist",
  "non_native_english_speaker", "expert_practitioner",
];

// ⚠ THE AXIS THE BRIEF ACTUALLY ASKS FOR: "expose members to many prompt
// engineering techniques". A challenge is chosen so that meeting it well
// REQUIRES the technique — not so that the technique is mentioned in the brief,
// which would just be telling the member the answer.
//
// Recorded in `generation_params.technique`, which the deck view omits. That
// omission is doing real work: a member who could see "this one is testing
// few-shot" would supply two examples and stop thinking, and the bank would
// measure compliance rather than skill.
const TECHNIQUES = [
  "role_assignment",
  "few_shot_examples",
  "step_by_step_decomposition",
  "explicit_output_schema",
  "negative_constraints",
  "audience_adaptation",
  "tone_and_register_control",
  "length_and_budget_control",
  "context_supply",
  "delimiters_and_input_separation",
  "self_check_and_revision",
  "comparison_and_tradeoff_framing",
  "persona_and_voice",
  "chain_of_reasoning_request",
  "format_conversion",
  "ambiguity_resolution",
  "edge_case_enumeration",
  "iterative_refinement",
];

// ⚠ MUST STAY IN STEP WITH `promptarena-judge`. The judge marks these eight and
// nothing else, and the rubric written here is the weight map it reads. A name
// invented here that the judge does not know is a weight applied to nothing —
// the judge logs it and falls back to its house weights, so the failure is
// visible rather than silent, but the challenge author's intent is lost.
//
// They are duplicated rather than shared because the deploy twin inlines only
// `_shared/cors.ts`; a third shared module would have to be inlined into both
// twins and would be one more thing to keep in step, not one fewer. The
// duplication is checked by the test harness instead.
const DIMENSIONS = [
  "clarity",
  "context",
  "goal_definition",
  "instructions",
  "constraints",
  "output_format",
  "completeness",
  "creativity",
] as const;

type Dimension = typeof DIMENSIONS[number];

// A brief shorter than this is a topic, not a challenge. The legacy bank's
// wordings run 45-130 characters and several of them ("Write a prompt to give
// me a 30-minute workout plan") are exactly the kind of thing that produced 93
// near-identical submissions.
const BRIEF_MIN_CHARS = 60;
const BRIEF_MAX_CHARS = 900;
const TITLE_MIN_CHARS = 8;
const TITLE_MAX_CHARS = 120;

// ============================================================
// The system prompt
// ============================================================
const SYSTEM_PROMPT =
  `You write practice challenges for PromptArena, a prompt-engineering practice mode run by Sahaba Club. A member reads your challenge and writes a PROMPT to meet it. An AI coach then scores their prompt and teaches them.

You are writing the challenge, never the answer. Never include an example prompt, never demonstrate the technique, and never hint at what a good answer contains beyond what the brief legitimately asks for. A member who can read the answer off the challenge learns nothing.

## What a challenge is

A short, concrete, realistic situation with a stated goal, given to the member in the second person. It should read like a real task somebody actually has, not like an exam question.

Good: "A regional hospital wants to turn its 40-page discharge policy into something a newly qualified nurse can act on during a shift. Write the prompt that produces it."
Weak: "Write a prompt about healthcare."

## What makes a challenge worth setting

- **It has a real audience and a real constraint.** "Explain X" teaches nothing; "explain X to somebody who will have to repeat it to their manager in one minute" forces choices.
- **It cannot be met by restating it.** If pasting the challenge back would score well, the challenge is too thin.
- **It leaves the member the interesting decisions.** State the goal and the situation; do not pre-decide the structure, the format or the tone unless that is the point of the challenge.
- **It is answerable in one prompt.** Not a project, not a conversation — one well-built prompt.

## The axes you are given

Each challenge you write is assigned a domain, a target audience, a difficulty (1 easiest to 5 hardest), a creativity level (1 tightly specified to 5 wide open) and a **technique**. Honour all five.

The technique is the important one and it is the reason this mode exists. Write a challenge that CANNOT BE MET WELL WITHOUT USING IT — but never name it, never describe it, and never tell the member to use it. If the technique is "few_shot_examples", set a task where the required output has an idiosyncratic house style that could only be conveyed by showing examples. If it is "negative_constraints", set a task with a well-known default answer that must be avoided. The member should discover the technique because the task demands it.

## Constraints

Give each challenge one to four \`constraints\` — the rules the member's prompt must respect, shown to them as a checklist beside the brief. They must be checkable by reading the prompt ("under 80 words", "must not name a specific brand", "must specify an output format"), not by running it. Do not make a constraint that simply restates the technique.

## The rubric

Weight the eight marking dimensions from 0 to 5 for this specific challenge. 0 means it does not apply here. Be genuinely differential — a challenge about producing a structured report should weight output_format heavily; an open creative brief should weight it at 0 or 1 and creativity at 4 or 5. A rubric that is the same for every challenge is a rubric that says nothing.

The dimensions: clarity, context, goal_definition, instructions, constraints, output_format, completeness, creativity.

## Variety, which is the whole point

You are producing several challenges at once. They must differ from each other in subject, in shape and in what they demand — not five versions of one idea with the nouns swapped. You are also given the titles already in the bank: do not produce anything that duplicates or lightly rewords one of them.

The bank this replaces had 19 distinct challenges for 556 attempts, and five of them carried half the traffic — a workout plan, a futuristic-city image, a career-coaching question, a coffee-shop growth question and a healthy-eating video script. Those are the rut. Write away from them.

## Register

Write in clear, plain English. No markdown, no headings, no emoji, no exclamation marks, no marketing voice. The title is a short human label, not a sentence and not a slug.`;

// The strict JSON schema. `technique` is echoed back so a mismatch between what
// was asked for and what was written is visible; it is not trusted as a
// selection, since the assignment is made here.
const CHALLENGE_SCHEMA = {
  type: "object",
  properties: {
    challenges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "A short human label, 8 to 120 characters. Not a sentence." },
          brief: {
            type: "string",
            description:
              "The situation and the goal, in the second person, 60 to 900 characters. What the member must achieve with a prompt.",
          },
          domain: { type: "string", description: "Echo the domain you were assigned." },
          target_audience: { type: "string", description: "Echo the target audience you were assigned." },
          technique: { type: "string", description: "Echo the technique you were assigned." },
          difficulty: { type: "integer", description: "Echo the difficulty you were assigned, 1 to 5." },
          creativity: { type: "integer", description: "Echo the creativity level you were assigned, 1 to 5." },
          constraints: {
            type: "array",
            items: { type: "string" },
            description: "One to four rules the member's prompt must respect, checkable by reading the prompt.",
          },
          rubric: {
            type: "object",
            properties: Object.fromEntries(
              DIMENSIONS.map((d) => [d, { type: "integer", description: `Weight for ${d}, 0 to 5` }]),
            ),
            required: [...DIMENSIONS],
            additionalProperties: false,
          },
        },
        required: [
          "title", "brief", "domain", "target_audience", "technique",
          "difficulty", "creativity", "constraints", "rubric",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["challenges"],
  additionalProperties: false,
} as const;

// ============================================================
// The handler
// ============================================================
//
// Synchronous, unlike `promptarena-judge` and `generate-avatar`, and
// deliberately: nobody is sitting on a spinner. The caller is staff tooling or
// a scheduled job that wants to know what landed in the bank, and there is no
// row for it to poll — a challenge that fails to generate leaves no trace and
// needs none. One model call for the whole batch fits inside the budget with
// room to spare.
//
//   POST {}                                → 5 challenges, axes chosen here
//   POST {"count": 3, "domain": "legal"}   → 3, all in that domain
//   POST {"dry_run": true}                 → generated and validated, not stored
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Taken here rather than inside the model call so the retry budget is
  // measured against the invocation's own wall clock — the auth lookup and the
  // bank read have already spent some of it.
  const startedAt = Date.now();

  try {
    if (!SERVICE_ROLE_KEY) {
      return fail(new ChallengeError("not_configured", 503, "Not configured"));
    }
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ---- Staff or the service role, and nobody else ----
    //
    // Checked in the function body because this runs as the service role: RLS
    // is bypassed, so the database will not refuse anything on our behalf. If
    // this check is not made, it is not made.
    //
    // ⚠ There is no member path here at any tier. This is not a paywall — 0029
    // is emphatic that PromptArena has none — it is that generating challenges
    // is a maintenance operation that spends money and writes the marking
    // scheme. A member calling it could fill the bank with challenges whose
    // rubric they had just watched being written.
    const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
    if (bearer !== SERVICE_ROLE_KEY) {
      const { data: userData, error: userError } = await admin.auth.getUser(bearer);
      if (userError || !userData?.user) {
        return fail(new ChallengeError("not_signed_in", 401, "Not signed in"));
      }
      const { data: callerProfile } = await admin
        .from("profiles")
        .select("role")
        .eq("user_id", userData.user.id)
        .maybeSingle();
      if (callerProfile?.role !== "staff" && callerProfile?.role !== "admin" && callerProfile?.role !== "global_admin") {
        console.error(`non-staff user ${userData.user.id} attempted promptarena-challenge`);
        return fail(new ChallengeError("not_allowed", 403, "Not allowed"));
      }
    }

    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is not set");
      return fail(new ChallengeError(
        "ai_unconfigured",
        503,
        "The challenge generator isn't configured yet. Set OPENAI_API_KEY in the Edge Function secrets.",
      ));
    }

    const body = await req.json().catch(() => ({}));
    const count = clampInt(body?.count, 1, BATCH_MAX, BATCH_DEFAULT);
    const dryRun = body?.dry_run === true;

    // ---- What is already in the bank ----
    //
    // Two separate things are read from it, and they answer two different
    // questions. `titles` stops the model re-inventing something that is
    // already there. `coverage` is what makes the spread widen: it is the
    // count per domain, per audience and per technique, and `chooseAxes` picks
    // the thinnest.
    const bank = await readBank(admin);

    const requests: AxisRequest[] = [];
    for (let i = 0; i < count; i++) {
      requests.push(chooseAxes(body, bank, requests));
    }

    // Resolved once for the whole batch: ten challenges written in one
    // invocation must be ten challenges from one generator, or
    // `generator_version` is a column that answers a question about the batch
    // rather than about the row.
    const cfg = await resolveChallengeConfig(admin);

    const drafts = await askModel({ requests, titles: bank.titles, cfg }, startedAt);

    // ---- Validation ----
    //
    // Every rule in the system prompt is also a check here. A rule that exists
    // only in the prompt is a rule that holds until the day it does not —
    // `build-prospect-profile` makes the same argument at length about invented
    // biography and checks every one of its prompt rules in code.
    const { accepted, rejected } = validate(drafts, requests, bank);

    if (!accepted.length) {
      // Every candidate was refused. Retryable: a different draw usually
      // produces usable rows, and the caller should not have to distinguish
      // "the model is down" from "this batch happened to be all duplicates".
      throw new ChallengeError(
        "nothing_usable",
        502,
        "The generator produced nothing usable this time. Try again.",
        { retryable: true },
      );
    }

    if (dryRun) {
      return json({ ok: true, dry_run: true, generated: accepted.length, rejected, challenges: accepted });
    }

    const rows = accepted.map((c) => toRow(c, cfg));
    const { data: inserted, error: insertErr } = await admin
      .from("promptarena_challenges")
      .insert(rows)
      .select("id, title, difficulty, domain, target_audience, creativity");
    if (insertErr) {
      // Not retryable: the same rows inserted again produce the same error.
      // A CHECK violation here means `validate` let something through, which
      // is a bug in this file and should read like one.
      console.error(`promptarena-challenge insert: ${insertErr.message}`);
      throw new ChallengeError("write_failed", 500, insertErr.message);
    }

    return json({
      ok: true,
      dry_run: false,
      inserted: inserted?.length ?? 0,
      rejected,
      model: cfg.model,
      generator_version: cfg.generatorVersion,
      challenges: inserted,
    });
  } catch (err) {
    if (err instanceof ChallengeError) {
      console.error(`promptarena-challenge ${err.code} after ${err.attempts} attempt(s): ${err.message}`);
      return fail(err);
    }
    console.error(err);
    return fail(new ChallengeError(
      "internal_error",
      500,
      String(err instanceof Error ? err.message : err),
    ));
  }
});

// One shape for every failure, so a caller can branch on `code` and never has
// to read `error` to find out what happened. `Retry-After` is a real header as
// well as a body field.
function fail(err: ChallengeError, extra: Record<string, unknown> = {}): Response {
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
// Reading the bank
// ============================================================

type Bank = {
  titles: string[];
  folded: Set<string>;
  briefTokens: Array<Set<string>>;
  coverage: {
    domain: Record<string, number>;
    audience: Record<string, number>;
    technique: Record<string, number>;
  };
  total: number;
};

// Reads active AND retired challenges. A retired one must still block a
// duplicate: regenerating something that was retired for being incoherent, and
// then serving it again, is the failure mode retirement exists to prevent.
async function readBank(admin: ReturnType<typeof createClient>): Promise<Bank> {
  const { data, error } = await admin
    .from("promptarena_challenges")
    .select("title, brief, domain, target_audience, generation_params")
    .order("created_at", { ascending: false })
    .limit(RECENT_TITLES_MAX);
  if (error) throw new ChallengeError("internal_error", 500, error.message);

  const bank: Bank = {
    titles: [],
    folded: new Set(),
    briefTokens: [],
    coverage: { domain: {}, audience: {}, technique: {} },
    total: 0,
  };

  for (const row of data ?? []) {
    const title = String(row.title ?? "");
    if (title) {
      bank.titles.push(title);
      bank.folded.add(fold(title));
    }
    bank.briefTokens.push(new Set(tokens(String(row.brief ?? ""))));
    bump(bank.coverage.domain, String(row.domain ?? "general"));
    bump(bank.coverage.audience, String(row.target_audience ?? "general"));
    const params = row.generation_params;
    const technique = params && typeof params === "object" && !Array.isArray(params)
      ? String((params as Record<string, unknown>).technique ?? "")
      : "";
    if (technique) bump(bank.coverage.technique, technique);
    bank.total++;
  }
  return bank;
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

// ============================================================
// Choosing the axes
// ============================================================

type AxisRequest = {
  domain: string;
  target_audience: string;
  technique: string;
  difficulty: number;
  creativity: number;
};

// ⚠ THE ANSWER TO THE MEASURED NARROWNESS, and the reason this is arithmetic
// rather than an instruction in the prompt.
//
// A model asked to "vary the domain" varies it within the genre it already
// thinks the genre is — which for prompt-engineering challenges is marketing,
// image generation and self-improvement, exactly the rut the legacy bank is in.
// Choosing the axis here, from a fixed wide vocabulary, weighted towards
// whatever the bank has least of, means the spread widens whether or not the
// model would have widened it.
//
// `pending` is the axes already chosen for THIS batch, counted alongside the
// stored ones. Without it, a batch of five generated against an empty bank
// would pick the same thinnest domain five times over.
function chooseAxes(body: Record<string, unknown>, bank: Bank, pending: AxisRequest[]): AxisRequest {
  const pin = (key: string): string => {
    const v = body?.[key];
    return typeof v === "string" && v.trim() ? v.trim().toLowerCase().replace(/\s+/g, "_") : "";
  };

  const pendingCount = (field: keyof AxisRequest, value: string): number =>
    pending.filter((r) => r[field] === value).length;

  const thinnest = (options: string[], counter: Record<string, number>, field: keyof AxisRequest): string => {
    let best = options[0];
    let bestScore = Infinity;
    // Shuffled so that a bank with several equally thin domains does not always
    // pick the same one — ties are broken by chance rather than by array order,
    // which would make the vocabulary fill left to right for ever.
    for (const option of shuffle(options)) {
      const score = (counter[option] ?? 0) + pendingCount(field, option);
      if (score < bestScore) {
        bestScore = score;
        best = option;
      }
    }
    return best;
  };

  return {
    domain: pin("domain") || thinnest(DOMAINS, bank.coverage.domain, "domain"),
    target_audience: pin("target_audience") || thinnest(AUDIENCES, bank.coverage.audience, "target_audience"),
    technique: pin("technique") || thinnest(TECHNIQUES, bank.coverage.technique, "technique"),
    // Difficulty and creativity are drawn rather than balanced. Balancing them
    // would produce a bank with exactly as many 1s as 5s, which is not what a
    // practice bank should look like — most challenges should sit in the
    // middle, with the extremes present but uncommon. The weights below give
    // roughly 15/25/30/20/10 across 1..5.
    difficulty: clampInt(body?.difficulty, 1, 5, weightedDraw([15, 25, 30, 20, 10])),
    creativity: clampInt(body?.creativity, 1, 5, weightedDraw([10, 20, 30, 25, 15])),
  };
}

function weightedDraw(weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i + 1;
  }
  return weights.length;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ============================================================
// Validation
// ============================================================

type Draft = {
  title: string;
  brief: string;
  domain: string;
  target_audience: string;
  technique: string;
  difficulty: number;
  creativity: number;
  constraints: string[];
  rubric: Record<string, number>;
};

type Accepted = Draft & { requested: AxisRequest };

// Every prompt rule, checked. The reasons are named individually rather than
// counted, because "3 rejected" is not a finding and "3 rejected as duplicates
// of existing titles" is — it means the bank is full enough that the model
// needs a different instruction, not that the model is misbehaving.
function validate(
  drafts: Draft[],
  requests: AxisRequest[],
  bank: Bank,
): { accepted: Accepted[]; rejected: Array<{ title: string; reason: string }> } {
  const accepted: Accepted[] = [];
  const rejected: Array<{ title: string; reason: string }> = [];
  // Seeded from the bank and grown as this batch is accepted, so two
  // challenges in one response cannot duplicate each other either.
  const seenTitles = new Set(bank.folded);
  const seenBriefs = [...bank.briefTokens];

  drafts.forEach((draft, index) => {
    const requested = requests[index] ?? requests[requests.length - 1];
    const title = String(draft.title ?? "").trim().replace(/\s+/g, " ");
    const brief = String(draft.brief ?? "").trim();

    const reject = (reason: string) => rejected.push({ title: title || `#${index}`, reason });

    if (title.length < TITLE_MIN_CHARS || title.length > TITLE_MAX_CHARS) {
      return reject(`title length ${title.length}`);
    }
    if (brief.length < BRIEF_MIN_CHARS || brief.length > BRIEF_MAX_CHARS) {
      // A brief under BRIEF_MIN_CHARS is a topic, and a topic is what produced
      // 93 near-identical workout-plan submissions.
      return reject(`brief length ${brief.length}`);
    }
    // Markdown, headings and the model narrating its own instructions. A brief
    // is read straight onto a card in `app/promptarena.html`, which renders it
    // as text — a stray `##` reaches the member as two hashes.
    if (/^#{1,6}\s|\*\*|\n\s*[-*]\s|\[[^\]]{2,40}\]|\{\{/.test(brief)) {
      return reject("brief contains markup or a placeholder");
    }
    // ⚠ The generator must never write the answer into the question. A brief
    // naming the technique tells the member which tool to reach for, and the
    // whole point is that they work it out from the task.
    if (mentionsTechnique(brief, requested.technique)) {
      return reject(`brief names its own technique (${requested.technique})`);
    }
    if (seenTitles.has(fold(title))) {
      return reject("duplicate title");
    }
    // Near-duplicate by content, which is the case that actually matters: the
    // legacy bank's 26 wordings collapsed to 19 challenges precisely because
    // re-wordings of one idea look distinct until you read them.
    const briefWords = new Set(tokens(brief));
    if (seenBriefs.some((prev) => jaccard(prev, briefWords) >= 0.6)) {
      return reject("near-duplicate of an existing brief");
    }

    const constraints = cleanList(draft.constraints, 4, 200);
    if (!constraints.length) {
      return reject("no constraints");
    }

    const rubric = cleanRubric(draft.rubric);
    if (!rubric) {
      return reject("rubric weights everything at zero");
    }

    seenTitles.add(fold(title));
    seenBriefs.push(briefWords);
    accepted.push({
      title,
      brief,
      // ⚠ The axes come from the REQUEST, never from what the model echoed
      // back. 0029 makes these columns so that "how many hard healthcare
      // challenges do we have" is answerable, and that answer is only worth
      // anything if the column says what was actually asked for. A model that
      // drifts to an adjacent domain and reports the drift would make the
      // coverage counts describe the model's preferences rather than the bank.
      domain: requested.domain,
      target_audience: requested.target_audience,
      technique: requested.technique,
      difficulty: requested.difficulty,
      creativity: requested.creativity,
      constraints,
      rubric,
      requested,
    });
  });

  return { accepted, rejected };
}

// Catches the technique name however it is spelled — the vocabulary is
// snake_case and prose is not, so "few_shot_examples" has to match "few shot",
// "few-shot" and "fewshot". Single-word techniques are skipped: "context" and
// "persona" are ordinary English and a brief may legitimately use them.
function mentionsTechnique(brief: string, technique: string): boolean {
  const words = technique.split("_").filter((w) => w.length > 2);
  if (words.length < 2) return false;
  const folded = fold(brief);
  // Every significant word of the technique appearing adjacent, with anything
  // or nothing between them.
  const pattern = words.map((w) => fold(w)).join("[a-z0-9]{0,3}");
  return new RegExp(pattern).test(folded);
}

// Weights clamped to 0..5, non-numbers dropped, unknown dimension names
// discarded. Returns null when nothing is left weighted — a rubric of zeros
// would make the judge fall back to its house weights, which is a defensible
// outcome but not one to store as though it were a considered marking scheme.
function cleanRubric(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  let total = 0;
  for (const d of DIMENSIONS) {
    const v = Number((raw as Record<string, unknown>)[d]);
    const w = Number.isFinite(v) ? Math.min(5, Math.max(0, Math.round(v))) : 0;
    out[d] = w;
    total += w;
  }
  return total > 0 ? out : null;
}

function cleanList(v: unknown, max: number, maxChars: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = String(item ?? "").trim().replace(/\s+/g, " ");
    if (s && !out.includes(s)) out.push(s.slice(0, maxChars));
    if (out.length === max) break;
  }
  return out;
}

// The row as 0029 wants it. `generated_at` is set here rather than left to
// `created_at`: they are the same instant today, but they mean different things
// — one is when the model wrote it and the other is when the row appeared — and
// a backfill of previously generated challenges would separate them.
function toRow(c: Accepted, cfg: ChallengeConfig): Record<string, unknown> {
  return {
    title: c.title,
    brief: c.brief,
    difficulty: c.difficulty,
    domain: c.domain,
    target_audience: c.target_audience,
    creativity: c.creativity,
    constraints: c.constraints,
    rubric: c.rubric,
    generated_by_model: cfg.model,
    generator_version: cfg.generatorVersion,
    // ⚠ `technique` lives here and nowhere else. 0029 has no column for it, and
    // `generation_params` is deliberately absent from `promptarena_challenge_deck`
    // — which is what stops a member reading which technique they are being
    // tested on and writing to it instead of to the brief. Staff can still ask
    // "how many few-shot challenges do we have" as
    // `generation_params->>'technique'`.
    generation_params: {
      technique: c.technique,
      requested: c.requested,
      // Recorded so a later reader can tell a challenge whose axes were pinned
      // by a caller from one the generator balanced on its own — they are
      // different provenance claims and only the second is evidence about the
      // spread.
      axes_chosen_by: "generator",
    },
    generated_at: new Date().toISOString(),
    is_active: true,
  };
}

// ============================================================
// The model call
// ============================================================

// Retries the transient half of the taxonomy in-process and gives up early
// rather than late. `startedAt` is the invocation's start, not this function's:
// the budget being protected is the Edge Function's wall clock, and it has
// already been running for the auth lookup and the bank read by the time we get
// here.
//
// ---- Why truncation is retried -----------------------------------------
//
// The first draft of this function marked `output_truncated` 500 and NOT
// retryable, reasoning that "the same batch size hits the same ceiling every
// time". That is wrong, and the sibling's logs prove it: two consecutive runs
// over the same 87 people failed on *different* sets — 27 then 29, six that had
// succeeded now failing and four the reverse. A deterministic ceiling cannot do
// that. Reasoning length is sampled, so a batch that sits near the ceiling fits
// on some draws and not others.
//
// Retrying the same request at the same ceiling would just be another flip, so
// the ceiling escalates instead: attempt one asks for `ceilingFor(n, false)`,
// any attempt after a truncation asks for `ceilingFor(n, true)`.
async function askModel(
  // `cfg` rides on the input rather than beside it, so the retry loop and the
  // single attempt cannot end up on two different configurations.
  input: { requests: AxisRequest[]; titles: string[]; cfg: ChallengeConfig },
  startedAt: number,
): Promise<Draft[]> {
  let attempt = 0;
  let escalated = false;
  for (;;) {
    attempt++;
    let failure: ChallengeError;
    try {
      return await askModelOnce(input, ceilingFor(input.requests.length, escalated));
    } catch (err) {
      // Anything arriving here unclassified is a defect in this file, and it
      // must NOT be swept into the retryable bucket: retrying a bug three times
      // is three times the cost and the same wrong answer, reported as though
      // the network were at fault.
      if (err instanceof ChallengeError) {
        failure = err;
      } else {
        console.error("promptarena-challenge: unclassified failure in askModel", err);
        failure = new ChallengeError(
          "internal_error",
          500,
          String(err instanceof Error ? err.message : err),
        );
      }
      failure.attempts = attempt;
    }

    // Raise the ceiling for whatever comes next. Done before `planRetry` so it
    // also applies when the *next* failure is a rate limit: once we know this
    // batch needs more room, every further attempt gets it.
    if (failure.code === "output_truncated") escalated = true;

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
      `openai attempt ${attempt} failed (${failure.code}); retrying in ${plan.delayMs}ms ` +
        `at ceiling ${ceilingFor(input.requests.length, escalated)}`,
    );
    await sleep(plan.delayMs);
  }
}

// Pure, and separated from the loop so it can be exercised without a network:
// every input is an argument, including the clock reading and the source of
// randomness.
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
  // The reserve is room for the attempt the sleep is *for*, and it is larger
  // here than in `build-prospect-profile` because one call produces a whole
  // batch and takes correspondingly longer.
  if (opts.elapsedMs + delayMs + opts.reserveMs > opts.deadlineMs) {
    return { retry: false, delayMs, reason: "budget_exhausted" };
  }
  return { retry: true, delayMs, reason: "retry" };
}

// Exponential with equal jitter. A `Retry-After` from OpenAI wins whenever it
// asks for longer than we would have waited anyway — it is the only party that
// knows when the window actually reopens — and it is deliberately not capped
// here, because `planRetry` compares it against the remaining budget.
function backoffDelayMs(attempt: number, retryAfterMs: number | null, rand: () => number): number {
  const window = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
  const jittered = Math.round(window / 2 + rand() * (window / 2));
  return Math.max(jittered, retryAfterMs ?? 0);
}

// ⚠ Order matters. QUOTA IS CHECKED BEFORE THE RATE LIMIT: OpenAI reports an
// exhausted balance as HTTP 429 with `insufficient_quota` in the body, and
// treated as a rate limit it would be retried, backed off, retried again and
// reported as "busy" for ever, when the true answer is that somebody has to add
// credit.
function triageOpenAI(status: number, detail: string, retryAfterMs: number | null): ChallengeError {
  if (/model_not_found|does not exist|unknown model/i.test(detail)) {
    return new ChallengeError(
      "model_not_configured",
      503,
      // Two possible sources since 0031, so the sentence names both — this
      // classifier sees a response, not the configuration that produced it.
      "The configured AI model name isn't valid. Change it under Admin → AI services → PromptArena challenge writer if a model is set there, or set OPENAI_MODEL in the Supabase Edge Function secrets to a model your account can use.",
    );
  }
  if (/insufficient_quota|billing_hard_limit|exceeded your current quota|billing_not_active/i.test(detail)) {
    return new ChallengeError(
      "quota_exhausted",
      402,
      "The AI account has run out of credit. Top up the OpenAI billing account, then run this again.",
    );
  }
  if (status === 401 || status === 403 || /invalid_api_key|incorrect api key/i.test(detail)) {
    return new ChallengeError(
      "ai_credentials",
      503,
      "The AI service rejected our credentials. Check OPENAI_API_KEY.",
    );
  }
  if (status === 429) {
    return new ChallengeError(
      "rate_limited",
      429,
      "The AI service is rate-limiting us right now. Try again in a moment.",
      { retryable: true, retryAfterMs },
    );
  }
  if (status === 408 || status === 409 || status >= 500) {
    return new ChallengeError(
      "upstream_error",
      502,
      `The AI service couldn't answer just now (its status was ${status}). Try again shortly.`,
      { retryable: true, retryAfterMs },
    );
  }
  if (status === 400 || status === 422) {
    return new ChallengeError(
      "upstream_rejected_request",
      500,
      "The AI service rejected the request this function sent. That is a bug here.",
    );
  }
  return new ChallengeError(
    "upstream_error",
    502,
    `The AI service couldn't answer just now (its status was ${status}). Try again shortly.`,
    { retryable: true, retryAfterMs },
  );
}

// `Retry-After` is seconds or an HTTP date. OpenAI also sends
// `x-ratelimit-reset-requests` / `-tokens` as a duration string ("6m0s",
// "1.5s", "200ms"), which is often the only one present on a 429.
//
// Pure: takes a lookup function and the current time.
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

// "6m0s", "1.5s", "200ms", "1h2m3s" → milliseconds. Anything not wholly made of
// duration parts returns null rather than a number built from the parts it
// recognised: half-parsing "soon" into 0 would look like an instruction to
// retry immediately.
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
  input: { requests: AxisRequest[]; titles: string[]; cfg: ChallengeConfig },
  maxOutputTokens: number,
): Promise<Draft[]> {
  const lines = [
    `Write ${input.requests.length} challenge${input.requests.length === 1 ? "" : "s"}, one for each specification below, in this order.`,
    "",
  ];

  input.requests.forEach((r, i) => {
    lines.push(
      `### Challenge ${i + 1}`,
      `- domain: ${r.domain}`,
      `- target audience: ${r.target_audience}`,
      `- difficulty: ${r.difficulty} of 5`,
      `- creativity room: ${r.creativity} of 5 (1 = tightly specified, 5 = wide open)`,
      `- technique the challenge must demand: ${r.technique}`,
      "",
    );
  });

  if (input.titles.length) {
    lines.push(
      "### Already in the bank — do not duplicate or reword any of these",
      "",
      ...input.titles.map((t) => `- ${t}`),
      "",
    );
  }

  lines.push(
    "Remember: never name the technique in the brief, never show an example prompt, and make the challenges genuinely different from each other.",
  );

  const userPrompt = lines.join("\n");

  // One hung socket must not be allowed to spend the whole invocation. Aborted
  // attempts are retryable — a timeout is the most transient thing in the set.
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
        model: input.cfg.model,
        instructions: input.cfg.systemPrompt,
        // See `ceilingFor`: sized per challenge from the bounds `validate`
        // enforces, plus a reasoning allowance, because this ceiling is shared
        // with the model's own reasoning tokens. Escalates once on truncation.
        max_output_tokens: maxOutputTokens,
        input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
        text: {
          format: {
            type: "json_schema",
            name: "promptarena_challenges",
            strict: true,
            schema: CHALLENGE_SCHEMA,
          },
        },
      }),
    });
  } catch (err) {
    const aborted = abort.signal.aborted;
    console.error("OpenAI request failed: " + String(err instanceof Error ? err.message : err));
    throw new ChallengeError(
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
    throw new ChallengeError("model_refused", 422, "The model declined to write these challenges");
  }
  // ⚠ Checked BEFORE parsing. A truncated response still carries an
  // `output_text` part, cut off mid-string — parsing it would either throw or,
  // worse, succeed against a batch whose last challenge lost half its brief, and
  // store a half-written challenge for members to answer.
  if (data.status === "incomplete") {
    const reason = data.incomplete_details?.reason ?? "unknown";
    console.error(
      `openai returned incomplete (${reason}) at max_output_tokens=${maxOutputTokens} ` +
        `for ${input.requests.length} challenge(s); reasoning tokens used: ` +
        `${data.usage?.output_tokens_details?.reasoning_tokens ?? "unreported"} ` +
        `of ${data.usage?.output_tokens ?? "unreported"} output tokens`,
    );

    // A different condition wearing the same status — the model's own filter
    // stopped it, no ceiling is involved, and raising ours would not change the
    // answer.
    if (reason === "content_filter") {
      throw new ChallengeError(
        "content_filtered",
        422,
        "The AI service stopped partway through. Not a size problem — one of the requested axes produced something it would not write.",
      );
    }

    // Retryable, and `askModel` escalates the ceiling before going again. 503
    // rather than 500 because the remaining operator action is to raise a
    // configured number.
    throw new ChallengeError(
      "output_truncated",
      503,
      `The AI service ran out of room mid-batch (ceiling ${maxOutputTokens} tokens, shared with its own ` +
        `reasoning). If this persists, raise REASONING_TOKENS_FIXED_RETRY in promptarena-challenge or ask ` +
        `for fewer challenges per call — re-running at the same ceiling will not reliably fix it.`,
      { retryable: true },
    );
  }
  const textPart = parts.find((p: { type?: string }) => p.type === "output_text");
  if (!textPart?.text) {
    // An empty 200 is the upstream misbehaving rather than refusing, and it does
    // clear on a second ask — so unlike the two above, this one is retryable.
    throw new ChallengeError(
      "upstream_bad_response",
      502,
      "Nothing came back from the AI service. Try again shortly.",
      { retryable: true },
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(textPart.text);
  } catch {
    throw new ChallengeError(
      "upstream_bad_response",
      502,
      "The AI service's answer wasn't readable. Try again shortly.",
      { retryable: true },
    );
  }

  const list = parsed.challenges;
  if (!Array.isArray(list) || !list.length) {
    throw new ChallengeError(
      "upstream_bad_response",
      502,
      "The AI service returned no challenges. Try again shortly.",
      { retryable: true },
    );
  }

  return list.map((c: Record<string, unknown>) => ({
    title: String(c?.title ?? ""),
    brief: String(c?.brief ?? ""),
    domain: String(c?.domain ?? ""),
    target_audience: String(c?.target_audience ?? ""),
    technique: String(c?.technique ?? ""),
    difficulty: Number(c?.difficulty ?? 3),
    creativity: Number(c?.creativity ?? 3),
    constraints: Array.isArray(c?.constraints) ? (c.constraints as unknown[]).map(String) : [],
    rubric: (c?.rubric ?? {}) as Record<string, number>,
  }));
}

// ============================================================
// Small helpers
// ============================================================

// Letters and digits only, lowercased — the comparison that treats "Coffee Shop
// Growth" and "coffee-shop growth" as one title.
function fold(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// Content words only. Short function words are dropped because every brief in
// English shares them, and counting them would make any two briefs look like
// near-duplicates of each other.
function tokens(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of b) if (a.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders },
  });
}
