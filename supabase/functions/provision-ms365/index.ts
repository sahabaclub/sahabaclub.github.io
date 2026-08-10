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
  deleteAccount,
  disableAccount,
  findUserIdByMailbox,
  graphDiagnostics,
  isUsableMailboxName,
  provisionMailbox,
  removeAllLicenses,
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

    // The same connection, carrying the CALLER's token instead of the service
    // role, for asking the database who they are. `is_staff()` and
    // `has_admin_section()` both read `auth.uid()`, which is null on `admin`
    // above — asking through that client answers "no" for everybody, the trap
    // that made `send-avatar-announcement` skip all 19 members.
    const asCaller = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const {
      action,
      mailbox: existingMailbox,
      fullName: requestedName,
      targetUserId,
      mode,
    } = await req.json();
    if (
      action !== "create" && action !== "reset" &&
      action !== "diagnose" && action !== "offboard"
    ) {
      return json({ error: "action must be 'create', 'reset', 'diagnose' or 'offboard'" }, 400);
    }

    // ---- action = "offboard" : GLOBAL ADMIN ONLY -------------------------
    //
    // Ahmed: "Once I delete a member, any Microsoft 365 account should deleted
    // also". This is the Microsoft half; the database half is
    // public.delete_member_completely() in 0058.
    //
    // ⚠ THIS RUNS FIRST, BEFORE the database delete, and the order is not
    // interchangeable. `ms365_accounts` is what says which mailbox belongs to
    // this member, and it goes with the cascade — so after the database half
    // there is nothing left to look the address up from, and the mailbox
    // becomes an orphan in the tenant that nobody can trace back to a person.
    //
    // Two modes, because Ahmed asked to be given the choice each time:
    //
    //   block  — sign-in disabled, every licence removed. The account and its
    //            mail still exist in the tenant, and this is reversible from
    //            the Microsoft admin centre.
    //   delete — the user is deleted in Entra. Microsoft keeps it recoverable
    //            for 30 days and then the mailbox and its contents are gone.
    //
    // Neither is the default. The dialog makes the caller pick.
    if (action === "offboard") {
      const { data: actor } = await admin
        .from("profiles").select("role").eq("user_id", user.id).maybeSingle();
      // Deliberately stricter than the rest of this function: `staff` may
      // provision and reset, but only a global admin may take an account away.
      //
      // ⚠ THIS ONE KEEPS ITS ROLE NAMES ON PURPOSE, and it is the only gate in
      // the sweep of 10 Aug that does. `is_staff()` is too WIDE here — it
      // includes plain `staff` — and there is no narrower helper to use:
      //
      // ⚠ `public.is_admin()` EXISTS AND IS STALE. 0003 defines it as
      // `role = 'admin'` and 0054 renamed administrators to `global_admin`
      // without touching it, so it now answers false for Ahmed. Nothing calls
      // it — measured across the migrations, the functions and the client — so
      // it is dead rather than dangerous, but it is exactly the shape of bug
      // that locked him out of his own dashboard once already. Do not reach
      // for it here. Fixing or dropping it needs a migration.
      if (actor?.role !== "admin" && actor?.role !== "global_admin") {
        return json({ error: "Only a global admin may offboard a member" }, 403);
      }
      if (mode !== "block" && mode !== "delete") {
        return json({ error: "mode must be 'block' or 'delete'" }, 400);
      }
      if (!targetUserId) return json({ error: "targetUserId is required" }, 400);
      if (targetUserId === user.id) {
        return json({ error: "You cannot offboard your own account" }, 400);
      }

      const { data: acct } = await admin
        .from("ms365_accounts").select("mailbox").eq("user_id", targetUserId).maybeSingle();

      // No mailbox on record is a SUCCESS, not a failure. Most members have
      // never provisioned one, and the delete flow calls this unconditionally
      // so it cannot be skipped by accident.
      if (!acct?.mailbox) {
        return json({ ok: true, mailbox: null, did: "nothing", reason: "no Microsoft 365 account on record" });
      }

      const graphId = await findUserIdByMailbox(acct.mailbox);
      if (!graphId) {
        // On record here, absent from the tenant — already removed by hand.
        // Say so plainly rather than failing: the member still needs deleting.
        return json({ ok: true, mailbox: acct.mailbox, did: "nothing", reason: "not found in the tenant" });
      }

      if (mode === "delete") {
        await deleteAccount(graphId);
      } else {
        // Licences first. Disabling an account does NOT release its seat, and
        // a blocked-but-licensed account keeps a licence Ahmed is paying for
        // out of circulation indefinitely.
        await removeAllLicenses(graphId);
        await disableAccount(graphId);
      }

      // The ms365_* rows are left alone: the caller deletes the member next,
      // and the cascade takes them. Clearing them here would leave a window
      // where the mailbox is gone and the record still claims it exists.
      return json({ ok: true, mailbox: acct.mailbox, did: mode });
    }

    // ---- action = "diagnose" : STAFF ONLY, read-only ----
    //
    // Answers "are the Graph credentials right, and are there licence seats
    // left?" without creating, changing or deleting anything. Worth having as
    // its own action: the alternative way to find out is to run a real
    // provisioning attempt, which creates a mailbox in the tenant and burns a
    // seat just to discover a secret is wrong.
    if (action === "diagnose") {
      // ⚠ `is_staff()` rather than the three role names spelled out — 0054
      // defines it as exactly that list, so the same people pass. Asked as the
      // CALLER: `is_staff()` reads `auth.uid()`, null on the service client.
      const { data: diagIsStaff, error: diagGateError } = await asCaller.rpc("is_staff");
      if (diagGateError) {
        console.error("provision-ms365: is_staff failed: " + diagGateError.message);
        return json({ error: "Could not check permissions" }, 500);
      }
      if (diagIsStaff !== true) {
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
    // Kept so the database write below can undo the Graph account it belongs
    // to. Null on `reset`, where the account is not ours to remove.
    let createdUserId: string | null = null;

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
      createdUserId = created.userId;
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
      // ⚠ `is_staff()`, same reasoning as `diagnose` above: 0054 defines it as
      // exactly the three names this used to spell out.
      const { data: resetIsStaff, error: resetGateError } = await asCaller.rpc("is_staff");
      if (resetGateError) {
        console.error("provision-ms365: is_staff failed: " + resetGateError.message);
        return json({ error: "Could not check permissions" }, 500);
      }
      if (resetIsStaff !== true) {
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
      // NOT set here. It used to be, which asserted the credential had been
      // sent before anything had tried to send it — so a failed send left a
      // row claiming the member had been told their password. Written below,
      // only once Resend has actually accepted it.
      credential_sent_at: null,
    });

    if (upsertError) {
      // The mailbox exists in the tenant at this point. Leaving it behind
      // means a licensed account with no database row: invisible to the club,
      // unreachable by the member, and still holding the name — so the retry
      // collides with our own wreckage and issues them a "…1" address.
      if (createdUserId) {
        try {
          await deleteAccount(createdUserId);
          console.error(`rolled back ${result.mailbox} after ms365_accounts write failed`);
        } catch (cleanupErr) {
          console.error(
            `ORPHAN: ${result.mailbox} (${createdUserId}) exists in the tenant but has ` +
            `no ms365_accounts row and could not be deleted. Remove it by hand. ${cleanupErr}`,
          );
        }
      }
      throw upsertError;
    }

    // The starter password goes into the vault BEFORE anything tries to email
    // it, and that order is the whole point. Email was the only copy: when
    // Resend refused — a missing key, an unverified domain, a bounce — the
    // password ceased to exist anywhere at all and the member was left holding
    // a real mailbox they could not open. Now the dashboard can always show it,
    // and the email is a convenience on top rather than the single channel.
    //
    // Failure here is logged and not fatal, for the same reason the email is
    // not fatal: the mailbox exists either way, and 0021's reset flow can
    // recover a member who ends up with neither copy. It is logged loudly
    // because it means the dashboard will have nothing to show.
    let credentialSaved = false;
    try {
      const { error: vaultError } = await admin.from("ms365_credentials").upsert({
        user_id: user.id,
        temp_password: result.tempPassword,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      if (vaultError) {
        console.error(
          `ms365_credentials write failed for ${result.mailbox} — the member will have ` +
          `no password on their dashboard and will need a reset:`, vaultError,
        );
      } else {
        credentialSaved = true;
      }
    } catch (vaultErr) {
      console.error(`ms365_credentials write threw for ${result.mailbox}:`, vaultErr);
    }

    // ⚠ fetch(), NOT functions.invoke(). Changed 8 Aug 2026, and the note this
    // replaces was right about the danger and wrong about the cause.
    //
    // It said: invoke() resolves with { error } on a non-2xx rather than
    // throwing, so the result must be read or a 403 vanishes silently and
    // leaves the member with a mailbox whose password existed nowhere but a
    // discarded variable. All true, and the result WAS read.
    //
    // What nobody knew is that invoke() fails here every time. It failed all 18
    // calls in send-avatar-announcement and reported only its generic
    // `Edge Function returned a non-2xx status code`; the identical request via
    // plain fetch, same URL, same key, succeeded. So the careful error handling
    // below has most likely been faithfully logging a failure on every single
    // provisioning since this shipped, into a log nobody reads.
    //
    // ⚠ `credential_sent_at` is stamped only on a real 2xx, and 0039 vaults the
    // password so the dashboard can show it. That vault is the reason this bug
    // cost confusion rather than a lost mailbox — the member could still get in.
    // Do not let that become an argument for leaving the mail unverified.
    let credentialSent = false;
    try {
      const mailRes = await fetch(`${SUPABASE_URL}/functions/v1/send-transactional-email`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          apikey: SERVICE_ROLE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: user.email,
          template: "ms365_credential",
          data: { mailbox: result.mailbox, tempPassword: result.tempPassword, preExisting },
        }),
      });
      if (!mailRes.ok) {
        // ⚠ The body is read for the STATUS and the provider's message only.
        // This template carries a starter password in its request; nothing from
        // this response is echoed to the caller, and the request body is never
        // logged.
        const mailBody = await mailRes.text().catch(() => "");
        console.error(
          `send-transactional-email ${mailRes.status} for ${result.mailbox}: ${mailBody.slice(0, 300)}`,
        );
      } else {
        credentialSent = true;
        await admin.from("ms365_accounts")
          .update({ credential_sent_at: new Date().toISOString() })
          .eq("user_id", user.id);
      }
    } catch (emailError) {
      console.error(`send-transactional-email threw for ${result.mailbox}:`, emailError);
    }

    // The mailbox is real either way, so this is a success — but the client is
    // told whether the email actually went, so it can say so rather than
    // implying an email is on its way that never left. `credentialSaved` lets
    // it point at the dashboard when the email failed, which is now a genuine
    // answer rather than an apology.
    return json({ ok: true, mailbox: result.mailbox, credentialSent, credentialSaved });
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
