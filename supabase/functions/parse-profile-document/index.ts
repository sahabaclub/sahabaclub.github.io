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
// Uses OpenAI's Responses API over plain fetch rather than the SDK: one HTTP
// call, no npm/esm.sh version to drift out from under the deployment.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   OPENAI_API_KEY
//   OPENAI_MODEL                             — optional, see below
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

// Deliberately an environment variable with a default, not a constant. Model
// names change faster than this function will, and a wrong one should be a
// dashboard edit rather than a redeploy — the error handler below says so
// explicitly when OpenAI rejects the name.
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-5";

// Mirrors the `profiles` columns the onboarding form writes, so whichever
// intake route a member picks, the shape that comes out is identical.
//
// Every property is listed in `required` and additionalProperties is false,
// because OpenAI's strict mode demands both. Fields that may genuinely have
// no answer return "" or [] rather than being omitted.
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

    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is not set");
      return json({ error: "Document import isn't configured yet. Please fill the form in directly." }, 503);
    }

    const { fileBase64, mediaType } = await req.json();
    if (!fileBase64) {
      return json({ error: "fileBase64 is required" }, 400);
    }

    // PDFs go in as a file part; plain text is decoded and sent as text.
    // Word documents have to be saved as PDF first — the onboarding page says
    // so before upload rather than letting someone pick a .docx and hit this.
    const documentPart = mediaType === "text/plain"
      ? { type: "input_text", text: atob(fileBase64) }
      : {
          type: "input_file",
          filename: "profile.pdf",
          file_data: "data:application/pdf;base64," + fileBase64,
        };

    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        instructions: SYSTEM_PROMPT,
        max_output_tokens: 4000,
        input: [
          {
            role: "user",
            content: [
              documentPart,
              { type: "input_text", text: "Extract this person's profile fields." },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "profile",
            strict: true,
            schema: PROFILE_SCHEMA,
          },
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("OpenAI " + res.status + ": " + detail);

      // The model name is the one setting most likely to be wrong, and the
      // generic message would send someone hunting in the wrong place.
      if (/model_not_found|does not exist|unknown model/i.test(detail)) {
        return json({
          error: "The configured AI model name isn't valid. Set OPENAI_MODEL in the Supabase Edge Function secrets to a model your account can use.",
        }, 502);
      }
      if (res.status === 401) {
        return json({ error: "The AI service rejected our credentials. Check OPENAI_API_KEY." }, 502);
      }
      return json({ error: "Couldn't read that document just now. Try again, or fill the form in directly." }, 502);
    }

    const data = await res.json();

    const message = (data.output ?? []).find((o: { type?: string }) => o.type === "message");
    const parts = message?.content ?? [];

    // A refusal comes back as its own content type with no JSON in it, so
    // reaching for output_text first would read undefined.
    if (parts.some((p: { type?: string }) => p.type === "refusal")) {
      return json({ error: "Couldn't read that document. Try filling the form in directly." }, 422);
    }

    // Truncation gives back valid-looking but incomplete text; better to say
    // so than to hand back half a profile.
    if (data.status === "incomplete") {
      console.error("incomplete: " + JSON.stringify(data.incomplete_details));
      return json({ error: "That document was too long to read in one go. Try a shorter CV, or fill the form in directly." }, 422);
    }

    const textPart = parts.find((p: { type?: string }) => p.type === "output_text");
    if (!textPart?.text) {
      return json({ error: "No profile fields came back — try filling the form in directly." }, 502);
    }

    // The member sees these in a review step and can correct anything before
    // it's saved, so the model is never the last word on their own profile.
    return json({ ok: true, profile: JSON.parse(textPart.text) });
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
