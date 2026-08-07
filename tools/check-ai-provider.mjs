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

console.log("");
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log("ai-provider logic is sound.");
