// send-campaign
// ------------------------------------------------------------
// Sends the drafts a human has already approved. Nothing else.
//
// This is a separate function from write-contact-email because generating and
// sending are separate decisions, and from send-transactional-email because
// that one is service-role-only — it takes an arbitrary `to` address, so it
// deliberately cannot be reached from a browser at all. This one can be
// called by staff, so it never takes an address as input: it only ever mails
// the address stored on a recipient row that is already marked 'approved'.
//
// Sends in batches. A 900-person campaign is many calls, and that is the
// right shape: it means a mistake noticed after the first fifty costs fifty
// emails, not nine hundred.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   RESEND_API_KEY, RESEND_FROM
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "Sahaba Club <membership@sahabaclub.com>";
const SITE = "https://www.sahabaclub.ai";

const DEFAULT_BATCH = 25;
const MAX_BATCH = 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData.user) return json({ error: "Not signed in" }, 401);

    const { data: callerProfile } = await admin
      .from("profiles").select("role").eq("user_id", userData.user.id).maybeSingle();
    if (!callerProfile || (callerProfile.role !== "admin" && callerProfile.role !== "staff")) {
      return json({ error: "Club staff only" }, 403);
    }

    if (!RESEND_API_KEY) {
      return json({ error: "Email sending isn't configured. Set RESEND_API_KEY." }, 503);
    }

    const body = await req.json().catch(() => ({}));
    const campaignId: string | undefined = body.campaignId;
    const test: boolean = body.test === true;
    const batch = Math.min(Math.max(Number(body.limit) || DEFAULT_BATCH, 1), MAX_BATCH);
    if (!campaignId) return json({ error: "campaignId is required" }, 400);

    const { data: campaign } = await admin
      .from("campaigns")
      .select("id, name, from_name, from_email, reply_to, status")
      .eq("id", campaignId)
      .maybeSingle();
    if (!campaign) return json({ error: "Campaign not found" }, 404);
    if (campaign.status === "cancelled") {
      return json({ error: "This campaign was cancelled." }, 409);
    }

    // A test send goes to the person clicking the button and nobody else, so
    // they can see a real draft arrive in a real inbox before committing.
    if (test) {
      const { data: sample } = await admin
        .from("campaign_recipients")
        .select("subject, body_text, full_name")
        .eq("campaign_id", campaignId)
        .in("status", ["generated", "approved"])
        .limit(1)
        .maybeSingle();
      if (!sample) return json({ error: "No drafts to preview yet." }, 400);

      const to = userData.user.email;
      if (!to) return json({ error: "Your account has no email address to send a test to." }, 400);

      const resp = await sendOne({
        from: fromHeader(campaign),
        replyTo: campaign.reply_to,
        to,
        subject: "[TEST] " + sample.subject,
        text: sample.body_text ?? "",
        unsubscribeToken: null,
      });
      if (!resp.ok) return json({ error: "Resend refused the test: " + resp.detail }, 502);
      return json({ ok: true, test: true, to });
    }

    // Only approved drafts. 'generated' is not enough — that is the whole
    // point of the review step existing.
    const { data: recipients, error: rErr } = await admin
      .from("campaign_recipients")
      .select("id, contact_id, email, subject, body_text")
      .eq("campaign_id", campaignId)
      .eq("status", "approved")
      .limit(batch);
    if (rErr) return json({ error: rErr.message }, 500);

    if (!recipients?.length) {
      const { count: left } = await admin
        .from("campaign_recipients")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaignId)
        .eq("status", "approved");
      if ((left ?? 0) === 0) {
        await admin.from("campaigns")
          .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", campaignId)
          .in("status", ["review", "sending"]);
      }
      return json({ ok: true, sent: 0, failed: 0, remaining: 0, done: true });
    }

    await admin.from("campaigns")
      .update({ status: "sending", updated_at: new Date().toISOString() })
      .eq("id", campaignId)
      .in("status", ["review", "generating", "draft"]);

    // Re-check consent at the moment of sending. Between approval and send a
    // person can unsubscribe, and the approved draft sitting in the table
    // knows nothing about that.
    const { data: contacts } = await admin
      .from("marketing_contacts")
      .select("id, unsubscribed_at, bounced_at, is_test, email_valid, unsubscribe_token")
      .in("id", recipients.map((r) => r.contact_id));
    const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const r of recipients) {
      const c = contactById.get(r.contact_id);
      if (!c || c.unsubscribed_at || c.bounced_at || c.is_test || !c.email_valid) {
        await admin.from("campaign_recipients").update({
          status: "skipped",
          error: c?.unsubscribed_at ? "Unsubscribed before this send" : "No longer mailable",
          updated_at: new Date().toISOString(),
        }).eq("id", r.id);
        skipped++;
        continue;
      }

      if (!r.subject || !r.body_text) {
        await admin.from("campaign_recipients").update({
          status: "failed", error: "Draft is empty", updated_at: new Date().toISOString(),
        }).eq("id", r.id);
        failed++;
        continue;
      }

      const resp = await sendOne({
        from: fromHeader(campaign),
        replyTo: campaign.reply_to,
        to: r.email,
        subject: r.subject,
        text: r.body_text,
        unsubscribeToken: c.unsubscribe_token,
      });

      if (resp.ok) {
        await admin.from("campaign_recipients").update({
          status: "sent", sent_at: new Date().toISOString(), error: null,
          updated_at: new Date().toISOString(),
        }).eq("id", r.id);
        sent++;
      } else {
        console.error("Resend failed for recipient " + r.id + ": " + resp.detail);
        await admin.from("campaign_recipients").update({
          status: "failed", error: resp.detail.slice(0, 500),
          updated_at: new Date().toISOString(),
        }).eq("id", r.id);
        failed++;
      }
    }

    const { count: remaining } = await admin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "approved");

    if ((remaining ?? 0) === 0) {
      await admin.from("campaigns")
        .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", campaignId);
    }

    return json({ ok: true, sent, failed, skipped, remaining: remaining ?? 0, done: (remaining ?? 0) === 0 });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

function fromHeader(campaign: { from_name?: string; from_email?: string }) {
  if (campaign.from_name && campaign.from_email) {
    return `${campaign.from_name} <${campaign.from_email}>`;
  }
  return RESEND_FROM;
}

async function sendOne(opts: {
  from: string;
  replyTo?: string | null;
  to: string;
  subject: string;
  text: string;
  unsubscribeToken: string | null;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const unsubUrl = opts.unsubscribeToken
    ? `${SITE}/unsubscribe.html?t=${opts.unsubscribeToken}`
    : null;

  // The footer is appended here rather than asked of the model, so it is
  // identical on every email and cannot be paraphrased away. A marketing
  // email without a working opt-out is the fastest route to a blocked domain.
  const text = unsubUrl
    ? `${opts.text}\n\n—\nYou're receiving this because you registered for a Sahaba Club event.\nUnsubscribe: ${unsubUrl}`
    : opts.text;

  const html = unsubUrl
    ? `${toHtml(opts.text)}<hr style="border:none;border-top:1px solid #e5e7eb;margin:26px 0 14px;">` +
      `<p style="font-size:12px;color:#6b7280;line-height:1.6;margin:0;">` +
      `You're receiving this because you registered for a Sahaba Club event.<br>` +
      `<a href="${unsubUrl}" style="color:#6b7280;">Unsubscribe</a></p>`
    : toHtml(opts.text);

  const payload: Record<string, unknown> = {
    from: opts.from,
    to: opts.to,
    subject: opts.subject,
    text,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;` +
          `font-size:15px;line-height:1.65;color:#111827;max-width:560px;">${html}</div>`,
  };
  if (opts.replyTo) payload.reply_to = opts.replyTo;

  // List-Unsubscribe is what makes Gmail and Outlook show their own
  // one-click unsubscribe control. People who can unsubscribe easily do that
  // instead of pressing "spam", and it is the spam presses that cost us the
  // domain.
  if (unsubUrl) {
    payload.headers = {
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (resp.ok) return { ok: true };
  return { ok: false, detail: resp.status + " " + (await resp.text()) };
}

// The drafts are plain text by design — they read like a person wrote them,
// not like a template. This is the minimum needed to keep the paragraphs
// apart in an HTML client.
function toHtml(text: string) {
  const escaped = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
