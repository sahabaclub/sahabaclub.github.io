// send-newsletter
// ------------------------------------------------------------
// Resolves a segment from profiles.interests + newsletter_opt_in, then
// sends one email per recipient via Resend.
//
//   { subject, html, interests: [], dryRun: true }   — count the segment
//   { subject, html, interests: ["Agentic AI"] }     — send to that segment
//   { subject, html, interests: [] }                 — send to everyone opted in
//
// Admin only: the caller's profile must have role = 'admin'.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY, RESEND_FROM
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "Sahaba Club <hello@sahabaclub.com>";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData.user) {
      return json({ error: "Not signed in" }, 401);
    }

    const { data: callerProfile } = await admin
      .from("profiles")
      .select("role")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!callerProfile || callerProfile.role !== "admin") {
      return json({ error: "Admins only" }, 403);
    }

    const { subject, html, interests, dryRun } = await req.json();

    // Everyone who opted in; narrowed to an interest overlap when one is
    // given. `overlaps` is Postgres array-overlap (&&) — a member matches
    // if any one of their interests is in the target list.
    let query = admin
      .from("profiles")
      .select("user_id")
      .eq("newsletter_opt_in", true);
    if (Array.isArray(interests) && interests.length > 0) {
      query = query.overlaps("interests", interests);
    }

    const { data: recipients, error: segmentError } = await query;
    if (segmentError) throw segmentError;

    // Emails live on auth.users, not profiles — phone-signup members may
    // not have one at all, so they're filtered out rather than counted as
    // reachable.
    const emails: string[] = [];
    for (const row of recipients ?? []) {
      const { data: authUser } = await admin.auth.admin.getUserById(row.user_id);
      if (authUser?.user?.email) emails.push(authUser.user.email);
    }

    if (dryRun) {
      return json({ ok: true, matched: recipients?.length ?? 0, reachable: emails.length });
    }

    if (!subject || !html) {
      return json({ error: "subject and html are required to send" }, 400);
    }
    if (emails.length === 0) {
      return json({ error: "Nobody in that segment has an email address." }, 400);
    }

    // One request per recipient so nobody sees anyone else's address, and
    // one person's bounce doesn't take down the whole send.
    let sent = 0;
    const failed: string[] = [];
    for (const to of emails) {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: RESEND_FROM, to, subject, html }),
      });
      if (resp.ok) sent++;
      else {
        failed.push(to);
        console.error(`Resend failed for ${to}: ${resp.status} ${await resp.text()}`);
      }
    }

    return json({ ok: true, sent, failed: failed.length });
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
