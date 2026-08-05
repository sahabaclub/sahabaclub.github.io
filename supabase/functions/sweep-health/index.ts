// sweep-health
// ------------------------------------------------------------
// Answers one question: are the notification sweeps still running?
//
// It exists because a scheduler that stops is silent. pg_cron does not raise,
// does not email, and does not appear anywhere a person looks — the first sign
// is a member asking why nobody warned them their mailbox was expiring. The
// heartbeat is a row in `notification_sweep_runs` every fifteen minutes; this
// endpoint turns its ABSENCE into an HTTP status something can fail on.
//
// Called by .github/workflows/sweep-watchdog.yml.
//
// ============================================================
// ⚠ WHY THIS IS NOT GATED ON THE SERVICE-ROLE KEY
// ============================================================
//
// The obvious implementation is to let the watchdog present
// SUPABASE_SERVICE_ROLE_KEY, like send-license-reminders and
// send-transactional-email do. That is rejected here.
//
// The repo is PUBLIC. A GitHub Actions secret is not itself public — it is not
// in the tree and is not readable from a fork's pull request — but the
// service-role key is total authority over this database: every table, every
// row, RLS bypassed. Putting it in CI to answer "is the cron alive" trades the
// whole database against a liveness check. The blast radius of the credential
// should match the job it does.
//
// So this takes a DEDICATED token, WATCHDOG_TOKEN, which can do exactly one
// thing: read four scalars about scheduler freshness. If it leaks, somebody
// learns when the club's cron last ran. Rotating it is `supabase secrets set`
// and a repo-secret edit, with nothing else affected.
//
// The service-role key IS used inside the function, where it never leaves
// Supabase — that is the point of the split.
//
// ⚠ The response carries NO member data of any kind: four numbers and a
// timestamp. Do not add anything to it. The moment it carries a name or a
// count of people, its exposure stops being trivial and the reasoning above
// stops holding.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WATCHDOG_TOKEN
//   supabase secrets set WATCHDOG_TOKEN=... --project-ref sobxhcsgtimtiqtvqbag
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WATCHDOG_TOKEN = Deno.env.get("WATCHDOG_TOKEN") ?? "";

// The schedule is every 15 minutes. 45 allows two consecutive misses before
// anyone is woken up — a single skipped tick during a Supabase maintenance
// window is not worth an alert, and an alert that cries wolf gets muted, which
// is how a real outage goes unnoticed.
const STALE_AFTER_MINUTES = 45;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Length-independent comparison. The timing signal on a string compare is a
// stretch to exploit over the public internet, but this is three lines and the
// alternative is explaining why it was fine.
function tokensMatch(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // A missing WATCHDOG_TOKEN secret must FAIL CLOSED. Defaulting to open would
  // make an unconfigured deployment publicly readable, and the failure would
  // look exactly like success.
  if (!WATCHDOG_TOKEN) {
    return json({ error: "not configured" }, 503);
  }

  const presented =
    req.headers.get("x-watchdog-token") ??
    (req.headers.get("Authorization") ?? "").replace("Bearer ", "");

  if (!tokensMatch(presented, WATCHDOG_TOKEN)) {
    return json({ error: "not allowed" }, 403);
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: "not configured" }, 503);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data, error } = await admin
    .from("notification_sweep_health")
    .select("last_run_at, minutes_since_last_run, last_run_ok, runs_last_24h")
    .maybeSingle();

  if (error) {
    // The watchdog must not read a failed read as a healthy one.
    return json({ ok: false, reason: "could not read health", detail: error.message }, 500);
  }

  const minutes = data?.minutes_since_last_run ?? null;

  // ⚠ null is the WORST state, not the absence of a problem. It means the
  // table is empty — the schedule has never run at all, which is precisely the
  // failure this project has shipped twice. Treating null as "nothing to
  // report" would make the watchdog silent in exactly the case it exists for.
  const neverRan = minutes === null;
  const stale = neverRan || minutes > STALE_AFTER_MINUTES;
  const lastRunFailed = data?.last_run_ok === false;
  const ok = !stale && !lastRunFailed;

  return json(
    {
      ok,
      reason: neverRan
        ? "the sweeps have never run — is pg_cron enabled and section 5 of 0046 applied?"
        : stale
        ? `last run was ${minutes} minutes ago, over the ${STALE_AFTER_MINUTES} minute limit`
        : lastRunFailed
        ? "the last run completed but reported a failure — see notification_sweep_runs.detail"
        : "healthy",
      last_run_at: data?.last_run_at ?? null,
      minutes_since_last_run: minutes,
      runs_last_24h: data?.runs_last_24h ?? 0,
      stale_after_minutes: STALE_AFTER_MINUTES,
    },
    // A non-2xx is what lets `curl --fail` and the workflow below do the work
    // without parsing anything.
    ok ? 200 : 503
  );
});
