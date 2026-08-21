// backfill-profile-headlines
// ------------------------------------------------------------
// Writes the headline and the years-of-experience count that most profiles
// never got, from what is already on the profile.
//
// ============================================================
// Why these two fields are empty on almost everybody
// ============================================================
//
// `parse-profile-document` has produced both since it was written — they are
// in its schema with their own descriptions, and the form has had `f-headline`
// and `f-years` all along. Measured 19 Aug 2026: of 45 profiles, 25 came from
// a CV, all 25 have a bio and 20 have work history — so the extraction ran and
// its output was saved — yet only 4 have a headline and 7 a years count. The
// plumbing is intact; those profiles simply predate the two fields reaching
// it. Nothing needs fixing for NEW profiles. This is the arrears.
//
// ⚠ IT NEVER OVERWRITES. A member who wrote their own headline keeps it, and
// so does one whose headline the parser got right. Only a null or empty field
// is filled, and each field is decided separately — a profile with a headline
// and no year count gets only the count.
//
// ⚠ IT COUNTS, IT DOES NOT ESTIMATE. years_experience comes from dated roles
// in work_history. When there are no dates the model is told to return null
// rather than a guess, because a number on a profile reads as a fact and
// "sounds senior" is not one. Same rule parse-profile-document states.
//
//   POST /backfill-profile-headlines?dry=1        see who is in scope
//   POST /backfill-profile-headlines?limit=10     do the next 10
//
// Staff only, checked in this file. Delete it once the arrears are cleared —
// it is a one-off, like send-welcome-backfill was.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { callText, providerFor } from "../_shared/ai-provider.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-5";

// Small: each profile is its own model call, and an Edge Function has a
// wall-clock limit. Ten at a time finishes comfortably and can be repeated.
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 40;

const SYSTEM = [
  "You write one short professional headline for a member of Sahaba Club, an AI and cloud community, and count their years of professional experience.",
  "",
  "THE HEADLINE: six to ten words, the kind of line that sits under a name. Say what they do and what they are working on — not a bare job title, and not a sentence lifted out of their bio. Write it in the language the profile is written in.",
  "",
  "THE COUNT: total years of professional work, from the dated roles you are given — the span from the start of the earliest professional job to the most recent date. Leave out study and internships.",
  "",
  "⚠ Work it out or return nothing. Counting from dated roles is not inventing. Putting a number on how senior somebody sounds is. If there are no dates to count from, return null for the count — never a guess.",
  "⚠ Use only what you are given. Do not add an employer, a certification or a specialism that is not in the text.",
].join("\n");

const SCHEMA = {
  name: "profile_headline",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      headline: {
        type: "string",
        description: "Six to ten words. Empty string if there is nothing here to build one from.",
      },
      years_experience: {
        type: ["integer", "null"],
        description: "Total years from dated roles, 0 to 60. null when there are no dates to count from.",
      },
    },
    required: ["headline", "years_experience"],
  },
};

type Row = {
  user_id: string;
  full_name: string | null;
  headline: string | null;
  bio: string | null;
  company: string | null;
  position: string | null;
  industry: string | null;
  experience_level: string | null;
  skills: string[] | null;
  interests: string[] | null;
  years_experience: number | null;
  work_history: unknown;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!SERVICE_ROLE_KEY) return json({ error: "Not configured" }, 503);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ---- Who is asking ----  is_staff() must be asked AS THE CALLER: it reads
    // auth.uid(), which is null on an admin client.
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);

    const asCaller = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: staff, error: staffErr } = await asCaller.rpc("is_staff");
    if (staffErr) return json({ error: "Could not check permissions" }, 500);
    if (staff !== true) return json({ error: "Not allowed" }, 403);

    const params = new URL(req.url).searchParams;
    const dryRun = params.get("dry") === "1";
    const limit = clampLimit(params.get("limit"));

    const { data: rows, error: readErr } = await admin
      .from("profiles")
      .select("user_id, full_name, headline, bio, company, position, industry, experience_level, skills, interests, years_experience, work_history")
      .or("headline.is.null,headline.eq.,years_experience.is.null");

    if (readErr) {
      console.error("backfill-profile-headlines: read failed: " + readErr.message);
      return json({ error: "Could not read profiles" }, 500);
    }

    // ⚠ Only profiles with something to work FROM. A member who signed up and
    // filled in nothing has no material for a headline, and asking a model for
    // one anyway is how a profile ends up with a sentence about nobody.
    const candidates = (rows ?? []).filter((p: Row) => hasMaterial(p));
    const batch = candidates.slice(0, limit);

    if (dryRun) {
      return json({
        ok: true, dry_run: true,
        needs_something: (rows ?? []).length,
        have_material: candidates.length,
        would_do_now: batch.length,
        skipped_no_material: (rows ?? []).length - candidates.length,
        sample: batch.slice(0, 8).map((p: Row) => ({
          user_id: p.user_id.slice(0, 8),
          wants_headline: !nonEmpty(p.headline),
          wants_years: p.years_experience == null,
          has_bio: Boolean(p.bio && p.bio.trim().length > 40),
          roles: roleCount(p.work_history),
        })),
      });
    }

    let wroteHeadline = 0;
    let wroteYears = 0;
    const failures: { user_id: string; error: string }[] = [];

    for (const p of batch) {
      let out: { headline?: unknown; years_experience?: unknown };
      try {
        const res = await callText({
          model: MODEL,
          provider: providerFor(MODEL),
          system: SYSTEM,
          user: describe(p),
          maxOutputTokens: 2000,
          schema: SCHEMA,
        });
        if (!res.ok) {
          failures.push({ user_id: p.user_id.slice(0, 8), error: (res.error || "model refused").slice(0, 120) });
          continue;
        }
        out = JSON.parse(res.text);
      } catch (err) {
        failures.push({ user_id: p.user_id.slice(0, 8), error: String(err instanceof Error ? err.message : err).slice(0, 120) });
        continue;
      }

      // ⚠ Each field decided on its own, and only when it is currently empty.
      const patch: Record<string, unknown> = {};
      if (!nonEmpty(p.headline) && typeof out.headline === "string" && out.headline.trim()) {
        patch.headline = out.headline.trim().slice(0, 160);
      }
      if (p.years_experience == null && Number.isInteger(out.years_experience)) {
        const y = out.years_experience as number;
        // The 0..60 CHECK on the column. A value outside it would fail the
        // UPDATE and take the whole row's patch with it.
        if (y >= 0 && y <= 60) patch.years_experience = y;
      }
      if (!Object.keys(patch).length) continue;

      const { error: upErr } = await admin.from("profiles").update(patch).eq("user_id", p.user_id);
      if (upErr) {
        failures.push({ user_id: p.user_id.slice(0, 8), error: upErr.message.slice(0, 120) });
        continue;
      }
      if (patch.headline !== undefined) wroteHeadline++;
      if (patch.years_experience !== undefined) wroteYears++;
    }

    return json({
      ok: failures.length === 0,
      considered: batch.length,
      wrote_headline: wroteHeadline,
      wrote_years: wroteYears,
      remaining: Math.max(0, candidates.length - batch.length),
      failed: failures.length,
      failures,
    });
  } catch (err) {
    console.error("backfill-profile-headlines: " + String(err));
    return json({ error: String(err) }, 500);
  }
});

function nonEmpty(v: string | null): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function roleCount(wh: unknown): number {
  return Array.isArray(wh) ? wh.length : 0;
}

// Enough to write a line about: a real bio, a job title, or dated roles.
// Skills alone are not enough — "Excel, Teamwork" describes a thousand people.
function hasMaterial(p: Row): boolean {
  if (p.bio && p.bio.trim().length > 40) return true;
  if (nonEmpty(p.position) || nonEmpty(p.company)) return true;
  return roleCount(p.work_history) > 0;
}

// What the model is allowed to see. Deliberately narrow: no email, no user id,
// no links — none of it helps write a headline, and a prompt is the wrong
// place for anything that does not.
function describe(p: Row): string {
  const lines: string[] = [];
  if (nonEmpty(p.full_name)) lines.push("Name: " + p.full_name);
  if (nonEmpty(p.position)) lines.push("Current role: " + p.position);
  if (nonEmpty(p.company)) lines.push("Company: " + p.company);
  if (nonEmpty(p.industry)) lines.push("Industry: " + p.industry);
  if (nonEmpty(p.experience_level)) lines.push("Level they chose: " + p.experience_level);
  if (p.skills?.length) lines.push("Skills: " + p.skills.slice(0, 20).join(", "));
  if (p.interests?.length) lines.push("Interests: " + p.interests.slice(0, 20).join(", "));
  if (p.bio && p.bio.trim()) lines.push("About: " + p.bio.trim().slice(0, 1500));

  // ⚠ THE KEYS ARE position/company/start/end — NOT title/start_date/end_date.
  // The first version of this guessed the second set, so every role rendered
  // with no dates on it, the model dutifully returned null for the count on
  // all three profiles in the first batch, and the run reported
  // wrote_years: 0 with no failures. It looked like the model declining to
  // guess, which is exactly what it is supposed to do — the only reason it was
  // caught is that ZERO of three is not what a set of CVs with four, two and
  // six dated roles should produce. Measured against the real jsonb: 136 role
  // entries, every one of them carrying these six keys.
  const roles = Array.isArray(p.work_history) ? p.work_history : [];
  if (roles.length) {
    lines.push("Dated roles (for the count):");
    for (const r of roles.slice(0, 15)) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const span = [o.start, o.is_current === true ? "present" : o.end]
        .filter((x) => typeof x === "string" && x.trim())
        .join(" to ");
      const bits = [o.position, o.company, span]
        .filter((x) => typeof x === "string" && x.trim())
        .join(" · ");
      if (bits) lines.push("  - " + bits);
    }
  }

  // Said out loud so the model does not fill a gap it can see.
  if (!nonEmpty(p.headline)) lines.push("(This profile has no headline. Write one.)");
  if (p.years_experience == null) lines.push("(This profile has no year count. Count one, or return null.)");
  return lines.join("\n");
}

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
