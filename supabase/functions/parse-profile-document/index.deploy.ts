// GENERATED - do not edit. Deploy-time twin of index.ts with the ../_shared/cors.ts
// import replaced by the corsHeaders object inline, and nothing else. The Supabase
// dashboard editor deploys one function directory at a time and cannot reach a
// shared parent file. Edit index.ts and regenerate; the two must stay in step.

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
// Work history (profiles.work_history, added in 0023) is the other half of
// that. `company` and `position` hold one job; a CV is mostly the twelve years
// before it, and all of it used to be read and then thrown away. 0023 stores it
// as jsonb and deliberately puts no CHECK on the structure — "a CHECK on jsonb
// structure would reject a perfectly good import over a field order nobody
// sees" — which makes this function the only place the shape is enforced. See
// normaliseWorkHistory below: dates coerced to YYYY-MM, is_current reconciled
// against the end date, lengths capped, order imposed here rather than trusted.
//
// Uses OpenAI's Responses API over plain fetch rather than the SDK: one HTTP
// call, no npm/esm.sh version to drift out from under the deployment.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   OPENAI_API_KEY
//   OPENAI_MODEL                             — optional, see below
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// ---- inlined from ../_shared/cors.ts ----
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

// Caps on profiles.work_history. 0023 stores it as jsonb with no CHECK, and
// the member's own row is what gets written, so an adversarial CV — or just a
// twenty-page academic one — must not be able to push an unbounded blob into
// it. Twenty roles covers a forty-year career with room to spare; anything
// past that is padding or an attack. Worst case is roughly 20 KB of JSON.
const MAX_WORK_HISTORY = 20;
const MAX_WORK_TEXT = 200;      // company, position
const MAX_WORK_SUMMARY = 600;   // one or two sentences, generously

// A role dated 1743 or 2087 is a misread, not a job. Anything outside this
// becomes null, the same as an unparseable date.
const MIN_WORK_YEAR = 1900;

// Both spellings appear on CVs and both have to resolve to the same month.
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

// "Present", "Current", "Ongoing" and friends are not dates — they are the
// document saying the role has no end. They become null, and it is is_current
// that carries the meaning.
const OPEN_ENDED =
  /^(present|current|currently|now|ongoing|to\s*date|till\s*date|until\s*now|to\s*present)$/i;

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
    // The one field the schema was missing, and the one a CV is mostly made
    // of. `end` is a string rather than a nullable type because strict mode
    // is easier to satisfy with the same "" convention every other optional
    // field here uses; normaliseWorkHistory turns "" into the null 0023
    // documents. Nothing below is trusted — the model is asked for the right
    // shape because asking is cheap, and then the answer is rebuilt anyway.
    work_history: {
      type: "array",
      description: "Every distinct role the document dates or describes, most recent first, including the current one. Education, certifications, awards and unpaid volunteering do not belong here — only employment, contracting and internships. Return an empty array if the document lists no roles.",
      items: {
        type: "object",
        properties: {
          company: { type: "string", description: "The organisation the role was at, as the document writes it. Empty string only if the document genuinely does not name one." },
          position: { type: "string", description: "The job title held in that role, e.g. Solutions Architect. Empty string only if the document gives no title." },
          start: { type: "string", description: "When the role started, as \"YYYY-MM\" — e.g. \"2021-03\". If the document gives only a year, return just \"YYYY\". If it gives no start date at all, return an empty string. Do not invent a month." },
          end: { type: "string", description: "When the role ended, in the same format as start. Return an empty string if the role is still held — never write \"Present\", \"Current\" or today's date." },
          is_current: { type: "boolean", description: "True only for a role the person still holds. If you set this true, end must be an empty string. Exactly one role is usually current, and a CV whose most recent role has an end date has none." },
          summary: { type: "string", description: "One or two sentences on what they did in that role, in the third person, drawn from the bullet points under it. Empty string if the document only gives a title and dates." },
        },
        required: ["company", "position", "start", "end", "is_current", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "full_name", "headline", "bio", "experience_level", "industry",
    "company", "position", "years_experience", "city", "country",
    "timezone", "language", "skills", "interests", "goals", "open_to",
    "work_history",
  ],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You extract structured profile fields from a CV or a LinkedIn profile export for Sahaba Club, an AI and cloud community.

Fill each field only from what the document actually says. Where the document gives you nothing to go on, return an empty string, a zero or an empty array — do not infer, estimate, or invent. Goals in particular are often absent from a CV; an empty array is the correct answer there, not a guess about what someone probably wants. Never guess where someone lives from a phone number's country code, the country of a university they attended, or the language a document is written in.

Working things out from what is written is not inventing: years of experience should be counted from dated roles, and a headline should be composed from their actual work. Putting in something the document does not support is.

Keep skills and interests as short, individually meaningful tags ("Power Apps", "Copilot Studio") rather than sentences, since they are used for filtering and matching.

WORK HISTORY. Return every employment entry the document contains, not just the current one — a CV is mostly this, and the rest of the profile only holds one job. One entry per role: a promotion within the same employer is a separate role if the document dates it separately, and a single role is not split across entries. Give dates as the document gives them, reduced to year and month ("2021-03"), or to just the year when that is all it says. If a role is still held, set is_current true and leave end empty rather than writing "Present". "company" and "position" must agree with the top-level company and position fields for whichever entry is current.`;

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

    // Base64 is ~4/3 of the bytes, so this is roughly an 8 MB file. Without a
    // cap any signed-in member can post an arbitrarily large body straight
    // into a paid API call.
    if (fileBase64.length > 11_000_000) {
      return json({ error: "That file is too big — please upload one under 8 MB." }, 413);
    }

    const type = String(mediaType || "").toLowerCase();
    const isImage = type.startsWith("image/");
    const isText = type === "text/plain";

    // Three shapes, and the media type decides which. This used to hardcode
    // `data:application/pdf` for anything that was not plain text, so a photo
    // of a CV was handed to the model labelled as a PDF and rejected outright.
    let documentPart: Record<string, unknown>;
    if (isText) {
      let decoded: string;
      try {
        // atob throws on malformed base64; that is a bad request, not a 500.
        decoded = new TextDecoder().decode(
          Uint8Array.from(atob(fileBase64), (c) => c.charCodeAt(0)),
        );
      } catch {
        return json({ error: "That file couldn't be read. Try a PDF or a photo instead." }, 400);
      }
      documentPart = { type: "input_text", text: decoded };
    } else if (isImage) {
      // A photo or screenshot of a CV — the model reads it directly, so a
      // member with their CV on paper or in an image can still use this.
      documentPart = { type: "input_image", image_url: `data:${type};base64,${fileBase64}` };
    } else {
      documentPart = {
        type: "input_file",
        filename: "profile.pdf",
        file_data: `data:${type || "application/pdf"};base64,${fileBase64}`,
      };
    }

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
        // Reasoning tokens are spent from the SAME budget as the output, so
        // 4000 shared between them starved the JSON and returned
        // status:"incomplete" — surfaced to the member as "that document was
        // too long", which sent them looking for a shorter CV when the length
        // was never the problem. Measured: a 2,000-character CV took 30s.
        //
        // Extracting fields off a CV is not a problem that needs deep
        // reasoning, so effort is capped and the ceiling raised. Both matter:
        // low effort brings the latency down, the higher ceiling stops a
        // long CV truncating.
        reasoning: { effort: "low" },
        max_output_tokens: 8000,
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

  // Always present, even as [], so the review step and the save path never
  // have to distinguish "the model returned nothing" from "this deployment
  // predates work history".
  profile.work_history = normaliseWorkHistory(profile.work_history);

  return profile;
}

// ---- Work history ------------------------------------------------------

type WorkEntry = {
  company: string;
  position: string;
  start: string | null;
  end: string | null;
  is_current: boolean;
  summary: string;
};

// 0023 stores this as jsonb with no CHECK on its structure, on purpose, so
// this function is where the shape is actually decided. Everything the model
// sent is treated as a suggestion: dates are re-parsed, is_current is
// recomputed, order is imposed, and the whole thing is capped.
function normaliseWorkHistory(raw: unknown): WorkEntry[] {
  if (!Array.isArray(raw)) return [];

  const entries: WorkEntry[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;

    const company = clip(row.company, MAX_WORK_TEXT);
    const position = clip(row.position, MAX_WORK_TEXT);

    // A row with neither an employer nor a title says nothing a member would
    // want on their profile, whatever else it carries.
    if (!company && !position) continue;

    const start = toYearMonth(row.start);
    const end = toYearMonth(row.end);

    // The one contradiction the model can produce that the member cannot see
    // the consequences of. An end date is something the document said; the
    // is_current flag is the model's inference about it, so the date wins and
    // the flag is corrected rather than the entry being dropped.
    //
    // Note the asymmetry: no end date does NOT make a role current. "Left in
    // 2019, no leaving month given" is a real and common shape, and inventing
    // is_current there would put a job someone left years ago at the top of
    // their profile as though they were still in it.
    const is_current = end === null && row.is_current === true;

    entries.push({
      company,
      position,
      start,
      end,
      is_current,
      summary: clip(row.summary, MAX_WORK_SUMMARY),
    });
  }

  // Newest first, decided here rather than trusted from the model — it is the
  // order 0023 documents and the order the profile renders in. A role still
  // held is newer than any dated one. Undated roles sink to the bottom, since
  // there is nothing to place them by. Array.prototype.sort is stable, so
  // entries that tie keep the order the document had them in.
  entries.sort((a, b) => {
    if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
    const byStart = compareDesc(a.start, b.start);
    if (byStart !== 0) return byStart;
    return compareDesc(a.end, b.end);
  });

  // Sort first, then cap, so a long CV keeps its most recent roles rather
  // than whichever ones the model happened to emit first.
  return entries.slice(0, MAX_WORK_HISTORY);
}

// Newest first, with null — "no date given" — always last.
function compareDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : -1;
}

// Only a string or a number is text. Anything else — an object, an array —
// would stringify to "[object Object]" and land on someone's profile looking
// like a bug they wrote themselves.
function clip(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

// CVs write dates every way there is, and 0023 wants one: "YYYY-MM". This
// takes the four shapes that actually turn up and refuses everything else —
// an unparseable date becomes null, because a blank is visible in the review
// step and a guessed date is not.
//
// A year with no month becomes January of that year. The alternative, storing
// a bare "YYYY", would mean every reader of work_history has to handle two
// different lengths of string forever, for a distinction nobody displays.
// January is also where a year-only date belongs when sorting: it is the
// earliest month the role could have started, so "2021" sorts just before
// "2021-03" rather than after it.
function toYearMonth(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text) return null;

  // "Present" is not a date. It means the role has no end, which is null here
  // and is_current above.
  if (OPEN_ENDED.test(text)) return null;

  // 2021-03, 2021/03, 2021-03-15 — ISO and its near misses.
  let m = text.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/);
  if (m) return build(Number(m[1]), Number(m[2]));

  // 03/2021, 3-2021 — month first, the other way round from the above, told
  // apart by which group is four digits.
  m = text.match(/^(\d{1,2})[-/.](\d{4})$/);
  if (m) return build(Number(m[2]), Number(m[1]));

  // Mar 2021, March 2021, Mar. 2021, Mar-2021 — and the reverse, 2021 March.
  // An unrecognised word here falls through to the year-only branch rather
  // than failing: "Spring 2021" matches this shape but is not a month.
  m = text.match(/^([A-Za-z]{3,9})\.?[\s\-/,]+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return build(Number(m[2]), MONTHS[m[1].toLowerCase()]);
  m = text.match(/^(\d{4})[\s\-/,]+([A-Za-z]{3,9})\.?$/);
  if (m && MONTHS[m[2].toLowerCase()]) return build(Number(m[1]), MONTHS[m[2].toLowerCase()]);

  // 2021, and anything else built around a year we can still read a year out
  // of — "Spring 2021", "Summer 2019". The season is dropped rather than
  // mapped to a month: which months it means depends on the hemisphere, and
  // the year is the part that is actually stated.
  m = text.match(/(?:^|\D)(\d{4})(?:\D|$)/);
  if (m) return build(Number(m[1]), 1);

  return null;
}

function build(year: number, month: number): string | null {
  const now = new Date().getUTCFullYear();
  // A date after next year is a typo or a misread column, not a job.
  if (!Number.isInteger(year) || year < MIN_WORK_YEAR || year > now + 1) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return year + "-" + String(month).padStart(2, "0");
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
