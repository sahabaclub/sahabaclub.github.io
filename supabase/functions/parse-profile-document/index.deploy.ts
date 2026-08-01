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
// What comes out has to be good enough to match on — people to coaches, to
// events, to courses — so the extraction covers the matching fields (headline,
// company, position, years_experience, city, country, open_to) and not just
// the biographical ones. Country and tags are pinned to the controlled
// vocabularies in public.countries and public.tag_suggestions: free text is
// what produced "UAE" and "United Arab Emirates" as two separate countries and
// made filtering by either of them useless.
//
// Uses OpenAI's Responses API over plain fetch rather than the SDK: one HTTP
// call, no npm/esm.sh version to drift out from under the deployment.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   OPENAI_API_KEY
//   OPENAI_MODEL                             — optional, see below
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inlined rather than imported from ../_shared/cors.ts: the dashboard editor
// deploys one function directory at a time, so a shared parent file is not
// reachable there. Keep in sync with supabase/functions/_shared/cors.ts.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

// Deliberately an environment variable with a default, not a constant. Model
// names change faster than this function will, and a wrong one should be a
// dashboard edit rather than a redeploy — the error handler below says so
// explicitly when OpenAI rejects the name.
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-5";

// tag_suggestions is seeded from every member's existing skills and interests,
// so it grows with the club and has no natural ceiling. The prompt only needs
// enough of it to anchor spelling, and the most-used tags are the ones a new
// CV is most likely to collide with.
const MAX_TAGS_IN_PROMPT = 300;

// Kept in step with the open_to enum below; used to sanity-check what comes
// back before it reaches the review step.
const OPEN_TO_VALUES = ["mentoring", "collaborating", "hiring", "speaking"];

// Matches the 0..60 check constraint on profiles.years_experience. Clamping
// here means a nonsense number is visible in the review step rather than
// surfacing much later as a failed save.
const MAX_YEARS_EXPERIENCE = 60;

type Admin = ReturnType<typeof createClient>;

// Mirrors the `profiles` columns the onboarding form writes, so whichever
// intake route a member picks, the shape that comes out is identical.
//
// Every property is listed in `required` and additionalProperties is false,
// because OpenAI's strict mode demands both. Fields that may genuinely have
// no answer return "", 0 or [] rather than being omitted.
const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    full_name: { type: "string", description: "The person's full name, or empty string if not stated." },
    headline: { type: "string", description: "One short professional line of the kind that sits under a name, about six to ten words, e.g. \"Cloud engineer building AI agents\". Write what they do and what they are working on now — not a sentence lifted from the bio, and not a bare job title. Empty string if the document gives you nothing to build one from." },
    bio: { type: "string", description: "Two or three sentences summarising their background, written in the third person." },
    experience_level: {
      type: "string",
      enum: ["student", "early-career", "mid-career", "senior", ""],
      description: "Career stage. Empty string if the document gives no basis to judge.",
    },
    industry: { type: "string", description: "Primary industry, e.g. Fintech. Empty string if unclear." },
    company: { type: "string", description: "The organisation they work for right now. Empty string if the document names no current employer — do not fall back to a past one." },
    position: { type: "string", description: "Their current job title, e.g. Solutions Architect. Empty string if the document states no current role." },
    years_experience: { type: "integer", description: "Total years of professional experience, worked out from the dated roles in the document: the span from the start of the earliest professional job to the latest date given. Leave out study and internships. Return 0 when there are no dates to count from — never put a number on how senior someone sounds." },
    city: { type: "string", description: "The city they are currently based in, as the document writes it. Empty string if no location is given." },
    country: { type: "string", description: "The country they are currently based in. It must be one of the country names listed in the instructions, copied exactly. If their country is not on that list, or the document does not say where they are, return an empty string." },
    timezone: { type: "string", description: "IANA timezone inferred from stated location, e.g. Asia/Dubai. Empty string if no location is given." },
    // "Primary working language" made the model return "" whenever a CV
    // listed more than one — which is most of them here, and Arabic/English
    // is exactly the pair that matters for coach matching. Asking for one of
    // the listed languages rather than an adjudication fixes it.
    language: { type: "string", description: "The person's main working language. If the document lists several, give the one they most likely work in, or else the first listed. Empty string only if no language is named anywhere." },
    skills: { type: "array", items: { type: "string" }, description: "Concrete skills, tools, and technologies." },
    interests: { type: "array", items: { type: "string" }, description: "Topics and areas the person is drawn to." },
    goals: { type: "array", items: { type: "string" }, description: "What they appear to be working toward. Empty array if the document says nothing about this." },
    open_to: {
      type: "array",
      items: { type: "string", enum: OPEN_TO_VALUES },
      description: "Only the things the document actually signals this person is open to. \"Mentored junior developers\" earns mentoring; \"open to collaboration\" earns collaborating; recruiting or team-building responsibilities earn hiring; offering to speak or a record of talks earns speaking. A senior title on its own earns none of them. An empty array is the ordinary answer.",
    },
  },
  required: [
    "full_name", "headline", "bio", "experience_level", "industry",
    "company", "position", "years_experience", "city", "country",
    "timezone", "language", "skills", "interests", "goals", "open_to",
  ],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You extract structured profile fields from a CV or a LinkedIn profile export for Sahaba Club, an AI and cloud community.

Fill each field only from what the document actually says. Where the document gives you nothing to go on, return an empty string, a zero or an empty array — do not infer, estimate, or invent. Goals in particular are often absent from a CV; an empty array is the correct answer there, not a guess about what someone probably wants. Never guess where someone lives from a phone number's country code, the country of a university they attended, or the language a document is written in.

Working things out from what is written is not inventing: years of experience should be counted from dated roles, and a headline should be composed from their actual work. Putting in something the document does not support is.

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

    const { countries, tags } = await loadVocabularies(admin);

    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        instructions: buildInstructions(countries, tags),
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

    const profile = reconcile(JSON.parse(textPart.text), countries, tags);

    // The member sees these in a review step and can correct anything before
    // it's saved, so the model is never the last word on their own profile.
    return json({ ok: true, profile });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

// Reads the two controlled vocabularies. Either may be absent — the migration
// that creates them is applied separately from this deployment — and that is
// not an error here: with no list to constrain against, the function extracts
// free text exactly as it did before, rather than refusing to read a CV
// because a lookup table is missing.
async function loadVocabularies(admin: Admin): Promise<{ countries: string[]; tags: string[] }> {
  const [countryRes, tagRes] = await Promise.all([
    admin.from("countries").select("name").order("sort_order", { ascending: true }),
    admin.from("tag_suggestions").select("tag").order("uses", { ascending: false }).limit(MAX_TAGS_IN_PROMPT),
  ]);

  if (countryRes.error) console.error("countries unavailable: " + countryRes.error.message);
  if (tagRes.error) console.error("tag_suggestions unavailable: " + tagRes.error.message);

  return {
    countries: textColumn(countryRes.data, "name"),
    tags: textColumn(tagRes.data, "tag"),
  };
}

function textColumn(rows: unknown, key: string): string[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => String((row as Record<string, unknown>)?.[key] ?? "").trim())
    .filter((value) => value !== "");
}

// The vocabularies go into the prompt rather than into the JSON schema as
// enums. An enum would make the model pick *some* listed country for a person
// based in Brazil; a list plus a rule lets it answer "not on the list", which
// is the honest answer and the one the review step can fix.
function buildInstructions(countries: string[], tags: string[]): string {
  let instructions = SYSTEM_PROMPT;

  if (countries.length) {
    instructions += `

COUNTRIES. The value you return for "country" must be one of these names, copied exactly, character for character:
${countries.join("\n")}

If the person is based in a country that is not on that list, or the document does not say where they are, return an empty string for country. Do not return an abbreviation, an alternative spelling, a city, a region, or a neighbouring country that happens to be listed.`;
  }

  if (tags.length) {
    instructions += `

TAGS. Skills and interests are filtered and matched on, so everyone has to spell them the same way. These tags are already in use:
${tags.join(", ")}

Whenever something in the document matches one of those tags, return that tag with exactly the spelling and capitalisation shown. Invent a new tag only when nothing in the list covers it, and then keep it in the same short style.`;
  }

  return instructions;
}

// Everything above is a request to the model; this is what happens when it
// answers differently anyway. Nothing here fills a field in — it only refuses
// values the rest of the system cannot use.
function reconcile(raw: unknown, countries: string[], tags: string[]): Record<string, unknown> {
  const profile = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  // A variant spelling is worse than a blank. A blank is visibly missing and
  // the member corrects it in the review step; "UAE" quietly becomes a second
  // country that nobody filtering for the United Arab Emirates ever sees.
  if (countries.length) {
    profile.country = canonical(profile.country, countries) ?? "";
  }

  // Tags are a softer rule — a genuinely new skill is allowed through — so an
  // unmatched tag is kept as written, and a match is snapped to the club's
  // spelling of it.
  if (tags.length) {
    profile.skills = canonicalTags(profile.skills, tags);
    profile.interests = canonicalTags(profile.interests, tags);
  }

  const years = Number(profile.years_experience);
  profile.years_experience = Number.isFinite(years)
    ? Math.min(MAX_YEARS_EXPERIENCE, Math.max(0, Math.round(years)))
    : 0;

  profile.open_to = Array.isArray(profile.open_to)
    ? [...new Set(profile.open_to.map((v) => String(v ?? "").toLowerCase().trim()))]
        .filter((v) => OPEN_TO_VALUES.includes(v))
    : [];

  return profile;
}

// Case- and punctuation-insensitive, the same normalisation 0019 used to fold
// the country variants already in the table.
function normalise(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function canonical(value: unknown, vocabulary: string[]): string | undefined {
  const key = normalise(value);
  if (!key) return undefined;
  return vocabulary.find((entry) => normalise(entry) === key);
}

function canonicalTags(value: unknown, vocabulary: string[]): string[] {
  if (!Array.isArray(value)) return [];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    const text = String(item ?? "").trim();
    const key = normalise(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(canonical(text, vocabulary) ?? text);
  }

  return out;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
