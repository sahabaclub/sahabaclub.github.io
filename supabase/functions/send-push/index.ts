// send-push
// ------------------------------------------------------------
// Delivers the push copy of a notification. Reads `push_queue()`, sends each
// row to its browser's push service, records what happened, and stamps
// `pushed_at` so nothing is delivered twice.
//
// ⚠ THIS FUNCTION HAS NEVER RUN. It was written without Deno available on the
// machine that produced it, so it has had NO typecheck and NO execution — not
// even an import resolution. Treat the first invocation as the first test, run
// it with ?dry=1 before anything else, and read the logs rather than assuming.
// Everything else in this feature is verified by parse and contract checks;
// this file is the weakest evidence in it.
//
// ============================================================
// What this deliberately does NOT decide
// ============================================================
//
// Who should receive a push is decided ENTIRELY by `push_queue()` in 0047:
// which kinds use the push channel, who has switched push off, the 24-hour
// horizon, and whether the member already read it. None of that logic is
// repeated here, on purpose. A sender that re-implemented the eligibility
// filter in TypeScript would be a second place for it to drift from
// `should_notify`, and the drift would show up as members receiving things
// they had switched off — the exact failure the preference system exists to
// prevent.
//
// This file's only judgement is about DELIVERY: batching, retries, and what a
// push service's error code means.
//
// Trigger: pg_cron via pg_net, alongside the sweeps. ⚠ The credential must
// come from Supabase Vault, NOT pasted into `cron.schedule` — `cron.job`
// stores the statement in plaintext for any SQL session to read. See section 6
// of 0046, which says the same thing about the email sender.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//          VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
// Push services want a contact for whoever is sending, so they can get in
// touch before blocking an origin that misbehaves.
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:info@sahabaclub.com";

// One pass. Deliberately modest: this runs every few minutes, so a backlog
// drains over several passes rather than one invocation racing a timeout.
const BATCH = 200;

// Sent at once. Push services are fine with parallelism, but an unbounded
// Promise.all over a large backlog opens hundreds of sockets from one worker.
const CONCURRENCY = 10;

interface QueueRow {
  notification_id: string;
  title: string;
  body: string | null;
  href: string | null;
  tag: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Scheduled job, not a public endpoint. Without this anyone could drain the
  // queue, or simply run it repeatedly to make the club look broken.
  const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (!SERVICE_ROLE_KEY || bearer !== SERVICE_ROLE_KEY) {
    return json({ error: "Not allowed" }, 403);
  }

  // ⚠ Fail closed and say which half is missing. An unconfigured deployment
  // that returned 200 with "sent: 0" would look exactly like a quiet day, and
  // this project has a documented history of exactly that confusion.
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return json(
      {
        error: "VAPID keys are not set",
        hint: "node tools/generate-vapid-keys.mjs, then supabase secrets set --env-file",
      },
      503
    );
  }

  const dryRun = new URL(req.url).searchParams.get("dry") === "1";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  } catch (e) {
    return json({ error: "VAPID keys were rejected", detail: String(e) }, 503);
  }

  const { data, error } = await admin.rpc("push_queue", { p_limit: BATCH });
  if (error) {
    // ⚠ "permission denied for function push_queue" here means the
    // service_role grants in section 4 of 0047 were not applied. That is the
    // single most likely first failure of this function.
    return json({ error: error.message }, 500);
  }

  const rows = (data ?? []) as QueueRow[];
  if (!rows.length) return json({ ok: true, queued: 0, sent: 0, failed: 0, gone: 0 });
  if (dryRun) {
    return json({
      ok: true,
      dryRun: true,
      queued: rows.length,
      // No payloads, no endpoints: a dry run must not print a capability into
      // the function logs.
      distinctNotifications: new Set(rows.map((r) => r.notification_id)).size,
    });
  }

  let sent = 0;
  let failed = 0;
  let gone = 0;
  const deliveredNotificationIds = new Set<string>();

  async function deliver(row: QueueRow) {
    const payload = JSON.stringify({
      title: row.title,
      body: row.body ?? "",
      href: row.href ?? null,
      tag: row.tag,
    });

    try {
      await webpush.sendNotification(
        {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        },
        payload,
        // Sit in the push service's queue for at most an hour. These are
        // time-bound things — an event starting, a licence expiring — and a
        // reminder delivered six hours late is worse than one not delivered.
        { TTL: 3600 }
      );

      sent++;
      deliveredNotificationIds.add(row.notification_id);
      await admin.rpc("record_push_result", { p_endpoint: row.endpoint, p_ok: true });
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode ?? 0;

      // 404 and 410 are the push services saying this subscription is
      // permanently dead — uninstalled, permission revoked, token rotated.
      // record_push_result deletes it. Anything else is soft: a timeout, a
      // 5xx, a rate limit. Those increment a counter and are retried next pass.
      const isGone = status === 404 || status === 410;
      if (isGone) gone++;
      else failed++;

      await admin.rpc("record_push_result", {
        p_endpoint: row.endpoint,
        p_ok: false,
        p_gone: isGone,
      });

      // ⚠ A dead endpoint must NOT hold its notification back. If every one of
      // a member's devices is gone, the notification would otherwise be
      // retried on every pass forever. It is marked pushed below regardless of
      // per-device outcome, because "we tried every device we knew about" is
      // what pushed_at records — not "it definitely arrived", which no push
      // service ever tells us anyway.
      deliveredNotificationIds.add(row.notification_id);
    }
  }

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    await Promise.all(rows.slice(i, i + CONCURRENCY).map(deliver));
  }

  let marked = 0;
  if (deliveredNotificationIds.size) {
    const { data: markedCount, error: markError } = await admin.rpc("mark_pushed", {
      p_ids: Array.from(deliveredNotificationIds),
    });
    if (markError) {
      // Worth being loud about: sends succeeded but the stamp failed, so the
      // next pass will send them all again. Better to know than to discover it
      // from a member receiving the same banner every five minutes.
      return json(
        { ok: false, error: "sent but could not mark pushed", detail: markError.message, sent, failed, gone },
        500
      );
    }
    marked = Number(markedCount) || 0;
  }

  return json({ ok: true, queued: rows.length, sent, failed, gone, marked });
});
