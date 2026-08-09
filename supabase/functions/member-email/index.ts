// member-email — the onboarding emails a member triggers for themselves
// ------------------------------------------------------------
// Two sends live here:
//
//   welcome        once, when a member first reaches onboarding
//   ms365_linked   when they connect a mailbox they already had
//
// Neither existed before. The `welcome` template had never had a caller at all,
// and linking a mailbox sent nothing, so a returning EduHackAI participant
// linked their account and heard silence.
//
// ⚠ WHY THIS FUNCTION EXISTS AT ALL, rather than the page calling
// send-transactional-email directly: that function takes an arbitrary `to` and
// sends from a domain we have spent DNS records establishing as ours, so it
// demands the service-role key. A browser must never hold that key. This
// function is the member-facing side of the wall — it accepts a member's own
// JWT, decides everything that matters server-side, and only then speaks to
// send-transactional-email with the service role.
//
// THE RECIPIENT IS NEVER TAKEN FROM THE REQUEST. It is read off the verified
// JWT, and the mailbox for `ms365_linked` is read out of `ms365_accounts` for
// that user id. A body that tried to pass `to` or `mailbox` is ignored — there
// is no code path here that can be talked into mailing a stranger.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

type Kind = "welcome" | "ms365_linked";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "Not signed in" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Verify the caller. getUser(jwt) checks the signature server-side — the
    // token is not trusted for anything beyond identifying who sent it.
    const jwt = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    const user = userData?.user;
    if (userError || !user) return json({ error: "Not signed in" }, 401);
    if (!user.email) return json({ error: "This account has no email address" }, 400);

    const body = await req.json().catch(() => ({}));
    const kind = String(body?.kind ?? "") as Kind;
    if (kind !== "welcome" && kind !== "ms365_linked") {
      return json({ error: "Unknown email kind" }, 400);
    }

    if (kind === "welcome") {
      // Send-once. The page that calls this reloads, and three reloads must not
      // be three welcome emails — for the member or for the cc.
      const { data: profile } = await admin
        .from("profiles")
        .select("welcome_email_sent_at, full_name")
        .eq("user_id", user.id)
        .maybeSingle();

      if (profile?.welcome_email_sent_at) {
        return json({ ok: true, skipped: "already_sent" });
      }

      const sent = await send(user.email, "welcome", {
        fullName: profile?.full_name ?? "",
      });
      if (!sent.ok) return json({ ok: false, error: sent.error }, 502);

      // Stamped only after Resend accepted it. Stamping first would mean one
      // failed send costs the member their welcome email for ever.
      await admin
        .from("profiles")
        .update({ welcome_email_sent_at: new Date().toISOString() })
        .eq("user_id", user.id);

      return json({ ok: true, sent: "welcome" });
    }

    // ms365_linked — the mailbox comes from the database, not the caller.
    const { data: account } = await admin
      .from("ms365_accounts")
      .select("mailbox")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!account?.mailbox) {
      return json({ error: "No Microsoft 365 account on record" }, 404);
    }

    const sent = await send(user.email, "ms365_linked", { mailbox: account.mailbox });
    if (!sent.ok) return json({ ok: false, error: sent.error }, 502);
    return json({ ok: true, sent: "ms365_linked" });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

// One place that talks to send-transactional-email, so the service-role call
// and its error handling are not copied twice.
//
// ⚠ fetch(), NOT admin.functions.invoke(). This is the fix from 8 Aug 2026 and
// it is worth knowing why, because the old version looked correct.
//
// `functions.invoke()` failed EVERY call in send-avatar-announcement — all 18
// members — and reported only `Edge Function returned a non-2xx status code`,
// its generic wrapper, with the response body discarded. The same request sent
// with a plain fetch, to the same URL with the same key, SUCCEEDED. So the
// credentials were never wrong; invoke() was.
//
// Which means the welcome mail and the ms365_linked mail have almost certainly
// never been delivered — 0040 shipped them with a caller that could not call.
// Nothing crashed, because invoke() resolves with `{ error }` rather than
// throwing, so the failure went to a log nobody reads.
//
// The status and body are now carried into the message. "403 Not allowed" and
// "422 invalid recipient" need completely different fixes, and the old wording
// could not tell them apart.
async function send(
  to: string,
  template: Kind,
  data: Record<string, unknown>,
) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-transactional-email`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        apikey: SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to, template, data }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`send-transactional-email ${res.status} for ${template}: ${body.slice(0, 300)}`);
      return { ok: false as const, error: "Could not send the email" };
    }
    return { ok: true as const };
  } catch (err) {
    console.error(`send-transactional-email threw for ${template}:`, err);
    return { ok: false as const, error: "Could not reach the email service" };
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
