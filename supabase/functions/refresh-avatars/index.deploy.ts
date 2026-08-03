// GENERATED - do not edit. Deploy-time twin of index.ts with the ../_shared/cors.ts, ../_shared/ai-config.ts, ../_shared/avatar-art.ts imports replaced by those files inline, and
// nothing else. The Supabase dashboard editor deploys one function directory at a
// time and cannot reach a shared parent file. Edit index.ts and regenerate; the
// two must stay in step.

// refresh-avatars
// ------------------------------------------------------------
// Redraws the whole wall on the new month's theme. Runs on a schedule, in
// batches, until nothing is due.
//
// The point of the feature: the same person, rendered differently each month,
// so the directory looks alive rather than frozen. Members keep their own
// three tries on top of this — a refresh is the club's picture of them, not
// one of their goes, so it resets `avatar_attempts` to 0 and stamps the new
// cycle, leaving them three fresh tries for the month.
//
// The thing that shapes this function more than anything else: THERE IS NO
// SOURCE PHOTOGRAPH. 0015 destroys it after the first generation, on purpose,
// and `source_purged_at` is the receipt. So the monthly redraw cannot work
// the way the first generation did. It works from the member's *existing
// generated avatar* — their likeness as the club already holds it — plus
// their interests and the new month's theme. Nothing here reads, wants, or
// could use a real photo, and the purge receipt is re-stamped in the same
// UPDATE as the new `avatar_url` exactly as it is in generate-avatar.
//
// Batching, and why there is a `remaining`: image generation takes seconds
// per member, and an Edge Function has a wall-clock limit. Each member is
// committed on their own, so an interrupted run loses at most the one in
// flight, and `avatars_due_refresh` is ordered oldest-first so the next run
// resumes where this one stopped rather than starting over.
//
// Trigger it from Supabase's scheduled functions, or pg_cron — loop while
// `done` is false:
//   select cron.schedule('avatar-refresh', '15 3 1-7 * *', $$
//     select net.http_post(
//       url := '<project>/functions/v1/refresh-avatars?limit=10',
//       headers := jsonb_build_object('Authorization', 'Bearer <service role>')
//     );
//   $$);
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   OPENAI_API_KEY
//   OPENAI_IMAGE_MODEL                       — optional, same default as generate-avatar
//
// Since 0031 the artwork and the image model can also be set from Admin → AI
// services. ⚠ This function and `generate-avatar` read the SAME service row —
// `avatar-art` — which is the whole point: the wall and the individual
// portraits have to be the same artwork, and the panel is not able to give
// them two. The secret above and the constants in `_shared/avatar-art.ts`
// remain the floor for both.
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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const IMAGE_MODEL = Deno.env.get("OPENAI_IMAGE_MODEL") ?? "gpt-image-1";

// ⚠ The same slug `generate-avatar` reads. Two functions, one row. See the
// header of `_shared/avatar-art.ts`.
const AI_SLUG = "avatar-art";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

// Stop starting new members after this long and report what is left. The
// function's own limit is higher; returning a clean `remaining` beats being
// killed between the storage upload and the profile UPDATE.
const TIME_BUDGET_MS = 110_000;

type DueRow = {
  user_id: string;
  full_name: string | null;
  interests: string[] | null;
  skills: string[] | null;
  industry: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Scheduled job, not a public endpoint — the same gate as
  // send-transactional-email and send-license-reminders. Without it, any
  // visitor could make the club regenerate several hundred images, which is a
  // bill rather than a defacement, and this function writes avatars for
  // members other than the caller by design. Nothing legitimate reaches it
  // from a browser.
  const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (!SERVICE_ROLE_KEY || bearer !== SERVICE_ROLE_KEY) {
    console.error("refresh-avatars called without the service role key");
    return json({ error: "Not allowed" }, 403);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const params = new URL(req.url).searchParams;
  const dryRun = params.get("dry") === "1";
  const limit = clampLimit(params.get("limit"));

  const cycle = currentCycle();
  const startedAt = Date.now();

  // Read once for the whole batch, not once per member: every avatar in one
  // run must be drawn on one month's theme by one model, or the "wall" this
  // job exists to keep coherent is a wall drawn by two different setups
  // because somebody saved halfway through. Never throws — a database this
  // job cannot read means the batch runs on the code defaults, which is a
  // month of avatars that look right rather than a month with none.
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

  try {
    if (!dryRun && !OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is not set");
      return json({ error: "Avatar generation isn't configured yet." }, 503);
    }

    // The view already filters to discoverable members whose cycle is not the
    // current month. `count: exact` gives the size of the whole queue, not
    // just this page, which is what makes `remaining` answerable without a
    // second query.
    //
    // The ORDER BY is restated here even though 0018 has one. A view's
    // internal ordering is not something a paginated query is entitled to
    // rely on, and this is precisely the query that relies on it: oldest
    // first is what lets an interrupted run resume instead of handing back
    // the same ten people every time.
    const { data: due, count, error: dueErr } = await admin
      .from("avatars_due_refresh")
      .select("user_id, full_name, interests, skills, industry", { count: "exact" })
      .order("avatar_refreshed_at", { ascending: true, nullsFirst: true })
      .range(0, limit - 1);
    if (dueErr) return json({ error: dueErr.message }, 500);

    const batch = (due ?? []) as DueRow[];
    const totalDue = count ?? batch.length;

    // The avatar to redraw is not in the view — 0018 selects the fields the
    // prompt needs and nothing else. One lookup for the whole batch rather
    // than one per member.
    const ids = batch.map((r) => r.user_id);
    const avatarUrls = new Map<string, string>();
    if (ids.length) {
      const { data: current, error: curErr } = await admin
        .from("profiles")
        .select("user_id, avatar_url")
        .in("user_id", ids);
      if (curErr) return json({ error: curErr.message }, 500);
      for (const r of current ?? []) avatarUrls.set(r.user_id, r.avatar_url ?? "");
    }

    if (dryRun) {
      // Same shape as send-license-reminders' dry run: enough to see who is
      // next and why, with nothing spent. `willRedraw` is the interesting
      // column — false means we will write the themed fallback because there
      // is no usable picture to work from.
      return json({
        ok: true,
        dryRun: true,
        cycle,
        theme,
        // Which artwork this run would use, and where it came from. A dry run
        // whose whole job is "see who is next and why" should also answer
        // "and drawn how" — an activated house style that nobody expected is
        // exactly the thing worth catching before several hundred images.
        model: imageModel,
        artSource: ai.source,
        artVersion: ai.version || null,
        wouldProcess: batch.length,
        remaining: totalDue,
        sample: batch.slice(0, 10).map((r) => ({
          user_id: r.user_id,
          full_name: r.full_name,
          willRedraw: !!storagePathFor(avatarUrls.get(r.user_id) ?? ""),
        })),
      });
    }

    let processed = 0;
    let superseded = 0;
    const failures: Array<{ user_id: string; reason: string }> = [];
    let ranOutOfTime = false;

    for (const row of batch) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        ranOutOfTime = true;
        break;
      }

      try {
        const written = await refreshOne(
          admin, row, avatarUrls.get(row.user_id) ?? "", cycle, theme, art, imageModel,
        );
        // Either way they are in this cycle now and out of the queue, so both
        // count toward `processed` — `superseded` is only there to explain a
        // month where the numbers look light.
        if (!written) superseded++;
        processed++;
      } catch (err) {
        // A member who fails keeps last month's avatar and last month's
        // cycle, so they stay in the view and are picked up first next run.
        // Nothing is half-written: the profile UPDATE is the last step.
        const reason = String(err instanceof Error ? err.message : err);
        console.error("refresh-avatars " + row.user_id + ": " + reason);
        failures.push({ user_id: row.user_id, reason });
      }
    }

    // Everyone we did not advance is still due, failures included.
    const remaining = Math.max(0, totalDue - processed);

    // `done` tells the scheduler whether looping again is worth anything.
    // Nothing left is the obvious case. The other one matters more: a full
    // batch that advanced nobody means every member in it failed, and since
    // the view is ordered oldest-first the next call would hand back the same
    // people and fail the same way. Reporting done stops that loop and leaves
    // them for the next scheduled run, by which time a busy image service or
    // a bad model name will plausibly have changed.
    const done = remaining === 0 || (processed === 0 && !ranOutOfTime);

    return json({
      ok: true,
      cycle,
      theme,
      model: imageModel,
      artSource: ai.source,
      artVersion: ai.version || null,
      processed,
      failed: failures.length,
      superseded,
      remaining,
      done,
      ranOutOfTime,
      failures: failures.slice(0, 20),
    });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

// One member, start to finish. Throws on anything that should count as a
// failure; the caller records it and moves to the next person. Returns false
// if the member drew their own avatar while this was running — see
// saveRefreshed.
async function refreshOne(
  admin: ReturnType<typeof createClient>,
  row: DueRow,
  currentUrl: string,
  cycle: string,
  theme: string,
  // Resolved once for the batch by the handler and passed down rather than
  // read here, so every member in one run is drawn the same way.
  art: { house_style: string; variants: string[] },
  imageModel: string,
): Promise<boolean> {
  const profile = {
    full_name: row.full_name,
    interests: row.interests,
    skills: row.skills,
    industry: row.industry,
  };

  const sourcePath = storagePathFor(currentUrl);

  // No picture we can redraw. Rather than skipping — which would leave them
  // out of the month forever, since the view would keep offering them and
  // every run would keep passing — they get the deterministic themed tile,
  // which is real club artwork and changes with the month like everyone
  // else's. That covers a member with no avatar at all, and one sitting on
  // last month's fallback SVG, which the image endpoint will not accept as
  // input anyway.
  if (!sourcePath) {
    const url = await uploadFallback(admin, row.user_id, String(row.full_name ?? ""), cycle);
    if (!url) throw new Error("fallback upload failed");
    return await saveRefreshed(admin, row.user_id, {
      avatar_url: url,
      avatar_source: "fallback",
      avatar_theme: theme,
      avatar_cycle: cycle,
    });
  }

  // Their existing avatar, out of our own bucket. Downloaded through the
  // storage API rather than fetched from the public URL for two reasons: the
  // CDN can still be holding a previous version, and `avatar_url` is a column
  // members may write. Following an arbitrary URL out of a member-writable
  // column, from a service-role job, is a request-forgery hole — so anything
  // that is not a path inside the avatars bucket is treated as "no usable
  // source" above and never fetched.
  const { data: blob, error: dlErr } = await admin.storage
    .from(AVATAR_BUCKET)
    .download(sourcePath);
  if (dlErr || !blob) throw new Error("couldn't read the current avatar: " + (dlErr?.message ?? "missing"));

  let sourceBytes = new Uint8Array(await blob.arrayBuffer());
  if (!sourceBytes.byteLength) throw new Error("current avatar is empty");

  // Variant 0, as it always was: the monthly job draws one picture per member
  // and has nothing to vary between. The rota still has to be passed, because
  // entry 0 is one of the three staff can edit.
  const prompt = buildPrompt(profile, theme, "avatar", 0, art);
  const pngBytes = await generate(sourceBytes, prompt, imageModel);

  // Generated art rather than a photograph, but zeroed on the same principle
  // as generate-avatar: the input to an image call does not outlive the call.
  sourceBytes.fill(0);
  sourceBytes = new Uint8Array(0);

  // A new path each month rather than an overwrite, so the public URL changes
  // and no CDN anywhere serves last month's face. Same `<user_id>/` prefix,
  // so the storage policies in 0016 cover it unchanged.
  const path = `${row.user_id}/${crypto.randomUUID()}.png`;
  const { error: upErr } = await admin.storage
    .from(AVATAR_BUCKET)
    .upload(path, pngBytes, { contentType: "image/png", upsert: false });
  if (upErr) throw new Error("upload: " + upErr.message);

  const avatarUrl = admin.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl;

  return await saveRefreshed(admin, row.user_id, {
    avatar_url: avatarUrl,
    avatar_prompt: prompt,
    avatar_theme: theme,
    avatar_cycle: cycle,
  });
}

// The one UPDATE, for both paths.
//
// `avatar_source` is deliberately not set on the redraw path: 0015's CHECK
// allows only upload/google/microsoft/linkedin/fallback, and the honest
// answer to "where did this likeness come from" is still whatever they first
// gave us. The fallback path passes 'fallback' because that is exactly what
// it wrote.
//
// `source_purged_at` travels with `avatar_url` and `avatar_is_generated` in
// the same statement, the same as generate-avatar — 0015's alert looks for a
// generated avatar with a null purge timestamp, and a monthly job that split
// these would trip it several hundred times.
//
// `avatar_attempts` goes to 0 with the new cycle: the club redrawing everyone
// must not cost a member one of their own three tries for the month.
//
// Guarded on the member not already being in this cycle. The window is small
// but real — this job reads a batch, then spends several seconds per member
// inside OpenAI, and a member who generates their own avatar during those
// seconds has deliberately chosen a picture. Overwriting it with the batch's
// version, and handing back the tries they just spent, is the wrong outcome
// even though it is the rarer one. Returns false when that happened; the row
// is already out of `avatars_due_refresh` either way.
async function saveRefreshed(
  admin: ReturnType<typeof createClient>,
  userId: string,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("profiles")
    .update({
      ...fields,
      avatar_is_generated: true,
      avatar_attempts: 0,
      avatar_refreshed_at: now,
      source_purged_at: now,
      updated_at: now,
    })
    .eq("user_id", userId)
    // `neq` alone would drop everyone with a null cycle, because NULL <> 'x'
    // is NULL rather than true — and a never-refreshed member is exactly who
    // this job is for.
    .or(`avatar_cycle.is.null,avatar_cycle.neq.${fields.avatar_cycle}`)
    .select("user_id");
  if (error) throw new Error("save: " + error.message);
  return !!data?.length;
}

// ---- OpenAI -----------------------------------------------------------

// The edits endpoint again, with the member's existing avatar as the image
// input. Errors here are read from a log by whoever is watching the batch,
// not by a member staring at a spinner, so the triage is shorter than
// generate-avatar's and phrased for the operator.
async function generate(bytes: Uint8Array, prompt: string, model: string): Promise<Uint8Array> {
  const form = new FormData();
  form.append("model", model);
  form.append("image", new Blob([bytes], { type: "image/png" }), "avatar.png");
  form.append("prompt", prompt);
  form.append("size", "1024x1024");
  form.append("quality", "high");

  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { "Authorization": "Bearer " + OPENAI_API_KEY },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text();
    if (/model_not_found|does not exist|unknown model/i.test(detail)) {
      // Names which setting is actually in play — since 0031 the model can
      // come from the admin panel instead of the secret, and sending an
      // operator to change a value nothing is reading wastes a batch window.
      throw new Error(
        model === IMAGE_MODEL
          ? "OPENAI_IMAGE_MODEL is not a model this account can use"
          : `the image model chosen in Admin → AI services (${model}) is not one this account can use`,
      );
    }
    if (res.status === 401) throw new Error("OpenAI rejected OPENAI_API_KEY");
    if (res.status === 429) throw new Error("rate limited");
    throw new Error("OpenAI " + res.status + ": " + detail.slice(0, 200));
  }

  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("no image came back");
  return decodeBase64(b64);
}

// ---- Helpers ----------------------------------------------------------

// The object path inside the avatars bucket, or null if this URL is not one
// of ours. Doubles as the "can we redraw this?" test — see refreshOne. SVG is
// excluded because it is the fallback tile and the image endpoint will not
// take it as input.
function storagePathFor(url: string): string | null {
  const marker = "/storage/v1/object/public/" + AVATAR_BUCKET + "/";
  const at = String(url ?? "").indexOf(marker);
  if (at === -1) return null;

  const path = decodeURIComponent(url.slice(at + marker.length).split("?")[0]);
  if (!path || path.toLowerCase().endsWith(".svg")) return null;
  // `..` cannot climb out of a bucket through the storage API, but a path
  // arriving from a column is not a place to find out.
  if (path.includes("..")) return null;
  return path;
}

function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
