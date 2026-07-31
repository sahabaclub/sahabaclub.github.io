// provision-ms365
// ------------------------------------------------------------
// Called once, from app/onboarding.html, right after someone answers
// "do you already have a @sahabaclub.com account?".
//
//   { action: "create" }                       — first-timer, no mailbox yet
//   { action: "reset", mailbox: "x@sahabaclub.com" } — reclaiming an old one
//
// Either way this ends with: a mailbox that exists and is licensed, a
// fresh temporary credential (never returned to the browser — only
// emailed), and an `ms365_accounts` row the rest of the app can read.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — to write ms365_accounts
//   MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET
//   MS_GRAPH_LICENSE_SKU_ID                  — which M365 SKU to assign
//   MS365_DOMAIN                              — defaults to sahabaclub.com
//   RESEND_API_KEY, RESEND_FROM               — for the credential email
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { createMailbox, findAvailableMailbox, resetMailboxPassword } from "../_shared/graph.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");

    // Service-role client: bypasses RLS so this function can write
    // ms365_accounts for the caller, but we still verify *who* the caller
    // is from their own JWT before doing anything on their behalf.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData.user) {
      return json({ error: "Not signed in" }, 401);
    }
    const user = userData.user;

    const { action, mailbox: existingMailbox } = await req.json();
    if (action !== "create" && action !== "reset") {
      return json({ error: "action must be 'create' or 'reset'" }, 400);
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("full_name")
      .eq("user_id", user.id)
      .maybeSingle();
    const displayName = profile?.full_name || user.email || "Sahaba Club member";

    let result: { mailbox: string; tempPassword: string };
    let preExisting: boolean;

    if (action === "create") {
      const mailbox = await findAvailableMailbox(displayName);
      const created = await createMailbox(mailbox, displayName);
      result = { mailbox: created.mailbox, tempPassword: created.tempPassword };
      preExisting = false;
    } else {
      if (!existingMailbox) return json({ error: "mailbox is required for action=reset" }, 400);
      result = await resetMailboxPassword(existingMailbox);
      preExisting = true;
    }

    const licenseExpiresAt = new Date();
    licenseExpiresAt.setMonth(licenseExpiresAt.getMonth() + 3);

    const { error: upsertError } = await admin.from("ms365_accounts").upsert({
      user_id: user.id,
      mailbox: result.mailbox,
      status: "active",
      pre_existing: preExisting,
      license_expires_at: licenseExpiresAt.toISOString().slice(0, 10),
      grace_ends_at: null,
      credential_sent_at: new Date().toISOString(),
    });
    if (upsertError) throw upsertError;

    // Best-effort: a delivery failure here shouldn't undo the mailbox
    // that was just created — log it and let the member request a resend
    // from their dashboard later (that resend endpoint is a Phase 2 item).
    try {
      await admin.functions.invoke("send-transactional-email", {
        body: {
          to: user.email,
          template: "ms365_credential",
          data: { mailbox: result.mailbox, tempPassword: result.tempPassword, preExisting },
        },
      });
    } catch (emailError) {
      console.error("send-transactional-email failed:", emailError);
    }

    return json({ ok: true, mailbox: result.mailbox });
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
