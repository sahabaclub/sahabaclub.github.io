// GENERATED - do not edit. Deploy-time twin of index.ts with the ../_shared/cors.ts, ../_shared/ai-config.ts imports replaced by those files inline, and
// nothing else. The Supabase dashboard editor deploys one function directory at a
// time and cannot reach a shared parent file. Edit index.ts and regenerate; the
// two must stay in step.

// write-contact-email
// ------------------------------------------------------------
// Writes one email per person, using that person's own history with the club
// — the events they registered for, the ones they actually turned up to,
// where they registered from, what they were studying, whether they already
// hold a Sahaba Club mailbox.
//
// It writes drafts. It does not send. Every draft lands in
// campaign_recipients with status 'generated' and a human has to approve it
// before send-campaign will touch it. That separation is deliberate: this
// model is writing to nine hundred real people who gave us their address to
// attend an event, and a hallucinated "great to see you at EduHackAI" to
// somebody who never went is not a small mistake.
//
// Called from the admin campaigns screen in batches, because 900 sequential
// model calls will not fit in one function invocation and pretending
// otherwise just means half-finished campaigns.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   OPENAI_API_KEY
//   OPENAI_MODEL                             — optional, defaults below
//
// Since 0031 the system prompt, the model and the output ceiling can also be
// set from Admin → AI services, under the `write-contact-email` service. The
// constants below remain the floor: with nothing activated, or with the
// database unreachable, this function behaves exactly as it did before.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// ---- inlined from ../_shared/cors.ts ----
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
// ---- inlined from ../_shared/ai-config.ts ----
type AiDb = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
};

// A whole invocation reads the same configuration, and some of these functions
// loop — `promptarena-judge` drains a queue, `refresh-avatars` walks a batch,
// `write-contact-email` writes for up to 25 people. One read per invocation
// rather than one per item, without making a stale cache outlive the instance
// that made it.
//
// 60 seconds, not "for ever": Edge Function instances are reused between
// requests, so a permanent memo would mean an activated prompt taking effect
// only after the instance recycled — which is invisible, unpredictable, and
// exactly the kind of thing that gets debugged as "the save didn't work".
const CACHE_MS = 60_000;

const cache = new Map<string, { at: number; row: StoredConfig | null }>();

type StoredConfig = {
  model: string | null;
  max_output_tokens: number | null;
  parts: unknown;
  version: number | null;
  config_digest: string | null;
};

type AiDefaults = {
  model: string;
  maxOutputTokens?: number;
  parts: Record<string, unknown>;
};

type AiConfig = {
  slug: string;
  model: string;
  maxOutputTokens: number;
  parts: Record<string, unknown>;
  version: number;
  digest: string;
  // 'database' means at least one field came from a stored version. Logged by
  // some callers so a support question about a strange answer can start with
  // "which prompt produced it".
  source: "database" | "code";
};

// The one entry point. `slug` is `ai_services.slug`; `defaults` is what the
// function would have used before 0031 existed.
async function loadAiConfig(
  admin: AiDb,
  slug: string,
  defaults: AiDefaults,
): Promise<AiConfig> {
  const base: AiConfig = {
    slug,
    model: defaults.model,
    maxOutputTokens: defaults.maxOutputTokens ?? 0,
    parts: { ...defaults.parts },
    version: 0,
    digest: "",
    source: "code",
  };

  const row = await read(admin, slug);
  if (!row) return base;

  const merged: AiConfig = { ...base, parts: { ...defaults.parts } };
  let touched = false;

  const model = trimmed(row.model);
  if (model) {
    merged.model = model;
    touched = true;
  }

  // Only accepted when the caller has a ceiling at all. A service that does
  // not send `max_output_tokens` to OpenAI (the image ones) must not acquire
  // one because a row carried a number.
  if (defaults.maxOutputTokens && Number.isInteger(row.max_output_tokens) && (row.max_output_tokens as number) > 0) {
    merged.maxOutputTokens = row.max_output_tokens as number;
    touched = true;
  }

  // Part-by-part, and only keys the caller declared. A stored `parts` object
  // carrying a key this version of the function knows nothing about is
  // ignored rather than passed through — which is what makes rolling the code
  // back over a newer stored configuration safe.
  if (row.parts && typeof row.parts === "object" && !Array.isArray(row.parts)) {
    const stored = row.parts as Record<string, unknown>;
    for (const key of Object.keys(defaults.parts)) {
      if (!(key in stored)) continue;
      const fallback = defaults.parts[key];
      const value = Array.isArray(fallback)
        ? listPart(stored[key], fallback as unknown[])
        : textPart(stored[key], String(fallback ?? ""));
      if (value !== fallback) {
        merged.parts[key] = value;
        touched = true;
      }
    }
  }

  if (Number.isInteger(row.version) && (row.version as number) > 0) merged.version = row.version as number;
  merged.digest = trimmed(row.config_digest);
  merged.source = touched ? "database" : "code";
  return merged;
}

// ---- Part validation --------------------------------------------------
//
// Strict, and deliberately so. These decide whether a stored value is good
// enough to send to a paid model call in place of one that was written and
// reviewed in a source file. "Present but empty" is the single most likely
// way for a stored prompt to be wrong, and it is the one that would otherwise
// produce a silently unguided model rather than a visible error.

function textPart(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return text ? text : fallback;
}

// A list part is all-or-nothing against the code's own list. The twelve
// monthly themes and the three avatar variants are ROTAS: they are indexed by
// month and by attempt number, so a stored list of a different length does not
// mean "fewer themes", it means every index after the edit points somewhere
// different from what the code that reads it expects. Length is therefore part
// of the shape, not a preference.
function listPart(value: unknown, fallback: unknown[]): unknown[] {
  if (!Array.isArray(value)) return fallback;
  if (value.length !== fallback.length) return fallback;
  const clean = value.map((v) => (typeof v === "string" ? v.trim() : ""));
  if (clean.some((v) => !v)) return fallback;
  return clean;
}

// Convenience for callers whose parts are all plain strings.
function part(cfg: AiConfig, key: string, fallback: string): string {
  return textPart(cfg.parts[key], fallback);
}

function listOf(cfg: AiConfig, key: string, fallback: string[]): string[] {
  const value = listPart(cfg.parts[key], fallback);
  return value.map((v) => String(v));
}

// ---- The read ---------------------------------------------------------
//
// `ai_active_config` is a view over the one active version per service. It is
// read with the service role, because every caller of this file already is one
// — and because the view is staff-only, which a function's own JWT-less
// service context satisfies by bypassing RLS rather than by passing it.
async function read(admin: AiDb, slug: string): Promise<StoredConfig | null> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.row;

  try {
    const { data, error } = await admin
      .from("ai_active_config")
      .select("model, max_output_tokens, parts, version, config_digest")
      .eq("slug", slug)
      .maybeSingle();

    if (error) {
      // Logged rather than thrown. The most likely cause on a fresh
      // environment is that 0031 has not been applied yet, and a function
      // that refused to run until a migration landed would be a worse
      // outcome than one that runs on its own defaults and says so.
      console.warn(`ai-config: ${slug} unreadable (${error.message}) — using code defaults`);
      cache.set(slug, { at: Date.now(), row: null });
      return null;
    }

    const row = (data ?? null) as StoredConfig | null;
    cache.set(slug, { at: Date.now(), row });
    return row;
  } catch (err) {
    console.warn(`ai-config: ${slug} lookup failed (${String(err)}) — using code defaults`);
    cache.set(slug, { at: Date.now(), row: null });
    return null;
  }
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-5";

// The code default for the ceiling, and the slug the admin panel stores an
// override under.
const MAX_OUTPUT_TOKENS = 2000;
const AI_SLUG = "write-contact-email";

// How many people one invocation will write for. Small enough to finish
// inside the function timeout, large enough that a 900-person campaign is
// tens of clicks rather than hundreds. The screen loops until none are left.
const DEFAULT_BATCH = 8;
const MAX_BATCH = 25;

const EMAIL_SCHEMA = {
  type: "object",
  properties: {
    subject: {
      type: "string",
      description:
        "Subject line, under 70 characters. Specific to this person where there is something true to be specific about. No emoji, no ALL CAPS, no 'Re:' or 'Fwd:'.",
    },
    body_text: {
      type: "string",
      description:
        "The complete email as plain text, including the greeting and the sign-off. Use blank lines between paragraphs. No markdown, no HTML, no placeholders in square brackets.",
    },
    personalisation_note: {
      type: "string",
      description:
        "One short line for the staff reviewer saying which facts about this person you used. Empty string if you used none.",
    },
  },
  required: ["subject", "body_text", "personalisation_note"],
  additionalProperties: false,
} as const;

// The naming rule is not a style preference. The club's agreement with
// Microsoft is an education one and the licence tier is not something we
// advertise; publicly it is always "Microsoft 365 Cloud Licenses". The model
// gets told plainly because it will otherwise happily repeat "A1" out of the
// context it is given.
const SYSTEM_PROMPT =
  `You write short, personal emails on behalf of Sahaba Club — a Dubai-based AI and cloud community, and a Microsoft partner. You are writing to one specific person, and you are given everything the club actually knows about them.

Rules, in order of importance:

1. Never state anything that is not in the facts you are given. Do not invent events, dates, prices, links, achievements, or a shared history that is not recorded. If the facts are thin, write a short, warm, general email — that is the correct outcome, not a failure.
2. Never write the phrase "A1", "Office 365 A1", or any licence tier name. The Microsoft licences are always and only called "Microsoft 365 Cloud Licenses".
3. Anything given to you as "must appear verbatim" must appear exactly as written, unchanged.
4. Write to a person, not to a segment. If they came to a specific event, name it. If they registered but did not attend, do not imply they were there — an invitation to come this time is the honest version.
5. Keep it short. Three or four short paragraphs at most. A reader on a phone should get the point in the first two lines.
6. No marketing throat-clearing. Do not open with "I hope this email finds you well", "In today's fast-paced world", or "We are thrilled to announce".
7. Sign off as the sender given to you. Do not add a footer, an unsubscribe line, or a postscript — those are added afterwards.
8. Do not use placeholders. If you do not know their first name, address them without one rather than writing "Hi [Name]".

Write in the language you are asked for. If asked to match the contact, use Arabic only when their own details clearly indicate they would prefer it; otherwise English.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Staff only. This function reads the personal details of people who are
    // not members and spends money per call; both are reasons the check is
    // here and not merely on the page that calls it.
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData.user) {
      return json({ error: "Not signed in" }, 401);
    }
    const { data: callerProfile } = await admin
      .from("profiles")
      .select("role")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!callerProfile || (callerProfile.role !== "admin" && callerProfile.role !== "staff")) {
      return json({ error: "Club staff only" }, 403);
    }

    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is not set");
      return json({ error: "The AI writer isn't configured yet. Set OPENAI_API_KEY in the Edge Function secrets." }, 503);
    }

    const body = await req.json().catch(() => ({}));
    const campaignId: string | undefined = body.campaignId;
    const only: string[] | undefined = body.recipientIds;
    const regenerate: boolean = body.regenerate === true;
    const batch = Math.min(Math.max(Number(body.limit) || DEFAULT_BATCH, 1), MAX_BATCH);

    if (!campaignId) return json({ error: "campaignId is required" }, 400);

    const { data: campaign, error: cErr } = await admin
      .from("campaigns")
      .select("id, name, brief, must_include, tone, language, from_name, status")
      .eq("id", campaignId)
      .maybeSingle();
    if (cErr || !campaign) return json({ error: "Campaign not found" }, 404);
    if (!campaign.brief.trim()) {
      return json({ error: "Write the brief first — the model has nothing to work from." }, 400);
    }

    // Which drafts to write. Normally the ones not yet written; explicitly
    // chosen ones when a reviewer asks for a rewrite.
    //
    // An edited draft is never regenerated in bulk. Someone spent time on it,
    // and silently overwriting that is the kind of thing that makes people
    // stop trusting the tool.
    let q = admin
      .from("campaign_recipients")
      .select("id, contact_id, email, full_name, status, edited")
      .eq("campaign_id", campaignId)
      .limit(batch);

    if (only && only.length) {
      q = q.in("id", only);
    } else if (regenerate) {
      q = q.in("status", ["pending", "generated"]).eq("edited", false);
    } else {
      q = q.eq("status", "pending");
    }

    const { data: recipients, error: rErr } = await q;
    if (rErr) return json({ error: rErr.message }, 500);
    if (!recipients?.length) {
      return json({ ok: true, written: 0, failed: 0, remaining: 0, done: true });
    }

    // One round trip for all the contacts and all their engagements, rather
    // than two queries per person.
    const contactIds = recipients.map((r) => r.contact_id);
    const [contactsRes, engRes] = await Promise.all([
      admin.from("marketing_contacts")
        .select("id, full_name, first_name, email, country, city, university_or_company, occupation, tech_experience, how_heard, sahaba_mailbox, linked_user_id, engagement_count, first_seen_at, last_seen_at, notes, unsubscribed_at, bounced_at, is_test, email_valid")
        .in("id", contactIds),
      admin.from("contact_engagements")
        .select("contact_id, event_name, engagement_type, occurred_at")
        .in("contact_id", contactIds),
    ]);

    type Row = Record<string, unknown>;
    const contactById = new Map<string, Row>(
      (contactsRes.data ?? []).map((c) => [c.id as string, c as Row]),
    );
    const engByContact = new Map<string, Row[]>();
    for (const e of (engRes.data ?? []) as Row[]) {
      const key = String(e.contact_id);
      const list = engByContact.get(key) ?? [];
      list.push(e);
      engByContact.set(key, list);
    }

    let written = 0;
    let failed = 0;
    let skipped = 0;

    // Resolved once for the whole batch rather than per recipient: twenty-five
    // emails written in one invocation are one campaign, and a batch written
    // half on one prompt and half on another is a campaign nobody can review
    // as a whole. Never throws — see `_shared/ai-config.ts`.
    const ai = await loadAiConfig(admin, AI_SLUG, {
      model: MODEL,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      parts: { system: SYSTEM_PROMPT },
    });

    for (const r of recipients) {
      const contact = contactById.get(r.contact_id);
      if (!contact) {
        await admin.from("campaign_recipients")
          .update({ status: "failed", error: "Contact no longer exists", updated_at: new Date().toISOString() })
          .eq("id", r.id);
        failed++;
        continue;
      }

      // Last line of defence. The segment that built this list should already
      // have excluded these people, but a campaign can sit in review for a
      // week and someone can unsubscribe in the meantime — so it is checked
      // again here, at the moment of writing, and again before sending.
      if (contact.unsubscribed_at || contact.bounced_at || contact.is_test || !contact.email_valid) {
        await admin.from("campaign_recipients")
          .update({
            status: "skipped",
            error: contact.unsubscribed_at
              ? "Unsubscribed"
              : contact.bounced_at
              ? "Address previously bounced"
              : contact.is_test
              ? "Test record"
              : "Address looks invalid",
            updated_at: new Date().toISOString(),
          })
          .eq("id", r.id);
        skipped++;
        continue;
      }

      const context = buildContext(contact, engByContact.get(r.contact_id) ?? []);

      try {
        const draft = await writeOne(ai, campaign, context);
        await admin.from("campaign_recipients").update({
          subject: draft.subject,
          body_text: draft.body_text,
          context_used: { ...context, personalisation_note: draft.personalisation_note },
          // What actually wrote this draft, which is the point of the column —
          // since 0031 that is not necessarily what the secret says.
          model: ai.model,
          generated_at: new Date().toISOString(),
          status: "generated",
          error: null,
          updated_at: new Date().toISOString(),
        }).eq("id", r.id);
        written++;
      } catch (err) {
        console.error("draft failed for " + r.id + ": " + String(err));
        await admin.from("campaign_recipients").update({
          status: "failed",
          error: String(err).slice(0, 500),
          updated_at: new Date().toISOString(),
        }).eq("id", r.id);
        failed++;
      }
    }

    const { count: remaining } = await admin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "pending");

    if (campaign.status === "draft" || campaign.status === "generating") {
      await admin.from("campaigns")
        .update({
          status: (remaining ?? 0) > 0 ? "generating" : "review",
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaignId);
    }

    return json({
      ok: true,
      written,
      failed,
      skipped,
      remaining: remaining ?? 0,
      done: (remaining ?? 0) === 0,
    });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

// What the model is allowed to know about this person. Built explicitly
// rather than passing the row through, so that adding a column to
// marketing_contacts later cannot quietly start leaking it into prompts —
// a date of birth and a phone number have no business in here.
function buildContext(contact: Record<string, unknown>, engagements: Array<Record<string, unknown>>) {
  const sorted = [...engagements].sort((a, b) =>
    String(a.occurred_at ?? "").localeCompare(String(b.occurred_at ?? "")));

  const TYPE_WORD: Record<string, string> = {
    registration: "registered for",
    checkin: "attended",
    voting: "voted at",
    application: "applied to",
    other: "engaged with",
  };

  return {
    first_name: contact.first_name || firstWord(contact.full_name) || null,
    full_name: contact.full_name || null,
    country: contact.country || null,
    city: contact.city || null,
    university_or_company: contact.university_or_company || null,
    occupation: contact.occupation || null,
    experience: contact.tech_experience || null,
    how_they_found_us: contact.how_heard || [],
    // Phrased rather than dumped, because "registered for X but did not
    // attend" is the distinction the model most often gets wrong, and it is
    // also the most embarrassing one to get wrong.
    history: sorted.map((e) =>
      `${TYPE_WORD[String(e.engagement_type)] ?? "engaged with"} ${e.event_name ?? "a Sahaba Club event"}` +
      (e.occurred_at ? ` (${String(e.occurred_at).slice(0, 10)})` : "")
    ),
    times_engaged: contact.engagement_count ?? 0,
    first_seen: contact.first_seen_at ? String(contact.first_seen_at).slice(0, 10) : null,
    last_seen: contact.last_seen_at ? String(contact.last_seen_at).slice(0, 10) : null,
    already_has_a_club_mailbox: !!contact.sahaba_mailbox,
    already_a_member_on_the_website: !!contact.linked_user_id,
    staff_notes: contact.notes || null,
  };
}

function firstWord(name: unknown): string | null {
  const s = String(name ?? "").trim();
  return s ? s.split(/\s+/)[0] : null;
}

async function writeOne(
  ai: AiConfig,
  campaign: Record<string, unknown>,
  context: Record<string, unknown>,
): Promise<{ subject: string; body_text: string; personalisation_note: string }> {
  const languageLine = campaign.language === "match"
    ? "Choose the language this person is most likely to read comfortably, based on their details."
    : campaign.language === "ar"
    ? "Write in Arabic."
    : "Write in English.";

  const userPrompt = [
    `What we want to say:\n${campaign.brief}`,
    campaign.must_include
      ? `\nMust appear verbatim, exactly as written:\n${campaign.must_include}`
      : "",
    `\nTone: ${campaign.tone}. ${languageLine}`,
    `\nSign off as: ${campaign.from_name}`,
    `\nEverything the club knows about this person (nothing else is known — do not go beyond it):\n${JSON.stringify(context, null, 2)}`,
  ].filter(Boolean).join("\n");

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + OPENAI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ai.model,
      instructions: part(ai, "system", SYSTEM_PROMPT),
      max_output_tokens: ai.maxOutputTokens,
      input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
      text: {
        format: { type: "json_schema", name: "email", strict: true, schema: EMAIL_SCHEMA },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    if (/model_not_found|does not exist|unknown model/i.test(detail)) {
      throw new Error(
        ai.model === MODEL
          ? "OPENAI_MODEL is not a model this account can use"
          : `the model chosen in Admin → AI services for outreach emails (${ai.model}) is not one this account can use`,
      );
    }
    if (res.status === 401) throw new Error("OpenAI rejected our credentials (check OPENAI_API_KEY)");
    if (res.status === 429) throw new Error("OpenAI rate limit — try this batch again shortly");
    throw new Error("OpenAI " + res.status + ": " + detail.slice(0, 200));
  }

  const data = await res.json();
  const message = (data.output ?? []).find((o: { type?: string }) => o.type === "message");
  const parts = message?.content ?? [];

  if (parts.some((p: { type?: string }) => p.type === "refusal")) {
    throw new Error("The model declined to write this one");
  }
  if (data.status === "incomplete") {
    throw new Error("Ran out of output tokens before finishing");
  }

  const textPart = parts.find((p: { type?: string }) => p.type === "output_text");
  if (!textPart?.text) throw new Error("No draft came back");

  const parsed = JSON.parse(textPart.text);

  // Rule 2 is the one with a real-world cost if it slips through, so it is
  // checked rather than trusted. Failing loudly here puts it in front of a
  // reviewer as an error instead of putting "Office 365 A1" in front of 900
  // people.
  const forbidden = /\bA1\b|office\s*365\s*a1/i;
  if (forbidden.test(parsed.subject) || forbidden.test(parsed.body_text)) {
    throw new Error("Draft named the licence tier — regenerate this one");
  }
  if (/\[[A-Za-z ]+\]/.test(parsed.body_text)) {
    throw new Error("Draft contains an unfilled placeholder");
  }

  return parsed;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
