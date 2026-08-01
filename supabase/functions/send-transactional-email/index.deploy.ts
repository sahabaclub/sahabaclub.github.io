// ⚠ GENERATED — do not edit. Deploy-time twin of index.ts with ../_shared/*
// inlined, because the Supabase dashboard editor cannot resolve relative
// imports outside the function directory. Edit index.ts and regenerate.
// send-transactional-email
// ------------------------------------------------------------
// One function, one job: hand a template + data to Resend. Called from
// other Edge Functions (provision-ms365 today; booking confirmations
// and event reminders land here too once those phases start) rather
// than from the browser, so the Resend API key never reaches the client.
//
// Secrets this function needs (see SETUP.md):
//   RESEND_API_KEY
//   RESEND_FROM   — e.g. "Sahaba Club <members@sahabaclub.com>"
const corsHeaders = {  "Access-Control-Allow-Origin": "*",  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",};

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "Sahaba Club <members@sahabaclub.com>";

type TemplateName = "welcome" | "ms365_credential" | "ms365_reset_request";

// The ms365_reset_request template interpolates a member's own name and the
// free-text "how did you hear about us" they typed on a form years ago —
// values this codebase did not generate. Escaping them keeps a stray angle
// bracket from breaking the mail, and keeps anything worse out of Ahmed's
// inbox. The two older templates render system-generated values only.
function esc(v: unknown) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

function orUnknown(v: unknown) {
  const s = String(v ?? "").trim();
  return s ? esc(s) : "<em>not on record</em>";
}

function renderTemplate(template: TemplateName, data: Record<string, unknown>) {
  if (template === "ms365_reset_request") {
    // Sent to staff, not to the member — it is a work item, so it reads as
    // one: who, how to reach them, and why we believe the mailbox is theirs.
    const mailbox = esc(data.mailbox);
    return {
      subject: `Microsoft 365 password reset requested — ${mailbox}`,
      html: `
        <p><strong>${orUnknown(data.fullName)}</strong> has signed up on sahabaclub.ai and
           recognised their Sahaba Club Microsoft 365 mailbox, but does not know the
           password. They are asking you to reset it.</p>
        <table cellpadding="4" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
          <tr><td><strong>Mailbox</strong></td><td>${mailbox}</td></tr>
          <tr><td><strong>Name</strong></td><td>${orUnknown(data.fullName)}</td></tr>
          <tr><td><strong>Personal email</strong></td><td>${orUnknown(data.personalEmail)}</td></tr>
          <tr><td><strong>Mobile</strong></td><td>${orUnknown(data.phone)}</td></tr>
          <tr><td><strong>With the club since</strong></td><td>${orUnknown(data.memberSince)}</td></tr>
          <tr><td><strong>Where they came from</strong></td><td>${orUnknown(data.contactSource)}</td></tr>
        </table>
        <p style="color:#555;font-size:13px">Matched because that personal email is already
           on record against this mailbox. They were not asked to type it, and they were
           never shown any mailbox other than their own.</p>
        <p style="color:#555;font-size:13px">Request id: ${esc(data.requestId)}</p>
      `,
    };
  }

  if (template === "ms365_credential") {
    const mailbox = String(data.mailbox ?? "");
    const tempPassword = String(data.tempPassword ?? "");
    const preExisting = Boolean(data.preExisting);
    return {
      subject: preExisting
        ? "Your Sahaba Club Microsoft 365 account is reset"
        : "Your Sahaba Club Microsoft 365 account is ready",
      html: `
        <p>Hi,</p>
        <p>${preExisting ? "Your existing" : "Your new"} Microsoft 365 mailbox is ready:</p>
        <p><strong>${mailbox}</strong></p>
        <p>Temporary password: <code>${tempPassword}</code></p>
        <p>You'll be asked to set your own password the first time you sign in at
           <a href="https://portal.office.com">portal.office.com</a>. This benefit is
           free for your first 3 months as a Sahaba Club member.</p>
        <p>— Sahaba Club</p>
      `,
    };
  }
  // "welcome" — sent right after signup, before the Microsoft 365 step.
  return {
    subject: "Welcome to Sahaba Club",
    html: `
      <p>Welcome to Sahaba Club — you're in.</p>
      <p>Next up: setting up your free Microsoft 365 account, and building your profile
         so we can match you with the right coaches and content.</p>
      <p>— Sahaba Club</p>
    `,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Server-to-server only. This function takes an arbitrary `to` address and
    // sends from a domain we have spent DNS records establishing as genuinely
    // ours — so without this check, any signed-in member could use it to mail
    // anyone as Sahaba Club. That is an open relay, and the cost of it being
    // found is sahabaclub.com landing on a blocklist and *all* our mail, human
    // included, stopping.
    //
    // The only caller is provision-ms365, which invokes it with the service
    // role key. Nothing legitimate reaches this from a browser.
    const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    if (!SERVICE_ROLE_KEY || bearer !== SERVICE_ROLE_KEY) {
      console.error("send-transactional-email called without the service role key");
      return json({ error: "Not allowed" }, 403);
    }

    const { to, template, data } = await req.json();
    if (!to || !template) {
      return json({ error: "to and template are required" }, 400);
    }

    const { subject, html } = renderTemplate(template as TemplateName, data ?? {});

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: RESEND_FROM, to, subject, html }),
    });
    if (!resp.ok) {
      throw new Error(`Resend error ${resp.status}: ${await resp.text()}`);
    }

    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
