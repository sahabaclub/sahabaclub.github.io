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
import {
  graphDiagnostics,
  isUsableMailboxName,
  provisionMailbox,
  resetMailboxPassword,
} from "../_shared/graph.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MS365_DOMAIN = Deno.env.get("MS365_DOMAIN") ?? "sahabaclub.com";

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

    const { action, mailbox: existingMailbox, fullName: requestedName } = await req.json();
    if (action !== "create" && action !== "reset" && action !== "diagnose") {
      return json({ error: "action must be 'create', 'reset' or 'diagnose'" }, 400);
    }

    // ---- action = "diagnose" : STAFF ONLY, read-only ----
    //
    // Answers "are the Graph credentials right, and are there licence seats
    // left?" without creating, changing or deleting anything. Worth having as
    // its own action: the alternative way to find out is to run a real
    // provisioning attempt, which creates a mailbox in the tenant and burns a
    // seat just to discover a secret is wrong.
    if (action === "diagnose") {
      const { data: diagProfile } = await admin
        .from("profiles")
        .select("role")
        .eq("user_id", user.id)
        .maybeSingle();
      if (diagProfile?.role !== "staff" && diagProfile?.role !== "admin") {
        return json({ error: "Not allowed" }, 403);
      }
      try {
        return json({ ok: true, diagnostics: await graphDiagnostics() });
      } catch (graphError) {
        // The AADSTS code is the whole point of this call, so it is returned
        // rather than swallowed into a generic 500.
        return json({ ok: false, error: String(graphError) }, 200);
      }
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("full_name")
      .eq("user_id", user.id)
      .maybeSingle();

    // The member may supply a Latin spelling of their name for the mailbox.
    // It is only ever used as a name — mailboxLocalPart strips it to [a-z0-9]
    // before it reaches Graph — so there is nothing here to inject with.
    const suppliedName = typeof requestedName === "string"
      ? requestedName.trim().slice(0, 80)
      : "";
    const displayName = suppliedName || profile?.full_name || "";

    let result: { mailbox: string; tempPassword: string };
    let preExisting: boolean;

    if (action === "create") {
      // Refuse if this member already has a mailbox on record. Without this,
      // a second click mints a brand new mailbox from their name and the
      // upsert below overwrites the row pointing at the old one — so the
      // member silently loses the account they already had, and the tenant
      // keeps an orphan nobody is tracking. Someone who already has one wants
      // the linking flow, not a second address.
      const { data: already } = await admin
        .from("ms365_accounts")
        .select("mailbox")
        .eq("user_id", user.id)
        .maybeSingle();
      if (already?.mailbox) {
        return json({
          error: "You already have a Microsoft 365 account on record.",
          mailbox: already.mailbox,
          code: "already_provisioned",
        }, 409);
      }

      // A @sahabaclub.com address has to be typeable and recognisable, so the
      // name behind it must be Latin script. An Arabic-script name leaves
      // nothing to build from — that is asked for, not guessed at, and never
      // filled in from the email address, which produces things like
      // ahmedrazeknhgmailcom@sahabaclub.com.
      if (!isUsableMailboxName(displayName)) {
        return json({
          error: "We need your name in English letters to build your @sahabaclub.com address.",
          code: "name_not_latin",
        }, 400);
      }

      const created = await provisionMailbox(displayName, displayName);
      result = { mailbox: created.mailbox, tempPassword: created.tempPassword };
      preExisting = false;
    } else {
      // ---- action = "reset" : STAFF ONLY ----
      //
      // This branch resets the password of whatever mailbox it is handed and
      // emails the new one to the caller. Without the check below, any signed-in
      // member could reset the tenant Global Admin and receive the password —
      // `mailbox` comes from the request body and proves nothing about who owns it.
      //
      // Members do not reach this any more. A member who has lost their password
      // uses the flow in migration 0021: the site shows them their own mailbox,
      // they ask for a reset, and a human does it. That was a deliberate design
      // decision, not a limitation — a password reset on a real tenant mailbox
      // should have a person behind it.
      const { data: prof } = await admin
        .from("profiles")
        .select("role")
        .eq("user_id", user.id)
        .maybeSingle();
      if (prof?.role !== "staff" && prof?.role !== "admin") {
        console.error(`non-staff user ${user.id} attempted action=reset`);
        return json({ error: "Not allowed" }, 403);
      }

      if (!existingMailbox) return json({ error: "mailbox is required for action=reset" }, 400);
      // Second line of defence: never touch an address outside our own tenant,
      // whatever a caller asks for.
      if (!String(existingMailbox).toLowerCase().trim().endsWith(`@${MS365_DOMAIN.toLowerCase()}`)) {
        return json({ error: `mailbox must be on ${MS365_DOMAIN}` }, 400);
      }

      result = await resetMailboxPassword(String(existingMailbox).trim());
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
