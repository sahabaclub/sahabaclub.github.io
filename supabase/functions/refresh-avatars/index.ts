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
//   OPENAI_API_KEY    — when the configured model is an OpenAI one
//   GEMINI_API_KEY    — when it is a Google one; whichever the model needs
//   OPENAI_IMAGE_MODEL                       — optional, same default as generate-avatar
//
// Since 0031 the artwork and the image model can also be set from Admin → AI
// services. ⚠ This function and `generate-avatar` read the SAME service row —
// `avatar-art` — which is the whole point: the wall and the individual
// portraits have to be the same artwork, and the panel is not able to give
// them two. The secret above and the constants in `_shared/avatar-art.ts`
// remain the floor for both.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { listOf, loadAiConfig, part } from "../_shared/ai-config.ts";
import { callImage, type Provider, providerConfigured } from "../_shared/ai-provider.ts";
import {
  AVATAR_ART_DEFAULTS,
  AVATAR_BUCKET,
  buildPrompt,
  currentCycle,
  HOUSE_STYLE,
  themeForCycle,
  THEMES,
  uploadFallback,
  VARIANTS,
} from "../_shared/avatar-art.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// ⚠ No OPENAI_API_KEY constant here any more, deliberately: since this
// function draws through `callImage()`, the key is chosen by that module from
// the provider it is routing to — OPENAI_API_KEY or GEMINI_API_KEY. A copy
// read here would be the OpenAI one regardless of which API the run uses, and
// the precondition below would then be asking about the wrong secret.
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

// The one failure that is worth distinguishing by type rather than by reading
// its message: it is true for the whole batch, not for the member it happened
// to surface on, so the loop stops instead of confirming it several hundred
// times. See `generate` and the catch in the batch loop.
class QuotaExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExhausted";
  }
}

type DueRow = {
  user_id: string;
  full_name: string | null;
  interests: string[] | null;
  skills: string[] | null;
  industry: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Not a public endpoint. Without a gate any visitor could make the club
  // regenerate several hundred images, which is a bill rather than a
  // defacement, and this function writes avatars for members other than the
  // caller by design.
  //
  // TWO WAYS IN, and the second one exists because the first turned out to be
  // unusable by a human:
  //
  //   1. The service-role key — the scheduled path, unchanged.
  //
  //   2. A STAFF SESSION. Added 8 Aug 2026.
  //
  // ⚠ The original comment here said "nothing legitimate reaches it from a
  // browser", and on 8 Aug something did: a staff-initiated restart of the
  // whole avatar system, which is precisely the sort of thing a club admin
  // should be able to set off and precisely the sort of thing nobody wants on
  // a cron. Worse, the service-role branch cannot be exercised by hand at all
  // — `SUPABASE_SERVICE_ROLE_KEY` is INJECTED BY SUPABASE and is not the value
  // on either dashboard page, which is the discovery that cost 7 Aug most of a
  // day and led to `SENDER_TOKEN` in the two notification senders. Pasting the
  // dashboard's service_role key here returns 403 forever and the message
  // gives you no clue why.
  //
  // So this asks `is_staff()` as the CALLER — the same universal gate the rest
  // of the admin surface uses, never a hardcoded list of role names, which
  // this project has got wrong twice. A member token reaches nothing.
  const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!SERVICE_ROLE_KEY) return json({ error: "Not configured" }, 503);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  if (bearer !== SERVICE_ROLE_KEY) {
    if (!bearer) return json({ error: "Not allowed" }, 403);

    const { data: userData, error: userErr } = await admin.auth.getUser(bearer);
    if (userErr || !userData?.user) {
      console.error("refresh-avatars: not the service key and not a valid session");
      return json({ error: "Not allowed" }, 403);
    }

    // is_staff() reads auth.uid(), which is null on an admin client — it has
    // to be asked through a client carrying the caller's own token.
    const asCaller = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const { data: staff, error: staffErr } = await asCaller.rpc("is_staff");
    if (staffErr) {
      console.error("refresh-avatars: is_staff failed: " + staffErr.message);
      return json({ error: "Could not check permissions" }, 500);
    }
    if (staff !== true) {
      console.error(`user ${userData.user.id} attempted to reach refresh-avatars`);
      return json({ error: "Not allowed" }, 403);
    }
  }
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

  // ⚠ Which API this model belongs to, ASKED rather than guessed. `ai_models`
  // records the provider that listed the model, so it is the answer the
  // listing API actually gave; `providerFor()`'s regex is the fallback for a
  // model that is not in the table. Read ONCE per run, not per member — the
  // whole batch draws with one model.
  const { data: modelRow } = await admin
    .from("ai_models")
    .select("provider")
    .eq("id", imageModel)
    .maybeSingle();
  const imageProvider: Provider | null =
    modelRow?.provider === "google" || modelRow?.provider === "openai" ? modelRow.provider : null;

  const art = {
    house_style: part(ai, "house_style", HOUSE_STYLE),
    variants: listOf(ai, "variants", VARIANTS),
  };
  const theme = themeForCycle(cycle, listOf(ai, "themes", THEMES));

  try {
    // ⚠ Asks about the key for the provider THIS RUN will actually use. It
    // checked OPENAI_API_KEY unconditionally, which since the switch would
    // refuse a perfectly configured Google run for a missing OpenAI key — and,
    // worse in the other direction, would let a Google run start with no
    // GEMINI_API_KEY and fail one member at a time.
    const runProvider: Provider = imageProvider ?? "openai";
    if (!dryRun && !providerConfigured(runProvider)) {
      console.error(`no API key for provider ${runProvider}`);
      return json({
        error: runProvider === "google"
          ? "GEMINI_API_KEY is not set, and the avatar model configured in Admin → AI services is a Google one."
          : "Avatar generation isn't configured yet — OPENAI_API_KEY is not set.",
      }, 503);
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
    let quotaExhausted = false;

    for (const row of batch) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        ranOutOfTime = true;
        break;
      }

      try {
        const written = await refreshOne(
          admin, row, avatarUrls.get(row.user_id) ?? "", cycle, theme, art, imageModel, imageProvider,
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

        // ⚠ An exhausted balance is not this member's problem and will not
        // clear for the next one. Working through the rest of the batch would
        // be several hundred requests to be told the same thing, and it would
        // bury the one line an operator needs to read.
        if (err instanceof QuotaExhausted) {
          quotaExhausted = true;
          break;
        }
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
    //
    // An exhausted balance joins that list for the same reason and more
    // strongly: it is the one failure guaranteed to still be true on the next
    // call. Without it a batch that drew twenty people and then ran dry would
    // report `processed > 0`, the scheduler would loop, and the whole remaining
    // membership would be walked one paid-for 429 at a time.
    const done = remaining === 0 || quotaExhausted || (processed === 0 && !ranOutOfTime);

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
      quotaExhausted,
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
  imageProvider: Provider | null,
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
  const drawn = await generate(sourceBytes, prompt, imageModel, imageProvider);

  // Generated art rather than a photograph, but zeroed on the same principle
  // as generate-avatar: the input to an image call does not outlive the call.
  sourceBytes.fill(0);
  sourceBytes = new Uint8Array(0);

  // A new path each month rather than an overwrite, so the public URL changes
  // and no CDN anywhere serves last month's face. Same `<user_id>/` prefix,
  // so the storage policies in 0016 cover it unchanged.
  //
  // ⚠ The extension FOLLOWS the bytes, it is not assumed — d03f5e1's finding on
  // the member path applies identically here: Gemini returns JPEG, and storing
  // JPEG under a .png name with a PNG content type "works" only because
  // browsers sniff the real bytes. 0016's bucket allows png, jpeg and webp, so
  // there was never a reason to mislabel it.
  const outType = drawn.mediaType || "image/png";
  const outExt = /jpe?g/i.test(outType) ? "jpg" : /webp/i.test(outType) ? "webp" : "png";
  const path = `${row.user_id}/${crypto.randomUUID()}.${outExt}`;
  const { error: upErr } = await admin.storage
    .from(AVATAR_BUCKET)
    .upload(path, drawn.bytes, { contentType: outType, upsert: false });
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

// ---- The image call ---------------------------------------------------

// The edits endpoint again, with the member's existing avatar as the image
// input. Errors here are read from a log by whoever is watching the batch,
// not by a member staring at a spinner, so the triage is shorter than
// generate-avatar's and phrased for the operator.
//
// ⚠ THROUGH callImage() SINCE 10 AUG 2026, and the reason is worth keeping.
// This function was deliberately left on OpenAI when generate-avatar moved —
// "blast radius of one first" — and that was right while the shared
// `avatar-art` config still named an OpenAI model. It stopped being right the
// moment `nano-banana-pro-preview` was activated: 0031 gives generate-avatar
// and refresh-avatars ONE configuration on purpose, so activating a Google
// model pointed this function's OpenAI call at a model OpenAI has never heard
// of. Every member in the next monthly run would have failed with "the image
// model chosen in Admin → AI services is not one this account can use" — an
// accurate message about a setting that was correct.
//
// The lesson is the coupling, not the model: a shared configuration means the
// two functions must agree about what a model IS, so they now share the same
// router as well as the same house style.
//
// ⚠ The provider is PASSED, not guessed. `providerFor()` is a regex over the
// model name, and d03f5e1 is the record of what that costs — it did not know
// `nano-banana`, so the panel called it Google and generate-avatar called it
// OpenAI. `ai_models.provider` is what the listing API actually said, and this
// function can reach the database, so it asks. The regex stays as the fallback
// for a model that is not in the table.
async function generate(
  bytes: Uint8Array,
  prompt: string,
  model: string,
  provider: Provider | null,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const result = await callImage({
    model,
    provider: provider ?? undefined,
    prompt,
    image: bytes,
    // ⚠ The stored avatar is whatever the last run wrote, which since d03f5e1
    // may be JPEG rather than PNG. Naming it png here would hand OpenAI a file
    // whose extension contradicts its bytes.
    mediaType: "image/png",
    // OpenAI-only; callImage does not forward them to Google.
    size: "1024x1024",
    quality: "high",
  });

  if (!result.ok) {
    const detail = String(result.error ?? "");
    const res = { status: result.status };
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
    // ⚠ QUOTA IS MATCHED BEFORE THE 429, the same ordering the five contract
    // functions use. OpenAI reports an exhausted balance as HTTP 429 with
    // `insufficient_quota` in the body; nothing here matched it, so a spent
    // balance arrived as "rate limited" — a transient-sounding reason recorded
    // against every member in the batch in turn, each one costing a request to
    // discover the same thing. It is thrown as its own type so the batch loop
    // can stop rather than work through several hundred people.
    if (/insufficient_quota|billing_hard_limit|exceeded your current quota|billing_not_active|balance is spent/i.test(detail)) {
      // ⚠ Names the provider that actually refused, because there are two now
      // and topping up the wrong account fixes nothing.
      throw new QuotaExhausted(`the ${result.provider} account is out of credit — top it up and re-run`);
    }
    if (res.status === 401 || res.status === 403 || /invalid_api_key|incorrect api key/i.test(detail)) {
      throw new Error(
        result.provider === "google" ? "Google rejected GEMINI_API_KEY" : "OpenAI rejected OPENAI_API_KEY",
      );
    }
    if (res.status === 429) throw new Error("rate limited");
    throw new Error(result.provider + " " + res.status + ": " + detail.slice(0, 200));
  }

  // callImage already decoded the base64 and already treats a 200 carrying no
  // image as a failure — the shape a Gemini refusal takes — so reaching here
  // means there are bytes.
  if (!result.bytes || !result.bytes.length) throw new Error("no image came back");
  return { bytes: result.bytes, mediaType: result.mediaType || "image/png" };
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
