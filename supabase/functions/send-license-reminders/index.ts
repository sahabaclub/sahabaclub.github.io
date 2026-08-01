// send-license-reminders
// ------------------------------------------------------------
// Runs once a day. Finds trials approaching their end date and emails the
// member, then records which stage was sent so the same warning never goes
// twice.
//
// Only 'trial' plans are chased. Lifetime and premium licences have no end
// date, and a countdown email to a coach who was given a permanent account
// would be alarming and wrong.
//
// Stages are 30, 14, 7 and 1 days out. The job picks the *smallest* stage
// the member has passed and hasn't been sent yet — so if the schedule misses
// a few days, or a trial is extended and the stage reset, nobody receives
// four emails at once.
//
// Trigger it from Supabase's scheduled functions, or pg_cron:
//   select cron.schedule('ms365-reminders', '0 8 * * *', $$
//     select net.http_post(
//       url := '<project>/functions/v1/send-license-reminders',
//       headers := jsonb_build_object('Authorization', 'Bearer <service role>')
//     );
//   $$);
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, RESEND_FROM
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "Sahaba Club <membership@sahabaclub.com>";
const SITE = "https://www.sahabaclub.ai";

const STAGES = [30, 14, 7, 1];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Scheduled job, not a public endpoint. Without this anyone could make the
  // club email its entire membership.
  const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (!SERVICE_ROLE_KEY || bearer !== SERVICE_ROLE_KEY) {
    return json({ error: "Not allowed" }, 403);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const dryRun = new URL(req.url).searchParams.get("dry") === "1";

  try {
    const today = new Date();
    const horizon = new Date(today.getTime() + 31 * 86400000).toISOString().slice(0, 10);

    // Only trials, only ones still live, only within the widest stage.
    const { data: accounts, error } = await admin
      .from("ms365_accounts")
      .select("user_id, mailbox, plan, status, license_expires_at, reminder_stage")
      .eq("plan", "trial")
      .in("status", ["active", "provisioning"])
      .not("license_expires_at", "is", null)
      .lte("license_expires_at", horizon);

    if (error) return json({ error: error.message }, 500);

    const due: Array<{ user_id: string; mailbox: string; days: number; stage: number }> = [];

    for (const a of accounts ?? []) {
      const days = Math.ceil(
        (new Date(a.license_expires_at + "T00:00:00").getTime() - today.getTime()) / 86400000
      );
      if (days < 0) continue;                       // expiry job's problem, not ours

      // The tightest stage this member has reached.
      const stage = STAGES.filter((s) => days <= s).sort((x, y) => x - y)[0];
      if (stage === undefined) continue;

      // Already sent this one, or a later (smaller) one. reminder_stage counts
      // down, so "already at or below" means nothing new to say.
      if (a.reminder_stage !== null && a.reminder_stage <= stage) continue;

      due.push({ user_id: a.user_id, mailbox: a.mailbox, days, stage });
    }

    if (dryRun) {
      return json({ ok: true, dryRun: true, wouldSend: due.length, sample: due.slice(0, 10) });
    }

    let sent = 0;
    const failures: Array<{ user_id: string; reason: string }> = [];

    for (const d of due) {
      // The address to write to is the member's sign-in email, not their new
      // mailbox — the whole point is that they may have stopped checking it.
      const { data: userRes } = await admin.auth.admin.getUserById(d.user_id);
      const email = userRes?.user?.email;
      if (!email) {
        failures.push({ user_id: d.user_id, reason: "no email on account" });
        continue;
      }

      const { data: profile } = await admin
        .from("profiles").select("full_name").eq("user_id", d.user_id).maybeSingle();

      const mail = renderReminder({
        name: firstName(profile?.full_name),
        mailbox: d.mailbox,
        days: d.days,
      });

      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + RESEND_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: RESEND_FROM, to: email, subject: mail.subject, html: mail.html }),
      });

      if (!resp.ok) {
        failures.push({ user_id: d.user_id, reason: "resend " + resp.status });
        continue;
      }

      // Recorded only after Resend accepted it. If this update fails the
      // member gets a duplicate tomorrow, which is a far better failure than
      // marking it sent and never actually warning them.
      await admin
        .from("ms365_accounts")
        .update({ reminder_stage: d.stage, last_reminder_at: new Date().toISOString() })
        .eq("user_id", d.user_id);

      sent++;
    }

    return json({ ok: true, considered: accounts?.length ?? 0, sent, failures });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

function firstName(full?: string | null) {
  if (!full) return "there";
  return full.trim().split(/\s+/)[0];
}

function renderReminder(d: { name: string; mailbox: string; days: number }) {
  const { name, mailbox, days } = d;

  const when = days <= 1 ? "tomorrow"
             : days <= 7 ? "in " + days + " days"
             : "in " + days + " days";

  const subject = days <= 1
    ? "Your Microsoft 365 account ends tomorrow"
    : days <= 7
      ? "Your Microsoft 365 account ends in " + days + " days"
      : "Your free Microsoft 365 ends " + when;

  // The pitch is what they lose and what they've built, not a discount code.
  // Someone who has been using the mailbox for three months has files in it.
  const urgency = days <= 7
    ? `<p style="margin:0 0 16px;padding:12px 14px;background:#fff6e5;border-left:3px solid #e0a83e;">
         After it ends, your files stay safe for another three months but you
         won't be able to sign in. Upgrading any time before then keeps everything
         exactly as it is.</p>`
    : "";

  const html = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;color:#1a1d26;line-height:1.6;">
      <p>Hi ${escapeHtml(name)},</p>

      <p>Your free Microsoft 365 account — <strong>${escapeHtml(mailbox)}</strong> —
         ends <strong>${when}</strong>.</p>

      ${urgency}

      <p>Sahaba Club Premium is <strong>$10 a month</strong> and keeps it running, along with:</p>

      <ul style="padding-left:18px;">
        <li>Your Microsoft 365 account, for as long as you're a member</li>
        <li>Discounts on paid events, hackathons and 1:1 coaching</li>
        <li>Premium-only events and sessions</li>
      </ul>

      <p style="margin:26px 0;">
        <a href="${SITE}/membership.html"
           style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;display:inline-block;">
          Go Premium — $10/month
        </a>
      </p>

      <p style="color:#5a6172;font-size:14px;">
        Not ready? That's fine — your Sahaba Club membership stays free forever, and you
        keep full access to events, your profile and the community.
      </p>

      <p style="color:#5a6172;font-size:14px;">— Sahaba Club</p>
    </div>
  `;

  return { subject, html };
}

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
