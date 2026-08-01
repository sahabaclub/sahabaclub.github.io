// notify-ms365-reset
// ------------------------------------------------------------
// A member has recognised their @sahabaclub.com mailbox but does not know
// the password. This emails Ahmed asking him to reset it, with enough
// context to act without going and looking anything up.
//
// It does NOT reset anything. That is the whole point. provision-ms365's
// `reset` branch takes a mailbox from the request body and resets it with
// no proof of ownership, which is why this flow does not call it — a
// password reset on a real tenant mailbox goes through a human.
//
// The request row is created by request_ms365_password_reset() BEFORE this
// function is called, and that row is the durable record. This function is
// a notification on top: if it is not deployed, or Resend is down, the
// request still exists and still appears in admin. Nothing is lost.
//
// No ../_shared imports on purpose. Dashboard deploys cannot resolve them,
// and this function has no index.deploy.ts twin to keep in sync — it is
// deployable by CLI or by pasting into the dashboard, unchanged.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Where reset requests go. Deliberately a constant: this address is the
// destination for a message about somebody else's account, so it is not
// something a caller gets to influence.
const OPS_EMAIL = "ahmed@sahabaclub.com";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return json({ error: "server not configured" }, 500);
    }

    // Identify the caller from their own JWT. Nothing about which request
    // gets emailed comes from the request body — the caller can only ever
    // cause their own pending row to be sent.
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "not signed in" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "not signed in" }, 401);
    const user = userData.user;

    const { data: reqRow, error: reqErr } = await admin
      .from("ms365_reset_requests")
      .select("*")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (reqErr) return json({ error: reqErr.message }, 500);
    // Already emailed, or never raised. Either way there is nothing to do
    // and it is not an error the member should see as a failure.
    if (!reqRow) return json({ ok: true, sent: false, reason: "no pending request" });

    const since = reqRow.member_since
      ? new Date(reqRow.member_since).toISOString().slice(0, 10)
      : null;

    const sendRes = await fetch(`${SUPABASE_URL}/functions/v1/send-transactional-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // send-transactional-email requires the service-role key — it is
        // not callable from a browser, by design.
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      // It renders from a fixed template allowlist rather than taking a
      // subject and body, which is what stops it being a general-purpose
      // mailer. `ms365_reset_request` is added there for this flow.
      body: JSON.stringify({
        to: OPS_EMAIL,
        template: "ms365_reset_request",
        data: {
          mailbox: reqRow.mailbox,
          fullName: reqRow.full_name,
          personalEmail: reqRow.personal_email,
          phone: reqRow.phone,
          memberSince: since,
          contactSource: reqRow.contact_source,
          requestId: reqRow.id,
        },
      }),
    });

    if (!sendRes.ok) {
      const detail = await sendRes.text();
      console.error("send-transactional-email failed:", sendRes.status, detail);
      // The row stays 'pending' so it is still visible in admin and a retry
      // will pick it up. The member is told it was recorded, because it was.
      return json({ ok: true, sent: false, reason: "email failed, request recorded" });
    }

    await admin
      .from("ms365_reset_requests")
      .update({ status: "emailed", notified_at: new Date().toISOString() })
      .eq("id", reqRow.id);

    return json({ ok: true, sent: true });
  } catch (err) {
    console.error("notify-ms365-reset:", err);
    return json({ error: "unexpected error" }, 500);
  }
});
