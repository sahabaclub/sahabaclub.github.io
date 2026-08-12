// linkedin-daily-events
// ------------------------------------------------------------
// Emails Ghadir a ready-to-paste LinkedIn post about TOMORROW's events, every
// night at 22:00 Dubai, with the event images attached. She posts it by hand.
//
// ⚠ THE NAME IS NOW HALF RIGHT AND IT IS KEPT ON PURPOSE. This started on
// 11 Aug as a job that posted to LinkedIn through the API; Ahmed changed the
// plan the same day. Renaming a deployed function means deleting the old one
// and leaving an orphan behind on the dashboard, which is a worse trade than a
// name that needs one sentence of explanation. It still produces the LinkedIn
// post; it just hands it to a person instead of an API.
//
// ---- Why the email route is better, not merely different --------------
//
// The API route was blocked behind LinkedIn's Community Management API — an
// approval measured in days, for a token that then expires on LinkedIn's
// schedule and takes the job down when it does. Email needs no approval, no
// token, and no permission LinkedIn can withdraw. It also puts a person
// between the database and the company page, which for a post naming other
// organisations' events is exactly where a person should be.
//
// ---- The decisions, all Ahmed's --------------------------------------
//
//   * TOMORROW's events, not today's. The email lands at 22:00 so there is a
//     night to read it and post before the day starts.
//   * Every published event on that date, whoever runs it.
//   * One post, simply written, with ONE call to action pointing at the
//     website. Not a link per event: LinkedIn favours a single link, and the
//     events page is where every event is anyway.
//   * A short note on a night with nothing on, rather than silence. Somebody
//     is waiting for this email; silence and a broken job look identical.
//
// Secrets (see section 7 of SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   RESEND_API_KEY, RESEND_FROM              — already set, shared with the other senders
//   BRIEF_TO    — comma-separated. Defaults below.
//   BRIEF_CC    — comma-separated. Defaults below.
//
//   POST /linkedin-daily-events?dry=1     compose and return, send nothing
//   POST /linkedin-daily-events           the real run, once per day
//   POST /linkedin-daily-events?date=YYYY-MM-DD   a specific day, for testing
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "Sahaba Club <members@sahabaclub.com>";

// The shared token pg_cron calls with. Already set on this project and already
// used by the two notification senders — see the gate below for why it exists
// rather than the service role key.
const SENDER_TOKEN = Deno.env.get("SENDER_TOKEN") ?? "";

// ⚠ RECIPIENTS ARE A SECRET, NOT A CONSTANT, and there is a specific reason.
// `ghadir@sahabaclub.com` is the address Ahmed asked for and NOBODY HAS
// CONFIRMED IT EXISTS — it is not in `ms365_accounts`, where every other club
// mailbox is. Her verified address is the gmail one. Both are here so the
// brief cannot vanish into a mailbox that was never created, and they are a
// secret so that can be corrected in one command without a deploy.
const BRIEF_TO = (Deno.env.get("BRIEF_TO") ?? "ghadir@sahabaclub.com,ghadeer.aldesouky@gmail.com")
  .split(",").map((s) => s.trim()).filter(Boolean);
const BRIEF_CC = (Deno.env.get("BRIEF_CC") ?? "ahmed@sahabaclub.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const SITE = "https://www.sahabaclub.ai";
const CLUB_TZ = "Asia/Dubai";

// Resend's ceiling is 40MB for the whole message. This is deliberately well
// under it: a brief that fails to send because six conference banners were
// 7MB each is a brief nobody reads.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// ⚠ TOMORROW IN ASIA/DUBAI, NOT UTC, AND AT 22:00 THAT IS THE WHOLE POINT.
// 22:00 Dubai is 18:00 UTC the same day, so a UTC-based "tomorrow" would be
// right tonight and wrong the moment the schedule moved an hour either way.
// `events.event_date` is a plain date somebody wrote thinking in local time,
// so the question has to be asked in local time.
function clubDatePlus(days: number): string {
  const now = new Date();
  const shifted = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CLUB_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(shifted);
}

function prettyDate(iso: string): string {
  // Noon avoids the date sliding either way when this is rendered in a zone
  // behind or ahead of the club's.
  const d = new Date(iso + "T12:00:00Z");
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: CLUB_TZ, weekday: "long" }).format(d);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: CLUB_TZ, day: "numeric" }).format(d);
  const month = new Intl.DateTimeFormat("en-GB", { timeZone: CLUB_TZ, month: "long" }).format(d);
  return `${weekday} ${day} ${month}`;
}

type EventRow = {
  slug: string;
  title: string;
  time_label: string | null;
  mode: string | null;
  location: string | null;
  country: string | null;
  price_label: string | null;
  image_url: string | null;
};

// ---- The post Ghadir pastes -------------------------------------------
//
// Simple, scannable, one call to action. No event URLs in the body: LinkedIn
// treats a single link better than several, and every one of these events is
// on the events page anyway. The CTA is the only link, and it is the point of
// the whole post.
function composePost(day: string, events: EventRow[]): string {
  const when = prettyDate(day);
  const heading = events.length === 1
    ? `One AI event tomorrow — ${when}`
    : `${events.length} AI events tomorrow — ${when}`;

  const lines = events.map((e) => {
    const where = e.mode === "Online"
      ? "Online"
      : [e.location, e.country].filter(Boolean).join(", ") || (e.mode ?? "");
    const facts = [e.time_label, where, e.price_label].filter(Boolean).join("  ·  ");
    return facts ? `▸ ${e.title}\n   ${facts}` : `▸ ${e.title}`;
  });

  return [
    heading,
    "",
    lines.join("\n\n"),
    "",
    "Times, full details and how to register — all of them are on the site:",
    `${SITE}/events.html`,
    "",
    "Sahaba Club — the AI universe in the shape of a club.",
    "",
    "#AI #ArtificialIntelligence #Dubai #TechCommunity #SahabaClub",
  ].join("\n");
}

// The email around it. Ghadir's job is copy, paste, attach — so the post sits
// in one block she can select in a single drag, and nothing else in the mail
// is selectable text that could come with it.
function composeEmail(day: string, events: EventRow[], post: string, images: { filename: string; url: string }[]) {
  const when = prettyDate(day);
  const rows = images.map((img) => `
    <div style="margin:0 0 10px">
      <img src="${escapeHtml(img.url)}" alt="" style="max-width:260px;border-radius:8px;border:1px solid #ddd">
      <div style="font:12px/1.4 Arial,sans-serif;color:#666">${escapeHtml(img.filename)}</div>
    </div>`).join("");

  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7fb;font:15px/1.6 Arial,sans-serif;color:#1a1a2e">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:26px">
    <p style="margin:0 0 4px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#5B3DF5;font-weight:bold">Sahaba Club</p>
    <h1 style="margin:0 0 6px;font-size:21px">Tomorrow's post — ${escapeHtml(when)}</h1>
    <p style="margin:0 0 20px;color:#555">${events.length} event${events.length === 1 ? "" : "s"} to announce.
       Copy the text below, attach the ${images.length} image${images.length === 1 ? "" : "s"} from this email, and post to LinkedIn.</p>

    <p style="margin:0 0 6px;font-weight:bold">The post</p>
    <pre style="margin:0 0 22px;padding:16px;background:#f4f2fd;border:1px solid #ddd8f5;border-radius:8px;
                white-space:pre-wrap;word-wrap:break-word;font:14px/1.65 Arial,sans-serif;color:#1a1a2e">${escapeHtml(post)}</pre>

    ${images.length ? `<p style="margin:0 0 8px;font-weight:bold">The images (attached to this email)</p>${rows}` : ""}

    <p style="margin:22px 0 0;font-size:13px;color:#777">
      Sent automatically at 22:00 Dubai time, the night before. Nobody needs to reply to this.
    </p>
  </div>
</body></html>`;
}

// Fetch each image and hand Resend the bytes rather than a URL. A link would
// be smaller, but an attachment Ghadir can drag straight into LinkedIn is the
// entire job — and it also means a broken image is discovered here, tonight,
// rather than by her at posting time.
async function collectAttachments(events: EventRow[]) {
  const attachments: { filename: string; content: string }[] = [];
  const previews: { filename: string; url: string }[] = [];
  const skipped: string[] = [];
  let total = 0;

  for (const e of events) {
    if (!e.image_url) { skipped.push(`${e.slug}: no image on the event`); continue; }
    try {
      const res = await fetch(e.image_url);
      if (!res.ok) { skipped.push(`${e.slug}: image returned ${res.status}`); continue; }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (total + buf.byteLength > MAX_ATTACHMENT_BYTES) {
        skipped.push(`${e.slug}: image skipped, the mail was getting too large`);
        continue;
      }
      total += buf.byteLength;

      const type = res.headers.get("content-type") ?? "";
      const ext = /jpe?g/i.test(type) ? "jpg" : /webp/i.test(type) ? "webp" : /gif/i.test(type) ? "gif" : "png";
      const filename = `${e.slug.slice(0, 60)}.${ext}`;

      // ⚠ CHUNKED. `String.fromCharCode(...bytes)` throws RangeError on a file
      // of any size — the same trap the avatar encoder hit, where the symptom
      // looked like a corrupt upload rather than a stack overflow.
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
      }
      attachments.push({ filename, content: btoa(binary) });
      previews.push({ filename, url: e.image_url });
    } catch (err) {
      skipped.push(`${e.slug}: could not fetch the image (${String(err).slice(0, 80)})`);
    }
  }
  return { attachments, previews, skipped, totalBytes: total };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!SERVICE_ROLE_KEY) return json({ error: "Not configured" }, 503);

    // ---- Who may run this ----
    //
    // Two kinds of caller, and they need different answers:
    //
    //   the scheduler   pg_cron, holding a shared token
    //   a human         staff, pressing it to see a dry run
    //
    // ⚠ THE SCHEDULER CHECK IS `SENDER_TOKEN` FIRST, AND THIS PROJECT LEARNED
    // THAT THE EXPENSIVE WAY. The value Supabase injects as
    // SUPABASE_SERVICE_ROLE_KEY matches NONE of the keys the dashboard offers,
    // so a job gated on that value alone returns 403 to every scheduled call —
    // proven by digest comparison in `send-notification-emails`, which carries
    // the full account. The first draft of this file had exactly that bug and
    // would have failed silently every night at 22:00.
    //
    // ⚠ Deployed with --no-verify-jwt, like the other two scheduled senders,
    // because a shared token is not a JWT and the gateway would reject it
    // before this code ran. The staff path below verifies its own JWT, so
    // nothing is weakened by that: an unsigned caller with no token still
    // reaches nothing.
    const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
    if (!bearer) return json({ error: "Not signed in" }, 401);

    const schedulerToken = SENDER_TOKEN || SERVICE_ROLE_KEY;
    const isScheduler = Boolean(schedulerToken) && bearer === schedulerToken;

    if (!isScheduler) {
      const { data: userData, error: userError } = await admin.auth.getUser(bearer);
      if (userError || !userData?.user) return json({ error: "Not signed in" }, 401);
      const asCaller = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        global: { headers: { Authorization: `Bearer ${bearer}` } },
      });
      const { data: isStaff, error: gateError } = await asCaller.rpc("is_staff");
      if (gateError) return json({ error: "Could not check permissions" }, 500);
      if (isStaff !== true) return json({ error: "Not allowed" }, 403);
    }

    const params = new URL(req.url).searchParams;
    const dryRun = params.get("dry") === "1";
    // ⚠ A REAL SEND THAT GOES ONLY TO THE CC AND CLAIMS NOTHING. Somebody has
    // to see this arrive in a mail client before it is trusted to run
    // unattended — a dry run proves the text, not that Resend accepts an 8MB
    // attachment or that the images survive the trip. Ghadir is deliberately
    // NOT on a test: an unexpected 'post this tomorrow' email at the wrong
    // hour is exactly the confusion this job exists to remove. Same reasoning
    // as the campaign test send, which marks its stand-in drafts rather than
    // mailing real recipients.
    const testOnly = params.get("test") === "1";
    const day = params.get("date") || clubDatePlus(1);

    // ⚠ ONE PLACE DECIDES WHO GETS IT, AND EVERY REPORT READS FROM HERE.
    // The first version worked out the recipients inside the Resend payload
    // and then described them separately in the response — so a test that
    // correctly went to Ahmed alone REPORTED that it had gone to Ghadir. A
    // receipt that names the wrong recipient is worse than no receipt: it is
    // the thing somebody checks before believing a person was or was not
    // emailed.
    const recipients = testOnly
      ? { to: BRIEF_CC, cc: [] as string[] }
      : { to: BRIEF_TO, cc: BRIEF_CC };

    const { data: rows, error: evErr } = await admin
      .from("events")
      .select("slug, title, time_label, mode, location, country, price_label, image_url")
      .eq("is_published", true)
      .eq("event_date", day)
      .order("time_label", { ascending: true, nullsFirst: false })
      .order("title", { ascending: true });
    if (evErr) return json({ error: evErr.message }, 500);

    const events = (rows ?? []) as EventRow[];
    const empty = events.length === 0;

    const post = empty ? "" : composePost(day, events);
    const { attachments, previews, skipped } = empty
      ? { attachments: [], previews: [], skipped: [] as string[] }
      : await collectAttachments(events);

    const subject = (testOnly ? "[TEST] " : "") + (empty
      ? `No events tomorrow — ${prettyDate(day)}`
      : `LinkedIn post for tomorrow — ${events.length} event${events.length === 1 ? "" : "s"}, ${prettyDate(day)}`);

    const html = empty
      ? `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7fb;font:15px/1.6 Arial,sans-serif;color:#1a1a2e">
           <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:26px">
             <p style="margin:0 0 4px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#5B3DF5;font-weight:bold">Sahaba Club</p>
             <h1 style="margin:0 0 8px;font-size:21px">Nothing on tomorrow</h1>
             <p style="margin:0 0 6px;color:#555">No events are listed for ${escapeHtml(prettyDate(day))}, so there is no post to make.</p>
             <p style="margin:0;color:#777;font-size:13px">This note exists so you know the job ran. The next one is tomorrow at 22:00.</p>
           </div></body></html>`
      : composeEmail(day, events, post, previews);

    if (dryRun) {
      return json({
        ok: true, day, dryRun: true, sent: false,
        event_count: events.length, to: recipients.to, cc: recipients.cc, subject,
        attachments: attachments.map((a) => a.filename), skipped,
        post,
      });
    }

    // ---- Claim the day BEFORE sending ----
    //
    // ⚠ Claim first, send second. A retry, an overlapping run or somebody
    // pressing the button twice collides on the primary key instead of putting
    // a second copy in Ghadir's inbox. 0063's note has the longer argument.
    //
    // ⚠ A TEST CLAIMS NOTHING. It must be possible to send yourself a sample
    // of tomorrow without that consuming tomorrow — otherwise the one action a
    // person takes to check the job is the action that stops the job running.
    const { error: claimErr } = testOnly ? { error: null } : await admin.from("linkedin_daily_posts").insert({
      post_date: day,
      status: "claimed",
      body: post || null,
      event_slugs: events.map((e) => e.slug),
      event_count: events.length,
    });
    if (claimErr) {
      const already = String(claimErr.code) === "23505";
      return json(
        already ? { ok: true, day, sent: false, reason: "already handled today" } : { error: claimErr.message },
        already ? 200 : 500,
      );
    }

    if (!RESEND_API_KEY) {
      await admin.from("linkedin_daily_posts")
        .update({ status: "email_failed", error: "RESEND_API_KEY is not set" }).eq("post_date", day);
      return json({ ok: false, day, sent: false, error: "RESEND_API_KEY is not set" }, 503);
    }

    let res: Response;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: RESEND_FROM,
          to: recipients.to,
          ...(recipients.cc.length ? { cc: recipients.cc } : {}),
          subject,
          html,
          ...(attachments.length ? { attachments } : {}),
        }),
      });
    } catch (netErr) {
      const message = "could not reach Resend: " + String(netErr);
      await admin.from("linkedin_daily_posts")
        .update({ status: "email_failed", error: message }).eq("post_date", day);
      return json({ ok: false, day, sent: false, error: message }, 502);
    }

    if (!res.ok) {
      // Resend's raw refusal, kept whole: an unverified sending domain, a
      // rejected recipient and an oversized attachment are three different
      // fixes and the sentence that tells them apart is in there.
      const detail = (await res.text()).slice(0, 1000);
      await admin.from("linkedin_daily_posts")
        .update({ status: "email_failed", error: `${res.status}: ${detail}` }).eq("post_date", day);
      console.error(`linkedin-daily-events: Resend ${res.status}: ${detail}`);
      return json({ ok: false, day, sent: false, status: res.status, error: detail }, 502);
    }

    const sentBody = await res.json().catch(() => ({}));
    if (!testOnly) await admin.from("linkedin_daily_posts").update({
      status: empty ? "skipped_empty" : "emailed",
      post_urn: sentBody?.id ?? null,
      posted_at: new Date().toISOString(),
    }).eq("post_date", day);

    return json({
      ok: true, day, sent: true, empty,
      event_count: events.length, to: recipients.to, cc: recipients.cc,
      attachments: attachments.map((a) => a.filename), skipped,
      resend_id: sentBody?.id ?? null,
    });
  } catch (err) {
    console.error(err);
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
