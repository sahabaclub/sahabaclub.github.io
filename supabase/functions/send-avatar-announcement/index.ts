// send-avatar-announcement
// ------------------------------------------------------------
// The one-off mail for the 8 Aug 2026 avatar restart. Deliberately its own
// function and deliberately disposable: it is not a campaign, it has no
// segments, and when this announcement is out it should be deleted rather than
// generalised into "the club mailer" by the next person who needs to tell
// everybody something.
//
// ============================================================
// The audience is the snapshot, not `profiles`
// ============================================================
//
// It reads `avatar_restart_2026_08`, which 0061 wrote one row per member at
// the moment of the restart. That is the correct audience and a live query
// against `profiles` is not: somebody who signs up tomorrow would be told the
// club redrew an avatar they never had, and somebody deleted in between would
// still be mailed. The snapshot is also where `announced_at` lives, so the
// audience and the record of who has been told are the same rows.
//
// ⚠ MEMBERS WHO TURNED CLUB EMAIL OFF ARE INCLUDED. Ahmed's decision, 8 Aug,
// asked and confirmed. `newsletter_opt_in` is READ and REPORTED — the response
// says how many recipients had it false — so the cost of that decision is
// visible in the output rather than buried. It is not used as a filter.
// Changing that is a one-line change at OPT_OUT_FILTER below.
//
// ============================================================
// Which of the two mails each member gets
// ============================================================
//
// ⚠ DERIVED FROM WHAT ACTUALLY HAPPENED, not from what was planned. A member
// gets the "we redrew your avatar" copy only if they were in group A AND their
// `avatar_url` today differs from the one 0061 recorded. refresh-avatars can
// fail per member — it catches, records and moves on — so a member whose
// redraw failed is still sitting on their old picture, and telling them to go
// and admire a new one would be the mail arriving to contradict their own
// screen. They get the other version, which is true for them.
//
// ============================================================
// Sending
// ============================================================
//
// Through send-transactional-email, exactly as member-email does, so the
// template lives in one place. That function holds the Resend key and the
// esc()-ing; this one holds the loop and the bookkeeping.
//
//   POST /send-avatar-announcement?dry=1        see the audience, send nothing
//   POST /send-avatar-announcement?limit=25     send the next 25
//
// Staff only, checked here, because this function can mail every member of the
// club. If the check is not in this file, it is not made.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// ⚠ Small on purpose. Resend rate-limits, and an Edge Function has a
// wall-clock limit — but the real reason is that a mistake in the copy or the
// audience is unrecoverable once the mail is delivered. Twenty-five at a time
// means the first batch can be read in an inbox before the second is sent.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// Set to true to honour newsletter_opt_in. Left false by Ahmed's decision.
const OPT_OUT_FILTER = false;

// ⚠ Addresses that must never receive this announcement. Ahmed, 8 Aug:
// exclude the test account.
//
// Kept HERE rather than expressed by stamping `announced_at` on the row,
// which is the other obvious way to do it. Stamping would record that the
// account WAS announced to, which is false, and the lie would outlive the
// reason for it — the snapshot is the only record of this operation and it
// should not contain a claim nobody can check. A named constant is in git,
// shows up in review, and says why.
//
// Compared case-insensitively: the address in `auth.users` is whatever was
// typed at signup.
const EXCLUDED_EMAILS = new Set([
  "test25dec@sahabaclub.com",
]);

type Row = {
  user_id: string;
  cohort: string;
  prior_avatar_url: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!SERVICE_ROLE_KEY) return json({ error: "Not configured" }, 503);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ---- Who is asking ----
    //
    // ⚠ Asks `is_staff()` rather than comparing role names to a literal list.
    // This project has hardcoded that list twice and been bitten twice — 0054's
    // rename hid the Admin link from Ahmed, and the fixed version stayed hidden
    // from Ghadir. is_staff() is the one universal gate; a role granted staff
    // reaches this with no edit here, and a role that is not staff cannot.
    //
    // It has to be called as the CALLER, not as the service role: is_staff()
    // reads auth.uid(), which is null on an admin client, so asking through
    // `admin` would answer "no" for everybody including Ahmed.
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "").trim();
    if (!jwt) return json({ error: "Not signed in" }, 401);

    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return json({ error: "Not signed in" }, 401);

    const asCaller = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: staff, error: staffErr } = await asCaller.rpc("is_staff");
    if (staffErr) {
      console.error("is_staff failed: " + staffErr.message);
      return json({ error: "Could not check permissions" }, 500);
    }
    if (staff !== true) {
      console.error(`user ${userData.user.id} attempted to reach send-avatar-announcement`);
      return json({ error: "Not allowed" }, 403);
    }

    const params = new URL(req.url).searchParams;
    const dryRun = params.get("dry") === "1";
    const limit = clampLimit(params.get("limit"));

    // ---- Who has not been told yet ----
    const { data: pending, error: pendErr, count } = await admin
      .from("avatar_restart_2026_08")
      .select("user_id, cohort, prior_avatar_url", { count: "exact" })
      .is("announced_at", null)
      .order("recorded_at", { ascending: true })
      .range(0, limit - 1);
    if (pendErr) return json({ error: pendErr.message }, 500);

    const batch = (pending ?? []) as Row[];
    const totalPending = count ?? batch.length;

    if (!batch.length) {
      return json({ ok: true, sent: 0, failed: 0, skipped: 0, remaining: 0, note: "Nobody is waiting to be told." });
    }

    const ids = batch.map((r) => r.user_id);

    // Name and mail preference come from `profiles`, which the service role
    // reads with RLS bypassed.
    const { data: profs, error: profErr } = await admin
      .from("profiles")
      .select("user_id, full_name, newsletter_opt_in")
      .in("user_id", ids);
    if (profErr) return json({ error: profErr.message }, 500);

    // ⚠ THE ADDRESS COMES FROM THE AUTH ADMIN API, NOT `staff_member_details`.
    //
    // The obvious move is that view — it exists precisely because the
    // registration address lives in `auth.users`, which PostgREST cannot
    // expose. It returns NOTHING here, and silently: its last line is
    // `where public.is_staff()`, and `is_staff()` reads `auth.uid()`, which is
    // NULL on a service-role client. So the view is empty for the service role
    // exactly as it is for an anonymous visitor, and the first run of this
    // function skipped all 19 members with "no member record" — a message that
    // reads like the members are missing rather than the view being blind.
    //
    // Same shape as the `contact_link_status` note in the handoff. A definer
    // view whose predicate is a session function cannot be read by a caller
    // that has no session.
    const emailById = new Map<string, { email: string; confirmed: boolean }>();
    {
      const perPage = 200;
      for (let page = 1; page <= 20; page++) {
        const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page, perPage });
        if (listErr) return json({ error: "Could not read the member list: " + listErr.message }, 500);
        const users = list?.users ?? [];
        for (const u of users) {
          emailById.set(u.id, {
            email: String(u.email ?? "").trim(),
            confirmed: !!u.email_confirmed_at,
          });
        }
        if (users.length < perPage) break;
      }
    }

    const details = (profs ?? []).map((p) => ({
      user_id: p.user_id as string,
      full_name: p.full_name as string | null,
      newsletter_opt_in: p.newsletter_opt_in as boolean | null,
      email: emailById.get(p.user_id as string)?.email ?? "",
      email_confirmed_at: emailById.get(p.user_id as string)?.confirmed ? "yes" : null,
    }));

    // Today's avatar, to decide which of the two mails is true for them.
    const { data: now, error: nowErr } = await admin
      .from("profiles")
      .select("user_id, avatar_url")
      .in("user_id", ids);
    if (nowErr) return json({ error: nowErr.message }, 500);

    const byId = new Map(details?.map((d) => [d.user_id, d]) ?? []);
    const avatarNow = new Map(now?.map((p) => [p.user_id, p.avatar_url ?? ""]) ?? []);

    let sent = 0, failed = 0, skipped = 0, redrawnCount = 0, optedOut = 0;
    const skippedWhy: Record<string, number> = {};
    const preview: Array<Record<string, unknown>> = [];

    for (const row of batch) {
      const d = byId.get(row.user_id);
      const email = String(d?.email ?? "").trim();

      // ⚠ An unconfirmed address is not a member's address yet — it is a
      // string somebody typed. Mailing it bounces, and bounces are what cost a
      // domain its ability to reach anybody's inbox. Counted and reported
      // rather than silently dropped.
      const why = !d
        ? "no member record"
        : !email
        ? "no email address"
        : EXCLUDED_EMAILS.has(email.toLowerCase())
        ? "excluded by request"
        : !d.email_confirmed_at
        ? "email never confirmed"
        : OPT_OUT_FILTER && d.newsletter_opt_in === false
        ? "opted out of club email"
        : "";

      if (why) {
        skipped++;
        skippedWhy[why] = (skippedWhy[why] ?? 0) + 1;
        continue;
      }

      if (d.newsletter_opt_in === false) optedOut++;

      const changed = (avatarNow.get(row.user_id) ?? "") !== (row.prior_avatar_url ?? "");
      const redrawn = row.cohort === "A_redrawable" && changed;
      if (redrawn) redrawnCount++;

      if (dryRun) {
        if (preview.length < 10) {
          preview.push({
            email: maskEmail(email),
            cohort: row.cohort,
            wouldSay: redrawn ? "we redrew your avatar" : "your picture is untouched",
            optedOutOfEmail: d.newsletter_opt_in === false,
          });
        }
        continue;
      }

      // ⚠ fetch(), NOT admin.functions.invoke(). Same request, but invoke()
      // collapses every failure into "Edge Function returned a non-2xx status
      // code" and throws the body away — which is exactly the message 18
      // members' rows carried on the first attempt, and it says nothing about
      // whether the problem was the gateway, our own gate, or Resend. An error
      // column that cannot tell you which is an error column that costs a
      // second run to learn anything.
      let sendErr: { message: string } | null = null;
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/send-transactional-email`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            apikey: SERVICE_ROLE_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            to: email,
            template: "avatar_restart",
            data: { fullName: d.full_name ?? "", redrawn },
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          sendErr = { message: `${res.status} ${body.slice(0, 200)}` };
        }
      } catch (err) {
        sendErr = { message: "unreachable: " + String(err instanceof Error ? err.message : err) };
      }

      if (sendErr) {
        failed++;
        console.error(`avatar announcement failed for ${row.user_id}: ${sendErr.message}`);
        // ⚠ Recorded, and `announced_at` deliberately left null so a retry
        // picks them up. A failure that clears itself out of the queue is a
        // member who is never told and nobody who knows it.
        await admin
          .from("avatar_restart_2026_08")
          .update({ announce_error: String(sendErr.message).slice(0, 300) })
          .eq("user_id", row.user_id);
        continue;
      }

      sent++;
      // Stamped immediately, one member at a time, rather than in a single
      // update after the loop: if this function dies halfway through a batch,
      // the members already mailed must not be mailed again on the retry.
      const { error: stampErr } = await admin
        .from("avatar_restart_2026_08")
        .update({ announced_at: new Date().toISOString(), announce_error: null })
        .eq("user_id", row.user_id);
      if (stampErr) {
        // The mail is gone; the only honest thing left is to make the failure
        // loud, because the next run will send it again.
        console.error(`SENT BUT NOT STAMPED for ${row.user_id}: ${stampErr.message} — a retry will duplicate this one`);
      }
    }

    return json({
      ok: true,
      dryRun,
      pendingBeforeThisRun: totalPending,
      considered: batch.length,
      sent,
      failed,
      skipped,
      skippedWhy,
      wouldBeRedrawnCopy: redrawnCount,
      recipientsWhoOptedOutOfEmail: optedOut,
      optOutFilterActive: OPT_OUT_FILTER,
      remaining: Math.max(0, totalPending - (dryRun ? 0 : sent)),
      ...(dryRun ? { preview } : {}),
    });
  } catch (err) {
    console.error("send-avatar-announcement threw:", err);
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});

// Enough to recognise your own address in a dry run, not enough to harvest a
// member list out of a response body.
function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  const head = user.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, user.length - 2))}@${domain}`;
}

function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
