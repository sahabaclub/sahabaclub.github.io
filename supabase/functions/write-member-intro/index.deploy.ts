// GENERATED - do not edit. Deploy-time twin of index.ts with the ../_shared/cors.ts, ../_shared/ai-config.ts imports replaced by those files inline, and
// nothing else. The Supabase dashboard editor deploys one function directory at a
// time and cannot reach a shared parent file. Edit index.ts and regenerate; the
// two must stay in step.

// write-member-intro
// ------------------------------------------------------------
// Writes the two or three sentences that go under "Ayesha joined the club" on
// the feed.
//
// The post already exists. The trigger in 0015 creates it with a title only,
// the moment a profile becomes worth reading, and this function fills in the
// body afterwards. That split is the whole reliability story: if this function
// is slow, rate-limited, or broken, the wall still has a post that says
// someone joined. So the failure behaviour here is to leave the row alone and
// return an error — never to blank a title, never to insert a second post.
//
// The thing this has to get right is variety. A wall of "Say hello to X, who
// brings experience in Y" thirty times over reads as machine output and stops
// being worth looking at, no matter how accurate each line is. The model is
// told that plainly, and it is also handed the openings already on the wall so
// "don't repeat" is something it can check rather than merely intend.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   OPENAI_API_KEY
//   OPENAI_MODEL                             — optional, defaults below
//
// Since 0031 the system prompt, the model and the output ceiling can also be
// set from Admin → AI services, under the `write-member-intro` service. The
// constants below remain the floor: with nothing activated, or with the
// database unreachable, this function behaves exactly as it did before.
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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-5";

// The code default for the ceiling, and the slug the admin panel stores an
// override under.
const MAX_OUTPUT_TOKENS = 1200;
const AI_SLUG = "write-member-intro";

// How many recent intros are shown to the model as "already used". Enough for
// it to see the pattern it must avoid, few enough to stay cheap.
const RECENT_INTROS = 10;

// How many opening words have to match before two cards count as the same
// card. Six is where a shared opening stops being a coincidence of English
// and starts being a template: "Say hello to Ayesha, who" and "Say hello to
// Omar, who" are six words of identical scaffolding, and two of those next to
// each other on the wall is the exact failure this function exists to avoid.
// Fewer than six flags ordinary phrases; more than six almost never fires.
const OPENING_WORDS = 6;

const INTRO_SCHEMA = {
  type: "object",
  properties: {
    intro: {
      type: "string",
      description:
        "Two or three sentences introducing this person to the club, addressed to the club about them (\"Say hello to …\"). Warm, specific, plain language. No greeting line, no sign-off, no hashtags, no emoji, no markdown.",
    },
    vibe_tag: {
      type: "string",
      description:
        "One lowercase English word capturing the feel of this person's profile, e.g. builder, researcher, teacher, tinkerer, organiser. Used only to pick an accent colour.",
    },
  },
  required: ["intro", "vibe_tag"],
  additionalProperties: false,
} as const;

// Rule 2 exists for the same reason it does in write-contact-email: the club's
// Microsoft agreement is an education one, the licence tier is not something
// we advertise, and a model handed member context will otherwise repeat "A1"
// straight onto a public wall.
const SYSTEM_PROMPT =
  `You write the short introduction that appears under a new member's name on the Sahaba Club feed — a public wall inside the club, where dozens of these cards sit next to each other.

Rules, in order of importance:

1. Use only the facts you are given. Do not invent achievements, employers, job titles, awards, years of experience, or enthusiasm the profile does not show. A profile with three facts in it gets a short, warm, honest introduction — that is the correct outcome, not a failure.
2. Never write "A1", "Office 365 A1", or any licence tier name. The Microsoft licences are always and only called "Microsoft 365 Cloud Licenses".
3. Repetition is the failure mode. You are writing one card among many, and the reader sees them stacked. Vary the opening line every time. You are shown the openings already on the wall; do not begin the way any of them begin, and do not reuse their sentence shape.
4. Write to the club about this person, in the second person plural: "Say hello to …", "Meet …", or another natural equivalent — but not the same one twice.
5. Two or three sentences. Specific beats effusive: one true, concrete detail is worth more than three adjectives.
6. No marketing language, no "we are thrilled", no "passionate about", no hashtags, no emoji, no exclamation marks stacked up.
7. Use the name exactly as given. If there is no name, introduce them without one rather than writing a placeholder.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const body = await req.json().catch(() => ({}));
    const userId: string | undefined = body.userId;
    if (!userId) return json({ error: "userId is required" }, 400);

    // Three callers, three reasons:
    //   - the service role, when a scheduled job backfills posts;
    //   - staff, from the admin screen;
    //   - the member themself, straight after finishing their profile, which
    //     is the moment the trigger fired and the card is sitting there
    //     bodyless.
    // A member may only ever trigger their own.
    const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    if (!SERVICE_ROLE_KEY) {
      return json({ error: "Not configured" }, 503);
    }
    if (bearer !== SERVICE_ROLE_KEY) {
      const { data: userData, error: userError } = await admin.auth.getUser(bearer);
      if (userError || !userData.user) {
        return json({ error: "Not signed in" }, 401);
      }
      if (userData.user.id !== userId) {
        const { data: callerProfile } = await admin
          .from("profiles")
          .select("role")
          .eq("user_id", userData.user.id)
          .maybeSingle();
        if (!callerProfile || (callerProfile.role !== "admin" && callerProfile.role !== "staff")) {
          return json({ error: "You can only write your own introduction" }, 403);
        }
      }
    }

    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is not set");
      return json({ error: "The AI writer isn't configured yet. Set OPENAI_API_KEY in the Edge Function secrets." }, 503);
    }

    // The post has to exist before there is anything to write into. If the
    // trigger has not fired — profile not discoverable, or not complete
    // enough — that is the answer, not a reason to create one here.
    // limit(1) rather than maybeSingle(): the trigger allows exactly one
    // announcement per person, and if that invariant ever broke, filling in
    // the oldest post is a better answer than a 500.
    const { data: posts, error: postErr } = await admin
      .from("feed_posts")
      .select("id, kind, title, body")
      .eq("subject_user_id", userId)
      .in("kind", ["member_joined", "coach_joined"])
      .order("created_at", { ascending: true })
      .limit(1);
    if (postErr) return json({ error: postErr.message }, 500);
    const post = posts?.[0];
    if (!post) {
      return json({ error: "No welcome post for this member yet" }, 404);
    }
    if (post.body && body.regenerate !== true) {
      // Already written. Rewriting on every profile save would churn the wall
      // and spend money doing it.
      return json({ ok: true, alreadyWritten: true, postId: post.id });
    }

    const { data: profile, error: pErr } = await admin
      .from("profiles")
      .select("user_id, full_name, headline, bio, city, country, industry, experience_level, skills, interests, role")
      .eq("user_id", userId)
      .maybeSingle();
    if (pErr || !profile) return json({ error: "Profile not found" }, 404);

    // member_activity is a view over event registrations; a member who joined
    // this morning has no row in it, which is normal and not an error.
    const { data: activity } = await admin
      .from("member_activity")
      .select("events_attended, events_upcoming, top_topics")
      .eq("user_id", userId)
      .maybeSingle();

    // What the wall already sounds like. Only the openings are sent — the
    // model needs to know what to avoid, not to read everyone's biography.
    const { data: recent } = await admin
      .from("feed_posts")
      .select("body")
      .in("kind", ["member_joined", "coach_joined"])
      .not("body", "is", null)
      .neq("id", post.id)
      .order("created_at", { ascending: false })
      .limit(RECENT_INTROS);

    const recentBodies = (recent ?? [])
      .map((r) => String(r.body ?? "").trim())
      .filter(Boolean);

    const usedOpenings = recentBodies.map(firstSentence).filter(Boolean);

    // The same openings again, reduced to a comparable shape. Telling the
    // model not to repeat is instruction; this is the check — the prompt has
    // rule 3 and is handed the wall, and it still occasionally lands on "Say
    // hello to X, who" for the third time in a row.
    const usedFingerprints = new Set(recentBodies.map(openingFingerprint).filter(Boolean));

    const context = buildContext(profile, activity ?? null);

    // Resolved once, before the first attempt, so that the retry below is a
    // second attempt at the same prompt rather than a second prompt. Never
    // throws — see `_shared/ai-config.ts`.
    const ai = await loadAiConfig(admin, AI_SLUG, {
      model: MODEL,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      parts: { system: SYSTEM_PROMPT },
    });

    let written: { intro: string; vibe_tag: string };
    try {
      written = await writeIntro(ai, context, usedOpenings);
    } catch (err) {
      // The title-only post stays exactly as it is. A plain post is better
      // than no post, and much better than a half-written one.
      console.error("intro failed for " + userId + ": " + String(err));
      return json({ error: String(err instanceof Error ? err.message : err) }, 502);
    }

    // One retry, with the clash named rather than merely implied: "do not
    // open like these" clearly did not land, so the second attempt is told
    // exactly which words it just used and that they are forbidden.
    //
    // It stops at one. A second retry doubles the cost and the latency of the
    // moment a member is watching their profile finish, for a card that is
    // already acceptable — and an opening that survives being explicitly
    // banned is a sign the model has nothing else to say about this profile,
    // not a sign that asking a third time will help. A slightly similar post
    // beats no post, so a still-clashing retry is accepted and logged.
    if (usedFingerprints.has(openingFingerprint(written.intro))) {
      const clashing = firstWords(written.intro, OPENING_WORDS);
      try {
        const retried = await writeIntro(ai, context, usedOpenings, clashing);
        if (usedFingerprints.has(openingFingerprint(retried.intro))) {
          console.warn("intro for " + userId + " still opens like the wall: " + clashing);
        }
        // Taken either way. It was written knowing about the clash, so even
        // when the first six words survive, the rest of it has moved.
        written = retried;
      } catch (err) {
        // The first draft is already valid — it went through every check in
        // writeIntro. Losing it because the *optional* second call failed
        // would trade a good post for no post.
        console.error("intro retry failed for " + userId + ": " + String(err));
      }
    }

    const { error: updErr } = await admin
      .from("feed_posts")
      .update({ body: written.intro, updated_at: new Date().toISOString() })
      .eq("id", post.id);
    if (updErr) {
      console.error("update: " + updErr.message);
      return json({ error: updErr.message }, 500);
    }

    return json({
      ok: true,
      postId: post.id,
      intro: written.intro,
      vibeTag: written.vibe_tag,
    });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

// What the model is allowed to know. Built field by field rather than passing
// the profile row through, so that a column added to `profiles` later — a
// phone number, an address, a mailbox — cannot quietly start appearing in
// prompts, and from there on a public wall.
function buildContext(
  profile: Record<string, unknown>,
  activity: Record<string, unknown> | null,
) {
  return {
    name: nonEmpty(profile.full_name),
    headline: nonEmpty(profile.headline),
    bio: nonEmpty(profile.bio),
    city: nonEmpty(profile.city),
    country: nonEmpty(profile.country),
    industry: nonEmpty(profile.industry),
    experience_level: nonEmpty(profile.experience_level),
    skills: asList(profile.skills),
    interests: asList(profile.interests),
    joins_as: profile.role === "coach" ? "coach" : "member",
    // Only meaningful once they have actually turned up to something. Sent as
    // counts and topics, never as a list of dated events — this is a welcome
    // note, not an attendance record.
    events_attended: activity?.events_attended ?? 0,
    events_upcoming: activity?.events_upcoming ?? 0,
    topics_they_keep_returning_to: asList(activity?.top_topics),
  };
}

function nonEmpty(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function asList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

function firstSentence(s: string): string {
  const trimmed = s.trim();
  const stop = trimmed.search(/[.!?]/);
  return (stop === -1 ? trimmed : trimmed.slice(0, stop + 1)).slice(0, 160);
}

// The first six words as something two intros can be compared on. Case and
// punctuation are dropped because they are not what a reader notices: "Meet
// Ayesha — a teacher who" and "meet Omar, a teacher who" are the same card
// twice, and a comparison that treats the dash as a difference would say they
// are not. Names differ between members, so this only fires on genuinely
// shared scaffolding.
function openingFingerprint(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    // Unicode-aware: members' names carry accents, and stripping them into
    // separate words would shift the six-word window.
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, OPENING_WORDS)
    .join(" ");
}

// The same words as written, for quoting back at the model.
function firstWords(s: string, n: number): string {
  return String(s ?? "").trim().split(/\s+/).slice(0, n).join(" ");
}

async function writeIntro(
  ai: AiConfig,
  context: Record<string, unknown>,
  usedOpenings: string[],
  forbiddenOpening?: string,
): Promise<{ intro: string; vibe_tag: string }> {
  const avoid = usedOpenings.length
    ? `These introductions are already on the wall. Do not open like any of them, and do not copy their shape:\n${usedOpenings.map((o) => "- " + o).join("\n")}`
    : "This is the first introduction on the wall — set a tone the next ones will have to differ from.";

  // Only present on the retry. Naming the exact words is the point: the
  // general instruction has already been given once and did not work.
  const banned = forbiddenOpening
    ? `\nYour previous attempt began "${forbiddenOpening}", which is how an introduction already on the wall begins. Those opening words are forbidden. Do not reword them either — start from a different first word and a different sentence shape entirely.`
    : "";

  const userPrompt = [
    `Everything the club knows about this person (nothing else is known — do not go beyond it):\n${JSON.stringify(context, null, 2)}`,
    "",
    avoid,
    banned,
  ].filter(Boolean).join("\n");

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + OPENAI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ai.model,
      instructions: part(ai, "system", SYSTEM_PROMPT),
      max_output_tokens: ai.maxOutputTokens,
      input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
      text: {
        format: { type: "json_schema", name: "member_intro", strict: true, schema: INTRO_SCHEMA },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error("OpenAI " + res.status + ": " + detail.slice(0, 500));
    if (/model_not_found|does not exist|unknown model/i.test(detail)) {
      // Names whichever setting is actually in play — since 0031 the model can
      // come from the admin panel instead of the secret.
      throw new Error(
        ai.model === MODEL
          ? "The configured AI model name isn't valid. Set OPENAI_MODEL in the Supabase Edge Function secrets to a model your account can use."
          : `The model chosen in Admin → AI services for member introductions (${ai.model}) isn't valid for this account. Change it there, or reset that service to its code default.`,
      );
    }
    if (res.status === 401) throw new Error("The AI service rejected our credentials. Check OPENAI_API_KEY.");
    if (res.status === 429) throw new Error("The AI service is busy right now — try again in a moment.");
    throw new Error("OpenAI " + res.status);
  }

  const data = await res.json();
  const message = (data.output ?? []).find((o: { type?: string }) => o.type === "message");
  const parts = message?.content ?? [];

  if (parts.some((p: { type?: string }) => p.type === "refusal")) {
    throw new Error("The model declined to write this one");
  }
  if (data.status === "incomplete") {
    throw new Error("Ran out of output tokens before finishing");
  }

  const textPart = parts.find((p: { type?: string }) => p.type === "output_text");
  if (!textPart?.text) throw new Error("No introduction came back");

  const parsed = JSON.parse(textPart.text);
  const intro = String(parsed.intro ?? "").trim();
  if (!intro) throw new Error("The introduction came back empty");

  // Rule 2 is checked, not trusted — it is the one with a real-world cost, and
  // this text goes on a wall the whole club reads. Failing here leaves the
  // title-only post in place, which is the safe outcome.
  if (/\bA1\b|office\s*365\s*a1/i.test(intro)) {
    throw new Error("Draft named the licence tier — regenerate this one");
  }
  if (/\[[A-Za-z ]+\]/.test(intro)) {
    throw new Error("Draft contains an unfilled placeholder");
  }
  // The column is capped at 5000 in 0014; two or three sentences that somehow
  // ran long should fail here rather than at the database.
  if (intro.length > 1200) {
    throw new Error("Draft is far longer than a card — regenerate this one");
  }

  // Normalised so the UI's colour lookup has one shape to handle. Unknown
  // words are expected — the page hashes anything it does not recognise into
  // a palette slot rather than dropping the accent.
  const vibe = String(parsed.vibe_tag ?? "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 16);

  return { intro, vibe_tag: vibe || "member" };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
