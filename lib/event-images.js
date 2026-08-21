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

import { supabase } from "./supabase-client.js?v=415d6c02c6";

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
// ⚠ REVISED 7 Aug 2026, after Ahmed said "the best is not 800×250px". He was
// right, and the reason is worth keeping: the old figure was derived from the
// SHAPE OF THE LOGOS ALREADY IN THE REPO — gitex-global.png at 1100×345,
// ai-everything.png at 745×223, world-ai-expo.png at 370×85, all roughly 3:1
// wordmarks — rather than from the shape of the HOLE THEY GO IN. Describing
// the existing files is not the same as describing the slot, and the two had
// never been compared.
//
// Measured in the browser rather than reasoned about. `.featured-card` is a
// FIXED 672×168 — it does not grow with the viewport — and `.featured-media`
// is `flex: 0 0 32%` of it with 15px of padding, so the box a logo actually
// gets is about **185×137 CSS px, a ratio of 1.35:1**.
//
// The logo is `object-fit: contain` inside that box, so a 3.2:1 wordmark is
// limited by WIDTH and lands at 185×58 — using 42% of the height it was given.
// It looks like a thin band on a large tile, which is exactly what Ahmed was
// seeing.
//
// So: 4:3, and 800×600 to cover 185×137 at 4× for the densest phone screens.
// A wide wordmark is still accepted and still looks fine — many real event
// logos ARE wordmarks and cannot be reshaped — it simply sits smaller, which
// is what the ratio warning now says instead of pretending 3:1 is ideal.
//
// TRANSPARENCY is the part that most affects the result and was buried at the
// end of a sentence. The tile is a coloured panel; a logo exported on white
// arrives as a white rectangle sitting on violet. It is now the first thing
// the hint says.
//
// `eventSquare` stays 1200×1200. Also measured: the event-page hero renders
// 320×320 and the Hub card 247×247, both 1:1, so 1200 covers the larger at
// nearly 4×. What changed is the EXPLANATION — it claimed a square "crops
// predictably into the card", and after 457f054 the Hub and related cards are
// `object-fit: contain` and crop nothing at all. Only the event-page hero
// still crops. A reason that is no longer true is worse than no reason: it
// tells the next person to design around a constraint that has gone.
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
      "Used in three places: the event page header (320px, square, and the " +
      "one place a non-square image is cropped), the Sahaba Club Events Hub " +
      "card (247px, square), and the wide “You might also like” card, where " +
      "it is shown whole with bars at the sides. A square is the only shape " +
      "that suits all three.",
  },
  featuredLogo: {
    key: "featuredLogo",
    label: "Banner logo",
    // The tile's usable box is 185×137 CSS px at 1.35:1 — measured, see above.
    // 800×600 covers it at better than 4× on the densest screens.
    recommended: [800, 600],
    min: [400, 300],
    aspectHint: "landscape, about 4:3",
    ratio: 1.35,
    // Wide wordmarks are what most event logos actually are, and they cannot
    // be reshaped. Tolerance reaches past 3:1 so the common case uploads
    // without a warning that the person can do nothing about.
    ratioTolerance: 2,
    // Does NOT repeat the transparency line describeSpec() puts in front of
    // this — saying it twice in one hint reads as filler and gets skimmed.
    why:
      "The tile behind it is a solid colour, so a logo exported on white " +
      "arrives as a white box sitting on violet. 4:3 fills the tile; a wide " +
      "wordmark also works but sits as a narrower band across the middle.",
  },
};

// One sentence for the UI, built from the spec so the numbers can never drift
// from what is actually checked.
export function describeSpec(specKey) {
  const s = IMAGE_SPECS[specKey];
  if (!s) return "";
  // Transparency leads for the banner logo. It used to be a three-word aside
  // between the file formats and the explanation, which is the least-read
  // position in the sentence — and it is the single choice that most changes
  // how the result looks.
  const transparency =
    specKey === "featuredLogo" ? "Transparent PNG, no white background. " : "";
  return (
    transparency +
    `Best: ${s.recommended[0]}×${s.recommended[1]}px, ${s.aspectHint}. ` +
    `Minimum ${s.min[0]}×${s.min[1]}px. PNG, JPG or WebP, under 5MB. ` +
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
  // ⚠ Both messages describe what the person will SEE, and both were rewritten
  // on 7 Aug because they had stopped being true:
  //
  //  - "the card will crop the edges" was written when the Hub and related
  //    cards used object-fit: cover. Since 457f054 they use contain and crop
  //    nothing; only the event-page header still crops.
  //  - "the banner expects a wide wordmark" was the old 3:1 advice. The tile
  //    is 1.35:1, so a very wide wordmark is the case that now renders small.
  const ratio = size.height ? size.width / size.height : 0;
  if (ratio && Math.abs(ratio - s.ratio) > s.ratioTolerance) {
    notes.push(
      specKey === "eventSquare"
        ? `This is ${size.width}×${size.height}px, not square — the event page header will crop it to a square, so keep anything important away from the edges.`
        : `This is ${size.width}×${size.height}px — much wider than the tile, so it will sit as a thin band across the middle rather than filling it. It still works; a shape nearer 4:3 fills more of the tile.`
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
