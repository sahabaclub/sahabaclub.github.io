// One way to ask a model for text, whoever makes the model.
// ------------------------------------------------------------
// Ahmed: "I want to add Gemini models to the system, to be able to change the
// model easy."
//
// "Easy" is the requirement, and it is not satisfied by adding Gemini to a
// dropdown. Sixteen call sites across seven functions POST OpenAI's Responses
// shape directly. Selecting a Gemini model without this file would let staff
// SAVE the choice and then fail at call time — a panel that looks right and a
// feature that is broken, which is worse than not offering it.
//
// So the switch has to happen below the call sites: they say what they want,
// this decides who to ask.
//
// ============================================================
// The two shapes, and why a URL swap is not enough
// ============================================================
//
// OpenAI  POST /v1/responses
//   { model, instructions, max_output_tokens,
//     input: [{ role, content: [{ type: "input_text", text }] }],
//     text: { format: { type: "json_schema", name, strict, schema } } }
//   → output[].content[].text
//
// Google  POST /v1beta/models/<model>:generateContent
//   { systemInstruction: { parts: [{ text }] },
//     contents: [{ role: "user", parts: [{ text }] }],
//     generationConfig: { maxOutputTokens, responseMimeType, responseSchema } }
//   → candidates[0].content.parts[].text
//
// Same three ideas — a system prompt, a user turn, a schema the reply must
// match — expressed differently enough that every caller would otherwise carry
// both. The translation lives here once.
//
// ⚠ Google rejects the JSON Schema keywords OpenAI requires. `additionalProperties`
// and `$schema` are not understood, and `required` behaves differently. The
// schema is therefore CONVERTED rather than passed through — see toGeminiSchema.
// Sending an OpenAI schema unchanged produces a 400 that reads like a model
// error rather than a schema error, which is a bad hour.

const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
// Accepts either name: GEMINI_API_KEY is what Google's own docs use,
// GOOGLE_AI_API_KEY is what some tooling sets. Checking both avoids a silent
// "not configured" caused purely by which guide somebody followed.
const GOOGLE_KEY =
  Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GOOGLE_AI_API_KEY") ?? "";

export type Provider = "openai" | "google";

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

export function providerFor(model: string): Provider {
  return GOOGLE_FAMILIES.test(model) ? "google" : "openai";
}

export function keyFor(provider: Provider): string {
  return provider === "google" ? GOOGLE_KEY : OPENAI_KEY;
}

export function providerConfigured(provider: Provider): boolean {
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
export function normalise(
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
export const __testables = { toGeminiSchema, normalise };

export interface TextRequest {
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

export interface TextResult {
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

export async function callText(req: TextRequest): Promise<TextResult> {
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
export interface ImageRequest {
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

export interface ImageResult {
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

export async function callImage(req: ImageRequest): Promise<ImageResult> {
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

export interface GoogleModelList {
  ok: boolean;
  reason?: "no-key" | "bad-key" | "unreachable";
  models: Array<{ id: string; kind: "text" | "image" | "other"; owned_by: string; description?: string }>;
  // Google's own words when it refused. Carried because "invalid", "revoked"
  // and "restricted to another referrer" are three different fixes and only
  // the message says which.
  detail?: string;
}

export async function listGoogleModels(): Promise<GoogleModelList> {
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
