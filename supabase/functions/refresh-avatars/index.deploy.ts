// GENERATED - do not edit. Deploy-time twin of index.ts with the ../_shared/cors.ts, ../_shared/ai-config.ts, ../_shared/ai-provider.ts, ../_shared/avatar-art.ts imports replaced by those files inline, and
// nothing else. The Supabase dashboard editor deploys one function directory at a
// time and cannot reach a shared parent file. Edit index.ts and regenerate; the
// two must stay in step.

// refresh-avatars
// ------------------------------------------------------------
// Redraws the whole wall on the new month's theme. Runs on a schedule, in
// batches, until nothing is due.
//
// The point of the feature: the same person, rendered differently each month,
// so the directory looks alive rather than frozen. Members keep their own
// three tries on top of this — a refresh is the club's picture of them, not
// one of their goes, so it resets `avatar_attempts` to 0 and stamps the new
// cycle, leaving them three fresh tries for the month.
//
// The thing that shapes this function more than anything else: THERE IS NO
// SOURCE PHOTOGRAPH. 0015 destroys it after the first generation, on purpose,
// and `source_purged_at` is the receipt. So the monthly redraw cannot work
// the way the first generation did. It works from the member's *existing
// generated avatar* — their likeness as the club already holds it — plus
// their interests and the new month's theme. Nothing here reads, wants, or
// could use a real photo, and the purge receipt is re-stamped in the same
// UPDATE as the new `avatar_url` exactly as it is in generate-avatar.
//
// Batching, and why there is a `remaining`: image generation takes seconds
// per member, and an Edge Function has a wall-clock limit. Each member is
// committed on their own, so an interrupted run loses at most the one in
// flight, and `avatars_due_refresh` is ordered oldest-first so the next run
// resumes where this one stopped rather than starting over.
//
// Trigger it from Supabase's scheduled functions, or pg_cron — loop while
// `done` is false:
//   select cron.schedule('avatar-refresh', '15 3 1-7 * *', $$
//     select net.http_post(
//       url := '<project>/functions/v1/refresh-avatars?limit=10',
//       headers := jsonb_build_object('Authorization', 'Bearer <service role>')
//     );
//   $$);
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   OPENAI_API_KEY    — when the configured model is an OpenAI one
//   GEMINI_API_KEY    — when it is a Google one; whichever the model needs
//   OPENAI_IMAGE_MODEL                       — optional, same default as generate-avatar
//
// Since 0031 the artwork and the image model can also be set from Admin → AI
// services. ⚠ This function and `generate-avatar` read the SAME service row —
// `avatar-art` — which is the whole point: the wall and the individual
// portraits have to be the same artwork, and the panel is not able to give
// them two. The secret above and the constants in `_shared/avatar-art.ts`
// remain the floor for both.
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
// ---- inlined from ../_shared/ai-provider.ts ----
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
// Accepts either name: GEMINI_API_KEY is what Google's own docs use,
// GOOGLE_AI_API_KEY is what some tooling sets. Checking both avoids a silent
// "not configured" caused purely by which guide somebody followed.
const GOOGLE_KEY =
  Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GOOGLE_AI_API_KEY") ?? "";

type Provider = "openai" | "google";

// ⚠ A HEURISTIC, and it is wrong on its own. Use it only as a fallback.
//
// The first version tested for `gemini*` and nothing else, on the assumption
// that Google's models are called Gemini. The very first live listing disproved
// it: of the 42 models Google returned for this project, several are named
// `antigravity-preview-05-2026`, `deep-research-pro-preview-12-2025` and
// `learnlm-*`. Under a gemini-only test every one of those routes to OpenAI,
// which answers 404 model_not_found — a message that sends you to check the
// model list rather than the router.
//
// So `ai_models.provider` — which ai-admin now records from the horse's mouth,
// because it knows WHICH API returned each id — is the real answer, and callers
// should pass it. This exists for the case where a caller has only a string:
// it is right for everything named gemini/gemma/learnlm and wrong-but-safe
// otherwise, since defaulting to OpenAI fails loudly rather than silently.
// ⚠ `nano-banana` was missing here and it broke a live avatar generation on
// 10 Aug. googleKind() below knew about it — added when the image models were
// classified — and this did not, so the two disagreed: the panel correctly
// listed `nano-banana-pro-preview` as a Google IMAGE model, the test passed
// (ai-admin passes the provider explicitly, from ai_models.provider), and then
// generate-avatar, which has only the model NAME, routed it to OpenAI. OpenAI
// answered model_not_found and the member was told the model "isn't valid for
// this account" — pointing at the admin panel, which was right.
//
// ⚠ The real lesson is not the missing word. It is that a model's provider is
// recorded in `ai_models.provider`, from whichever API actually returned it,
// and every caller that can reach the database should PASS IT rather than ask
// this regex. A name-based guess cannot be right about a family nobody has
// seen yet, and Google keeps naming things like fruit.
const GOOGLE_FAMILIES = /^(models\/)?(gemini|gemma|learnlm|aqa|imagen|veo|antigravity|deep-research|nano-banana)/i;

function providerFor(model: string): Provider {
  return GOOGLE_FAMILIES.test(model) ? "google" : "openai";
}

function keyFor(provider: Provider): string {
  return provider === "google" ? GOOGLE_KEY : OPENAI_KEY;
}

function providerConfigured(provider: Provider): boolean {
  return keyFor(provider).length > 0;
}

// ⚠ Google's schema dialect. Differences that actually bite:
//
//   - `additionalProperties` is rejected outright.
//   - `$schema`, `definitions`, `$ref` are not supported.
//   - types must be UPPERCASE ("STRING", not "string").
//   - `nullable` replaces the ["string","null"] union form.
//
// Anything unrecognised is dropped rather than forwarded: a schema Google
// cannot parse fails the whole request, and losing a hint is better than
// losing the call.
function toGeminiSchema(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(toGeminiSchema);

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(src)) {
    if (k === "additionalProperties" || k === "$schema" || k === "definitions" || k === "$ref") {
      continue;
    }
    if (k === "type") {
      // ["string", "null"] → STRING + nullable
      if (Array.isArray(v)) {
        const real = v.find((t) => t !== "null");
        out.type = String(real ?? "string").toUpperCase();
        if (v.includes("null")) out.nullable = true;
      } else {
        out.type = String(v).toUpperCase();
      }
      continue;
    }
    if (k === "properties" && v && typeof v === "object") {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = toGeminiSchema(pv);
      }
      out.properties = props;
      continue;
    }
    out[k] = toGeminiSchema(v);
  }
  return out;
}

// Read a provider's body into the four things every caller needs. Shared by
// both call paths AND by the tests, so what is checked is what runs — a
// transcription of this logic could pass while the shipped version was wrong.
function normalise(
  raw: unknown,
  provider: Provider,
): { text: string; stopReason: "stop" | "length" | "filter" | "other"; truncated: boolean; refused: boolean } {
  if (provider === "openai") {
    let text = "";
    let refused = false;
    const output = (raw as { output?: unknown[] })?.output ?? [];
    for (const item of output as Array<{ content?: Array<{ type?: string; text?: string }> }>) {
      for (const part of item?.content ?? []) {
        if (part?.type === "refusal") refused = true;
        else if (part?.text) text += part.text;
      }
    }
    const r = raw as { status?: string; incomplete_details?: { reason?: string } };
    let stopReason: "stop" | "length" | "filter" | "other" = "stop";
    if (r?.status === "incomplete") {
      const reason = r.incomplete_details?.reason;
      stopReason = reason === "content_filter" ? "filter"
        : reason === "max_output_tokens" ? "length"
        : "other";
    }
    return { text, stopReason, truncated: r?.status === "incomplete", refused };
  }

  const cand = (raw as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }> })
    ?.candidates?.[0];
  let text = "";
  for (const part of cand?.content?.parts ?? []) if (part?.text) text += part.text;

  // ⚠ RECITATION belongs with SAFETY, not with length: the model stopped
  // because the answer was reproducing training data, and retrying at a bigger
  // ceiling produces the same stop while spending money.
  //
  // ⚠ A missing candidate is a FILTER, not an empty answer. Google drops the
  // candidate entirely when a prompt is blocked before generation, leaving only
  // promptFeedback.blockReason. Reporting that as "stop with no text" sends the
  // caller looking for a parsing bug.
  const blocked = (raw as { promptFeedback?: { blockReason?: string } })?.promptFeedback?.blockReason;
  const finish = cand?.finishReason;
  let gStop: "stop" | "length" | "filter" | "other";
  if (!cand && blocked) gStop = "filter";
  else if (finish === "MAX_TOKENS") gStop = "length";
  else if (finish === "SAFETY" || finish === "RECITATION" || finish === "PROHIBITED_CONTENT") gStop = "filter";
  else if (finish === "STOP" || finish === undefined) gStop = "stop";
  else gStop = "other";

  return {
    text,
    stopReason: gStop,
    truncated: gStop === "length",
    // Google has no separate refusal part: a filter stop with nothing written
    // IS the refusal.
    refused: gStop === "filter" && text.length === 0,
  };
}

// ⚠ Exported for tools/check-ai-provider.mjs only. toGeminiSchema is the most
// likely thing in this file to be quietly wrong — Google answers a bad schema
// with a 400 that reads like a model error — and it is not reachable from
// callText() without a network call and a key. Testing a transcription of it
// would pass while the shipped version was broken.
const __testables = { toGeminiSchema, normalise };

interface TextRequest {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  // ⚠ Pass this whenever it is known — it comes from ai_models.provider, which
  // ai-admin records from whichever API actually returned the id. The
  // heuristic above is only for callers holding nothing but a string, and it
  // cannot be right for a model family nobody has seen yet.
  provider?: Provider;
  // Optional strict-JSON contract. `name` is required by OpenAI and ignored by
  // Google, which is why it is carried rather than derived.
  schema?: { name: string; schema: unknown };
  signal?: AbortSignal;
}

interface TextResult {
  ok: boolean;
  text: string;
  provider: Provider;
  status: number;
  // The whole body, for callers that inspect finish reasons or token counts.
  raw: unknown;
  error?: string;
  // True when the model stopped because it hit the ceiling. Both providers
  // signal this differently and every caller wants to know, because the fix is
  // to retry with a larger one rather than to treat it as a bad answer.
  truncated?: boolean;

  // ⚠ Why it stopped, normalised — and the distinction is not cosmetic.
  // promptarena-challenge already treats these three as different outcomes and
  // is right to: raising the ceiling fixes "length" and does nothing for the
  // other two, so collapsing them would make the retry logic wrong.
  //
  //   "length"  ran out of room. Retry bigger.
  //   "filter"  the provider's safety system stopped it. Retrying is pointless.
  //   "stop"    finished normally.
  //   "other"   something new. Treated as not-retryable, because guessing
  //             wrong in the retryable direction spends money in a loop.
  //
  //   OpenAI  status:"incomplete" + incomplete_details.reason
  //           ("max_output_tokens" | "content_filter")
  //   Google  candidates[0].finishReason
  //           ("MAX_TOKENS" | "SAFETY" | "RECITATION" | "STOP")
  stopReason?: "stop" | "length" | "filter" | "other";

  // The model declined the instructions outright. OpenAI emits a `refusal`
  // content part; Google signals it through finishReason SAFETY with no text.
  refused?: boolean;

  // ⚠ The response headers, carried because `Retry-After` lives nowhere else.
  //
  // A caller backing off a 429 needs it, and it is not in the body — so a
  // TextResult without headers cannot express "wait 20 seconds", only "it
  // failed". promptarena-challenge already parses this header to schedule its
  // retry; migrating it to callText() without this would have silently
  // downgraded a measured wait into a guess, which is the kind of regression
  // that only shows up under load.
  //
  // The Headers object itself rather than a parsed number: the two formats
  // (delta-seconds and an HTTP date) are already handled by the callers that
  // care, and re-implementing that here would be a second place to get it
  // wrong.
  headers?: Headers;
}

async function callText(req: TextRequest): Promise<TextResult> {
  // An explicit provider always wins. The heuristic is the fallback, not the
  // rule — see the note on providerFor.
  const provider = req.provider ?? providerFor(req.model);
  const key = keyFor(provider);
  if (!key) {
    return {
      ok: false, text: "", provider, status: 503, raw: null,
      error:
        provider === "google"
          ? "GEMINI_API_KEY is not set on this project, so Gemini models cannot be called."
          : "OPENAI_API_KEY is not set.",
    };
  }
  return provider === "google" ? await callGoogle(req, key) : await callOpenAI(req, key);
}

async function callOpenAI(req: TextRequest, key: string): Promise<TextResult> {
  const body: Record<string, unknown> = {
    model: req.model,
    instructions: req.system,
    max_output_tokens: req.maxOutputTokens,
    input: [{ role: "user", content: [{ type: "input_text", text: req.user }] }],
  };
  if (req.schema) {
    body.text = {
      format: { type: "json_schema", name: req.schema.name, strict: true, schema: req.schema.schema },
    };
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: req.signal,
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      ok: false, text: "", provider: "openai", status: res.status, raw, headers: res.headers,
      error: readError(raw) || ("OpenAI returned " + res.status),
    };
  }

  // output[] holds reasoning items as well as the message; only the message
  // carries text, so this collects rather than indexing [0].
  const n = normalise(raw, "openai");
  return {
    ok: true, text: n.text, provider: "openai", status: res.status, raw, headers: res.headers,
    truncated: n.truncated, stopReason: n.stopReason, refused: n.refused,
  };
}

async function callGoogle(req: TextRequest, key: string): Promise<TextResult> {
  // Ids may arrive as "gemini-2.5-pro" or "models/gemini-2.5-pro"; the URL
  // wants the bare name.
  const model = req.model.replace(/^models\//, "");
  const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxOutputTokens };
  if (req.schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = toGeminiSchema(req.schema.schema);
  }

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) + ":generateContent",
    {
      method: "POST",
      signal: req.signal,
      // ⚠ Header, not ?key= in the URL. A query string lands in access logs and
      // in any proxy in between; a header does not.
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig,
      }),
    },
  );
  const raw = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      ok: false, text: "", provider: "google", status: res.status, raw, headers: res.headers,
      error: readError(raw) || ("Gemini returned " + res.status),
    };
  }

  const n = normalise(raw, "google");
  return {
    ok: true, text: n.text, provider: "google", status: res.status, raw, headers: res.headers,
    truncated: n.truncated, stopReason: n.stopReason, refused: n.refused,
  };
}

// ============================================================
// Drawing
// ============================================================
//
// The avatar services transform a source image: the member's picture in, a
// drawing out. That is an EDIT, not a generation, and the two providers express
// it about as differently as two APIs can.
//
//   OpenAI  POST /v1/images/edits, multipart/form-data
//           model, image (file), prompt, size, quality
//           → { data: [{ b64_json }] }
//
//   Google  POST /v1beta/models/<model>:generateContent, JSON
//           contents[0].parts = [ {text}, {inlineData:{mimeType,data}} ]
//           → candidates[0].content.parts[].inlineData.{mimeType,data}
//
// ⚠ `size` and `quality` are OPENAI-ONLY and are not forwarded to Google,
// which has no equivalent and rejects unknown generationConfig keys. Silently
// dropping them is right; pretending to honour them would be worse.
//
// ⚠ THE ERROR IS RETURNED AS THE PROVIDER'S RAW BODY TEXT, not a tidied
// message. generate-avatar triages on that body with regexes — insufficient
// quota, moderation, model_not_found — and turns each into a sentence a member
// reads off their own profile. Parsing it here would break every one of those
// branches, so this deliberately hands back exactly what the provider said.
interface ImageRequest {
  model: string;
  provider?: Provider;
  prompt: string;
  // The picture being transformed.
  image: Uint8Array;
  mediaType: string;
  // OpenAI only; see the note above.
  size?: string;
  quality?: string;
  signal?: AbortSignal;
}

interface ImageResult {
  ok: boolean;
  provider: Provider;
  status: number;
  bytes?: Uint8Array;
  mediaType?: string;
  // The provider's raw body on failure — see the note above.
  error?: string;
  headers?: Headers;
}

// ⚠ CHUNKED, and it is not a micro-optimisation. `String.fromCharCode(...bytes)`
// spreads every byte as an argument, and a 1 MB avatar is a million arguments —
// which overflows the call stack and throws RangeError on a photograph that is
// merely normal-sized. The failure looks like a corrupt image, not a stack
// limit.
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function callImage(req: ImageRequest): Promise<ImageResult> {
  const provider = req.provider ?? providerFor(req.model);
  const key = keyFor(provider);
  if (!key) {
    return {
      ok: false, provider, status: 503,
      error: provider === "google"
        ? "GEMINI_API_KEY is not set on this project, so Gemini models cannot be called."
        : "OPENAI_API_KEY is not set.",
    };
  }
  return provider === "google" ? await drawGoogle(req, key) : await drawOpenAI(req, key);
}

async function drawOpenAI(req: ImageRequest, key: string): Promise<ImageResult> {
  const form = new FormData();
  form.append("model", req.model);
  form.append("image", new Blob([req.image], { type: req.mediaType }), "source" + extFor(req.mediaType));
  form.append("prompt", req.prompt);
  if (req.size) form.append("size", req.size);
  if (req.quality) form.append("quality", req.quality);

  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    signal: req.signal,
    headers: { Authorization: "Bearer " + key },
    body: form,
  });

  if (!res.ok) {
    return { ok: false, provider: "openai", status: res.status, error: await res.text().catch(() => ""), headers: res.headers };
  }

  const raw = await res.json().catch(() => null);
  const b64 = (raw as { data?: Array<{ b64_json?: string }> })?.data?.[0]?.b64_json;
  if (!b64) {
    return { ok: false, provider: "openai", status: res.status, error: "no image in the response", headers: res.headers };
  }
  // The edits endpoint returns PNG.
  return { ok: true, provider: "openai", status: res.status, bytes: fromBase64(b64), mediaType: "image/png", headers: res.headers };
}

async function drawGoogle(req: ImageRequest, key: string): Promise<ImageResult> {
  const model = req.model.replace(/^models\//, "");

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) + ":generateContent",
    {
      method: "POST",
      signal: req.signal,
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: req.prompt },
            { inlineData: { mimeType: req.mediaType, data: toBase64(req.image) } },
          ],
        }],
        // ⚠ Asking for TEXT as well as IMAGE, not IMAGE alone. Several models in
        // this family refuse an image-only modality list, and a model that
        // returns a sentence alongside the picture costs nothing — the sentence
        // is ignored below. Refusing to draw because the modality list was too
        // narrow would cost the whole call.
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
    },
  );

  if (!res.ok) {
    return { ok: false, provider: "google", status: res.status, error: await res.text().catch(() => ""), headers: res.headers };
  }

  const raw = await res.json().catch(() => null);
  const parts = (raw as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
  })?.candidates?.[0]?.content?.parts ?? [];

  // ⚠ The picture is not always the first part. With TEXT in the modality list
  // the model may narrate before it draws, so this looks for the part that
  // actually carries image data rather than indexing [0].
  const drawn = parts.find((p) => p?.inlineData?.data);
  if (!drawn?.inlineData?.data) {
    // A refusal arrives as a 200 with no image, which is a different problem
    // from a 400 and has to read differently. The body is handed back whole so
    // the caller's own triage — moderation, safety — still has something to
    // match on.
    return {
      ok: false, provider: "google", status: res.status,
      error: "no image in the response: " + JSON.stringify(raw).slice(0, 500),
      headers: res.headers,
    };
  }

  return {
    ok: true, provider: "google", status: res.status,
    bytes: fromBase64(drawn.inlineData.data),
    mediaType: drawn.inlineData.mimeType || "image/png",
    headers: res.headers,
  };
}

// Mirrors generate-avatar's own helper: the multipart filename needs an
// extension the endpoint recognises, and it is derived from the media type
// rather than assumed.
function extFor(mediaType: string): string {
  if (/png/i.test(mediaType)) return ".png";
  if (/webp/i.test(mediaType)) return ".webp";
  return ".jpg";
}

// Both providers nest their message differently, and a caller that prints
// "[object Object]" at 2am is a caller that tells you nothing.
function readError(raw: unknown): string {
  const e = (raw as { error?: { message?: string } })?.error;
  if (e && typeof e.message === "string") return e.message;
  return "";
}

// ============================================================
// Listing what each provider offers
// ============================================================
//
// ai-admin refreshes `ai_models` on every panel load. This gives it the Google
// half in the same shape, so the panel does not need to know there are two.
//
// ⚠ NEVER THROWS, and the three outcomes are deliberately distinguishable.
//
// The caller retires any model it did not just see. That is right when Google
// answered and genuinely dropped a model, and WRONG when Google was briefly
// unreachable — the second case would mark every Gemini model unavailable
// because of a network blip, and staff would find their configured model gone.
//
//   { ok: true,  models: [...] }  Google answered. Safe to retire what is missing.
//   { ok: false, reason: "no-key" }   Not configured. Do not touch Google rows.
//   { ok: false, reason: "bad-key" }  Google refused the key. Do not touch Google rows.
//   { ok: false, reason: "unreachable" } Ask failed. Do not touch Google rows.
//
// A project with no Google key must still show its OpenAI models, so this is
// never fatal to the listing.
// ⚠ WHICH GOOGLE MODELS DRAW, AND WHY THIS IS A HEURISTIC.
//
// The previous version of this file asserted that "Google's image models do not
// serve generateContent", and hardcoded every Google model to `kind: "text"`.
// That was true of Imagen and Veo, which use `:predict`. It is NOT true of the
// Gemini `*-image` family, which does its image work THROUGH generateContent —
// measured 8 Aug 2026 on the club's own account, which lists seven of them.
//
// The consequence of the old assumption was not cosmetic: those seven were
// offered under the six TEXT services, 0031's trigger allowed it because the
// kind said text, and the call would return an image and no text — surfacing as
// "the call succeeded but produced no output at all".
//
// ⚠ THERE IS NO FIELD IN GOOGLE'S MODEL LIST THAT SAYS "THIS OUTPUTS IMAGES".
// `supportedGenerationMethods` reads `generateContent` for a text model and for
// an image model alike, so it cannot separate them. The name and the
// description are the only signals on offer, which makes this a heuristic in
// the same honest sense as `providerFor` above — and it is written to fail in
// the safer direction.
//
// Failing safe here means: a text model wrongly called an image model
// DISAPPEARS from the text dropdowns, which somebody notices immediately. An
// image model wrongly called text is the footgun described above, which nobody
// notices until a service returns nothing. So the test is deliberately narrow —
// it matches only what actually names itself an image model — and everything it
// is unsure about stays text.
//
// ⚠ `description` is carried through so this decision is checkable from the
// panel rather than taken on trust. When Google adds a family this misses, the
// evidence for the fix is already on screen.
function googleKind(id: string, description?: string): "text" | "image" {
  if (/(^|[-_])image([-_]|$)|nano-banana/i.test(id)) return "image";
  // A description that says it generates or edits images, for a family whose
  // name does not follow the convention.
  if (/\b(image generation|generates images|image editing|edits images)\b/i.test(String(description ?? ""))) {
    return "image";
  }
  return "text";
}

interface GoogleModelList {
  ok: boolean;
  reason?: "no-key" | "bad-key" | "unreachable";
  models: Array<{ id: string; kind: "text" | "image" | "other"; owned_by: string; description?: string }>;
  // Google's own words when it refused. Carried because "invalid", "revoked"
  // and "restricted to another referrer" are three different fixes and only
  // the message says which.
  detail?: string;
}

async function listGoogleModels(): Promise<GoogleModelList> {
  if (!GOOGLE_KEY) return { ok: false, reason: "no-key", models: [] };
  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
      { headers: { "x-goog-api-key": GOOGLE_KEY } },
    );
    // ⚠ A REFUSED KEY IS NOT AN UNREACHABLE API, and after a rotation that is
    // the only distinction that matters. Google answers a key it will not
    // accept with 400 INVALID_ARGUMENT, 401, or 403 PERMISSION_DENIED — it
    // ANSWERED, so the network is fine and retrying forever changes nothing.
    // Folding that into "unreachable" produces the worst possible message the
    // day somebody rotates this key: it points at the network while the panel
    // goes on showing 42 models that no longer answer to anyone.
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const refused = res.status === 400 || res.status === 401 || res.status === 403;
      return {
        ok: false,
        reason: refused ? "bad-key" : "unreachable",
        models: [],
        detail: body.slice(0, 300),
      };
    }
    const raw = await res.json();
    const models = (raw as {
      models?: Array<{ name?: string; description?: string; supportedGenerationMethods?: string[] }>;
    })?.models ?? [];
    const mapped = models
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => {
        const id = String(m.name ?? "").replace(/^models\//, "");
        return {
          id,
          kind: googleKind(id, m.description),
          owned_by: "google",
          description: String(m.description ?? ""),
        };
      })
      .filter((m) => m.id.length > 0);
    return { ok: true, models: mapped };
  } catch {
    return { ok: false, reason: "unreachable", models: [] };
  }
}
// ---- inlined from ../_shared/avatar-art.ts ----
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const AVATAR_BUCKET = "avatars";

// Three tries per monthly cycle. Also a CHECK constraint in 0015 (0..3), so
// nothing here may ever write 4.
const MAX_ATTEMPTS = 3;

// ---- Cycles -----------------------------------------------------------

// 'YYYY-MM', UTC. This has to agree with `to_char(now(), 'YYYY-MM')` in 0018,
// which is what `avatar_attempts_this_cycle` and the `avatars_due_refresh`
// view compare against — Supabase runs its databases in UTC, and taking the
// month from the local clock instead would put this code and the view on
// different months for a few hours around each boundary.
function currentCycle(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

// A fixed rota of twelve, one per month. Each is a mood and a palette accent,
// never a costume or a scene: the club's violet-to-cyan gradient stays the
// identity and the theme is what shifts on top of it. That is the whole point
// of the monthly refresh — the same person, rendered differently, so the wall
// looks alive rather than frozen — and it only works if December still
// obviously belongs to the same club as June.
//
// Indexed by calendar month rather than by a hash, so the theme is
// predictable: everyone regenerated in the same month shares it, which is
// what makes the change legible as "the wall turned over" rather than as
// noise.
const THEMES = [
  "deep winter night-sky indigo, cool and still, with faint starlight highlights",
  "soft plum and rose warmth cutting through the cool background",
  "fresh spring greens, new growth breaking through a cool palette",
  "clear rain-washed light, pale periwinkle and bright air",
  "blossom pinks and new-leaf green, light and open",
  "long golden early-summer light with warm amber highlights",
  "high bright summer, turquoise and sunlit white",
  "warm dusk, peach and coral rim light",
  "amber and ochre, the first turn of autumn light",
  "deep russet and dusk violet, a lantern-lit warmth",
  "cool misted grey-blue with a single warm ember accent",
  "deep night-sky blue with cool silver highlights",
];

// Takes the cycle string rather than a Date so the caller's month and the
// stored `avatar_theme` can never disagree.
//
// `themes` is trailing and optional so both callers keep working untouched and
// so an absent, short, or otherwise unusable stored rota lands on the constant
// above rather than on an undefined entry — an index into a rota is only
// meaningful if the rota is the length the index was written for, which is why
// `ai-config.ts` rejects a stored list of the wrong length outright and why
// this guard is here as well.
function themeForCycle(cycle: string, themes: readonly string[] = THEMES): string {
  const rota = themes.length === THEMES.length ? themes : THEMES;
  const month = Number(String(cycle).slice(5, 7));
  // An unparseable cycle should still produce a portrait. Falling back to
  // January is a duller failure than throwing halfway through a batch.
  const index = Number.isFinite(month) && month >= 1 && month <= 12 ? month - 1 : 0;
  return rota[index] || THEMES[index];
}

// ---- The house style --------------------------------------------------

// Every avatar on the wall shares it, which is what makes a directory of a
// few hundred people read as one club rather than a collage of whatever each
// member's photo happened to look like.
//
// Illustrated, not 3D. The earlier version of this asked for "stylised 3D
// character portrait, in the manner of a friendly modern animated film",
// which reliably produced glossy plastic-looking heads. What members actually
// want is a good, warm, high-quality drawing of themselves. So the style is
// stated positively (flat, painterly, hand-drawn) *and* negatively (no 3D
// render, no plastic surfacing) — image models drift back toward the
// render-y default unless told not to twice.
const HOUSE_STYLE = [
  "A clean, warm, high-quality stylised illustrated portrait: flat painterly character illustration, hand-drawn and hand-shaded.",
  "Not a 3D render, not CGI, not a photograph — illustration.",
  "Shoulders-up, facing the viewer, warm and approachable expression.",
  "Soft studio lighting with a gentle rim light; confident shapes and clean edges.",
  "Clean smooth gradient background in the Sahaba Club palette: violet #a78bfa into cyan #22d3ee.",
  "Flat colour with soft painterly shading — no glossy plastic surfacing, no ray-traced highlights, no photographic texture, no photorealism.",
  "Crisp and detailed at full resolution.",
  "No text, no lettering, no watermarks, no logos, no brand marks of any kind.",
  "Head and shoulders fill the frame; nothing else competes with the face.",
].join(" ");

// Where the portrait is coming from. 'photo' is a member's uploaded
// photograph on their own generation; 'avatar' is their existing generated
// avatar on the monthly refresh, where there is no photograph left to work
// from (0015 destroys it, deliberately) and the likeness has to be carried
// forward from the previous drawing.
type PromptMode = "photo" | "avatar";

// ---- The variant rota -------------------------------------------------

// Three tries used to mean three near-identical pictures. The prompt was the
// same on every attempt, and an image model handed the same prompt twice
// produces the same drawing with a different seed — so "generate another" gave
// a member noise rather than a choice, and they spent their allowance
// discovering that.
//
// These are ACCENTS ON ONE IDENTITY, not three art directions. Everything that
// makes the wall one wall — the illustrated house style, the violet-to-cyan
// gradient, the month's theme, the member's own interests — is stated above
// and stays stated. What rotates is framing, which end of the palette leads,
// and how the background is handled. That is enough for three visibly
// different pictures of the same person in the same club, and small enough
// that a member's three tries still all belong on the same directory page.
//
// The wording is deliberately phrased as a refinement rather than as a new
// instruction, because HOUSE_STYLE has already said "head and shoulders fill
// the frame" and "clean smooth gradient background". Two prompt lines that
// flatly contradict each other are two lines the model gets to choose between,
// which is how you get a rota that quietly does nothing.
const VARIANTS = [
  "a close crop — the head fills most of the frame and the shoulders only just " +
    "enter at the bottom; let the violet end of the gradient lead, with the cyan " +
    "kept back as a rim accent; the background stays a plain, smooth, unbroken " +
    "gradient with nothing in it",
  "a classic head-and-shoulders, with a little air above the head; let the cyan " +
    "end of the gradient lead, with the violet as the deeper accent underneath; " +
    "the background carries a few large, soft, low-contrast geometric shapes — " +
    "simple arcs and circles, well away from the face",
  "a slightly wider view — the upper chest is in frame and there is clear space " +
    "around the head; hold violet and cyan in even balance; the background is a " +
    "gentle depth-of-field wash, softly blurred and a little deeper at the edges " +
    "so the face still reads first",
];

// The attempt index (0, 1, 2) from generate-avatar, but tolerant of anything:
// a negative, a fraction or a NaN should produce a portrait, not an exception
// halfway through a paid image call.
function variantTreatment(variant: number, variants: readonly string[] = VARIANTS): string {
  // Same reasoning as `themeForCycle`: a rota of a different length means every
  // index means something other than what the caller meant by it, so a stored
  // list that is not three entries is not a shorter rota, it is the wrong rota.
  const rota = variants.length === VARIANTS.length ? variants : VARIANTS;
  const n = Number.isFinite(variant) ? Math.trunc(variant) : 0;
  const i = ((n % rota.length) + rota.length) % rota.length;
  return rota[i] || VARIANTS[i];
}

// ---- What the panel may replace ---------------------------------------
//
// The three slots, and nothing else. Exported as the real constants so the
// admin panel's "what it is now" and "reset to the code default" both read the
// artwork this file actually uses — no copy in a migration to drift out of
// step with it.
//
// ⚠ The keys match `ai_services.parts_shape` for slug 'avatar-art' in 0031. If
// one is renamed, rename it in both places: `ai-config.ts` merges by key and
// silently keeps the code default for a key it does not recognise, so a
// mismatch here shows up as "the save worked and nothing changed".
const AVATAR_ART_DEFAULTS = {
  house_style: HOUSE_STYLE,
  themes: THEMES as readonly string[],
  variants: VARIANTS as readonly string[],
};

// What `buildPrompt` will take instead of the constants. Every field optional:
// a stored version that only rewrote the house style must not blank the rota.
type AvatarArt = {
  house_style?: string;
  variants?: readonly string[];
};

// Built from the member's own interests, skills and industry, so that a wall
// of avatars in one house style is still a wall of different people. The
// interests come in as subtle props and colour accents rather than costumes:
// "interested in aviation" should not produce a pilot's uniform, it should
// produce a hint of sky in the palette.
//
// `variant` is optional and trailing on purpose. refresh-avatars calls this
// with three arguments and must keep compiling untouched — the monthly job
// draws one picture per member and has nothing to vary between, so variant 0
// is the right answer for it and it should not have to say so.
//
// `art` is trailing and optional for the same reason, and for a second one:
// called without it this function produces exactly what it produced before
// 0031, which is what "the code default is the floor" has to mean at the point
// where the prompt is actually assembled. What `art` can replace is the house
// style and the variant rota — two slots in a fixed composition. It cannot
// reorder the parts, remove the closing guard, or reach either caller without
// reaching the other.
function buildPrompt(
  profile: Record<string, unknown>,
  theme: string,
  mode: PromptMode = "photo",
  variant: number = 0,
  art: AvatarArt = {},
): string {
  // Blank is not an edit. A house style saved as an empty string would produce
  // a portrait with no style at all — the one failure mode a fallback exists
  // to prevent — so it lands on the constant, exactly as `ai-config.ts` would
  // have done one layer up. Both layers, because this one is also reachable
  // from the test run in `ai-admin`.
  const houseStyle = (art.house_style ?? "").trim() || HOUSE_STYLE;
  const interests = tidyList(profile.interests, 4);
  const skills = tidyList(profile.skills, 3);
  const industry = tidyOne(profile.industry);

  const themes = [...interests, ...skills].slice(0, 5);

  const personal = themes.length
    ? `Weave these interests in only as subtle background props and colour accents, never as costume, uniform, or anything held up to the camera: ${themes.join(", ")}.`
    : // A profile with nothing filled in still gets a portrait rather than an
      // error; it just gets the house style on its own.
      "Keep the background plain gradient with no props.";

  const context = industry
    ? `The person works in ${industry}; let that inform the styling gently, not literally.`
    : "";

  // The month, as an accent over the identity rather than a replacement for
  // it. Stated with the limit attached, because "seasonal theme" on its own
  // is an invitation to paint snow across the background.
  const seasonal = theme
    ? `This month's accent: ${theme}. Apply it to the lighting and to the secondary colours only — the violet-to-cyan gradient remains the dominant background and the club's identity.`
    : "";

  // Last of the accents, and the narrowest. Stated as a refinement of the
  // framing and background already described rather than as a replacement for
  // them, and with the identity restated afterwards so that a rota entry
  // asking for a wider crop cannot be read as permission to change the style.
  const treatment =
    `For this version, treat the composition as follows: ${variantTreatment(variant, art.variants)}. ` +
    "Where that differs in degree from the framing or background above, follow this line — " +
    "but the illustration style, the club's violet-to-cyan identity and this month's accent are unchanged.";

  // The opening line and the closing guard both depend on what the input
  // image actually is, which is the one real difference between the two
  // callers.
  const opening = mode === "photo"
    ? "Redraw the person in this photograph as an original illustrated character portrait."
    : "This image is an existing illustrated avatar of a club member. Redraw the same person as a fresh portrait for this month.";

  const closing = mode === "photo"
    ? "Do not reproduce the photograph itself, its background, or its clothing — this is a character inspired by the person, not a filtered photo."
    : // The refresh must be recognisably the same member: this is their face
      // on the directory, and a monthly job that quietly turns them into
      // somebody else is worse than not refreshing at all.
      "Keep the same person clearly recognisable — same face, same hair, same skin tone, same apparent age. Only the lighting, palette accents and background treatment change.";

  return [opening, houseStyle, personal, context, seasonal, treatment, closing]
    .filter(Boolean)
    .join(" ");
}

// Profile text is written by the member, but it still ends up inside a model
// prompt, so it is normalised rather than trusted: single line, trimmed,
// length-capped, and capped in count. A 900-word "interest" would otherwise
// drown the house style it is supposed to accent.
function tidyList(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.map((v) => tidyOne(v)).filter((v): v is string => !!v).slice(0, max)
    : [];
}

function tidyOne(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
}

// ---- The fallback -----------------------------------------------------

// Deterministic, themed, and different per member: the initials come from
// their name and the palette slot from their user id, so two members who run
// out of tries on the same day do not end up with the same tile. It is still
// recognisably club artwork — the point of a fallback is that the wall stays
// whole, not that it is obviously a failure state.
//
// Written as SVG because there is no rasteriser in this runtime, and stored
// under the same `<user_id>/` prefix as a generated avatar so the storage
// policy in 0016 covers both without a special case.

// Violet-to-cyan, the club's two colours, sampled at six points along the way
// so every fallback is obviously from the same set.
const PALETTES = [
  ["#a78bfa", "#22d3ee"],
  ["#8b5cf6", "#38bdf8"],
  ["#c4b5fd", "#06b6d4"],
  ["#7c3aed", "#22d3ee"],
  ["#a78bfa", "#0ea5e9"],
  ["#818cf8", "#2dd4bf"],
];

function fallbackSvg(userId: string, fullName: string, cycle: string): string {
  // The cycle is mixed into the seed so that a member sitting on a fallback
  // tile still visibly turns over each month, like everyone else on the wall.
  // Within a month it is stable, which is what "deterministic" has to mean
  // here — the same member regenerating twice in March gets the same tile.
  const seed = userId + ":" + cycle;
  const [from, to] = PALETTES[hash(seed) % PALETTES.length];
  const initials = initialsOf(fullName);
  // Rotating the gradient by the seed too, so two members on the same palette
  // slot still differ.
  const angle = hash(seed + "angle") % 360;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="${escapeXml(initials)}">
  <defs>
    <linearGradient id="g" gradientTransform="rotate(${angle} 0.5 0.5)">
      <stop offset="0%" stop-color="${from}"/>
      <stop offset="100%" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <circle cx="256" cy="256" r="150" fill="#ffffff" fill-opacity="0.14"/>
  <text x="256" y="256" fill="#ffffff" font-family="Inter, Segoe UI, system-ui, sans-serif"
        font-size="180" font-weight="600" text-anchor="middle" dominant-baseline="central"
        letter-spacing="4">${escapeXml(initials)}</text>
</svg>`;
}

// Draws the tile and puts it in the bucket. Returns the public URL, or "" if
// storage refused — the caller decides what that means, because the two
// callers write different columns afterwards.
async function uploadFallback(
  admin: SupabaseClient,
  userId: string,
  fullName: string,
  cycle: string,
): Promise<string> {
  const svg = fallbackSvg(userId, fullName, cycle);
  const path = `${userId}/fallback.svg`;

  // upsert: true, and the path stays the one 0016 documents — a member who
  // asks twice overwrites their own tile instead of accumulating a file per
  // month.
  const { error } = await admin.storage
    .from(AVATAR_BUCKET)
    .upload(path, new TextEncoder().encode(svg), {
      contentType: "image/svg+xml",
      upsert: true,
    });
  if (error) {
    console.error("fallback upload: " + error.message);
    return "";
  }

  const url = admin.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl;

  // Overwriting a fixed path means the CDN is still holding last month's
  // bytes under the same URL. The cycle rides along as a query parameter so
  // the stored URL changes when the tile does; storage ignores it.
  return url + (url.includes("?") ? "&" : "?") + "v=" + encodeURIComponent(cycle);
}

function initialsOf(fullName: string): string {
  const words = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "SC"; // Sahaba Club, for a profile with no name yet
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? [...words[words.length - 1]][0] ?? "" : "";
  return (first + last).toUpperCase();
}

// FNV-1a. Not for security — only to turn a uuid into a stable palette slot,
// where what matters is that the same member always lands on the same one.
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] ?? c));
}

// ---- Bytes ------------------------------------------------------------

function decodeBase64(b64: string): Uint8Array {
  // Data URLs are easy to send by accident from a FileReader; strip the
  // prefix rather than failing on it.
  const clean = String(b64).replace(/^data:[^;]+;base64,/, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function extFor(mediaType: string): string {
  return mediaType.includes("png") ? "png" : mediaType.includes("webp") ? "webp" : "jpg";
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// ⚠ No OPENAI_API_KEY constant here any more, deliberately: since this
// function draws through `callImage()`, the key is chosen by that module from
// the provider it is routing to — OPENAI_API_KEY or GEMINI_API_KEY. A copy
// read here would be the OpenAI one regardless of which API the run uses, and
// the precondition below would then be asking about the wrong secret.
const IMAGE_MODEL = Deno.env.get("OPENAI_IMAGE_MODEL") ?? "gpt-image-1";

// ⚠ The same slug `generate-avatar` reads. Two functions, one row. See the
// header of `_shared/avatar-art.ts`.
const AI_SLUG = "avatar-art";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

// Stop starting new members after this long and report what is left. The
// function's own limit is higher; returning a clean `remaining` beats being
// killed between the storage upload and the profile UPDATE.
const TIME_BUDGET_MS = 110_000;

// The one failure that is worth distinguishing by type rather than by reading
// its message: it is true for the whole batch, not for the member it happened
// to surface on, so the loop stops instead of confirming it several hundred
// times. See `generate` and the catch in the batch loop.
class QuotaExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExhausted";
  }
}

type DueRow = {
  user_id: string;
  full_name: string | null;
  interests: string[] | null;
  skills: string[] | null;
  industry: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Not a public endpoint. Without a gate any visitor could make the club
  // regenerate several hundred images, which is a bill rather than a
  // defacement, and this function writes avatars for members other than the
  // caller by design.
  //
  // TWO WAYS IN, and the second one exists because the first turned out to be
  // unusable by a human:
  //
  //   1. The service-role key — the scheduled path, unchanged.
  //
  //   2. A STAFF SESSION. Added 8 Aug 2026.
  //
  // ⚠ The original comment here said "nothing legitimate reaches it from a
  // browser", and on 8 Aug something did: a staff-initiated restart of the
  // whole avatar system, which is precisely the sort of thing a club admin
  // should be able to set off and precisely the sort of thing nobody wants on
  // a cron. Worse, the service-role branch cannot be exercised by hand at all
  // — `SUPABASE_SERVICE_ROLE_KEY` is INJECTED BY SUPABASE and is not the value
  // on either dashboard page, which is the discovery that cost 7 Aug most of a
  // day and led to `SENDER_TOKEN` in the two notification senders. Pasting the
  // dashboard's service_role key here returns 403 forever and the message
  // gives you no clue why.
  //
  // So this asks `is_staff()` as the CALLER — the same universal gate the rest
  // of the admin surface uses, never a hardcoded list of role names, which
  // this project has got wrong twice. A member token reaches nothing.
  const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!SERVICE_ROLE_KEY) return json({ error: "Not configured" }, 503);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  if (bearer !== SERVICE_ROLE_KEY) {
    if (!bearer) return json({ error: "Not allowed" }, 403);

    const { data: userData, error: userErr } = await admin.auth.getUser(bearer);
    if (userErr || !userData?.user) {
      console.error("refresh-avatars: not the service key and not a valid session");
      return json({ error: "Not allowed" }, 403);
    }

    // is_staff() reads auth.uid(), which is null on an admin client — it has
    // to be asked through a client carrying the caller's own token.
    const asCaller = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const { data: staff, error: staffErr } = await asCaller.rpc("is_staff");
    if (staffErr) {
      console.error("refresh-avatars: is_staff failed: " + staffErr.message);
      return json({ error: "Could not check permissions" }, 500);
    }
    if (staff !== true) {
      console.error(`user ${userData.user.id} attempted to reach refresh-avatars`);
      return json({ error: "Not allowed" }, 403);
    }
  }
  const params = new URL(req.url).searchParams;
  const dryRun = params.get("dry") === "1";
  const limit = clampLimit(params.get("limit"));

  const cycle = currentCycle();
  const startedAt = Date.now();

  // Read once for the whole batch, not once per member: every avatar in one
  // run must be drawn on one month's theme by one model, or the "wall" this
  // job exists to keep coherent is a wall drawn by two different setups
  // because somebody saved halfway through. Never throws — a database this
  // job cannot read means the batch runs on the code defaults, which is a
  // month of avatars that look right rather than a month with none.
  const ai = await loadAiConfig(admin, AI_SLUG, {
    model: IMAGE_MODEL,
    parts: AVATAR_ART_DEFAULTS,
  });
  const imageModel = ai.model;

  // ⚠ Which API this model belongs to, ASKED rather than guessed. `ai_models`
  // records the provider that listed the model, so it is the answer the
  // listing API actually gave; `providerFor()`'s regex is the fallback for a
  // model that is not in the table. Read ONCE per run, not per member — the
  // whole batch draws with one model.
  const { data: modelRow } = await admin
    .from("ai_models")
    .select("provider")
    .eq("id", imageModel)
    .maybeSingle();
  const imageProvider: Provider | null =
    modelRow?.provider === "google" || modelRow?.provider === "openai" ? modelRow.provider : null;

  const art = {
    house_style: part(ai, "house_style", HOUSE_STYLE),
    variants: listOf(ai, "variants", VARIANTS),
  };
  const theme = themeForCycle(cycle, listOf(ai, "themes", THEMES));

  try {
    // ⚠ Asks about the key for the provider THIS RUN will actually use. It
    // checked OPENAI_API_KEY unconditionally, which since the switch would
    // refuse a perfectly configured Google run for a missing OpenAI key — and,
    // worse in the other direction, would let a Google run start with no
    // GEMINI_API_KEY and fail one member at a time.
    const runProvider: Provider = imageProvider ?? "openai";
    if (!dryRun && !providerConfigured(runProvider)) {
      console.error(`no API key for provider ${runProvider}`);
      return json({
        error: runProvider === "google"
          ? "GEMINI_API_KEY is not set, and the avatar model configured in Admin → AI services is a Google one."
          : "Avatar generation isn't configured yet — OPENAI_API_KEY is not set.",
      }, 503);
    }

    // The view already filters to discoverable members whose cycle is not the
    // current month. `count: exact` gives the size of the whole queue, not
    // just this page, which is what makes `remaining` answerable without a
    // second query.
    //
    // The ORDER BY is restated here even though 0018 has one. A view's
    // internal ordering is not something a paginated query is entitled to
    // rely on, and this is precisely the query that relies on it: oldest
    // first is what lets an interrupted run resume instead of handing back
    // the same ten people every time.
    const { data: due, count, error: dueErr } = await admin
      .from("avatars_due_refresh")
      .select("user_id, full_name, interests, skills, industry", { count: "exact" })
      .order("avatar_refreshed_at", { ascending: true, nullsFirst: true })
      .range(0, limit - 1);
    if (dueErr) return json({ error: dueErr.message }, 500);

    const batch = (due ?? []) as DueRow[];
    const totalDue = count ?? batch.length;

    // The avatar to redraw is not in the view — 0018 selects the fields the
    // prompt needs and nothing else. One lookup for the whole batch rather
    // than one per member.
    const ids = batch.map((r) => r.user_id);
    const avatarUrls = new Map<string, string>();
    if (ids.length) {
      const { data: current, error: curErr } = await admin
        .from("profiles")
        .select("user_id, avatar_url")
        .in("user_id", ids);
      if (curErr) return json({ error: curErr.message }, 500);
      for (const r of current ?? []) avatarUrls.set(r.user_id, r.avatar_url ?? "");
    }

    if (dryRun) {
      // Same shape as send-license-reminders' dry run: enough to see who is
      // next and why, with nothing spent. `willRedraw` is the interesting
      // column — false means we will write the themed fallback because there
      // is no usable picture to work from.
      return json({
        ok: true,
        dryRun: true,
        cycle,
        theme,
        // Which artwork this run would use, and where it came from. A dry run
        // whose whole job is "see who is next and why" should also answer
        // "and drawn how" — an activated house style that nobody expected is
        // exactly the thing worth catching before several hundred images.
        model: imageModel,
        artSource: ai.source,
        artVersion: ai.version || null,
        wouldProcess: batch.length,
        remaining: totalDue,
        sample: batch.slice(0, 10).map((r) => ({
          user_id: r.user_id,
          full_name: r.full_name,
          willRedraw: !!storagePathFor(avatarUrls.get(r.user_id) ?? ""),
        })),
      });
    }

    let processed = 0;
    let superseded = 0;
    const failures: Array<{ user_id: string; reason: string }> = [];
    let ranOutOfTime = false;
    let quotaExhausted = false;

    for (const row of batch) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        ranOutOfTime = true;
        break;
      }

      try {
        const written = await refreshOne(
          admin, row, avatarUrls.get(row.user_id) ?? "", cycle, theme, art, imageModel, imageProvider,
        );
        // Either way they are in this cycle now and out of the queue, so both
        // count toward `processed` — `superseded` is only there to explain a
        // month where the numbers look light.
        if (!written) superseded++;
        processed++;
      } catch (err) {
        // A member who fails keeps last month's avatar and last month's
        // cycle, so they stay in the view and are picked up first next run.
        // Nothing is half-written: the profile UPDATE is the last step.
        const reason = String(err instanceof Error ? err.message : err);
        console.error("refresh-avatars " + row.user_id + ": " + reason);
        failures.push({ user_id: row.user_id, reason });

        // ⚠ An exhausted balance is not this member's problem and will not
        // clear for the next one. Working through the rest of the batch would
        // be several hundred requests to be told the same thing, and it would
        // bury the one line an operator needs to read.
        if (err instanceof QuotaExhausted) {
          quotaExhausted = true;
          break;
        }
      }
    }

    // Everyone we did not advance is still due, failures included.
    const remaining = Math.max(0, totalDue - processed);

    // `done` tells the scheduler whether looping again is worth anything.
    // Nothing left is the obvious case. The other one matters more: a full
    // batch that advanced nobody means every member in it failed, and since
    // the view is ordered oldest-first the next call would hand back the same
    // people and fail the same way. Reporting done stops that loop and leaves
    // them for the next scheduled run, by which time a busy image service or
    // a bad model name will plausibly have changed.
    //
    // An exhausted balance joins that list for the same reason and more
    // strongly: it is the one failure guaranteed to still be true on the next
    // call. Without it a batch that drew twenty people and then ran dry would
    // report `processed > 0`, the scheduler would loop, and the whole remaining
    // membership would be walked one paid-for 429 at a time.
    const done = remaining === 0 || quotaExhausted || (processed === 0 && !ranOutOfTime);

    return json({
      ok: true,
      cycle,
      theme,
      model: imageModel,
      artSource: ai.source,
      artVersion: ai.version || null,
      processed,
      failed: failures.length,
      superseded,
      remaining,
      done,
      ranOutOfTime,
      quotaExhausted,
      failures: failures.slice(0, 20),
    });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

// One member, start to finish. Throws on anything that should count as a
// failure; the caller records it and moves to the next person. Returns false
// if the member drew their own avatar while this was running — see
// saveRefreshed.
async function refreshOne(
  admin: ReturnType<typeof createClient>,
  row: DueRow,
  currentUrl: string,
  cycle: string,
  theme: string,
  // Resolved once for the batch by the handler and passed down rather than
  // read here, so every member in one run is drawn the same way.
  art: { house_style: string; variants: string[] },
  imageModel: string,
  imageProvider: Provider | null,
): Promise<boolean> {
  const profile = {
    full_name: row.full_name,
    interests: row.interests,
    skills: row.skills,
    industry: row.industry,
  };

  const sourcePath = storagePathFor(currentUrl);

  // No picture we can redraw. Rather than skipping — which would leave them
  // out of the month forever, since the view would keep offering them and
  // every run would keep passing — they get the deterministic themed tile,
  // which is real club artwork and changes with the month like everyone
  // else's. That covers a member with no avatar at all, and one sitting on
  // last month's fallback SVG, which the image endpoint will not accept as
  // input anyway.
  if (!sourcePath) {
    const url = await uploadFallback(admin, row.user_id, String(row.full_name ?? ""), cycle);
    if (!url) throw new Error("fallback upload failed");
    return await saveRefreshed(admin, row.user_id, {
      avatar_url: url,
      avatar_source: "fallback",
      avatar_theme: theme,
      avatar_cycle: cycle,
    });
  }

  // Their existing avatar, out of our own bucket. Downloaded through the
  // storage API rather than fetched from the public URL for two reasons: the
  // CDN can still be holding a previous version, and `avatar_url` is a column
  // members may write. Following an arbitrary URL out of a member-writable
  // column, from a service-role job, is a request-forgery hole — so anything
  // that is not a path inside the avatars bucket is treated as "no usable
  // source" above and never fetched.
  const { data: blob, error: dlErr } = await admin.storage
    .from(AVATAR_BUCKET)
    .download(sourcePath);
  if (dlErr || !blob) throw new Error("couldn't read the current avatar: " + (dlErr?.message ?? "missing"));

  let sourceBytes = new Uint8Array(await blob.arrayBuffer());
  if (!sourceBytes.byteLength) throw new Error("current avatar is empty");

  // Variant 0, as it always was: the monthly job draws one picture per member
  // and has nothing to vary between. The rota still has to be passed, because
  // entry 0 is one of the three staff can edit.
  const prompt = buildPrompt(profile, theme, "avatar", 0, art);
  const drawn = await generate(sourceBytes, prompt, imageModel, imageProvider);

  // Generated art rather than a photograph, but zeroed on the same principle
  // as generate-avatar: the input to an image call does not outlive the call.
  sourceBytes.fill(0);
  sourceBytes = new Uint8Array(0);

  // A new path each month rather than an overwrite, so the public URL changes
  // and no CDN anywhere serves last month's face. Same `<user_id>/` prefix,
  // so the storage policies in 0016 cover it unchanged.
  //
  // ⚠ The extension FOLLOWS the bytes, it is not assumed — d03f5e1's finding on
  // the member path applies identically here: Gemini returns JPEG, and storing
  // JPEG under a .png name with a PNG content type "works" only because
  // browsers sniff the real bytes. 0016's bucket allows png, jpeg and webp, so
  // there was never a reason to mislabel it.
  const outType = drawn.mediaType || "image/png";
  const outExt = /jpe?g/i.test(outType) ? "jpg" : /webp/i.test(outType) ? "webp" : "png";
  const path = `${row.user_id}/${crypto.randomUUID()}.${outExt}`;
  const { error: upErr } = await admin.storage
    .from(AVATAR_BUCKET)
    .upload(path, drawn.bytes, { contentType: outType, upsert: false });
  if (upErr) throw new Error("upload: " + upErr.message);

  const avatarUrl = admin.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl;

  return await saveRefreshed(admin, row.user_id, {
    avatar_url: avatarUrl,
    avatar_prompt: prompt,
    avatar_theme: theme,
    avatar_cycle: cycle,
  });
}

// The one UPDATE, for both paths.
//
// `avatar_source` is deliberately not set on the redraw path: 0015's CHECK
// allows only upload/google/microsoft/linkedin/fallback, and the honest
// answer to "where did this likeness come from" is still whatever they first
// gave us. The fallback path passes 'fallback' because that is exactly what
// it wrote.
//
// `source_purged_at` travels with `avatar_url` and `avatar_is_generated` in
// the same statement, the same as generate-avatar — 0015's alert looks for a
// generated avatar with a null purge timestamp, and a monthly job that split
// these would trip it several hundred times.
//
// `avatar_attempts` goes to 0 with the new cycle: the club redrawing everyone
// must not cost a member one of their own three tries for the month.
//
// Guarded on the member not already being in this cycle. The window is small
// but real — this job reads a batch, then spends several seconds per member
// inside OpenAI, and a member who generates their own avatar during those
// seconds has deliberately chosen a picture. Overwriting it with the batch's
// version, and handing back the tries they just spent, is the wrong outcome
// even though it is the rarer one. Returns false when that happened; the row
// is already out of `avatars_due_refresh` either way.
async function saveRefreshed(
  admin: ReturnType<typeof createClient>,
  userId: string,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("profiles")
    .update({
      ...fields,
      avatar_is_generated: true,
      avatar_attempts: 0,
      avatar_refreshed_at: now,
      source_purged_at: now,
      updated_at: now,
    })
    .eq("user_id", userId)
    // `neq` alone would drop everyone with a null cycle, because NULL <> 'x'
    // is NULL rather than true — and a never-refreshed member is exactly who
    // this job is for.
    .or(`avatar_cycle.is.null,avatar_cycle.neq.${fields.avatar_cycle}`)
    .select("user_id");
  if (error) throw new Error("save: " + error.message);
  return !!data?.length;
}

// ---- The image call ---------------------------------------------------

// The edits endpoint again, with the member's existing avatar as the image
// input. Errors here are read from a log by whoever is watching the batch,
// not by a member staring at a spinner, so the triage is shorter than
// generate-avatar's and phrased for the operator.
//
// ⚠ THROUGH callImage() SINCE 10 AUG 2026, and the reason is worth keeping.
// This function was deliberately left on OpenAI when generate-avatar moved —
// "blast radius of one first" — and that was right while the shared
// `avatar-art` config still named an OpenAI model. It stopped being right the
// moment `nano-banana-pro-preview` was activated: 0031 gives generate-avatar
// and refresh-avatars ONE configuration on purpose, so activating a Google
// model pointed this function's OpenAI call at a model OpenAI has never heard
// of. Every member in the next monthly run would have failed with "the image
// model chosen in Admin → AI services is not one this account can use" — an
// accurate message about a setting that was correct.
//
// The lesson is the coupling, not the model: a shared configuration means the
// two functions must agree about what a model IS, so they now share the same
// router as well as the same house style.
//
// ⚠ The provider is PASSED, not guessed. `providerFor()` is a regex over the
// model name, and d03f5e1 is the record of what that costs — it did not know
// `nano-banana`, so the panel called it Google and generate-avatar called it
// OpenAI. `ai_models.provider` is what the listing API actually said, and this
// function can reach the database, so it asks. The regex stays as the fallback
// for a model that is not in the table.
async function generate(
  bytes: Uint8Array,
  prompt: string,
  model: string,
  provider: Provider | null,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const result = await callImage({
    model,
    provider: provider ?? undefined,
    prompt,
    image: bytes,
    // ⚠ The stored avatar is whatever the last run wrote, which since d03f5e1
    // may be JPEG rather than PNG. Naming it png here would hand OpenAI a file
    // whose extension contradicts its bytes.
    mediaType: "image/png",
    // OpenAI-only; callImage does not forward them to Google.
    size: "1024x1024",
    quality: "high",
  });

  if (!result.ok) {
    const detail = String(result.error ?? "");
    const res = { status: result.status };
    if (/model_not_found|does not exist|unknown model/i.test(detail)) {
      // Names which setting is actually in play — since 0031 the model can
      // come from the admin panel instead of the secret, and sending an
      // operator to change a value nothing is reading wastes a batch window.
      throw new Error(
        model === IMAGE_MODEL
          ? "OPENAI_IMAGE_MODEL is not a model this account can use"
          : `the image model chosen in Admin → AI services (${model}) is not one this account can use`,
      );
    }
    // ⚠ QUOTA IS MATCHED BEFORE THE 429, the same ordering the five contract
    // functions use. OpenAI reports an exhausted balance as HTTP 429 with
    // `insufficient_quota` in the body; nothing here matched it, so a spent
    // balance arrived as "rate limited" — a transient-sounding reason recorded
    // against every member in the batch in turn, each one costing a request to
    // discover the same thing. It is thrown as its own type so the batch loop
    // can stop rather than work through several hundred people.
    if (/insufficient_quota|billing_hard_limit|exceeded your current quota|billing_not_active|balance is spent/i.test(detail)) {
      // ⚠ Names the provider that actually refused, because there are two now
      // and topping up the wrong account fixes nothing.
      throw new QuotaExhausted(`the ${result.provider} account is out of credit — top it up and re-run`);
    }
    if (res.status === 401 || res.status === 403 || /invalid_api_key|incorrect api key/i.test(detail)) {
      throw new Error(
        result.provider === "google" ? "Google rejected GEMINI_API_KEY" : "OpenAI rejected OPENAI_API_KEY",
      );
    }
    if (res.status === 429) throw new Error("rate limited");
    throw new Error(result.provider + " " + res.status + ": " + detail.slice(0, 200));
  }

  // callImage already decoded the base64 and already treats a 200 carrying no
  // image as a failure — the shape a Gemini refusal takes — so reaching here
  // means there are bytes.
  if (!result.bytes || !result.bytes.length) throw new Error("no image came back");
  return { bytes: result.bytes, mediaType: result.mediaType || "image/png" };
}

// ---- Helpers ----------------------------------------------------------

// The object path inside the avatars bucket, or null if this URL is not one
// of ours. Doubles as the "can we redraw this?" test — see refreshOne. SVG is
// excluded because it is the fallback tile and the image endpoint will not
// take it as input.
function storagePathFor(url: string): string | null {
  const marker = "/storage/v1/object/public/" + AVATAR_BUCKET + "/";
  const at = String(url ?? "").indexOf(marker);
  if (at === -1) return null;

  const path = decodeURIComponent(url.slice(at + marker.length).split("?")[0]);
  if (!path || path.toLowerCase().endsWith(".svg")) return null;
  // `..` cannot climb out of a bucket through the storage API, but a path
  // arriving from a column is not a place to find out.
  if (path.includes("..")) return null;
  return path;
}

function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
