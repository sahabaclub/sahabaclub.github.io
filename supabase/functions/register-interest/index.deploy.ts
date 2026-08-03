// GENERATED - do not edit. Deploy-time twin of index.ts with the ../_shared/cors.ts
// import replaced by the corsHeaders object inline, and nothing else. The Supabase
// dashboard editor deploys one function directory at a time and cannot reach a
// shared parent file. Edit index.ts and regenerate; the two must stay in step.

// register-interest
// ------------------------------------------------------------
// Somebody on the public hackathons page has said "tell me about EduHackAI-5".
// This records that, and emails the club so a human sees it the same day.
//
// ⚠ THIS IS THE ONLY ANONYMOUS FUNCTION IN THIS PROJECT, AND THAT IS
// DELIBERATE. Every other function here starts by proving who the caller is:
// provision-ms365 and notify-ms365-reset read the caller's own JWT,
// send-transactional-email demands the service-role key. This one cannot. The
// form it serves sits on a page that signed-out visitors read, and asking
// somebody to create an account before they may express interest in a
// hackathon is the opposite of the point.
//
// So every assumption those other functions get to make about their caller is
// unavailable here. The body is written by a stranger, the headers are written
// by a stranger, the size of the request is chosen by a stranger, and all four
// of the fields end up rendered as HTML in Ahmed's mail client. Everything
// below follows from that:
//
//   * the body is read through a byte cap, not with req.json(), so a 10MB
//     payload is dropped as it arrives rather than after it is buffered;
//   * every field is trimmed, stripped of control characters and length-capped
//     BEFORE any database or network work happens;
//   * the round is looked up by slug and rejected if unknown — the caller
//     never supplies an id, so it cannot aim this at another table's row;
//   * the notification's recipient is not in the request. It is a constant
//     here, and send-transactional-email pins it a second time for this
//     template (see FIXED_RECIPIENT there). A stranger cannot make this mail
//     anybody but the club.
//
// What it is NOT protected against, said plainly rather than implied away:
// there is no real rate limiting. `throttled()` below is an in-memory counter
// inside one isolate, and Supabase runs many isolates and recycles them, so a
// determined script gets as many rows as it likes. It cannot mail anybody but
// the club and it cannot write any other table, so the damage is junk rows in
// one table, cleanable from the admin page. Proper limiting needs either a
// table to count in (rejected: this is a public form and a write-per-attempt
// is its own problem) or Supabase's platform-level limits. Ahmed should know
// that is the state of it.
//
// ⚠ DEPLOY THIS ONE WITH JWT VERIFICATION OFF:
//
//     supabase functions deploy register-interest --no-verify-jwt
//
// The gateway's verify_jwt only accepts the older JWT-style anon key, and
// lib/supabase-client.js ships the newer `sb_publishable_…` key, which is not
// a JWT. Left on, the platform returns 401 before this file ever runs and the
// form fails for everybody with nothing in the function logs to explain it.
//
// ============================================================
// How the row gets written (migration 0036)
// ============================================================
//
// NOT with an insert. 0036 revokes `public.hackathon_interest` from anon and
// authenticated outright and leaves exactly one write path:
//
//   public.register_hackathon_interest(
//     p_slug text, p_full_name text, p_email text,
//     p_mobile text default null, p_current_job text default null
//   ) returns table (interest_id uuid, is_new boolean)
//
// `security definer`, EXECUTE granted to `service_role` alone. It resolves the
// slug itself, normalises the email, and upserts on
// (hackathon_id, lower(btrim(email))) — so idempotency is one statement inside
// the database rather than a select-then-insert here with a race between the
// two. `is_new` comes from `xmax = 0`, which is true only for a row that was
// genuinely inserted; that is what decides whether Ahmed is told, and it is
// what this function returns as `already`.
//
// The one column this function writes directly is `notified_at`, which 0036
// documents as the Edge Function's to set, for the same reason provision-ms365
// owns `credential_sent_at`: only the code that watched the send succeed can
// honestly say it did.
//
// If 0036 has not been applied, the RPC is missing rather than the table, and
// the message below says so in words an operator can act on.
//
// One deliberate difference from the RPC: it treats mobile and current_job as
// optional and CLIPS over-long values, because a database function's job is to
// accept what it is given. This function requires all four fields and REJECTS
// an over-long one, naming it, because a form can point at a field and ask
// again — and it is better for somebody to fix their own typo than for the
// club to store a silently truncated job title.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   INTEREST_NOTIFY_EMAIL                    — optional, defaults below
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// ---- inlined from ../_shared/cors.ts ----
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Where a new registration is announced. A constant, never a request field:
// the whole reason this endpoint is not a spam relay is that the person
// filling the form has no say in who hears about it. Read from the
// environment so it can move without a redeploy.
const NOTIFY_EMAIL = Deno.env.get("INTEREST_NOTIFY_EMAIL") ?? "ahmed@sahabaclub.com";

// Four short text fields and a slug. Anything larger than this is not a
// person filling in a form, so it is refused before it is decoded.
const MAX_BODY_BYTES = 8 * 1024;

// Caps applied after trimming, before anything else looks at the value. They
// are generous enough for a long Arabic name written in full and a job title
// with a department in it, and small enough that no single field can turn the
// notification into a wall of text.
const LIMITS: Record<string, number> = {
  full_name: 120,
  email: 254, // the longest an address may be, per RFC 5321
  mobile: 32,
  current_job: 120,
  round_slug: 64,
};

// The in-memory throttle described in the header. Per isolate, best effort,
// and honest about being neither of the things a rate limiter should be.
const THROTTLE_WINDOW_MS = 60_000;
const THROTTLE_MAX = 6;
const THROTTLE_MAX_KEYS = 1000;
const recentByCaller = new Map<string, number[]>();

// A mobile number typed by a real person in the Gulf or North Africa arrives
// in more shapes than a regex should have opinions about: +971 50 421 6499,
// 00201001234567, (050) 421-6499, 050/4216499, and — often — with Arabic-Indic
// digits straight off a phone keyboard. So the test is deliberately loose:
// the characters have to be plausible for a phone number, and there have to be
// between 7 and 15 digits once you count them. Nothing is rewritten; the value
// stored is the value typed, because a number the club later reads aloud or
// pastes into WhatsApp should be the one its owner recognises.
const PHONE_CHARS = /^[0-9\u0660-\u0669\u06F0-\u06F9+\-()./\s]+$/;
const ARABIC_INDIC = /[\u0660-\u0669\u06F0-\u06F9]/g;

// Not a full RFC 5322 parser and not trying to be — that regex accepts things
// no mail server would and rejects nothing useful. This asks the three
// questions that actually catch typos: one @, something either side of it, and
// a dot in the domain.
const EMAIL_RE = /^[^\s@,;:<>"'\\]+@[^\s@,;:<>"'\\.]+(\.[^\s@,;:<>"'\\.]+)+$/;

// Slugs are ours: 'eduhackai-5'. Checked here so a hostile value never reaches
// the query at all, on top of the round having to exist.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return fail("Send this as a POST request.", "method_not_allowed", 405);
  }

  try {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      console.error("register-interest: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
      return fail(
        "Registration is not available right now. Please try again shortly.",
        "server_not_configured",
        500,
      );
    }

    // ---- 1. The request itself, before it is trusted to be JSON ----
    if (throttled(req)) {
      return fail(
        "That is a lot of registrations from one place. Wait a minute and try again.",
        "rate_limited",
        429,
      );
    }

    const raw = await readCapped(req, MAX_BODY_BYTES);
    if (raw === null) {
      return fail("That request was too large to be a registration form.", "payload_too_large", 413);
    }

    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return fail("We couldn't read that submission. Please try again.", "invalid_json", 400);
    }

    // ---- 2. The fields, before anything looks anything up ----
    const fullName = clean(body.full_name);
    const email = clean(body.email).toLowerCase();
    const mobile = clean(body.mobile);
    const currentJob = clean(body.current_job);
    const roundSlug = clean(body.round_slug).toLowerCase();

    // Three strings per field: the name the form knows it by, the phrase that
    // fits "Please tell us …", and the noun that fits "… is too long". Written
    // out rather than derived, because an error a stranger reads mid-form is
    // not the place to be clever with string surgery.
    const fields: { field: string; value: string; ask: string; noun: string }[] = [
      { field: "full_name", value: fullName, ask: "your name", noun: "That name" },
      { field: "email", value: email, ask: "your email address", noun: "That email address" },
      { field: "mobile", value: mobile, ask: "your mobile number", noun: "That mobile number" },
      { field: "current_job", value: currentJob, ask: "what you do at the moment", noun: "That job title" },
      { field: "round_slug", value: roundSlug, ask: "which round this is for", noun: "That round" },
    ];
    for (const f of fields) {
      if (!f.value) return fail(`Please tell us ${f.ask}.`, "missing_field", 400, f.field);
      if (f.value.length > LIMITS[f.field]) {
        return fail(
          `${f.noun} is too long — please keep it under ${LIMITS[f.field]} characters.`,
          "too_long",
          400,
          f.field,
        );
      }
    }

    if (!EMAIL_RE.test(email)) {
      return fail("That doesn't look like an email address we could reach you at.", "invalid_email", 400, "email");
    }
    if (!plausibleMobile(mobile)) {
      return fail(
        "That doesn't look like a mobile number. Include the country code if you can — +971 50 000 0000.",
        "invalid_mobile",
        400,
        "mobile",
      );
    }
    if (!SLUG_RE.test(roundSlug)) {
      return fail("We don't recognise that hackathon round.", "unknown_round", 404, "round_slug");
    }

    // ---- 3. The round. Resolved from the slug; never taken as an id ----
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: round, error: roundErr } = await admin
      .from("hackathons")
      .select("id, slug, name")
      .eq("slug", roundSlug)
      .maybeSingle();

    if (roundErr) {
      console.error("register-interest: hackathons lookup failed:", roundErr);
      return fail("We couldn't check that hackathon round. Please try again shortly.", "round_lookup_failed", 500);
    }
    if (!round) {
      return fail("We don't recognise that hackathon round.", "unknown_round", 404, "round_slug");
    }

    // ---- 4. Write it, through the one function allowed to ----
    //
    // The upsert and the "was this new?" answer are a single statement inside
    // the database, so two simultaneous submissions cannot both come back as
    // new and cannot produce two rows. The alternative — select, then insert,
    // then interpret a unique violation — has a window between the two
    // statements and was rejected for that.
    const { data: rpcData, error: rpcErr } = await admin.rpc("register_hackathon_interest", {
      p_slug: roundSlug,
      p_full_name: fullName,
      p_email: email,
      p_mobile: mobile,
      p_current_job: currentJob,
    });

    if (rpcErr) {
      if (isMissingObject(rpcErr)) return notMigrated();
      // 22023 is the code the RPC raises for every argument it refuses. Its
      // own validation is stricter than the table's constraints and looser
      // than the checks above, so reaching it means this function's idea of a
      // valid submission and the database's have drifted apart. Say which
      // field, if it named one, and log the rest for whoever has to fix it.
      const code = String((rpcErr as { code?: string }).code ?? "");
      const detail = String((rpcErr as { message?: string }).message ?? "");
      if (code === "22023") {
        console.error("register-interest: the database refused a submission this function accepted:", detail);
        if (/no hackathon with slug/i.test(detail)) {
          return fail("We don't recognise that hackathon round.", "unknown_round", 404, "round_slug");
        }
        if (/email/i.test(detail)) {
          return fail("That doesn't look like an email address we could reach you at.", "invalid_email", 400, "email");
        }
        if (/full name/i.test(detail)) {
          return fail("Please tell us your name.", "missing_field", 400, "full_name");
        }
        return fail("We couldn't accept those details. Please check them and try again.", "rejected", 400);
      }
      console.error("register-interest: register_hackathon_interest failed:", rpcErr);
      return fail("We couldn't record that just now. Please try again shortly.", "insert_failed", 500);
    }

    // The RPC `returns table (…)`, so supabase-js hands back an array of one.
    const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
      { interest_id?: string; is_new?: boolean } | null | undefined;
    const isNew = row?.is_new === true;
    const id = row?.interest_id ?? null;

    // ---- 5. Tell the club. Never at the cost of the registration ----
    //
    // The row exists by now. If Resend is down, or the mail function has been
    // redeployed with a rotated key, the person still registered successfully
    // and must be told so — the row is the durable record and the admin page
    // reads it whether or not this email ever went. What the failure costs is
    // a `notified_at` that stays null, which is exactly what the admin page
    // shows as "not emailed" so a human can chase it.
    //
    // A re-submission does not bother Ahmed twice. The one exception is a
    // registration whose notification never went: leaving that alone means a
    // lost lead stays lost precisely because the person did the sensible thing
    // and tried again.
    if (isNew) {
      await notify(admin, { id, fullName, email, mobile, currentJob, round, repeat: false });
    } else if (id && !(await alreadyNotified(admin, id))) {
      await notify(admin, { id, fullName, email, mobile, currentJob, round, repeat: true });
    }

    return json({ ok: true, already: !isNew });
  } catch (err) {
    console.error("register-interest:", err);
    return fail("Something went wrong on our side. Please try again shortly.", "unexpected", 500);
  }
});

// ============================================================
// The notification
// ============================================================

interface NotifyArgs {
  id?: string | null;
  fullName: string;
  email: string;
  mobile: string;
  currentJob: string;
  round: { id: string; slug: string; name?: string | null };
  repeat: boolean;
}

// Returns nothing and throws nothing: every caller has already succeeded at
// the thing the visitor asked for, and none of them may fail because of this.
async function notify(admin: ReturnType<typeof createClient>, args: NotifyArgs) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-transactional-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // send-transactional-email is service-role only and is not callable
        // from a browser. This is a function-to-function call.
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        // Passed for the log line it writes, but not what decides the
        // recipient: that template pins its own destination. See
        // FIXED_RECIPIENT in send-transactional-email.
        to: NOTIFY_EMAIL,
        template: "hackathon_interest",
        data: {
          fullName: args.fullName,
          email: args.email,
          mobile: args.mobile,
          currentJob: args.currentJob,
          roundName: args.round.name || args.round.slug,
          roundSlug: args.round.slug,
          registrationId: args.id ?? "",
          repeat: args.repeat,
        },
      }),
    });

    if (!resp.ok) {
      console.error("register-interest: notification failed:", resp.status, await safeText(resp));
      return;
    }

    if (args.id) {
      await admin
        .from("hackathon_interest")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", args.id);
    }
  } catch (err) {
    console.error("register-interest: notification threw:", err);
  }
}

// Read-only, and only ever asked about a row the RPC just told us about. A
// failure here is answered "yes, already notified", because the cost of being
// wrong that way is a lead Ahmed has to find on the admin page, and the cost
// of being wrong the other way is mailing him again every time somebody
// refreshes a form.
async function alreadyNotified(admin: ReturnType<typeof createClient>, id: string): Promise<boolean> {
  const { data, error } = await admin
    .from("hackathon_interest")
    .select("notified_at")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("register-interest: could not read notified_at:", error);
    return true;
  }
  return !!data?.notified_at;
}

async function safeText(resp: Response) {
  try {
    return (await resp.text()).slice(0, 500);
  } catch {
    return "(no body)";
  }
}

// ============================================================
// Reading the request safely
// ============================================================

// req.json() and req.text() both buffer the whole body first, so a caller who
// sends ten megabytes has already cost us ten megabytes by the time any check
// runs. This reads the stream and gives up the moment the total passes the
// cap, returning null rather than a string.
async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    try {
      await req.body?.cancel();
    } catch { /* the client hung up; nothing to release */ }
    return null;
  }

  if (!req.body) return "";

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      try {
        await reader.cancel();
      } catch { /* as above */ }
      return null;
    }
    chunks.push(value);
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

// ============================================================
// Cleaning and validating
// ============================================================

// One place where a submitted value becomes a stored value. Non-strings become
// empty rather than "[object Object]" or "null", control characters (including
// the newlines somebody would use to try to shape the notification) become
// spaces, runs of whitespace collapse, and the result is trimmed. Length is
// checked by the caller, against LIMITS, so the field can be named in the
// error.
function clean(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return "";
  return v
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function plausibleMobile(v: string): boolean {
  if (!PHONE_CHARS.test(v)) return false;
  const digits = v.replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) & 0xf)).replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

// Per-isolate, per-caller, best effort. See the header: this is a sanity limit
// that stops one open tab hammering the endpoint, not a control anybody should
// describe as rate limiting.
function throttled(req: Request): boolean {
  const key = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
    req.headers.get("cf-connecting-ip") ||
    "unknown";

  const now = Date.now();
  const hits = (recentByCaller.get(key) ?? []).filter((t) => now - t < THROTTLE_WINDOW_MS);
  hits.push(now);
  recentByCaller.set(key, hits);

  // The map is the only thing here that grows, and a stranger chooses the
  // keys, so it is bounded rather than trusted. Oldest-inserted first: Map
  // iterates in insertion order.
  if (recentByCaller.size > THROTTLE_MAX_KEYS) {
    for (const k of recentByCaller.keys()) {
      recentByCaller.delete(k);
      if (recentByCaller.size <= THROTTLE_MAX_KEYS) break;
    }
  }

  return hits.length > THROTTLE_MAX;
}

// ============================================================
// Responses
// ============================================================

// "0036 has not been applied" arrives under four different codes depending on
// whether it is the function or the table that is missing and whether
// PostgREST or Postgres noticed first, so all four are treated as the one
// thing they actually mean.
//
//   42883 / PGRST202 — the RPC does not exist (0036 never ran)
//   42P01 / PGRST205 — the table does not exist, or is not in the schema cache
function isMissingObject(err: unknown): boolean {
  const e = (err ?? {}) as { code?: string; message?: string };
  if (["42883", "PGRST202", "42P01", "PGRST205"].includes(String(e.code ?? ""))) return true;
  const m = e.message ?? "";
  return /(hackathon_interest|register_hackathon_interest)/.test(m) &&
    /(does not exist|schema cache|could not find)/i.test(m);
}

function notMigrated() {
  const message =
    "Interest registration is not switched on yet: register_hackathon_interest / " +
    "hackathon_interest is missing from the database. Apply migration 0036 and try again.";
  console.error(`register-interest: ${message}`);
  return fail(message, "table_missing", 500);
}

function fail(error: string, code: string, status: number, field?: string) {
  return json(field ? { error, code, field } : { error, code }, status);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
