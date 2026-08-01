// avatar-art
// ------------------------------------------------------------
// The house style, the monthly theme rota, and the fallback tile.
//
// Two functions draw avatars: generate-avatar (one member, on demand, from
// their photo) and refresh-avatars (the whole wall, once a month, from what
// they already have). The pictures they produce sit next to each other in the
// same directory, so the style, the theme and the fallback have to be the
// same artwork — a house style that exists in two copies is a house style
// that drifts. Everything shared between them lives here; everything about
// *which columns get written* stays in the functions, because that part
// genuinely differs.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const AVATAR_BUCKET = "avatars";

// Three tries per monthly cycle. Also a CHECK constraint in 0015 (0..3), so
// nothing here may ever write 4.
export const MAX_ATTEMPTS = 3;

// ---- Cycles -----------------------------------------------------------

// 'YYYY-MM', UTC. This has to agree with `to_char(now(), 'YYYY-MM')` in 0018,
// which is what `avatar_attempts_this_cycle` and the `avatars_due_refresh`
// view compare against — Supabase runs its databases in UTC, and taking the
// month from the local clock instead would put this code and the view on
// different months for a few hours around each boundary.
export function currentCycle(now: Date = new Date()): string {
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
export function themeForCycle(cycle: string): string {
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
export const HOUSE_STYLE = [
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
export type PromptMode = "photo" | "avatar";

// Built from the member's own interests, skills and industry, so that a wall
// of avatars in one house style is still a wall of different people. The
// interests come in as subtle props and colour accents rather than costumes:
// "interested in aviation" should not produce a pilot's uniform, it should
// produce a hint of sky in the palette.
export function buildPrompt(
  profile: Record<string, unknown>,
  theme: string,
  mode: PromptMode = "photo",
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

  return [opening, HOUSE_STYLE, personal, context, seasonal, closing]
    .filter(Boolean)
    .join(" ");
}

// Profile text is written by the member, but it still ends up inside a model
// prompt, so it is normalised rather than trusted: single line, trimmed,
// length-capped, and capped in count. A 900-word "interest" would otherwise
// drown the house style it is supposed to accent.
export function tidyList(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.map((v) => tidyOne(v)).filter((v): v is string => !!v).slice(0, max)
    : [];
}

export function tidyOne(value: unknown): string {
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

export function fallbackSvg(userId: string, fullName: string, cycle: string): string {
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
export async function uploadFallback(
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

export function decodeBase64(b64: string): Uint8Array {
  // Data URLs are easy to send by accident from a FileReader; strip the
  // prefix rather than failing on it.
  const clean = String(b64).replace(/^data:[^;]+;base64,/, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function extFor(mediaType: string): string {
  return mediaType.includes("png") ? "png" : mediaType.includes("webp") ? "webp" : "jpg";
}
