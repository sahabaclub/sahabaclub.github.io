// GENERATED - do not edit. Deploy-time twin of index.ts with the ../_shared/cors.ts, ../_shared/ai-provider.ts, ../_shared/ai-config.ts, ../_shared/avatar-art.ts imports replaced by those files inline, and
// nothing else. The Supabase dashboard editor deploys one function directory at a
// time and cannot reach a shared parent file. Edit index.ts and regenerate; the
// two must stay in step.

// generate-avatar
// ------------------------------------------------------------
// Turns a member's real photo into a stylised illustrated Sahaba Club avatar,
// and then destroys the photo.
//
// The club's rule is that no real photographs live on the platform. That is a
// privacy promise, not a look, and it only holds because of how this function
// is written: the uploaded image arrives in the request body, is held in a
// local variable, is posted to OpenAI, and is never written to storage or to
// a column. The only bytes that reach the `avatars` bucket are the generated
// ones. `source_purged_at` is set in the same UPDATE that sets `avatar_url`,
// so there is no moment at which a generated avatar exists without the
// receipt saying the source is gone — 0015 has a verification query that
// alerts on exactly that pair.
//
// The function acts ONLY on the caller's own profile. The target user id is
// taken from the JWT and the request body is never consulted for it, because
// a function that accepts "whose photo is this" from the client is a machine
// for transforming pictures of other people.
//
// Three generations per member per month, then a themed fallback. The cap is
// here (and again as a CHECK constraint in 0015) because "generate another"
// is one button and image generation costs real money per press. Since 0018
// the three are an allowance per monthly cycle rather than a lifetime one:
// a member who is unhappy with all three in March gets three fresh tries in
// April, and refresh-avatars redraws everyone on the new month's theme in
// between. The style itself lives in _shared/avatar-art.ts, shared with that
// job so the wall stays one wall.
//
// ---- The member does not wait for the drawing ------------------------------
//
// This used to hold the HTTP request open for the whole OpenAI image call —
// tens of seconds, and a test run that went past a 45-second limit and was
// killed. A member sitting on a spinner that long assumes the page has hung,
// and the one thing they can do about it (press the button again) is the one
// thing that makes it worse.
//
// So the request now returns as soon as the attempt is RESERVED — 202, with
// the allowance the member has left — and the drawing happens in the
// background via EdgeRuntime.waitUntil. The reservation is the only part that
// has to be synchronous, because it is the part that decides whether this
// request is allowed to spend money at all, and its answer is what the member
// needs before they can press anything else.
//
// Progress is reported through `profiles.avatar_status` (0026), which the
// member's own row already lets them read, so the page polls one row it was
// going to read anyway rather than this function growing a second endpoint:
//
//   202 {ok, queued:true, ...}  →  avatar_status 'generating'
//                                    →  'ready'  and a new avatar_url
//                                    →  'failed' and a readable avatar_error
//
// What did NOT change is the privacy promise, and it is worth saying plainly
// because moving work into the background is exactly the kind of change that
// quietly breaks it: the photo bytes still live only in a local variable, they
// still never reach storage or a column, and they are still scrubbed the
// moment the image call is done with them. The only difference is that the
// variable now outlives the HTTP response instead of the request outliving the
// drawing.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   OPENAI_API_KEY
//   OPENAI_IMAGE_MODEL                       — optional, see below
//
// Since 0031 the artwork and the image model can also be set from Admin → AI
// services, under the `avatar-art` service that this function shares with
// `refresh-avatars`. The secret above and the constants in
// `_shared/avatar-art.ts` remain the floor: with nothing activated, or with
// the database unreachable, this function behaves exactly as it did before.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// ---- inlined from ../_shared/cors.ts ----
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
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

// A Supabase runtime global, not a Deno one, so it is in none of the types we
// import. Declared here rather than reached for through `globalThis as any`,
// and declared as possibly undefined on purpose: `waitUntil` is the whole
// reason this function can answer in a second, but a local `deno serve`, a
// self-hosted deployment or a future runtime may not have it. The fallback
// below awaits the work inline — slow, and exactly what this function used to
// do — because answering late is a worse outcome than dropping a member's
// paid-for image on the floor, not a better one.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

// An environment variable with a default rather than a constant, same as the
// text model in parse-profile-document: image model names change faster than
// this function will, and a wrong one should be a dashboard edit rather than
// a redeploy. The error handler below says so when OpenAI rejects the name.
//
// Since 0031 this is the FLOOR rather than the setting. The admin panel's
// `avatar-art` service can override the model and the artwork; when it has
// nothing active — a fresh environment, a deliberate reset, or a database this
// function could not read — everything below runs on exactly these values.
// See `_shared/ai-config.ts`.
const IMAGE_MODEL = Deno.env.get("OPENAI_IMAGE_MODEL") ?? "gpt-image-1";

// ⚠ The slug is shared with `refresh-avatars` on purpose, and it is the
// mechanism by which the two functions cannot drift apart. One row of artwork,
// two readers. See the header of `_shared/avatar-art.ts`.
const AI_SLUG = "avatar-art";

// Matches the bucket's allowed_mime_types in 0016. Checked here as well so a
// bad upload fails before it costs an OpenAI call.
const ALLOWED_MEDIA = ["image/png", "image/jpeg", "image/webp"];

// Where the photo came from, for `profiles.avatar_source`. 'fallback' is
// deliberately not accepted from the client — only this function assigns it.
const ALLOWED_SOURCES = ["upload", "google", "microsoft", "linkedin"];

// 8 MB decoded. Phone cameras produce more than this; the page downscales
// before upload, and a body that arrives bigger than this is a bug or an
// attempt to make us pay to forward large files to OpenAI.
const MAX_SOURCE_BYTES = 8_000_000;

// How many past drawings `avatar_gallery` keeps. Three tries a month, twelve
// months a year, and a jsonb column that is read whole every time the profile
// is: without a cap this grows for ever and every profile read pays for it.
// Twelve is four months of a member using their full allowance, which is more
// than enough for "put the one from last month back" — and every entry still
// points at a file in the bucket, so nothing is deleted by falling off the
// end, only forgotten.
const GALLERY_MAX = 12;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // The identity of the profile being changed comes from here and from
    // nowhere else. See the header note.
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData.user) {
      return json({ error: "Not signed in" }, 401);
    }
    const userId = userData.user.id;

    // ⚠ "Is a key set" became TWO questions when this function stopped being
    // OpenAI-only. This is the cheap one — is ANY provider configured. The one
    // that matters, is the key for the provider THIS SERVICE'S MODEL belongs
    // to configured, cannot be asked here: the model comes from the database,
    // resolved further down. Testing only OPENAI_API_KEY, as this did before,
    // would refuse a working Gemini-configured avatar service over a key it
    // never uses.
    if (!providerConfigured("openai") && !providerConfigured("google")) {
      console.error("neither OPENAI_API_KEY nor GEMINI_API_KEY is set");
      return json({ error: "Avatar generation isn't configured yet." }, 503);
    }

    const body = await req.json().catch(() => ({}));
    const source: string = body.source ?? "upload";
    const mediaType: string = body.mediaType ?? "image/png";
    const imageBase64: string = body.imageBase64 ?? "";

    if (!ALLOWED_SOURCES.includes(source)) {
      return json({ error: "Unknown avatar source" }, 400);
    }
    if (!ALLOWED_MEDIA.includes(mediaType)) {
      return json({ error: "Photos must be PNG, JPEG or WebP." }, 400);
    }

    const { data: profile, error: pErr } = await admin
      .from("profiles")
      .select("user_id, full_name, headline, industry, skills, interests, avatar_attempts, avatar_cycle")
      .eq("user_id", userId)
      .maybeSingle();
    if (pErr || !profile) {
      return json({ error: "No profile to attach an avatar to" }, 404);
    }

    // Attempts are counted per cycle, so the column on its own does not mean
    // what it says: an `avatar_attempts` of 3 stamped with last month's
    // `avatar_cycle` is a member with three tries in hand, not a member out
    // of them. `storedAttempts`/`storedCycle` are the raw row as we read it —
    // used only for the reservation guard below, which has to compare against
    // what is actually in the row — and `attempts` is what the member has
    // spent *this* month, which is what the cap and the response talk about.
    //
    // This mirrors public.avatar_attempts_this_cycle() in 0018. Both exist
    // because the rule is read from SQL as well as from here, and neither is
    // allowed to be the only place it is written down.
    const storedAttempts: number = profile.avatar_attempts ?? 0;
    const storedCycle: string | null = profile.avatar_cycle ?? null;
    const cycle = currentCycle();

    // The artwork and the model staff have chosen, or the constants above.
    // Read before the allowance check rather than after, because the themed
    // fallback tile below is stamped with `avatar_theme` too and a member out
    // of tries must land on the same month's accent as everybody else. One
    // memoised read per instance per minute, so this costs the fallback path
    // nothing. Never throws — see `_shared/ai-config.ts`.
    const ai = await loadAiConfig(admin, AI_SLUG, {
      model: IMAGE_MODEL,
      parts: AVATAR_ART_DEFAULTS,
    });
    const imageModel = ai.model;
    const art = {
      house_style: part(ai, "house_style", HOUSE_STYLE),
      variants: listOf(ai, "variants", VARIANTS),
    };

    const theme = themeForCycle(cycle, listOf(ai, "themes", THEMES));
    const staleCycle = storedCycle !== cycle;
    const attempts = staleCycle ? 0 : storedAttempts;

    // Out of tries *this month*: no OpenAI call, no increment. The fallback is
    // generated locally and costs nothing, so a member who has spent their
    // three still ends up with something that belongs on the wall — and gets
    // three more when the month turns over.
    //
    // This path stays synchronous. There is nothing to wait for — an SVG is
    // drawn in this process and uploaded — so queueing it would only cost the
    // member a poll to be told something that was already true when they
    // asked. It answers 200 with the finished URL, exactly as it always did.
    if (attempts >= MAX_ATTEMPTS) {
      const url = await storeFallback(admin, userId, profile, cycle, theme);
      if (!url) return json({ error: "Couldn't save an avatar just now." }, 502);
      return json({
        ok: true,
        queued: false,
        avatarUrl: url,
        attemptsUsed: attempts,
        attemptsLeft: 0,
        cycle,
        isFallback: true,
      });
    }

    // The photo. From here until the OpenAI call returns it exists only as
    // this local variable — nothing between these lines writes it anywhere.
    let sourceBytes: Uint8Array;
    try {
      sourceBytes = decodeBase64(imageBase64);
    } catch {
      return json({ error: "That photo didn't arrive in one piece — try again." }, 400);
    }
    if (!sourceBytes.byteLength) {
      return json({ error: "imageBase64 is required" }, 400);
    }
    if (sourceBytes.byteLength > MAX_SOURCE_BYTES) {
      return json({ error: "That photo is too large. Try one under 8 MB." }, 413);
    }

    // Reserve the attempt before spending money, guarded on the row we just
    // read. Two "generate another" clicks racing each other both read 2 and
    // would both generate; the guard means the loser's update matches no rows
    // and it is told to try again. The refund below covers the case where
    // OpenAI never produced an image.
    //
    // The guard is on the *stored* pair, not on the effective count, and that
    // is the part worth reading twice. If the row says (attempts 3, cycle
    // '2026-06') and this is July, the member has 0 spent and 3 in hand — but
    // guarding on `avatar_attempts = 0` would match nothing and every first
    // generation of a new month would fail as a phantom conflict. Guarding on
    // (3, '2026-06') — what is really in the row — matches exactly once, and
    // the write that wins is also the write that moves the row into July. The
    // loser of a genuine race then sees the new cycle and correctly conflicts.
    //
    // `avatar_status`/`avatar_error` ride along in the same statement rather
    // than following in a second one. The WHERE clause is untouched — this is
    // the same guard on the same pair — but it means the row is never briefly
    // "an attempt has been spent and nothing is happening", which is precisely
    // the state a polling client would read as a stuck generation.
    const next = attempts + 1;
    // The attempt index, 0-based, so a member's three tries in a cycle get the
    // three different treatments in _shared/avatar-art.ts rather than three
    // draws of the same prompt.
    const prompt = buildPrompt(profile, theme, "photo", next - 1, art);

    let reservation = admin
      .from("profiles")
      .update({
        avatar_attempts: next,
        avatar_cycle: cycle,
        avatar_status: "generating",
        avatar_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("avatar_attempts", storedAttempts);
    // A never-generated member has a null cycle, and `= null` is never true in
    // SQL — that comparison has to be IS NULL or the first ever generation
    // reserves nothing.
    reservation = storedCycle === null
      ? reservation.is("avatar_cycle", null)
      : reservation.eq("avatar_cycle", storedCycle);

    const { data: reserved, error: rErr } = await reservation.select("user_id");
    if (rErr) return json({ error: rErr.message }, 500);
    if (!reserved?.length) {
      return json({ error: "Another avatar is already being generated. Give it a moment." }, 409);
    }

    // Everything expensive, from here on, off the request's critical path.
    // `draw` never rejects — it records its own outcome on the profile row,
    // because after the response has gone there is nobody left to tell.
    const work = draw(admin, {
      userId,
      source,
      mediaType,
      sourceBytes,
      prompt,
      theme,
      cycle,
      variant: next - 1,
      attempts,
      next,
      // Carried into the background half rather than read again there: the
      // picture must be drawn by the model that was live when the attempt was
      // reserved, not by whatever staff activated in the seconds since.
      imageModel,
    });

    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
      EdgeRuntime.waitUntil(work);
    } else {
      // No waitUntil in this runtime. Do it the old way and answer late; the
      // response below is still a 202, so a client that polls afterwards
      // simply finds the work already finished on its first look.
      console.warn("EdgeRuntime.waitUntil is unavailable — drawing inline");
      await work;
    }

    // 202, not 200: accepted, not done. The allowance is already correct —
    // the attempt is spent whether or not the drawing lands, and it is given
    // back by `draw` if it does not, which the member sees on the next poll.
    return json({
      ok: true,
      queued: true,
      attemptsUsed: next,
      attemptsLeft: MAX_ATTEMPTS - next,
      cycle,
    }, 202);
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

// ---- The background half ----------------------------------------------

type DrawJob = {
  userId: string;
  source: string;
  mediaType: string;
  sourceBytes: Uint8Array;
  prompt: string;
  theme: string;
  cycle: string;
  variant: number;
  attempts: number;   // spent before this try — what a refund restores
  next: number;       // spent including this try — what the guard matches on
  imageModel: string; // resolved before the response went out; see above
};

// Draws, uploads, and writes the profile. Runs after the response has been
// sent, so it must never throw: an unhandled rejection inside waitUntil is a
// line in a log nobody is reading and a member left on 'generating' for ever.
// Every exit from here leaves `avatar_status` at 'ready' or 'failed'.
async function draw(admin: ReturnType<typeof createClient>, job: DrawJob): Promise<void> {
  const { userId, source, mediaType, prompt, theme, cycle, variant, attempts, next, imageModel } = job;

  try {
    // The photo has done its job, whether the call succeeded or not. It would
    // be collected when this task ends anyway; zeroing it is cheap and means
    // the source is gone before anything is written, not merely never written.
    // Attached to the call itself rather than placed after it, because a
    // failed generation is not a reason to keep somebody's photograph in
    // memory for the rest of the instance's life — and now that the response
    // has already gone, that life is longer than the request's was.
    const drawn = await generate(job.sourceBytes, mediaType, prompt, imageModel)
      .finally(() => job.sourceBytes.fill(0));

    // ⚠ THE FORMAT IS NOT ALWAYS PNG ANY MORE. OpenAI's edits endpoint returns
    // PNG and this hardcoded `.png` and `image/png` for as long as OpenAI was
    // the only provider. Gemini returns JPEG — measured, 10 Aug: a real
    // nano-banana-pro-preview call came back `image/jpeg`.
    //
    // Storing JPEG bytes under a .png name with a PNG content type mostly
    // "works", because browsers sniff the actual bytes — which is exactly what
    // makes it dangerous: it looks fine while the stored metadata is a lie, and
    // anything that trusts the extension or the content type rather than
    // sniffing gets the wrong answer. 0016's bucket allows png, jpeg and webp,
    // so there is no reason to mislabel it.
    const outType = drawn.mediaType || "image/png";
    const outExt = /jpe?g/i.test(outType) ? "jpg" : /webp/i.test(outType) ? "webp" : "png";

    const path = `${userId}/${crypto.randomUUID()}.${outExt}`;
    const { error: upErr } = await admin.storage
      .from(AVATAR_BUCKET)
      .upload(path, drawn.bytes, { contentType: outType, upsert: false });
    if (upErr) {
      console.error("upload: " + upErr.message);
      await fail(admin, userId, cycle, attempts, next, "Couldn't save the new avatar just now.");
      return;
    }
    const avatarUrl = admin.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl;

    // The gallery is read here, immediately before the write, rather than
    // carried down from the request — it is minutes old by then, and
    // refresh-avatars or the member's own previous try may have touched it.
    //
    // Read-then-write, so two drawings genuinely overlapping can still lose
    // one entry, and that is a known cost rather than an oversight. The
    // reservation guard does not prevent the overlap: it only stops two
    // requests that read the *same* row from both reserving. A second request
    // issued after the first has reserved reads the new count and reserves the
    // next attempt quite legitimately — and now that the response no longer
    // waits for the drawing, the member is free to send it. What is lost when
    // that happens is one row of history; the picture itself is in the bucket,
    // and the winning `avatar_url` is still the last one written. Serialising
    // it would mean a jsonb-appending SQL function on the hot path of every
    // generation, which is a lot of machinery for a forgotten thumbnail.
    const { data: current } = await admin
      .from("profiles")
      .select("avatar_gallery")
      .eq("user_id", userId)
      .maybeSingle();

    const held = current?.avatar_gallery;
    const previous = Array.isArray(held) ? held : [];
    const gallery = [
      { url: avatarUrl, prompt, theme, variant, cycle, created_at: new Date().toISOString() },
      ...previous,
    ].slice(0, GALLERY_MAX);

    // One UPDATE. `source_purged_at` travels with `avatar_url` so the two can
    // never disagree — the alert in 0015 looks for a generated avatar with a
    // null purge timestamp, and splitting these into two statements would
    // create a window where that is briefly true. `avatar_status` is in the
    // same statement for the same reason: 'ready' and the URL the member is
    // about to be shown must become true together, or a poll lands between
    // them and shows the old picture as the new one.
    const { error: saveErr } = await admin
      .from("profiles")
      .update({
        avatar_url: avatarUrl,
        avatar_gallery: gallery,
        avatar_status: "ready",
        avatar_error: null,
        avatar_is_generated: true,
        avatar_source: source,
        avatar_prompt: prompt,
        avatar_theme: theme,
        // Stamped here as well as by refresh-avatars: this member has now had
        // a picture drawn for this month, and `avatars_due_refresh` orders on
        // this column, so leaving it stale would send the monthly job to the
        // people who need it least first.
        avatar_refreshed_at: new Date().toISOString(),
        source_purged_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
    if (saveErr) {
      // The picture exists and is uploaded; only the row write failed. The
      // attempt is still refunded, because from the member's side nothing
      // happened and charging them for it would be wrong.
      console.error("save: " + saveErr.message);
      await fail(admin, userId, cycle, attempts, next, "Your avatar was drawn but couldn't be saved. Try again.");
    }
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    console.error("generate-avatar: " + message);
    await fail(admin, userId, cycle, attempts, next, message);
  }
}

// Give the try back and say what went wrong, in one statement.
//
// Nothing usable was produced, so nothing was charged for and the try is given
// back. Guarded on (next, cycle) so a concurrent success is never rolled back.
// The cycle is left at the current month rather than restored to the stale
// one: `attempts` is already the count for this month, and re-staling the row
// would only make the next request redo the reset.
//
// `avatar_status` and `avatar_error` sit inside the same guarded statement on
// purpose. If the guard misses, some other writer owns this row — a
// generation that succeeded while this one was failing, or the monthly
// refresh — and stamping 'failed' over their work would tell the member their
// perfectly good new avatar is broken.
async function fail(
  admin: ReturnType<typeof createClient>,
  userId: string,
  cycle: string,
  attempts: number,
  next: number,
  message: string,
): Promise<void> {
  const { error } = await admin
    .from("profiles")
    .update({
      avatar_attempts: attempts,
      avatar_status: "failed",
      // Read by the member, so it is the triaged sentence from `generate`
      // rather than a stack trace. Length-capped because the column is shown
      // in a state line, and a 4 kB OpenAI error body is not a sentence.
      avatar_error: message.slice(0, 300),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("avatar_attempts", next)
    .eq("avatar_cycle", cycle);
  if (error) console.error("refund: " + error.message);
}

// ---- OpenAI -----------------------------------------------------------

// POST /v1/images/edits, multipart — the edits endpoint rather than
// generations because the source photograph is the input we are transforming.
// Plain fetch and FormData, no SDK, same as every other function here.
async function generate(
  bytes: Uint8Array,
  mediaType: string,
  prompt: string,
  model: string,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  // ⚠ THROUGH callImage(), NOT api.openai.com DIRECTLY. Step 3 of the switch
  // Ahmed asked for on 8 Aug 2026: the member-triggered avatar may now be drawn
  // by Gemini as well as by OpenAI, decided by which model is configured for
  // `avatar-art` in the AI panel.
  //
  // ⚠ `refresh-avatars` is DELIBERATELY NOT MIGRATED. It redraws every member
  // in one run; this one redraws the single member who just asked. Moving the
  // blast-radius-of-one first is the whole point, and the two must not be
  // migrated together for tidiness.
  //
  // The provider comes from the model name. `ai_services` stores the model
  // string and not which API produced it — see providerFor's own note on why
  // that heuristic is safe here and wrong to rely on generally.
  const result = await callImage({
    model,
    prompt,
    image: bytes,
    mediaType,
    // OpenAI-only; callImage does not forward them to Google, which has no
    // equivalent and rejects unknown generationConfig keys.
    size: "1024x1024",
    quality: "high",
  });

  if (!result.ok) {
    // ⚠ `detail` is the provider's RAW body, which is exactly what every regex
    // below expects. callImage hands it back untouched for this reason — the
    // sentences these branches produce are read by the member off their own
    // profile row, and a tidied-up message would match none of them.
    const detail = String(result.error ?? "");
    const res = { status: result.status };
    console.error(result.provider + " " + result.status + ": " + detail.slice(0, 500));

    // Same triage as parse-profile-document: the model name is the setting
    // most likely to be wrong, and a generic message sends someone hunting in
    // the wrong place. These sentences now land in `avatar_error` and are read
    // by the member off their own profile row, so they still have to be
    // sentences rather than codes.
    // Since 0031 the model can come from the admin panel as well as from the
    // secret, and the two need different remedies — so the message names which
    // one is in play rather than sending somebody to the secrets screen to
    // change a value that is not being read.
    if (/model_not_found|does not exist|unknown model/i.test(detail)) {
      throw new Error(
        model === IMAGE_MODEL
          ? "The configured image model name isn't valid. Set OPENAI_IMAGE_MODEL in the Supabase Edge Function secrets to a model your account can use."
          : `The image model chosen in the admin panel (${model}) isn't valid for this account. Change it under Admin → AI services → Member avatars, or reset that service to its code default.`,
      );
    }
    // ⚠ QUOTA IS MATCHED BEFORE THE 429, the same ordering the five contract
    // functions use. OpenAI reports an exhausted balance as HTTP 429 with
    // `insufficient_quota` in the body. Nothing here matched it, so a spent
    // balance fell through to the "busy right now" sentence below and the
    // member was invited to try again — for ever, against a balance that only
    // an admin adding credit will change.
    if (/insufficient_quota|billing_hard_limit|exceeded your current quota|billing_not_active/i.test(detail)) {
      // `fail` refunds the attempt on every throw out of here, so this is a
      // promise the code actually keeps.
      throw new Error("The club's AI account has run out of credit — an admin needs to top it up. Your try hasn't been used up.");
    }
    if (res.status === 401 || res.status === 403 || /invalid_api_key|incorrect api key/i.test(detail)) {
      throw new Error("The AI service rejected our credentials. Check OPENAI_API_KEY.");
    }
    if (res.status === 429) {
      throw new Error("The image service is busy right now — try again in a moment.");
    }
    // A photo the safety system declines is a normal outcome, not a bug, and
    // the member needs to know a different photo will work.
    if (/moderation|safety|content_policy/i.test(detail)) {
      throw new Error("That photo couldn't be used. Try a clear, front-facing photo of yourself.");
    }
    throw new Error("Couldn't create an avatar just now. Try again shortly.");
  }

  // ⚠ callImage already decoded it, and already treated a 200-with-no-image as
  // a failure — which is the shape a Gemini refusal takes. So the old
  // "no image came back" branch has moved rather than disappeared; reaching
  // here means there are bytes.
  if (!result.bytes || !result.bytes.length) {
    throw new Error("No image came back — try again shortly.");
  }
  return { bytes: result.bytes, mediaType: result.mediaType || "image/png" };
}

// ---- The fallback -----------------------------------------------------

// The tile itself is drawn in _shared/avatar-art.ts, so that this and the
// monthly job produce the same artwork. What stays here is which columns get
// written, which is not the same for the two callers: this path is a member
// who has spent their three tries, so it must not touch the attempt count.
async function storeFallback(
  admin: ReturnType<typeof createClient>,
  userId: string,
  profile: Record<string, unknown>,
  cycle: string,
  theme: string,
): Promise<string> {
  const url = await uploadFallback(admin, userId, String(profile.full_name ?? ""), cycle);
  if (!url) return "";

  // The fallback carries the same purge receipt. Nothing was sent to OpenAI
  // on this path, so there is even less to keep — but a row with a generated
  // avatar and a null timestamp is what the alert looks for, and "we didn't
  // call the model this time" is not a reason to trip it.
  //
  // 'ready' rather than 'idle': this request finished, and a client that has
  // just been handed a URL should not then poll a status that says nothing is
  // happening. The tile is not added to `avatar_gallery` — it is deterministic
  // per member per month and can be redrawn at any time for nothing, so a
  // history entry for it would be a slot spent on something not worth keeping.
  const { error: saveErr } = await admin
    .from("profiles")
    .update({
      avatar_url: url,
      avatar_status: "ready",
      avatar_error: null,
      avatar_is_generated: true,
      avatar_source: "fallback",
      avatar_theme: theme,
      avatar_refreshed_at: new Date().toISOString(),
      source_purged_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  if (saveErr) {
    console.error("fallback save: " + saveErr.message);
    return "";
  }
  return url;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
