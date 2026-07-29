// parse-profile-document
// ------------------------------------------------------------
// Takes a CV or a LinkedIn PDF export and fills in the same profile
// fields the manual form collects — nothing more. The member reviews and
// corrects the result before anything is saved, so this function only
// *returns* the extracted fields; it never writes to the profiles table.
//
// LinkedIn's public API doesn't expose work history, so "import from
// LinkedIn" here means the member uses LinkedIn's own "Save to PDF" and
// uploads that — same pipeline as a CV, no separate code path.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — to verify the caller
//   ANTHROPIC_API_KEY
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.68.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? "" });

// Mirrors the `profiles` columns the onboarding form writes, so whichever
// intake route a member picks, the shape that comes out is identical.
const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    full_name: { type: "string", description: "The person's full name, or empty string if not stated." },
    bio: { type: "string", description: "Two or three sentences summarising their background, written in the third person." },
    experience_level: {
      type: "string",
      enum: ["student", "early-career", "mid-career", "senior", ""],
      description: "Career stage. Empty string if the document gives no basis to judge.",
    },
    industry: { type: "string", description: "Primary industry, e.g. Fintech. Empty string if unclear." },
    timezone: { type: "string", description: "IANA timezone inferred from stated location, e.g. Asia/Dubai. Empty string if no location is given." },
    language: { type: "string", description: "Primary working language. Empty string if not stated." },
    skills: { type: "array", items: { type: "string" }, description: "Concrete skills, tools, and technologies." },
    interests: { type: "array", items: { type: "string" }, description: "Topics and areas the person is drawn to." },
    goals: { type: "array", items: { type: "string" }, description: "What they appear to be working toward. Empty array if the document says nothing about this." },
  },
  required: ["full_name", "bio", "experience_level", "industry", "timezone", "language", "skills", "interests", "goals"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You extract structured profile fields from a CV or a LinkedIn profile export for Sahaba Club, an AI and cloud community.

Fill each field only from what the document actually says. Where the document gives you nothing to go on, return an empty string or an empty array — do not infer, estimate, or invent. Goals in particular are often absent from a CV; an empty array is the correct answer there, not a guess about what someone probably wants.

Keep skills and interests as short, individually meaningful tags ("Power Apps", "Copilot Studio") rather than sentences, since they are used for filtering and matching.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData.user) {
      return json({ error: "Not signed in" }, 401);
    }

    const { fileBase64, mediaType } = await req.json();
    if (!fileBase64) {
      return json({ error: "fileBase64 is required" }, 400);
    }

    // The API reads PDFs and plain text directly. Word documents have to be
    // saved as PDF first — the onboarding page says so before upload rather
    // than letting someone pick a .docx and hit this error.
    const documentSource = mediaType === "text/plain"
      ? { type: "text" as const, media_type: "text/plain" as const, data: atob(fileBase64) }
      : { type: "base64" as const, media_type: "application/pdf" as const, data: fileBase64 };

    const response = await anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      output_config: {
        // A form-filling task — low effort is the right trade here, and it
        // keeps thinking tokens well inside max_tokens.
        effort: "low",
        format: { type: "json_schema", schema: PROFILE_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: documentSource },
            { type: "text", text: "Extract this person's profile fields." },
          ],
        },
      ],
    });

    // Safety classifiers can decline a request; when they do, `content` is
    // empty and reading content[0] would throw.
    if (response.stop_reason === "refusal") {
      return json({ error: "Couldn't read that document. Try filling the form in directly." }, 422);
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return json({ error: "No profile fields came back — try filling the form in directly." }, 502);
    }

    // The member sees these in a review step and can correct anything before
    // it's saved, so the model is never the last word on their own profile.
    return json({ ok: true, profile: JSON.parse(textBlock.text) });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
