// send-notification-emails
// ------------------------------------------------------------
// The email copy of a notification with a deadline. Reads `email_queue()`,
// sends each row through send-transactional-email, and stamps `emailed_at` so
// nothing is delivered twice.
//
// ⚠ THIS FUNCTION HAS NEVER RUN. It was written without Deno on the machine
// that produced it, so it has had no typecheck and no execution. Run it with
// ?dry=1 FIRST and read the count before letting it send anything.
//
// ============================================================
// What this deliberately does NOT decide
// ============================================================
//
// Who gets an email is decided entirely by `email_queue()` in 0051: which
// kinds use the email channel, who has switched it off, whether they already
// read it in the app, the 24-hour horizon, and whether the address was ever
// confirmed. None of that is repeated here. A sender that re-implemented the
// filter would be a second place for it to drift from `should_notify`, and the
// drift shows up as members receiving mail they had switched off — the exact
// failure the preference system exists to prevent.
//
// This file's only judgement is about DELIVERY: batching, pacing, and what a
// failure means.
//
// ============================================================
// ⚠ THE SENDING DOMAIN IS THE THING BEING PROTECTED
// ============================================================
//
// Every email here leaves sahabaclub.com. That domain also carries human
// replies, Microsoft 365 credentials and the newsletter. Enough spam
// complaints and the club loses the ability to send ANY of it — the failure is
// not "this reminder did not arrive", it is "nothing from the club arrives any
// more, including a person answering a question".
//
// So the caution is deliberate and lives at three levels: the queue only ever
// contains the three deadline kinds, it excludes anything already read, and
// this file sends SEQUENTIALLY with a small gap rather than firing a burst.
// The burst is what a spam filter notices.
//
// Trigger: pg_cron via pg_net, alongside the sweeps — see task #10. ⚠ The
// credential must come from Supabase Vault, NOT pasted into `cron.schedule`;
// `cron.job` stores the statement in plaintext for any SQL session to read.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// See the long note beside the check below, and in send-push.
const SENDER_TOKEN = Deno.env.get("SENDER_TOKEN") ?? "";

// One pass. Small on purpose: this runs every few minutes, so a backlog drains
// over several passes rather than one invocation trying to mail everybody and
// looking exactly like a spam run while it does.
const BATCH = 50;

// Between sends. Resend's own limits are far higher than this — the pacing is
// about how a receiving provider reads a sudden burst from a domain that
// normally sends a handful a day.
const GAP_MS = 250;

interface QueueRow {
  notification_id: string;
  recipient_email: string;
  full_name: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ⚠ WHICH TEMPLATE, AND THEREFORE WHICH SENDER ADDRESS.
//
// The event reminder goes out from events@sahabaclub.com rather than the club
// address (Ahmed, 13 Aug); send-transactional-email picks the from line off the
// template name, so this map is what decides it. Everything else keeps the one
// generic `notification` template it has always used.
//
// ⚠ This does NOT decide who gets mailed — `email_queue()` still owns that, and
// this map must never grow into a second filter. A kind missing from here gets
// the default template, not silence.
const TEMPLATE_BY_KIND: Record<string, string> = {
  event_starting_soon: "event_reminder",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Scheduled job, not a public endpoint. Without this anyone could drain the
  // queue — or simply run it repeatedly to make the club look like a spammer.
  // ⚠ SENDER_TOKEN, with SUPABASE_SERVICE_ROLE_KEY kept as a fallback. The
  // value Supabase injects as SUPABASE_SERVICE_ROLE_KEY matches none of the
  // keys the dashboard offers, so comparing against it alone returned 403 to
  // every scheduled call. Proven by digest comparison and then confirmed by
  // storing the legacy service_role key and still getting 403. Full account in
  // tools/generate-sender-token.mjs and in send-push.
  //
  // Fails closed either way: an unset token cannot match, because the empty
  // string is rejected before the comparison.
  const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const expected = SENDER_TOKEN || SERVICE_ROLE_KEY;
  if (!expected || bearer !== expected) {
    return json({ error: "Not allowed" }, 403);
  }
  if (!SUPABASE_URL) return json({ error: "not configured" }, 503);

  const dryRun = new URL(req.url).searchParams.get("dry") === "1";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data, error } = await admin.rpc("email_queue", { p_limit: BATCH });
  if (error) {
    // ⚠ "permission denied for function email_queue" here means the
    // service_role grants in 0051 were not applied. That is the single most
    // likely first failure, and it is the same one 0047 documented for push.
    return json({ error: error.message }, 500);
  }

  const rows = (data ?? []) as QueueRow[];
  if (!rows.length) return json({ ok: true, queued: 0, sent: 0, failed: 0 });

  if (dryRun) {
    // ⚠ No addresses in the response. A dry run must not print members' email
    // addresses into the function logs, where they are readable by anyone with
    // dashboard access and outlive the run.
    const byKind: Record<string, number> = {};
    for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    return json({ ok: true, dryRun: true, queued: rows.length, byKind });
  }

  let sent = 0;
  let failed = 0;
  const sentIds: string[] = [];
  const failures: Array<{ kind: string; status: number; detail: string }> = [];

  for (const row of rows) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-transactional-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          to: row.recipient_email,
          template: TEMPLATE_BY_KIND[row.kind] ?? "notification",
          data: {
            fullName: row.full_name,
            title: row.title,
            body: row.body,
            href: row.href,
          },
        }),
      });

      if (res.ok) {
        sent++;
        sentIds.push(row.notification_id);
      } else {
        failed++;
        const detail = (await res.text()).slice(0, 160);
        // ⚠ The KIND is recorded, never the address. A failure log that names
        // who was mailed is a member list sitting in the function logs.
        failures.push({ kind: row.kind, status: res.status, detail });
      }
    } catch (e) {
      failed++;
      failures.push({ kind: row.kind, status: 0, detail: String(e).slice(0, 160) });
    }

    await sleep(GAP_MS);
  }

  // ⚠ Only what actually sent is stamped. A failed send stays in the queue and
  // is retried next pass — which is right for a deadline reminder, and is why
  // the horizon in email_queue matters: a persistently failing row ages out
  // after 24 hours rather than being retried forever.
  let marked = 0;
  if (sentIds.length) {
    const { data: n, error: markError } = await admin.rpc("mark_emailed", { p_ids: sentIds });
    if (markError) {
      // Loud, because the alternative is mailing the same people again on the
      // next pass — the one failure mode that turns a reminder into spam.
      return json(
        { ok: false, error: "sent but could not mark emailed", detail: markError.message, sent, failed },
        500
      );
    }
    marked = Number(n) || 0;
  }

  return json({ ok: failed === 0, queued: rows.length, sent, failed, marked, failures });
});
