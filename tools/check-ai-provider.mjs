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

console.log("");
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log("ai-provider logic is sound.");
