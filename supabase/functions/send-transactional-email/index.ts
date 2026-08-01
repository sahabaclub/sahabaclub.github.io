// send-transactional-email
// ------------------------------------------------------------
// One function, one job: hand a template + data to Resend. Called from
// other Edge Functions (provision-ms365 today; booking confirmations
// and event reminders land here too once those phases start) rather
// than from the browser, so the Resend API key never reaches the client.
//
// Secrets this function needs (see SETUP.md):
//   RESEND_API_KEY
//   RESEND_FROM   — e.g. "Sahaba Club <membership@sahabaclub.com>"
import { corsHeaders } from "../_shared/cors.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "Sahaba Club <membership@sahabaclub.com>";

type TemplateName = "welcome" | "ms365_credential";

function renderTemplate(template: TemplateName, data: Record<string, unknown>) {
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
