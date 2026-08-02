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
import { corsHeaders } from "../_shared/cors.ts";
import {
  AVATAR_BUCKET,
  buildPrompt,
  currentCycle,
  decodeBase64,
  extFor,
  MAX_ATTEMPTS,
  themeForCycle,
  uploadFallback,
} from "../_shared/avatar-art.ts";

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
