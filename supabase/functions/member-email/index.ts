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

      const sent = await send(admin, user.email, "welcome", {
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

    const sent = await send(admin, user.email, "ms365_linked", { mailbox: account.mailbox });
    if (!sent.ok) return json({ ok: false, error: sent.error }, 502);
    return json({ ok: true, sent: "ms365_linked" });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

// One place that talks to send-transactional-email, so the service-role call
// and its error handling are not copied twice. invoke() resolves with { error }
// on a non-2xx rather than throwing, so the result has to be read — a try/catch
// alone sees only network failures, which is how a Resend rejection used to
// vanish silently.
async function send(
  admin: ReturnType<typeof createClient>,
  to: string,
  template: Kind,
  data: Record<string, unknown>,
) {
  try {
    const { error } = await admin.functions.invoke("send-transactional-email", {
      body: { to, template, data },
    });
    if (error) {
      console.error(`send-transactional-email failed for ${template}:`, error);
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
