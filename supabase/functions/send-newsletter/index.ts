// send-newsletter
// ------------------------------------------------------------
// Resolves a segment from profiles.interests + newsletter_opt_in and reports
// its size. It no longer sends anything, and the rest of this header is why.
//
//   { interests: [], dryRun: true }   — count the segment  (works)
//   { subject, html, interests: [] }  — send               (refused, 501)
//
// Admin only: the caller's profile must have role = 'admin'.
//
// ============================================================
// Why the send path was removed rather than repaired
// ============================================================
//
// What it used to do, in one sentence: resolve every opted-in member, then POST
// them one at a time to Resend inside a single invocation, recording NOTHING
// about who had already been mailed.
//
// Three defects, and the third is the one that decides it:
//
//   1. The per-recipient `auth.admin.getUserById` loop ran BEFORE the `dryRun`
//      return, so merely COUNTING a segment cost one admin API round trip per
//      member. On any real membership the count alone approached the wall
//      clock, and counting is the safe operation.
//   2. It logged a member's email address on every Resend failure.
//   3. ⚠ The send loop was one sequential Resend POST per recipient against a
//      150s limit, with no per-recipient record written anywhere. Both halves
//      of that matter together: the loop CANNOT finish a real list inside the
//      limit, and because nothing is written per recipient, the invocation that
//      gets killed part-way leaves no trace of how far it got. The only
//      recovery is to run it again, which mails everyone who already received
//      it. There is no invocation of the old function that was safe — including
//      one that succeeded, since nothing recorded that it had.
//
// ---- Why this is not rebuilt on the send-campaign shape here ----
//
// `send-campaign` is the correct shape and this function should become it:
// bounded batches, a per-recipient row moved through
// approved → sending → sent/failed/skipped so a retry resumes instead of
// repeating, consent re-read at the moment of sending, and List-Unsubscribe on
// the message. Every one of those properties comes from ONE thing —
// `campaign_recipients`, a durable row per person. That table is where the
// resumability lives; the batching is just how it is walked.
//
// It cannot be reused as it stands: `campaign_recipients.contact_id` is NOT
// NULL and references `marketing_contacts` (migration 0011). Members are rows
// in `profiles`, and there is no foreign key from one to the other — the
// newsletter audience and the campaign audience are different populations. So
// a faithful rebuild needs a `newsletter_sends` ledger, which is a migration.
//
// A batched sender WITHOUT that ledger is not a smaller version of the fix, it
// is a different bug: a single invocation would mail the first batch and return
// `remaining`, and `app/newsletter.html` — which calls this once and reports
// `data.sent` — would show "sent to 25 members" and silently drop the rest.
// That is worse than the loud failure it replaces, because it looks like it
// worked.
//
// So the unsafe path is gone and the refusal names what to do instead. The
// count still works, and now costs one query.
//
// ---- What finishing this needs (neither is in supabase/functions/) ----
//
//   1. A migration adding a per-recipient ledger for member newsletters — the
//      `campaign_recipients` columns that matter are (id, recipient, status,
//      error, sent_at, updated_at) plus a unique key per (send, member).
//   2. `app/newsletter.html` pointed at whatever sends it, driving batches in a
//      loop and reporting progress, the way `app/admin/campaigns.html` already
//      drives `send-campaign` at :757 and :800.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// RESEND_API_KEY and RESEND_FROM are deliberately no longer read here: this
// function no longer sends mail, and holding the credential to do so would
// misrepresent that.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Emails live on auth.users, not profiles, so "how many can actually be
// reached" needs the auth side. `listUsers` is paginated — a handful of calls
// for the whole membership — rather than one call per member, which is what
// made the old count as expensive as a send.
const AUTH_PAGE_SIZE = 1000;
const AUTH_MAX_PAGES = 10;

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
    if (!callerProfile || callerProfile.role !== "admin" && callerProfile.role !== "global_admin") {
      return json({ error: "Admins only" }, 403);
    }

    const { interests, dryRun } = await req.json().catch(() => ({}));

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

    const matched = recipients?.length ?? 0;

    // ⚠ Anything that is not an explicit count is a send request, and there is
    // no send here. Refused BEFORE the reachability pass so a send request
    // costs nothing at all.
    //
    // 501, not 400: the request is well formed and would once have been
    // honoured. The caller is being told the capability is gone, which is a
    // different thing from being told they asked wrongly.
    if (dryRun !== true) {
      console.warn("send-newsletter: send refused — the send path was removed; use send-campaign");
      return json({
        error: "Newsletter sending has been turned off here. This function had no way to record who it had already mailed, " +
          "so a run that was interrupted — and on any real list it would be — could only be recovered by mailing everyone " +
          "a second time. Use the campaigns screen, which sends in reviewable batches and tracks every recipient.",
        code: "send_disabled",
        retryable: false,
        matched,
      }, 501);
    }

    const reachable = await countReachable(admin, recipients ?? []);

    return json({ ok: true, matched, reachable });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

// How many of these members have an email address at all. Phone-signup members
// may not, so they are not counted as reachable.
//
// One pass over the auth directory, not one lookup per member. Bounded by
// AUTH_MAX_PAGES so a directory larger than expected degrades into an
// undercount rather than into a timeout — and says so, rather than reporting a
// short number as though it were the answer.
async function countReachable(
  admin: ReturnType<typeof createClient>,
  recipients: Array<{ user_id: string }>,
): Promise<number> {
  if (!recipients.length) return 0;
  const wanted = new Set(recipients.map((r) => r.user_id));

  let reachable = 0;
  for (let page = 1; page <= AUTH_MAX_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: AUTH_PAGE_SIZE });
    if (error) {
      console.error("listUsers page " + page + ": " + error.message);
      break;
    }
    const users = data?.users ?? [];
    for (const u of users) {
      // No address is logged, here or anywhere else in this file. The old
      // version put a member's email in the function logs on every failure.
      if (u.email && wanted.has(u.id)) reachable++;
    }
    if (users.length < AUTH_PAGE_SIZE) break;
    if (page === AUTH_MAX_PAGES) {
      console.warn("send-newsletter: stopped paging the auth directory at " + AUTH_MAX_PAGES + " pages; count may be low");
    }
  }
  return reachable;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
