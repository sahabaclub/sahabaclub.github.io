// send-welcome-backfill
// ------------------------------------------------------------
// The belated welcome for members who joined before the welcome email had a
// caller. Deliberately its own function and deliberately disposable: when the
// backlog is clear this should be DELETED, not generalised into "the club
// mailer" by the next person who needs to tell everybody something.
//
// ============================================================
// Why this function has to exist at all
// ============================================================
//
// There was no way to send it. `member-email` reads the recipient off the
// caller's own verified JWT and says so in its header — "there is no code path
// here that can be talked into mailing a stranger" — which is correct and must
// stay that way. `send-transactional-email` takes an arbitrary `to` but demands
// the raw service-role key as its bearer, and that key must never leave
// Supabase: not into a browser, not onto a command line, not into a shell
// history. This function is the third option — staff-gated at the front, the
// service role only ever used server-side.
//
// ============================================================
// The audience, and the two people it deliberately excludes
// ============================================================
//
//   profiles.welcome_email_sent_at IS NULL
//   AND auth.users.email_confirmed_at IS NOT NULL
//   AND auth.users.created_at < CUTOFF
//
// ⚠ THE CONFIRMED-EMAIL CONDITION IS NOT TIDINESS. Measured 19 Aug: of the 19
// members with no welcome recorded, eighteen signed up 29 Jul–9 Aug — the real
// gap — and ONE signed up 18 Aug and has never confirmed their address. That
// one is not a victim of the missing caller; they never reached onboarding, so
// nothing was ever meant to fire. Mailing "you're in" to an address nobody has
// proved they own is how a sending domain earns a bounce and a spam complaint
// at the same time.
//
// ⚠ THE CUTOFF (below) IS A SECOND LOCK ON THE SAME DOOR. Without it this
// function stays live and will happily mail somebody who signs up next month
// between registering and reaching onboarding — arriving before the real
// welcome, or instead of it. A backfill should be able to run twice and mail
// nobody new.
//
// ============================================================
// Sending
// ============================================================
//
// Through send-transactional-email with the SAME `welcome` template the normal
// path uses, so there is one copy of the words. That function holds the Resend
// key and the escaping; this one holds the loop and the bookkeeping.
//
// ⚠ Each welcome CCs ONBOARDING_CC_EMAIL (ahmed@sahabaclub.com) — as `cc`, so
// the member sees it. That is existing behaviour for this template and is not
// overridden here, but it means N sends put N copies in that inbox.
//
//   POST /send-welcome-backfill?dry=1        see the audience, send nothing
//   POST /send-welcome-backfill?limit=25     send the next 25
//
// Staff only, checked in this file. If the check is not here, it is not made.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Nobody who signed up on or after this reaches the backfill — see the header.
// It is the day after the last member in the gap (9 Aug 2026).
const CUTOFF = "2026-08-10T00:00:00Z";

// ⚠ Addresses that must never receive this. Same list and same reasoning as
// send-avatar-announcement, where Ahmed excluded the test account on 8 Aug.
//
// Kept HERE rather than expressed by stamping `welcome_email_sent_at`, which is
// the other obvious way to do it. Stamping would record that the account WAS
// welcomed, which is false, and that lie would outlive the reason for it. A
// named constant is in git, shows up in review, and says why.
//
// Compared case-insensitively: the address in auth.users is whatever was typed.
const EXCLUDED_EMAILS = new Set([
  "test25dec@sahabaclub.com",
]);

// ⚠ Small on purpose. A mistake in the audience is unrecoverable once the mail
// is delivered; a small batch can be read in an inbox before the next is sent.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!SERVICE_ROLE_KEY) return json({ error: "Not configured" }, 503);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ---- Who is asking ----
    //
    // ⚠ is_staff() must be asked as the CALLER. It reads auth.uid(), which is
    // null on an admin client, so asking through `admin` answers "no" for
    // everybody including Ahmed.
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
    if (!jwt) return json({ error: "Not signed in" }, 401);

    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return json({ error: "Not signed in" }, 401);

    const asCaller = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: staff, error: staffErr } = await asCaller.rpc("is_staff");
    if (staffErr) {
      console.error("send-welcome-backfill: is_staff failed: " + staffErr.message);
      return json({ error: "Could not check permissions" }, 500);
    }
    if (staff !== true) {
      console.error(`send-welcome-backfill: user ${userData.user.id} attempted this`);
      return json({ error: "Not allowed" }, 403);
    }

    const params = new URL(req.url).searchParams;
    const dryRun = params.get("dry") === "1";
    const limit = clampLimit(params.get("limit"));

    // ---- Who has never been welcomed ----
    const { data: pending, error: pendErr } = await admin
      .from("profiles")
      .select("user_id, full_name")
      .is("welcome_email_sent_at", null);

    if (pendErr) {
      console.error("send-welcome-backfill: profiles read failed: " + pendErr.message);
      return json({ error: "Could not read the audience" }, 500);
    }

    // The address and the two eligibility facts live on auth.users, which is
    // not joinable from PostgREST. One lookup per candidate; the audience is
    // tens of rows, not thousands.
    const eligible: { id: string; email: string; name: string; created: string }[] = [];
    const skipped = { unconfirmed: 0, noEmail: 0, afterCutoff: 0, missing: 0, excluded: 0 };

    for (const p of pending ?? []) {
      const { data: u } = await admin.auth.admin.getUserById(p.user_id);
      const user = u?.user;
      if (!user) { skipped.missing++; continue; }
      if (!user.email) { skipped.noEmail++; continue; }
      if (EXCLUDED_EMAILS.has(user.email.toLowerCase())) { skipped.excluded++; continue; }
      if (!user.email_confirmed_at) { skipped.unconfirmed++; continue; }
      if (user.created_at >= CUTOFF) { skipped.afterCutoff++; continue; }
      eligible.push({
        id: p.user_id,
        email: user.email,
        name: p.full_name ?? "",
        created: String(user.created_at).slice(0, 10),
      });
    }

    // Oldest first: the people who have been waiting longest get theirs first.
    eligible.sort((a, b) => (a.created < b.created ? -1 : 1));
    const batch = eligible.slice(0, limit);

    // ⚠ Addresses are REPORTED AS DOMAIN ONLY. This response is read in a
    // browser and pasted into notes and transcripts; a member's address does
    // not belong in any of them. The signup date plus the domain is enough to
    // recognise the audience, and `user_id` is there if a specific row must be
    // found.
    const preview = batch.map((e) => ({
      user_id: e.id.slice(0, 8),
      signed_up: e.created,
      address: "***@" + e.email.split("@")[1],
      has_name: Boolean(e.name.trim()),
    }));

    if (dryRun) {
      return json({
        ok: true, dry_run: true,
        eligible_total: eligible.length,
        would_send_now: batch.length,
        skipped,
        cutoff: CUTOFF,
        audience: preview,
      });
    }

    // ---- Send ----
    let sent = 0;
    const failures: { user_id: string; error: string }[] = [];

    for (const person of batch) {
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
            to: person.email,
            template: "welcome",
            data: { fullName: person.name },
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
        // ⚠ NOT stamped. A failure must leave the row exactly as it was so the
        // next run picks it up again — stamping on failure costs that member
        // their welcome for ever, silently.
        console.error(`send-welcome-backfill: ${person.id} failed: ${sendErr.message}`);
        failures.push({ user_id: person.id.slice(0, 8), error: sendErr.message });
        continue;
      }

      // Stamped only after Resend accepted it, exactly as member-email does.
      // This is also what makes the whole function idempotent: run it twice and
      // the second run has nobody to mail.
      const { error: stampErr } = await admin
        .from("profiles")
        .update({ welcome_email_sent_at: new Date().toISOString() })
        .eq("user_id", person.id);

      if (stampErr) {
        // ⚠ Sent but not recorded — the one state that causes a DOUBLE send on
        // the next run. Loud, because it needs a human to stamp the row by hand.
        console.error(
          `send-welcome-backfill: SENT BUT NOT STAMPED for ${person.id} — ` +
          `stamp welcome_email_sent_at by hand or this member is mailed twice: ${stampErr.message}`,
        );
        failures.push({ user_id: person.id.slice(0, 8), error: "sent but not stamped: " + stampErr.message });
      }
      sent++;
    }

    return json({
      ok: failures.length === 0,
      sent,
      failed: failures.length,
      remaining: eligible.length - batch.length,
      failures,
    });
  } catch (err) {
    console.error("send-welcome-backfill: " + String(err));
    return json({ error: String(err) }, 500);
  }
});

function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
