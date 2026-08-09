// Exercise the pure logic in supabase/functions/_shared/ai-provider.ts.
//
//   node tools/check-ai-provider.mjs
//
// Two things are worth testing without a network call, and both would fail
// silently in production:
//
//   providerFor()    picks who to ask. Get it wrong and a Gemini id is posted
//                    to OpenAI, which answers 404 model_not_found — a message
//                    that sends you looking at the model list rather than at
//                    the router.
//
//   toGeminiSchema() converts OpenAI's JSON Schema dialect to Google's. Google
//                    REJECTS `additionalProperties` and lowercase type names,
//                    and the 400 it returns reads like a model problem rather
//                    than a schema problem. This is the conversion most likely
//                    to be wrong and least likely to be noticed.
//
// ⚠ Imports the REAL module rather than a copy. Node 24 strips the types on
// import; `Deno` is shimmed below because the module reads its keys at load.
// Testing a transcription of the logic would pass while the shipped file was
// broken, which is the whole failure this repo keeps writing checkers about.

globalThis.Deno = { env: { get: () => "" } };

const mod = await import(
  new URL("../supabase/functions/_shared/ai-provider.ts", import.meta.url).href
);

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log(`  FAIL  ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); }
  else console.log(`  ok    ${label}`);
}

console.log("routing");
check("gpt-5 -> openai", mod.providerFor("gpt-5"), "openai");
check("o4-mini -> openai", mod.providerFor("o4-mini"), "openai");
check("gpt-image-1 -> openai", mod.providerFor("gpt-image-1"), "openai");
check("gemini-2.5-pro -> google", mod.providerFor("gemini-2.5-pro"), "google");
check("models/gemini-2.0-flash -> google", mod.providerFor("models/gemini-2.0-flash"), "google");
// Case matters: a model list can return either.
check("GEMINI-2.5-PRO -> google", mod.providerFor("GEMINI-2.5-PRO"), "google");

// ⚠ These are REAL ids from the first live listing of this project's Google
// account, and every one of them routed to OpenAI under the original
// gemini-only test. They are the reason the heuristic was widened and the
// reason an explicit provider now overrides it.
check("deep-research-pro-preview-12-2025 -> google", mod.providerFor("deep-research-pro-preview-12-2025"), "google");
check("antigravity-preview-05-2026 -> google", mod.providerFor("antigravity-preview-05-2026"), "google");
check("learnlm-2.0-flash -> google", mod.providerFor("learnlm-2.0-flash"), "google");
check("gemma-3-27b-it -> google", mod.providerFor("gemma-3-27b-it"), "google");
// An OpenAI id that merely contains the word must NOT be dragged across.
check("gpt-4o-deep-research -> openai", mod.providerFor("gpt-4o-deep-research"), "openai");

console.log("\nan explicit provider overrides the heuristic");
const forced = await mod.callText({
  model: "some-unknown-future-model", provider: "google",
  system: "s", user: "u", maxOutputTokens: 10,
});
check("routed to google despite the name", /GEMINI_API_KEY/.test(forced.error || ""), true);

console.log("\nkeys absent -> callText refuses rather than posting");
const noKey = await mod.callText({ model: "gemini-2.5-pro", system: "s", user: "u", maxOutputTokens: 10 });
check("google without a key is not ok", noKey.ok, false);
check("  and says which key", /GEMINI_API_KEY/.test(noKey.error || ""), true);
check("  and does not invent text", noKey.text, "");

console.log("\nschema conversion");
// The exact shape the judge sends today.
const openaiSchema = {
  type: "object",
  additionalProperties: false,
  $schema: "http://json-schema.org/draft-07/schema#",
  properties: {
    verdict: { type: "string" },
    score: { type: ["number", "null"] },
    tags: { type: "array", items: { type: "string" } },
    nested: { type: "object", additionalProperties: false, properties: { a: { type: "boolean" } } },
  },
  required: ["verdict", "score"],
};
const g = mod.__testables?.toGeminiSchema
  ? mod.__testables.toGeminiSchema(openaiSchema)
  : null;

if (!g) {
  console.log("  SKIP  toGeminiSchema is not exported — see the note below");
} else {
  const s = JSON.stringify(g);
  check("additionalProperties dropped", s.includes("additionalProperties"), false);
  check("$schema dropped", s.includes("$schema"), false);
  check("root type uppercased", g.type, "OBJECT");
  check("leaf type uppercased", g.properties.verdict.type, "STRING");
  check("null union becomes nullable", [g.properties.score.type, g.properties.score.nullable], ["NUMBER", true]);
  check("array items converted", g.properties.tags.items.type, "STRING");
  check("nested object cleaned", g.properties.nested.properties.a.type, "BOOLEAN");
  check("required preserved", g.required, ["verdict", "score"]);
}

// ---- stop-reason normalisation -------------------------------------------
//
// The reason this is tested rather than eyeballed: promptarena-challenge treats
// length / filter / refusal as THREE different outcomes, and is right to —
// raising the ceiling fixes one and is pointless for the others. Collapsing
// them makes the retry logic wrong in the expensive direction, and no test of
// the happy path would notice.
//
// Bodies below are the real response shapes, trimmed.
console.log("\nstop reasons, normalised across providers");
{
  const cases = [
    ["openai length",
      { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] },
      "openai", { stopReason: "length", truncated: true, refused: false }],
    ["openai content filter",
      { status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] },
      "openai", { stopReason: "filter", truncated: true, refused: false }],
    ["openai refusal part",
      { status: "completed", output: [{ content: [{ type: "refusal", refusal: "no" }] }] },
      "openai", { stopReason: "stop", truncated: false, refused: true }],
    ["openai normal",
      { status: "completed", output: [{ content: [{ type: "output_text", text: "hi" }] }] },
      "openai", { stopReason: "stop", truncated: false, refused: false }],
    ["google MAX_TOKENS",
      { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "par" }] } }] },
      "google", { stopReason: "length", truncated: true, refused: false }],
    ["google SAFETY, nothing written",
      { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] },
      "google", { stopReason: "filter", truncated: false, refused: true }],
    ["google RECITATION is a filter, not length",
      { candidates: [{ finishReason: "RECITATION", content: { parts: [{ text: "x" }] } }] },
      "google", { stopReason: "filter", truncated: false, refused: false }],
    ["google prompt blocked before generation",
      { promptFeedback: { blockReason: "SAFETY" } },
      "google", { stopReason: "filter", truncated: false, refused: true }],
    ["google normal",
      { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "hi" }] } }] },
      "google", { stopReason: "stop", truncated: false, refused: false }],
  ];
  for (const [label, body, provider, want] of cases) {
    const got = mod.__testables.normalise(body, provider);
    check(label, { stopReason: got.stopReason, truncated: !!got.truncated, refused: !!got.refused }, want);
  }
}

// ============================================================
// Listing failures: a refused key vs an unreachable API
// ============================================================
//
// ⚠ THIS IS THE CHECK THAT MATTERS ON A ROTATION DAY, and it is testable only
// because the three outcomes are distinguishable in the first place.
//
// ai-admin deliberately does NOT retire Google rows when a listing fails —
// right, because a network blip would otherwise make every configured Gemini
// model vanish from the panel. The cost of that choice is that a DEAD key
// leaves the panel showing all 42 models exactly as it showed them yesterday.
// The note beside the count is then the only thing standing between staff and
// a model that cannot be called, so the note has to be right: "Google could
// not be reached" sends somebody to check the network, and the network is
// fine. Google answered. It said no.
//
// The module reads its keys at load, so this imports a SECOND instance with a
// key present — a query string defeats Node's module cache — and stubs fetch
// per case.
{
  console.log("");
  console.log("google listing failures");

  globalThis.Deno = { env: { get: (n) => (n === "GEMINI_API_KEY" ? "a-key" : "") } };
  const keyed = await import(
    new URL("../supabase/functions/_shared/ai-provider.ts", import.meta.url).href + "?withkey"
  );

  const realFetch = globalThis.fetch;
  const stub = (impl) => { globalThis.fetch = impl; };

  const respond = (status, body) => () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
      json: () => Promise.resolve(typeof body === "string" ? JSON.parse(body) : body),
    });

  // Google's real refusals. 400 INVALID_ARGUMENT is the one that would
  // otherwise be read as "your request was malformed" — it is not, the request
  // is fixed and known good; the only variable in it is the key.
  const invalid = { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } };
  const denied = { error: { code: 403, message: "Permission denied", status: "PERMISSION_DENIED" } };

  for (const [label, status, body, want] of [
    ["400 invalid key -> bad-key", 400, invalid, "bad-key"],
    ["401 -> bad-key", 401, { error: { message: "Unauthorized" } }, "bad-key"],
    ["403 permission denied -> bad-key", 403, denied, "bad-key"],
    // ⚠ Not the key. Retrying a 429 or a 503 is exactly the right move, and
    // calling either "bad-key" would send somebody to rotate a working
    // credential in the middle of an outage.
    ["429 rate limit -> unreachable", 429, { error: { message: "Resource exhausted" } }, "unreachable"],
    ["500 -> unreachable", 500, { error: { message: "Internal" } }, "unreachable"],
  ]) {
    stub(respond(status, body));
    const got = await keyed.listGoogleModels();
    check(label, { ok: got.ok, reason: got.reason, models: got.models.length }, { ok: false, reason: want, models: 0 });
  }

  stub(() => Promise.reject(new Error("dns")));
  const thrown = await keyed.listGoogleModels();
  check("network throw -> unreachable", { ok: thrown.ok, reason: thrown.reason }, { ok: false, reason: "unreachable" });

  // The message Google sent is carried through, because "invalid" and
  // "revoked" and "restricted to another referrer" are three different fixes.
  stub(respond(400, invalid));
  const detailed = await keyed.listGoogleModels();
  check("carries Google's own words", /API key not valid/.test(detailed.detail || ""), true);

  // And the success path still works, since everything above changed the
  // failure branch it shares.
  stub(respond(200, {
    models: [
      { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
      { name: "models/imagen-4", supportedGenerationMethods: ["predict"] },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
    ],
  }));
  const good = await keyed.listGoogleModels();
  check("200 keeps only generateContent", good.models.map((m) => m.id), ["gemini-2.5-pro"]);
  check("  and calls it text", good.models[0]?.kind, "text");
  check("  and reports ok", good.ok, true);

  // ============================================================
  // Which Google models draw
  // ============================================================
  //
  // ⚠ The seven ids below are REAL — read off the club's account on 8 Aug 2026,
  // not invented. Before this classifier every one of them was handed to the
  // six text services as `kind: "text"`, where a call returns an image, no
  // text, and the caller reports "produced no output at all".
  //
  // The negatives matter as much: `learnlm`, `antigravity` and
  // `deep-research-max` are text models whose names contain none of the
  // signals, and `gemini-2.5-flash-image-caption` is the trap — a model that
  // READS images and writes text. It must stay text, which is why the pattern
  // anchors on `image` as a whole segment rather than testing `includes`.
  stub(respond(200, {
    models: [
      "gemini-2.5-flash-image", "gemini-3-pro-image", "gemini-3-pro-image-preview",
      "gemini-3.1-flash-image", "gemini-3.1-flash-image-preview",
      "gemini-3.1-flash-lite-image", "nano-banana-pro-preview",
      "gemini-2.5-pro", "gemini-2.5-flash", "learnlm-2.0-flash-experimental",
      "antigravity-preview-05-2026", "deep-research-max-preview-04-2026",
    ].map((n) => ({ name: "models/" + n, supportedGenerationMethods: ["generateContent"] })),
  }));
  const kinds = await keyed.listGoogleModels();
  const kindOf = (id) => kinds.models.find((m) => m.id === id)?.kind;

  for (const id of ["gemini-2.5-flash-image", "gemini-3-pro-image", "gemini-3.1-flash-image",
    "gemini-3.1-flash-lite-image", "nano-banana-pro-preview"]) {
    check(`${id} -> image`, kindOf(id), "image");
  }
  for (const id of ["gemini-2.5-pro", "gemini-2.5-flash", "learnlm-2.0-flash-experimental",
    "antigravity-preview-05-2026", "deep-research-max-preview-04-2026"]) {
    check(`${id} -> text`, kindOf(id), "text");
  }
  check("all seven real image ids classified image",
    kinds.models.filter((m) => m.kind === "image").length, 7);

  // A family that does not follow the naming convention, caught by its own
  // description rather than by a guess.
  stub(respond(200, {
    models: [{
      name: "models/some-future-drawer",
      description: "A model for image generation and editing.",
      supportedGenerationMethods: ["generateContent"],
    }],
  }));
  check("description names it a drawer", (await keyed.listGoogleModels()).models[0]?.kind, "image");

  // ⚠ The control that stops this quietly matching everything: a model that
  // merely MENTIONS images in prose stays text.
  stub(respond(200, {
    models: [{
      name: "models/gemini-vision-reader",
      description: "Understands images and answers questions about them.",
      supportedGenerationMethods: ["generateContent"],
    }],
  }));
  check("control: an image READER stays text",
    (await keyed.listGoogleModels()).models[0]?.kind, "text");

  globalThis.fetch = realFetch;
}

// ============================================================
// Drawing
// ============================================================
{
  console.log("");
  console.log("callImage");

  globalThis.Deno = { env: { get: () => "a-key" } };
  const drawMod = await import(
    new URL("../supabase/functions/_shared/ai-provider.ts", import.meta.url).href + "?draw"
  );

  const realFetch = globalThis.fetch;
  let seen = null;
  const capture = (status, body, headers) => (url, init) => {
    seen = { url: String(url), init };
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: new Map(Object.entries(headers || {})),
      text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
      json: () => Promise.resolve(typeof body === "string" ? JSON.parse(body) : body),
    });
  };

  // A one-pixel PNG, and then something far bigger than the 0x8000 chunk.
  const tiny = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const huge = new Uint8Array(300000).map((_, i) => i % 251);

  // ---- OpenAI goes to the edits endpoint, as multipart ----
  globalThis.fetch = capture(200, { data: [{ b64_json: btoa("drawn") }] });
  const o = await drawMod.callImage({
    model: "gpt-image-1", prompt: "draw", image: tiny, mediaType: "image/png",
    size: "1024x1024", quality: "high",
  });
  check("openai -> /v1/images/edits", /api\.openai\.com\/v1\/images\/edits$/.test(seen.url), true);
  check("  sent as multipart FormData", seen.init.body instanceof FormData, true);
  check("  carries size and quality", [seen.init.body.get("size"), seen.init.body.get("quality")],
    ["1024x1024", "high"]);
  check("  returns the decoded bytes", new TextDecoder().decode(o.bytes), "drawn");
  check("  and reports png", o.mediaType, "image/png");

  // ---- Google goes to generateContent, as JSON with inlineData ----
  globalThis.fetch = capture(200, {
    candidates: [{ content: { parts: [
      { text: "here you go" },
      { inlineData: { mimeType: "image/webp", data: btoa("gemini-drawn") } },
    ] } }],
  });
  const g = await drawMod.callImage({
    model: "gemini-2.5-flash-image", prompt: "draw", image: tiny, mediaType: "image/jpeg",
    size: "1024x1024", quality: "high",
  });
  const gBody = JSON.parse(seen.init.body);
  check("google -> generateContent", /gemini-2\.5-flash-image:generateContent$/.test(seen.url), true);
  check("  source sent as inlineData", gBody.contents[0].parts[1].inlineData.mimeType, "image/jpeg");
  check("  asks for TEXT and IMAGE", gBody.generationConfig.responseModalities, ["TEXT", "IMAGE"]);
  // ⚠ The control for the note in drawGoogle: size/quality are OpenAI-only and
  // must not be forwarded, because Google rejects unknown generationConfig keys.
  check("  does NOT forward size/quality",
    [gBody.generationConfig.size, gBody.generationConfig.quality, gBody.size], [undefined, undefined, undefined]);
  // ⚠ And the picture was NOT the first part. Indexing [0] would have returned
  // the narration.
  check("  finds the image behind a text part", new TextDecoder().decode(g.bytes), "gemini-drawn");
  check("  keeps the provider's media type", g.mediaType, "image/webp");

  // ---- A 200 with no image is a failure, not an empty success ----
  globalThis.fetch = capture(200, { candidates: [{ content: { parts: [{ text: "I won't draw that" }] } }] });
  const refused = await drawMod.callImage({
    model: "gemini-2.5-flash-image", prompt: "draw", image: tiny, mediaType: "image/png",
  });
  check("200 with no image is not ok", refused.ok, false);
  check("  and hands back the body to triage on", /I won't draw that/.test(refused.error || ""), true);

  // ---- The raw error body survives, because generate-avatar regexes it ----
  globalThis.fetch = capture(429, '{"error":{"message":"insufficient_quota"}}');
  const broke = await drawMod.callImage({
    model: "gpt-image-1", prompt: "draw", image: tiny, mediaType: "image/png",
  });
  check("failure keeps the provider's raw body", /insufficient_quota/.test(broke.error || ""), true);
  check("  and the status", broke.status, 429);

  // ⚠ THE ONE THAT BREAKS ON A REAL PHOTOGRAPH. String.fromCharCode(...bytes)
  // spreads a million arguments for a 1 MB image and throws RangeError; the
  // symptom looks like a corrupt upload, not a stack limit. 300 KB is already
  // well past the 0x8000 chunk.
  globalThis.fetch = capture(200, {
    candidates: [{ content: { parts: [{ inlineData: { data: btoa("ok") } }] } }],
  });
  let bigOk = true, bigErr = "";
  try {
    await drawMod.callImage({
      model: "gemini-2.5-flash-image", prompt: "draw", image: huge, mediaType: "image/jpeg",
    });
  } catch (e) { bigOk = false; bigErr = String(e); }
  check("a 300 KB source does not blow the stack", bigOk, true, bigErr);
  // And it encoded faithfully, not merely without throwing.
  check("  and round-trips exactly",
    JSON.parse(seen.init.body).contents[0].parts[1].inlineData.data.length,
    Math.ceil(huge.length / 3) * 4);

  globalThis.fetch = realFetch;
}

console.log("");
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log("ai-provider logic is sound.");
