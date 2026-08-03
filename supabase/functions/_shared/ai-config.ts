// ai-config
// ------------------------------------------------------------
// How an ongoing AI service reads the prompt and the model that staff chose
// for it in the admin panel, and what happens when that reading fails.
//
// 0031 puts the prompt text, the model name and the output ceiling of eight
// services in the database so Ahmed can change them without a redeploy. This
// file is the only thing that reads them. Every one of those services calls
// `loadAiConfig` once per invocation and uses what comes back.
//
// ============================================================
// ⚠ THE CODE DEFAULT IS THE FLOOR, NOT THE STARTING POINT
// ============================================================
//
// A prompt in a database is a prompt that can be deleted, truncated, saved as
// an empty string, or made unreachable by an outage. None of those may be able
// to stop a member getting an avatar or a CV parsed. So:
//
//   * `loadAiConfig` NEVER throws and never rejects. Every failure path —
//     network, permission, malformed row, missing row, missing column — ends
//     at the caller's own defaults with `source: "code"`.
//   * The merge is PER PART, not per row. A row that carries a good house
//     style and an empty theme list gives you the stored house style and the
//     code's themes, not a half-empty prompt. `textPart` and `listPart` below
//     are where that is decided, and they are strict on purpose: anything that
//     is not a usable value of the right shape is treated as absent.
//   * A model or a ceiling that is blank or nonsensical falls back the same
//     way. `max_output_tokens` in particular: 0031 has a CHECK, but a value
//     arriving here that is not a positive integer is still ignored rather
//     than sent to OpenAI, because `max_output_tokens: 0` is a call that costs
//     money and returns nothing.
//
// The consequence worth stating plainly: **deleting every row in
// `ai_service_versions` restores the platform to exactly the behaviour it had
// before 0031.** That is the intended rollback of last resort, and it is why
// the defaults stay in the function files rather than being moved into the
// migration.
//
// ============================================================
// The digest, and why the judge depends on it
// ============================================================
//
// `digest` is computed by a database trigger over the whole activated
// configuration — parts, model, image model, ceiling. It is not something a
// caller chooses and not something the admin panel can set.
// `promptarena-judge` appends it to `JUDGE_VERSION`, so editing the judge's
// prompt or model moves `promptarena_submissions.judge_version` automatically
// and score drift stays attributable. See 0031 §6.
//
// Rolling back to an earlier configuration reproduces that configuration's
// digest, because the digest is over the content and not over the row. Two
// windows that were genuinely judged the same way therefore compare equal,
// which is the question the column exists to answer.
//
// ============================================================
// ⚠ Why there is no `import type { SupabaseClient }` here
// ============================================================
//
// `generate-avatar` and `refresh-avatars` import this file AND
// `_shared/avatar-art.ts`, and their `index.deploy.ts` twins inline both of
// them into one file — that is what the twins are for, since the Supabase
// dashboard editor cannot resolve `../_shared/*`. `avatar-art.ts` imports
// `SupabaseClient`; if this file did too, the generated twin would carry that
// import twice and be a duplicate binding, which is a SyntaxError before a
// single line runs.
//
// So the client is typed structurally, by the one thing this file does with
// it. That is not a workaround so much as an honest signature: `loadAiConfig`
// reads one row from one view and has no business being handed a type that
// says it could write.
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

export type AiDefaults = {
  model: string;
  maxOutputTokens?: number;
  parts: Record<string, unknown>;
};

export type AiConfig = {
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
export async function loadAiConfig(
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

export function textPart(value: unknown, fallback: string): string {
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
export function listPart(value: unknown, fallback: unknown[]): unknown[] {
  if (!Array.isArray(value)) return fallback;
  if (value.length !== fallback.length) return fallback;
  const clean = value.map((v) => (typeof v === "string" ? v.trim() : ""));
  if (clean.some((v) => !v)) return fallback;
  return clean;
}

// Convenience for callers whose parts are all plain strings.
export function part(cfg: AiConfig, key: string, fallback: string): string {
  return textPart(cfg.parts[key], fallback);
}

export function listOf(cfg: AiConfig, key: string, fallback: string[]): string[] {
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
