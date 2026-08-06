// Sahaba Club — event image uploads
// ------------------------------------------------------------
// Uploading event artwork and Mega Events banner logos from the admin panel,
// with the dimensions stated up front. Ahmed's requirement: "Each time system
// ask for photo should inform me the best dimensions for this image."
//
// ⚠ TEMPORAL DEAD ZONE — every module-level binding is declared at the top,
// before the first executing statement, and there is no top-level await.
//
// ⚠ Nothing here is a security boundary. The `event-images` bucket (0007) is
// publicly READABLE by design — event artwork has to load for signed-out
// visitors — and writable only by staff, enforced by a storage policy that
// calls is_staff(). A member who calls these functions gets refused by
// Postgres, not by this file.

import { supabase } from "./supabase-client.js";

const BUCKET = "event-images";

// Straight from the bucket definition in 0007. Duplicated here ONLY to give a
// useful message before the upload rather than a raw storage error after it —
// the bucket remains the authority, and these numbers must match it.
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];

// ============================================================
// The specs, measured rather than invented
// ============================================================
//
// `featuredLogo` is derived from the logos already in the banner:
// gitex-global.png is 1100×345, ai-everything.png 745×223,
// world-ai-expo.png 370×85 — all landscape wordmarks at roughly 3:1. The
// banner renders one into `.featured-media`, which is `flex: 0 0 32%` of a
// 560px card, so about 180px wide on screen; 800px wide covers that at 4×
// for a retina display with room to spare.
//
// `eventSquare` has no existing examples to measure — there is no square
// artwork in the project yet — so 1200 is chosen as the standard: large
// enough for the event page hero, and a square crops predictably into the
// small card without the subject drifting out of frame.
export const IMAGE_SPECS = {
  eventSquare: {
    key: "eventSquare",
    label: "Event image",
    recommended: [1200, 1200],
    min: [600, 600],
    aspectHint: "square (1:1)",
    // ⚠ Ratio tolerance is generous on purpose. A rejected upload with no
    // alternative is worse than a slightly-off crop, so a non-square image
    // WARNS and still uploads.
    ratio: 1,
    ratioTolerance: 0.25,
    why:
      "Shown small on the events list and large on the event page. A square " +
      "crops predictably into the card — a landscape photo loses its edges.",
  },
  featuredLogo: {
    key: "featuredLogo",
    label: "Banner logo",
    recommended: [800, 250],
    min: [400, 125],
    aspectHint: "landscape wordmark, about 3:1",
    ratio: 3.2,
    ratioTolerance: 1.6,
    why:
      "Sits on the coloured tile in the Mega Events banner. A transparent " +
      "background is what makes it sit on the tile rather than in a box.",
  },
};

// One sentence for the UI, built from the spec so the numbers can never drift
// from what is actually checked.
export function describeSpec(specKey) {
  const s = IMAGE_SPECS[specKey];
  if (!s) return "";
  return (
    `Best: ${s.recommended[0]}×${s.recommended[1]}px, ${s.aspectHint}. ` +
    `Minimum ${s.min[0]}×${s.min[1]}px. PNG, JPG or WebP, under 5MB. ` +
    (specKey === "featuredLogo" ? "Transparent PNG preferred. " : "") +
    s.why
  );
}

// ⚠ SVG is NOT accepted, and two of the banner logos already in the repo are
// SVG. That is not an inconsistency to fix by widening the bucket: an SVG is a
// document that can carry script, and this bucket is world-readable and
// served from the club's own origin. The committed SVGs are files a developer
// reviewed; an upload is not. Say so rather than letting the upload fail with
// a bare mime-type error.
export function rejectionReason(file) {
  if (!file) return "No file chosen.";
  if (/svg/i.test(file.type) || /\.svg$/i.test(file.name || "")) {
    return (
      "SVG can't be uploaded — it's a document that can carry script, and this " +
      "bucket is public. Export it as a transparent PNG instead."
    );
  }
  if (ALLOWED_TYPES.indexOf(file.type) === -1) {
    return `That's a ${file.type || "unknown"} file. Use PNG, JPG or WebP.`;
  }
  if (file.size > MAX_BYTES) {
    return `That file is ${(file.size / 1048576).toFixed(1)}MB. The limit is 5MB.`;
  }
  return null;
}

// Read the real pixel size before uploading, so the warning names actual
// numbers instead of guessing.
export function readImageSize(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

// Advice, never a refusal. Returns a string to show, or null when the image is
// a good fit. Deliberately separate from rejectionReason(): too small or the
// wrong shape is a judgement the person uploading should make, while the wrong
// file type is one the server will refuse anyway.
export async function inspect(file, specKey) {
  const s = IMAGE_SPECS[specKey];
  const size = await readImageSize(file);
  if (!s || !size) return { size: null, warning: null };

  const notes = [];
  if (size.width < s.min[0] || size.height < s.min[1]) {
    notes.push(
      `This is ${size.width}×${size.height}px, below the ${s.min[0]}×${s.min[1]} minimum — ` +
        `it will look soft, especially on a high-resolution screen.`
    );
  }
  const ratio = size.height ? size.width / size.height : 0;
  if (ratio && Math.abs(ratio - s.ratio) > s.ratioTolerance) {
    notes.push(
      specKey === "eventSquare"
        ? `This is ${size.width}×${size.height}px, not square — the card will crop the edges.`
        : `This is ${size.width}×${size.height}px. The banner expects a wide wordmark, so a tall image sits small on the tile.`
    );
  }
  return { size, warning: notes.length ? notes.join(" ") : null };
}

function extensionFor(type) {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  return "jpg";
}

// Upload and return the public URL.
//
// ⚠ Every upload gets its OWN path rather than overwriting a fixed one. The
// avatar code uses a fixed path plus `upsert` and then has to append a
// `?v=<timestamp>` cache-buster, because the CDN keeps serving the previous
// bytes from the same URL. A unique path avoids that class of bug entirely:
// the URL changes, so there is nothing stale to serve.
//
// The cost is orphans — replacing an event's image leaves the old file in the
// bucket. That is deliberate: deleting the previous file would risk removing
// artwork another row still points at (an event duplicated in the admin panel,
// say), and a few unreferenced images in a 5MB-per-file bucket are cheaper
// than one event rendering a broken image.
export async function uploadEventImage(file, options) {
  const opts = options || {};
  const specKey = opts.spec || "eventSquare";

  const bad = rejectionReason(file);
  if (bad) return { error: bad };

  // The folder only needs to be unique and stable-ish; it does not have to be
  // the event id, and for a new event there is no id yet.
  const folder = opts.eventId || "unassigned";
  const stamp = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const path = `${folder}/${specKey}-${stamp}.${extensionFor(file.type)}`;

  const up = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: false,
  });

  if (up.error) {
    const msg = String(up.error.message || "");
    if (/bucket/i.test(msg)) {
      return { error: "Image storage isn't set up on the server (bucket 'event-images' missing)." };
    }
    if (/policy|permission|denied/i.test(msg)) {
      return { error: "You don't have permission to upload images. Staff only." };
    }
    return { error: "Couldn't upload that image: " + msg };
  }

  const pub = supabase.storage.from(BUCKET).getPublicUrl(path);
  const url = pub && pub.data ? pub.data.publicUrl : null;
  if (!url) return { error: "Uploaded, but couldn't work out its public URL." };

  return { url, path };
}
