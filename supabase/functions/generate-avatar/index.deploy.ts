// GENERATED - do not edit. Deploy-time twin of index.ts with the ../_shared/cors.ts
// and ../_shared/avatar-art.ts imports replaced by those files inline, and nothing
// else. The Supabase dashboard editor deploys one function directory at a time and
// cannot reach a shared parent file. Edit index.ts and regenerate; keep them in step.

// generate-avatar
// ------------------------------------------------------------
// Turns a member's real photo into a stylised illustrated Sahaba Club avatar,
// and then destroys the photo.
//
// The club's rule is that no real photographs live on the platform. That is a
// privacy promise, not a look, and it only holds because of how this function
// is written: the uploaded image arrives in the request body, is held in a
// local variable, is posted to OpenAI, and is never written to storage or to
// a column. The only bytes that reach the `avatars` bucket are the generated
// ones. `source_purged_at` is set in the same UPDATE that sets `avatar_url`,
// so there is no moment at which a generated avatar exists without the
// receipt saying the source is gone — 0015 has a verification query that
// alerts on exactly that pair.
//
// The function acts ONLY on the caller's own profile. The target user id is
// taken from the JWT and the request body is never consulted for it, because
// a function that accepts "whose photo is this" from the client is a machine
// for transforming pictures of other people.
//
// Three generations per member per month, then a themed fallback. The cap is
// here (and again as a CHECK constraint in 0015) because "generate another"
// is one button and image generation costs real money per press. Since 0018
// the three are an allowance per monthly cycle rather than a lifetime one:
// a member who is unhappy with all three in March gets three fresh tries in
// April, and refresh-avatars redraws everyone on the new month's theme in
// between. The style itself lives in _shared/avatar-art.ts, shared with that
// job so the wall stays one wall.
//
// ---- The member does not wait for the drawing ------------------------------
//
// This used to hold the HTTP request open for the whole OpenAI image call —
// tens of seconds, and a test run that went past a 45-second limit and was
// killed. A member sitting on a spinner that long assumes the page has hung,
// and the one thing they can do about it (press the button again) is the one
// thing that makes it worse.
//
// So the request now returns as soon as the attempt is RESERVED — 202, with
// the allowance the member has left — and the drawing happens in the
// background via EdgeRuntime.waitUntil. The reservation is the only part that
// has to be synchronous, because it is the part that decides whether this
// request is allowed to spend money at all, and its answer is what the member
// needs before they can press anything else.
//
// Progress is reported through `profiles.avatar_status` (0026), which the
// member's own row already lets them read, so the page polls one row it was
// going to read anyway rather than this function growing a second endpoint:
//
//   202 {ok, queued:true, ...}  →  avatar_status 'generating'
//                                    →  'ready'  and a new avatar_url
//                                    →  'failed' and a readable avatar_error
//
// What did NOT change is the privacy promise, and it is worth saying plainly
// because moving work into the background is exactly the kind of change that
// quietly breaks it: the photo bytes still live only in a local variable, they
// still never reach storage or a column, and they are still scrubbed the
// moment the image call is done with them. The only difference is that the
// variable now outlives the HTTP response instead of the request outliving the
// drawing.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   OPENAI_API_KEY
//   OPENAI_IMAGE_MODEL                       — optional, see below
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// ---- inlined from ../_shared/cors.ts ----
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
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
function themeForCycle(cycle: string): string {
  const month = Number(String(cycle).slice(5, 7));
  // An unparseable cycle should still produce a portrait. Falling back to
  // January is a duller failure than throwing halfway through a batch.
  const index = Number.isFinite(month) && month >= 1 && month <= 12 ? month - 1 : 0;
  return THEMES[index];
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
function variantTreatment(variant: number): string {
  const n = Number.isFinite(variant) ? Math.trunc(variant) : 0;
  const i = ((n % VARIANTS.length) + VARIANTS.length) % VARIANTS.length;
  return VARIANTS[i];
}

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
function buildPrompt(
  profile: Record<string, unknown>,
  theme: string,
  mode: PromptMode = "photo",
  variant: number = 0,
): string {
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
    `For this version, treat the composition as follows: ${variantTreatment(variant)}. ` +
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

  return [opening, HOUSE_STYLE, personal, context, seasonal, treatment, closing]
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

// A Supabase runtime global, not a Deno one, so it is in none of the types we
// import. Declared here rather than reached for through `globalThis as any`,
// and declared as possibly undefined on purpose: `waitUntil` is the whole
// reason this function can answer in a second, but a local `deno serve`, a
// self-hosted deployment or a future runtime may not have it. The fallback
// below awaits the work inline — slow, and exactly what this function used to
// do — because answering late is a worse outcome than dropping a member's
// paid-for image on the floor, not a better one.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

// An environment variable with a default rather than a constant, same as the
// text model in parse-profile-document: image model names change faster than
// this function will, and a wrong one should be a dashboard edit rather than
// a redeploy. The error handler below says so when OpenAI rejects the name.
const IMAGE_MODEL = Deno.env.get("OPENAI_IMAGE_MODEL") ?? "gpt-image-1";

// Matches the bucket's allowed_mime_types in 0016. Checked here as well so a
// bad upload fails before it costs an OpenAI call.
const ALLOWED_MEDIA = ["image/png", "image/jpeg", "image/webp"];

// Where the photo came from, for `profiles.avatar_source`. 'fallback' is
// deliberately not accepted from the client — only this function assigns it.
const ALLOWED_SOURCES = ["upload", "google", "microsoft", "linkedin"];

// 8 MB decoded. Phone cameras produce more than this; the page downscales
// before upload, and a body that arrives bigger than this is a bug or an
// attempt to make us pay to forward large files to OpenAI.
const MAX_SOURCE_BYTES = 8_000_000;

// How many past drawings `avatar_gallery` keeps. Three tries a month, twelve
// months a year, and a jsonb column that is read whole every time the profile
// is: without a cap this grows for ever and every profile read pays for it.
// Twelve is four months of a member using their full allowance, which is more
// than enough for "put the one from last month back" — and every entry still
// points at a file in the bucket, so nothing is deleted by falling off the
// end, only forgotten.
const GALLERY_MAX = 12;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // The identity of the profile being changed comes from here and from
    // nowhere else. See the header note.
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData.user) {
      return json({ error: "Not signed in" }, 401);
    }
    const userId = userData.user.id;

    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is not set");
      return json({ error: "Avatar generation isn't configured yet." }, 503);
    }

    const body = await req.json().catch(() => ({}));
    const source: string = body.source ?? "upload";
    const mediaType: string = body.mediaType ?? "image/png";
    const imageBase64: string = body.imageBase64 ?? "";

    if (!ALLOWED_SOURCES.includes(source)) {
      return json({ error: "Unknown avatar source" }, 400);
    }
    if (!ALLOWED_MEDIA.includes(mediaType)) {
      return json({ error: "Photos must be PNG, JPEG or WebP." }, 400);
    }

    const { data: profile, error: pErr } = await admin
      .from("profiles")
      .select("user_id, full_name, headline, industry, skills, interests, avatar_attempts, avatar_cycle")
      .eq("user_id", userId)
      .maybeSingle();
    if (pErr || !profile) {
      return json({ error: "No profile to attach an avatar to" }, 404);
    }

    // Attempts are counted per cycle, so the column on its own does not mean
    // what it says: an `avatar_attempts` of 3 stamped with last month's
    // `avatar_cycle` is a member with three tries in hand, not a member out
    // of them. `storedAttempts`/`storedCycle` are the raw row as we read it —
    // used only for the reservation guard below, which has to compare against
    // what is actually in the row — and `attempts` is what the member has
    // spent *this* month, which is what the cap and the response talk about.
    //
    // This mirrors public.avatar_attempts_this_cycle() in 0018. Both exist
    // because the rule is read from SQL as well as from here, and neither is
    // allowed to be the only place it is written down.
    const storedAttempts: number = profile.avatar_attempts ?? 0;
    const storedCycle: string | null = profile.avatar_cycle ?? null;
    const cycle = currentCycle();
    const theme = themeForCycle(cycle);
    const staleCycle = storedCycle !== cycle;
    const attempts = staleCycle ? 0 : storedAttempts;

    // Out of tries *this month*: no OpenAI call, no increment. The fallback is
    // generated locally and costs nothing, so a member who has spent their
    // three still ends up with something that belongs on the wall — and gets
    // three more when the month turns over.
    //
    // This path stays synchronous. There is nothing to wait for — an SVG is
    // drawn in this process and uploaded — so queueing it would only cost the
    // member a poll to be told something that was already true when they
    // asked. It answers 200 with the finished URL, exactly as it always did.
    if (attempts >= MAX_ATTEMPTS) {
      const url = await storeFallback(admin, userId, profile, cycle, theme);
      if (!url) return json({ error: "Couldn't save an avatar just now." }, 502);
      return json({
        ok: true,
        queued: false,
        avatarUrl: url,
        attemptsUsed: attempts,
        attemptsLeft: 0,
        cycle,
        isFallback: true,
      });
    }

    // The photo. From here until the OpenAI call returns it exists only as
    // this local variable — nothing between these lines writes it anywhere.
    let sourceBytes: Uint8Array;
    try {
      sourceBytes = decodeBase64(imageBase64);
    } catch {
      return json({ error: "That photo didn't arrive in one piece — try again." }, 400);
    }
    if (!sourceBytes.byteLength) {
      return json({ error: "imageBase64 is required" }, 400);
    }
    if (sourceBytes.byteLength > MAX_SOURCE_BYTES) {
      return json({ error: "That photo is too large. Try one under 8 MB." }, 413);
    }

    // Reserve the attempt before spending money, guarded on the row we just
    // read. Two "generate another" clicks racing each other both read 2 and
    // would both generate; the guard means the loser's update matches no rows
    // and it is told to try again. The refund below covers the case where
    // OpenAI never produced an image.
    //
    // The guard is on the *stored* pair, not on the effective count, and that
    // is the part worth reading twice. If the row says (attempts 3, cycle
    // '2026-06') and this is July, the member has 0 spent and 3 in hand — but
    // guarding on `avatar_attempts = 0` would match nothing and every first
    // generation of a new month would fail as a phantom conflict. Guarding on
    // (3, '2026-06') — what is really in the row — matches exactly once, and
    // the write that wins is also the write that moves the row into July. The
    // loser of a genuine race then sees the new cycle and correctly conflicts.
    //
    // `avatar_status`/`avatar_error` ride along in the same statement rather
    // than following in a second one. The WHERE clause is untouched — this is
    // the same guard on the same pair — but it means the row is never briefly
    // "an attempt has been spent and nothing is happening", which is precisely
    // the state a polling client would read as a stuck generation.
    const next = attempts + 1;
    // The attempt index, 0-based, so a member's three tries in a cycle get the
    // three different treatments in _shared/avatar-art.ts rather than three
    // draws of the same prompt.
    const prompt = buildPrompt(profile, theme, "photo", next - 1);

    let reservation = admin
      .from("profiles")
      .update({
        avatar_attempts: next,
        avatar_cycle: cycle,
        avatar_status: "generating",
        avatar_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("avatar_attempts", storedAttempts);
    // A never-generated member has a null cycle, and `= null` is never true in
    // SQL — that comparison has to be IS NULL or the first ever generation
    // reserves nothing.
    reservation = storedCycle === null
      ? reservation.is("avatar_cycle", null)
      : reservation.eq("avatar_cycle", storedCycle);

    const { data: reserved, error: rErr } = await reservation.select("user_id");
    if (rErr) return json({ error: rErr.message }, 500);
    if (!reserved?.length) {
      return json({ error: "Another avatar is already being generated. Give it a moment." }, 409);
    }

    // Everything expensive, from here on, off the request's critical path.
    // `draw` never rejects — it records its own outcome on the profile row,
    // because after the response has gone there is nobody left to tell.
    const work = draw(admin, {
      userId,
      source,
      mediaType,
      sourceBytes,
      prompt,
      theme,
      cycle,
      variant: next - 1,
      attempts,
      next,
    });

    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
      EdgeRuntime.waitUntil(work);
    } else {
      // No waitUntil in this runtime. Do it the old way and answer late; the
      // response below is still a 202, so a client that polls afterwards
      // simply finds the work already finished on its first look.
      console.warn("EdgeRuntime.waitUntil is unavailable — drawing inline");
      await work;
    }

    // 202, not 200: accepted, not done. The allowance is already correct —
    // the attempt is spent whether or not the drawing lands, and it is given
    // back by `draw` if it does not, which the member sees on the next poll.
    return json({
      ok: true,
      queued: true,
      attemptsUsed: next,
      attemptsLeft: MAX_ATTEMPTS - next,
      cycle,
    }, 202);
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

// ---- The background half ----------------------------------------------

type DrawJob = {
  userId: string;
  source: string;
  mediaType: string;
  sourceBytes: Uint8Array;
  prompt: string;
  theme: string;
  cycle: string;
  variant: number;
  attempts: number;   // spent before this try — what a refund restores
  next: number;       // spent including this try — what the guard matches on
};

// Draws, uploads, and writes the profile. Runs after the response has been
// sent, so it must never throw: an unhandled rejection inside waitUntil is a
// line in a log nobody is reading and a member left on 'generating' for ever.
// Every exit from here leaves `avatar_status` at 'ready' or 'failed'.
async function draw(admin: ReturnType<typeof createClient>, job: DrawJob): Promise<void> {
  const { userId, source, mediaType, prompt, theme, cycle, variant, attempts, next } = job;

  try {
    // The photo has done its job, whether the call succeeded or not. It would
    // be collected when this task ends anyway; zeroing it is cheap and means
    // the source is gone before anything is written, not merely never written.
    // Attached to the call itself rather than placed after it, because a
    // failed generation is not a reason to keep somebody's photograph in
    // memory for the rest of the instance's life — and now that the response
    // has already gone, that life is longer than the request's was.
    const pngBytes = await generate(job.sourceBytes, mediaType, prompt)
      .finally(() => job.sourceBytes.fill(0));

    const path = `${userId}/${crypto.randomUUID()}.png`;
    const { error: upErr } = await admin.storage
      .from(AVATAR_BUCKET)
      .upload(path, pngBytes, { contentType: "image/png", upsert: false });
    if (upErr) {
      console.error("upload: " + upErr.message);
      await fail(admin, userId, cycle, attempts, next, "Couldn't save the new avatar just now.");
      return;
    }
    const avatarUrl = admin.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl;

    // The gallery is read here, immediately before the write, rather than
    // carried down from the request — it is minutes old by then, and
    // refresh-avatars or the member's own previous try may have touched it.
    //
    // Read-then-write, so two drawings genuinely overlapping can still lose
    // one entry, and that is a known cost rather than an oversight. The
    // reservation guard does not prevent the overlap: it only stops two
    // requests that read the *same* row from both reserving. A second request
    // issued after the first has reserved reads the new count and reserves the
    // next attempt quite legitimately — and now that the response no longer
    // waits for the drawing, the member is free to send it. What is lost when
    // that happens is one row of history; the picture itself is in the bucket,
    // and the winning `avatar_url` is still the last one written. Serialising
    // it would mean a jsonb-appending SQL function on the hot path of every
    // generation, which is a lot of machinery for a forgotten thumbnail.
    const { data: current } = await admin
      .from("profiles")
      .select("avatar_gallery")
      .eq("user_id", userId)
      .maybeSingle();

    const held = current?.avatar_gallery;
    const previous = Array.isArray(held) ? held : [];
    const gallery = [
      { url: avatarUrl, prompt, theme, variant, cycle, created_at: new Date().toISOString() },
      ...previous,
    ].slice(0, GALLERY_MAX);

    // One UPDATE. `source_purged_at` travels with `avatar_url` so the two can
    // never disagree — the alert in 0015 looks for a generated avatar with a
    // null purge timestamp, and splitting these into two statements would
    // create a window where that is briefly true. `avatar_status` is in the
    // same statement for the same reason: 'ready' and the URL the member is
    // about to be shown must become true together, or a poll lands between
    // them and shows the old picture as the new one.
    const { error: saveErr } = await admin
      .from("profiles")
      .update({
        avatar_url: avatarUrl,
        avatar_gallery: gallery,
        avatar_status: "ready",
        avatar_error: null,
        avatar_is_generated: true,
        avatar_source: source,
        avatar_prompt: prompt,
        avatar_theme: theme,
        // Stamped here as well as by refresh-avatars: this member has now had
        // a picture drawn for this month, and `avatars_due_refresh` orders on
        // this column, so leaving it stale would send the monthly job to the
        // people who need it least first.
        avatar_refreshed_at: new Date().toISOString(),
        source_purged_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
    if (saveErr) {
      // The picture exists and is uploaded; only the row write failed. The
      // attempt is still refunded, because from the member's side nothing
      // happened and charging them for it would be wrong.
      console.error("save: " + saveErr.message);
      await fail(admin, userId, cycle, attempts, next, "Your avatar was drawn but couldn't be saved. Try again.");
    }
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    console.error("generate-avatar: " + message);
    await fail(admin, userId, cycle, attempts, next, message);
  }
}

// Give the try back and say what went wrong, in one statement.
//
// Nothing usable was produced, so nothing was charged for and the try is given
// back. Guarded on (next, cycle) so a concurrent success is never rolled back.
// The cycle is left at the current month rather than restored to the stale
// one: `attempts` is already the count for this month, and re-staling the row
// would only make the next request redo the reset.
//
// `avatar_status` and `avatar_error` sit inside the same guarded statement on
// purpose. If the guard misses, some other writer owns this row — a
// generation that succeeded while this one was failing, or the monthly
// refresh — and stamping 'failed' over their work would tell the member their
// perfectly good new avatar is broken.
async function fail(
  admin: ReturnType<typeof createClient>,
  userId: string,
  cycle: string,
  attempts: number,
  next: number,
  message: string,
): Promise<void> {
  const { error } = await admin
    .from("profiles")
    .update({
      avatar_attempts: attempts,
      avatar_status: "failed",
      // Read by the member, so it is the triaged sentence from `generate`
      // rather than a stack trace. Length-capped because the column is shown
      // in a state line, and a 4 kB OpenAI error body is not a sentence.
      avatar_error: message.slice(0, 300),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("avatar_attempts", next)
    .eq("avatar_cycle", cycle);
  if (error) console.error("refund: " + error.message);
}

// ---- OpenAI -----------------------------------------------------------

// POST /v1/images/edits, multipart — the edits endpoint rather than
// generations because the source photograph is the input we are transforming.
// Plain fetch and FormData, no SDK, same as every other function here.
async function generate(bytes: Uint8Array, mediaType: string, prompt: string): Promise<Uint8Array> {
  const form = new FormData();
  form.append("model", IMAGE_MODEL);
  form.append("image", new Blob([bytes], { type: mediaType }), "source." + extFor(mediaType));
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
    console.error("OpenAI " + res.status + ": " + detail.slice(0, 500));

    // Same triage as parse-profile-document: the model name is the setting
    // most likely to be wrong, and a generic message sends someone hunting in
    // the wrong place. These sentences now land in `avatar_error` and are read
    // by the member off their own profile row, so they still have to be
    // sentences rather than codes.
    if (/model_not_found|does not exist|unknown model/i.test(detail)) {
      throw new Error(
        "The configured image model name isn't valid. Set OPENAI_IMAGE_MODEL in the Supabase Edge Function secrets to a model your account can use.",
      );
    }
    if (res.status === 401) {
      throw new Error("The AI service rejected our credentials. Check OPENAI_API_KEY.");
    }
    if (res.status === 429) {
      throw new Error("The image service is busy right now — try again in a moment.");
    }
    // A photo the safety system declines is a normal outcome, not a bug, and
    // the member needs to know a different photo will work.
    if (/moderation|safety|content_policy/i.test(detail)) {
      throw new Error("That photo couldn't be used. Try a clear, front-facing photo of yourself.");
    }
    throw new Error("Couldn't create an avatar just now. Try again shortly.");
  }

  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("No image came back — try again shortly.");
  return decodeBase64(b64);
}

// ---- The fallback -----------------------------------------------------

// The tile itself is drawn in _shared/avatar-art.ts, so that this and the
// monthly job produce the same artwork. What stays here is which columns get
// written, which is not the same for the two callers: this path is a member
// who has spent their three tries, so it must not touch the attempt count.
async function storeFallback(
  admin: ReturnType<typeof createClient>,
  userId: string,
  profile: Record<string, unknown>,
  cycle: string,
  theme: string,
): Promise<string> {
  const url = await uploadFallback(admin, userId, String(profile.full_name ?? ""), cycle);
  if (!url) return "";

  // The fallback carries the same purge receipt. Nothing was sent to OpenAI
  // on this path, so there is even less to keep — but a row with a generated
  // avatar and a null timestamp is what the alert looks for, and "we didn't
  // call the model this time" is not a reason to trip it.
  //
  // 'ready' rather than 'idle': this request finished, and a client that has
  // just been handed a URL should not then poll a status that says nothing is
  // happening. The tile is not added to `avatar_gallery` — it is deterministic
  // per member per month and can be redrawn at any time for nothing, so a
  // history entry for it would be a slot spent on something not worth keeping.
  const { error: saveErr } = await admin
    .from("profiles")
    .update({
      avatar_url: url,
      avatar_status: "ready",
      avatar_error: null,
      avatar_is_generated: true,
      avatar_source: "fallback",
      avatar_theme: theme,
      avatar_refreshed_at: new Date().toISOString(),
      source_purged_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  if (saveErr) {
    console.error("fallback save: " + saveErr.message);
    return "";
  }
  return url;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
