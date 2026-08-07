// ai-admin
// ------------------------------------------------------------
// The three things the AI services panel cannot do from the browser: ask
// OpenAI what models this account can actually use, show what each service's
// prompt is when nothing is stored, and make one real call to prove a draft
// prompt works before it is allowed to go live.
//
// Staff only, checked here. This function runs as the service role, so RLS is
// bypassed and the database will refuse nothing on our behalf — the same
// argument `promptarena-judge` and `import-event` make about their own checks.
// If the check is not in this file, it is not made.
//
// ============================================================
// 1. The model list is LIVE, not remembered
// ============================================================
//
// Ahmed: "show me the options of models we can use". There is exactly one
// honest source for that and it is not this file: it is
// `GET https://api.openai.com/v1/models` with the club's own key, which
// returns what the account is actually entitled to. A list typed into a
// migration in August is a list that is wrong by November — and being wrong in
// the *helpful* direction (offering a model that has been retired) is how you
// get every avatar in a month failing at once.
//
// So `action: "models"` fetches, classifies, caches into `public.ai_models`,
// and returns. The cache exists because 0031's trigger has to join to
// something — "a text model cannot be saved for an image service" has to be
// enforced where the write happens, and the database cannot call OpenAI. The
// cache is never the source; every panel load refreshes it.
//
// ⚠ THE KEY IS NEVER RETURNED, LOGGED, ECHOED OR INCLUDED IN ANY RESPONSE.
// This function reads `OPENAI_API_KEY` from the environment exactly as every
// other function here does, uses it in an Authorization header, and that is
// the whole of its involvement with it. The only thing said about it in any
// response is whether it is set at all, which the panel needs in order to
// explain an empty model list.
//
// ============================================================
// 2. What "the code default" is, and the one mirror in this repo
// ============================================================
//
// A prompt only lives in one place: the function that uses it. 0031 stores
// OVERRIDES, and `_shared/ai-config.ts` falls back to the source constant for
// any part that is missing, blank or malformed. That is what makes a bad edit
// recoverable and a deleted row harmless.
//
// But the panel has to show staff what they are about to change, or the first
// edit of `promptarena-judge` is somebody retyping a calibrated prompt from
// memory. So `action: "defaults"` returns the code defaults.
//
//   * `avatar-art` is a REAL IMPORT from `../_shared/avatar-art.ts`. Zero drift,
//     for the one service where drift matters most.
//   * The six text prompts below are MIRRORS, marked as such, one per service.
//     ⚠ They are not read by anything at run time — the functions use their own
//     constants — so a mirror that falls behind shows a stale starting point in
//     the panel and breaks nothing. That is the whole exposure, and it is why
//     the mirror lives here in TypeScript beside the originals rather than in
//     0031 as SQL: a reviewer diffing two .ts files will notice; a reviewer
//     diffing .ts against .sql will not.
//     0031's verification block says how to check them.
//
// ============================================================
// 3. The test run, and what it refuses
// ============================================================
//
// `parse-profile-document`, `promptarena-judge`, `promptarena-challenge`,
// `write-member-intro`, `write-contact-email` and `import-event` all use strict
// `json_schema` structured outputs. A prompt edit that contradicts the schema
// does not fail loudly at save time — it fails on every call afterwards, for
// everybody, until somebody notices that CV imports stopped working. The same
// is true of a model that cannot do structured output, and of a ceiling set
// low enough that the reasoning eats the answer.
//
// The only honest check is to make the call. `action: "test"` composes the
// prompt exactly as the service composes it, sends it to the candidate model
// at the candidate ceiling with the service's real schema, and reads what
// comes back. It then stamps `test_status` on the draft row as the service
// role — a column staff hold no UPDATE grant on — and 0031's
// `activate_ai_version` refuses to activate anything that is not 'passed'.
//
// A test FAILS, and therefore blocks activation, on any of:
//
//   * a non-2xx from OpenAI (a bad model name, a rejected key, a rate limit)
//   * `status: "incomplete"` — the ceiling is too low for this prompt
//   * a refusal part — the model declined the instructions
//   * no output text at all
//   * output that is not valid JSON
//   * output missing any key the schema marks required
//   * for an image service: no image came back, or the safety system declined
//     the prompt
//
// A test does NOT check that the prompt is *good*. It cannot. It checks that
// the prompt still produces the shape the rest of the platform is built to
// read, which is the failure that is silent.
//
// Secrets this function needs (see SETUP.md):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — injected by Supabase
//   OPENAI_API_KEY
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { listGoogleModels } from "../_shared/ai-provider.ts";
import {
  AVATAR_ART_DEFAULTS,
  buildPrompt,
  currentCycle,
  themeForCycle,
} from "../_shared/avatar-art.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

// A test run is one model call and this function does nothing else while it
// waits. Generous, because a judge prompt on a reasoning model at a 13,000
// ceiling genuinely takes a while, and a test that times out at 30s would
// teach staff that testing is unreliable rather than that their prompt is.
const TEST_TIMEOUT_MS = 90_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!SERVICE_ROLE_KEY) return json({ error: "Not configured" }, 503);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ---- Who is asking ----
    //
    // The same shape `import-event` and `write-contact-email` use, and for the
    // same reason: anyone can call an Edge Function with a valid member token,
    // and this one spends money and changes what every AI service on the
    // platform does.
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
    if (!jwt) return json({ error: "Not signed in" }, 401);

    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return json({ error: "Not signed in" }, 401);

    const { data: callerProfile } = await admin
      .from("profiles")
      .select("role")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!callerProfile || (callerProfile.role !== "admin" && callerProfile.role !== "staff" && callerProfile.role !== "global_admin")) {
      console.error(`user ${userData.user.id} attempted to reach ai-admin`);
      return json({ error: "Club staff only" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "").trim();

    if (action === "defaults") {
      // No OpenAI involvement and no secret involvement. Answered before the
      // key check below so the panel still shows staff their prompts on an
      // environment where the key has not been set yet.
      return json({ ok: true, defaults: CODE_DEFAULTS });
    }

    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is not set");
      return json({
        error: "OPENAI_API_KEY is not set in the Edge Function secrets, so there is no account to list models for.",
        // The panel needs to distinguish "no models" from "no key" — one is a
        // thing to fix in the Supabase dashboard and the other is a bug.
        code: "ai_unconfigured",
      }, 503);
    }

    if (action === "models") return await listModels(admin);
    if (action === "test") return await runTest(admin, body);

    return json({ error: "Unknown action. Expected 'models', 'defaults' or 'test'." }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});

// ============================================================
// The model list
// ============================================================

// ⚠ THE CLASSIFIER, AND THE ONE THING IT IS ALLOWED TO GET WRONG.
//
// OpenAI's `/v1/models` response says `id`, `object`, `created` and `owned_by`.
// It does NOT say which endpoint a model serves. So routing has to be derived
// from the id, and this is that derivation — a rule over live data, not a list
// of model names.
//
// Three buckets:
//
//   image   the id names an image family. These are the ones /v1/images/edits
//           and /v1/images/generations will accept.
//   text    a chat/reasoning family, minus the variants that are not general
//           text endpoints — audio, realtime, transcription, speech, embeddings,
//           moderation, search-preview and computer-use are all real models
//           this account may hold and none of them can serve
//           /v1/responses with a strict json_schema.
//   other   anything else, including a family this rule has never seen.
//
// ⚠ 'other' IS NOT SELECTABLE FOR EITHER KIND, and that is a deliberate trade
// rather than an oversight. A brand-new family with an unfamiliar name will
// land here and Ahmed will not be able to pick it until this rule learns it —
// one line, one deploy. The alternative is defaulting unknown families to
// 'text', which means the first genuinely new image model gets offered for the
// avatars and every avatar fails. Blocking a new model for a day is a smaller
// harm than a month of broken portraits, and the panel says plainly why a
// model is greyed out rather than hiding it.
function classify(id: string): "text" | "image" | "other" {
  const name = id.toLowerCase();

  if (/^(gpt-image|dall-e)/.test(name)) return "image";

  // Not a general text endpoint even though the family name looks like one.
  if (/(audio|realtime|transcribe|tts|whisper|embedding|moderation|search-preview|computer-use|codex|sora|image)/.test(name)) {
    return "other";
  }

  if (/^(gpt-|o[1-9]|chatgpt-)/.test(name)) return "text";

  return "other";
}

async function listModels(admin: ReturnType<typeof createClient>): Promise<Response> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { "Authorization": "Bearer " + OPENAI_API_KEY },
  });

  if (!res.ok) {
    const detail = await res.text();
    // Truncated, and it is worth saying why: an OpenAI error body is not a
    // place a key would normally appear, but a 4xx from a proxy or a gateway
    // can echo request headers, and this string goes to a browser.
    console.error("openai /v1/models " + res.status + ": " + detail.slice(0, 300));
    if (res.status === 401) {
      return json({
        error: "OpenAI rejected our credentials. Check OPENAI_API_KEY in the Edge Function secrets.",
        code: "ai_credentials",
      }, 502);
    }
    return json({ error: "Couldn't reach OpenAI to list models just now.", code: "upstream_error" }, 502);
  }

  const data = await res.json();
  const listed: Array<{ id?: string; owned_by?: string; created?: number }> =
    Array.isArray(data?.data) ? data.data : [];

  const now = new Date().toISOString();
  const rows = listed
    .map((m) => String(m?.id ?? "").trim())
    .filter(Boolean)
    .map((id) => {
      const src = listed.find((m) => m.id === id);
      return {
        id,
        kind: classify(id),
        owned_by: String(src?.owned_by ?? ""),
        released_at: Number.isFinite(src?.created)
          ? new Date((src!.created as number) * 1000).toISOString()
          : null,
        available: true,
        refreshed_at: now,
      };
    });

  if (!rows.length) {
    // An empty list from a 200 is not a reason to mark everything we know
    // about as gone. Leave the cache alone and say so.
    return json({ ok: true, models: [], note: "OpenAI returned no models for this account." });
  }

  // `first_seen_at` is deliberately absent from the update list: it is the
  // column that proves this table is a live cache rather than something a
  // migration seeded (0031 has a verification query for exactly that), and
  // re-stamping it on every refresh would erase the evidence.
  const { error: upErr } = await admin
    .from("ai_models")
    .upsert(rows, { onConflict: "id" });
  if (upErr) {
    console.error("ai_models upsert: " + upErr.message);
    return json({ error: "Couldn't save the model list: " + upErr.message }, 500);
  }

  // Anything we hold that OpenAI no longer lists is marked unavailable rather
  // than deleted. A version row in the history references the model it used,
  // and a model going away must not take that history with it — 0031's foreign
  // key is `on delete restrict` for the same reason.
  //
  // Identified by timestamp rather than by a NOT IN list of eighty model ids:
  // the upsert above stamped `refreshed_at = now` on everything OpenAI just
  // told us about, so anything still carrying an older stamp is by definition
  // absent from this listing. One predicate, no quoting, and it cannot be
  // defeated by a model id containing a comma or a quote.
  // ⚠ Scoped to OpenAI. Before Gemini existed this predicate was global, and
  // leaving it that way would retire every Google model on any refresh — the
  // OpenAI upsert stamps only OpenAI ids, so Gemini rows would always carry an
  // older timestamp and always look absent. Google is retired separately
  // below, and only when Google actually answered.
  const { error: goneErr } = await admin
    .from("ai_models")
    .update({ available: false })
    .lt("refreshed_at", now)
    .eq("available", true)
    .eq("provider", "openai");
  if (goneErr) console.error("ai_models retire: " + goneErr.message);

  // ---- Gemini ------------------------------------------------------------
  //
  // Failure here must not cost the OpenAI listing: a project with no Google key
  // is the normal case, and a Google outage is not a reason to show an error
  // page for a panel that is mostly about OpenAI.
  const google = await listGoogleModels();
  let googleNote = "";
  if (google.ok && google.models.length) {
    const gRows = google.models.map((m) => ({
      id: m.id,
      kind: m.kind,
      owned_by: m.owned_by,
      provider: "google",
      released_at: null,
      available: true,
      refreshed_at: now,
    }));
    const { error: gErr } = await admin.from("ai_models").upsert(gRows, { onConflict: "id" });
    if (gErr) {
      console.error("ai_models google upsert: " + gErr.message);
      googleNote = "Gemini models could not be saved: " + gErr.message;
    } else {
      // Only now is it safe to retire Google rows — we have a fresh answer to
      // compare against.
      const { error: gGone } = await admin
        .from("ai_models")
        .update({ available: false })
        .lt("refreshed_at", now)
        .eq("available", true)
        .eq("provider", "google");
      if (gGone) console.error("ai_models google retire: " + gGone.message);
      googleNote = google.models.length + " Gemini models available.";
    }
  } else if (google.reason === "no-key") {
    googleNote = "Gemini is not configured — set GEMINI_API_KEY to offer Google models.";
  } else if (google.reason === "unreachable") {
    // Say it plainly. Silence here reads as "Google has no models", which
    // would send someone to the Google console rather than to the network.
    googleNote = "Google could not be reached, so Gemini models were left as they were.";
  }

  const { data: stored } = await admin
    .from("ai_models")
    .select("id, kind, owned_by, released_at, available, provider, input_per_1m, output_per_1m, price_per_image, price_updated_at, price_source")
    .order("kind", { ascending: true })
    .order("id", { ascending: true });

  return json({
    ok: true,
    refreshed_at: now,
    google_note: googleNote,
    models: stored ?? [],
    counts: {
      text: rows.filter((r) => r.kind === "text").length,
      image: rows.filter((r) => r.kind === "image").length,
      other: rows.filter((r) => r.kind === "other").length,
    },
  });
}

// ============================================================
// The code defaults
// ============================================================
//
// ⚠ `avatar-art` is imported. The six below are mirrors — see the header for
// what that costs and why they are here rather than in the migration. Each
// carries the file it is a mirror of; if you change one, change both.

const CODE_DEFAULTS: Record<string, Record<string, unknown>> = {
  // Imported from ../_shared/avatar-art.ts. Not a copy.
  "avatar-art": {
    house_style: AVATAR_ART_DEFAULTS.house_style,
    themes: [...AVATAR_ART_DEFAULTS.themes],
    variants: [...AVATAR_ART_DEFAULTS.variants],
  },

  // Mirror of SYSTEM_PROMPT in supabase/functions/parse-profile-document/index.ts
  "parse-profile-document": {
    system:
      `You extract structured profile fields from a CV or a LinkedIn profile export for Sahaba Club, an AI and cloud community.

Fill each field only from what the document actually says. Where the document gives you nothing to go on, return an empty string, a zero or an empty array — do not infer, estimate, or invent. Goals in particular are often absent from a CV; an empty array is the correct answer there, not a guess about what someone probably wants. Never guess where someone lives from a phone number's country code, the country of a university they attended, or the language a document is written in.

Working things out from what is written is not inventing: years of experience should be counted from dated roles, and a headline should be composed from their actual work. Putting in something the document does not support is.

Keep skills and interests as short, individually meaningful tags ("Power Apps", "Copilot Studio") rather than sentences, since they are used for filtering and matching.

WORK HISTORY. Return every employment entry the document contains, not just the current one — a CV is mostly this, and the rest of the profile only holds one job. One entry per role: a promotion within the same employer is a separate role if the document dates it separately, and a single role is not split across entries. Give dates as the document gives them, reduced to year and month ("2021-03"), or to just the year when that is all it says. If a role is still held, set is_current true and leave end empty rather than writing "Present". "company" and "position" must agree with the top-level company and position fields for whichever entry is current.`,
  },

  // Mirror of SYSTEM_PROMPT in supabase/functions/promptarena-judge/index.ts
  //
  // ⚠ CALIBRATED. Read the header of that file before editing this in the
  // panel: the rule about never marking a prompt down for looking machine-
  // written is the reason the judge was rewritten, and 52 measured judgements
  // say what happens when it is absent.
  "promptarena-judge": {
    system:
      `You are the PromptArena coach. A member of Sahaba Club has been given a practice challenge and has written a prompt to meet it. You mark that prompt and you teach.

PromptArena is not an exam. It is a practice environment. Write the way a patient expert coach speaks to somebody they want to see improve: warm, specific, and honest. A low mark must teach, never scold. Never sarcasm, never disappointment, never praise that is not earned.

## ⚠ The rule that overrides every other consideration

**Never mark a prompt down for being well written, well structured, polished, grammatical, formatted, long, or professional-looking. Never comment on whether a human or an AI wrote it. Never suggest a member add "a human touch", "personal flair", typos, informality, imperfection or ambiguity.**

This is not a stylistic preference. The judge you replace scored 52 submissions on whether they "read AI-like due to perfect grammar and structured format". Those 52 average 2.94 against 5.43 for everything else. One member submitted a polished prompt and a rougher rewrite of the same idea five minutes apart; the polished one scored 3 and the rough one 7. A numbered Role / Task / Context scaffold — which is the single most-taught prompt-engineering technique there is — was scored 2.

**That judge was punishing the exact skill it existed to measure.** Structure, precision and clear writing are the subject of this mode. Reward them. If a prompt is excellent and also looks like it was carefully composed, that is what an excellent prompt looks like.

You are not being asked whether a prompt was AI-assisted. Do not consider it, do not mention it, and do not let it colour any dimension.

## What you actually judge

Judge the prompt as an instrument: **would a capable model, given only this prompt, produce what the challenge asked for?**

First, the gate. \`on_topic\` is false only when the prompt does not address the challenge at all — a news headline pasted under an image brief, an answer to a different question, or text that is not an instruction to anybody. A weak, vague or partial attempt at the right task is ON topic and is scored on its merits. Being off topic is a gate, not a dimension: it does not matter how well written it is.

Then mark each of these eight dimensions from 1 to 10. Mark them independently — a prompt can be crystal clear and supply no context at all.

- **clarity** — can a reader tell what is wanted without re-reading? Ambiguity costs marks; brevity on its own does not.
- **context** — does it supply the situation, background, audience or personal facts the model needs to tailor an answer? ("I am 38, 80 kg, new to the gym" is strong context.)
- **goal_definition** — is the desired outcome stated, rather than only the topic? "Explain blockchain" names a topic; "explain blockchain so a 12-year-old can retell it to a friend" names a goal.
- **instructions** — is the model told what to DO? Roles, steps, sub-tasks, worked structure. A numbered breakdown is a strength here, not a suspicion.
- **constraints** — limits and boundaries: length, tone, what to avoid, what to include, style, register.
- **output_format** — is the shape of the answer specified? A list, a table, three paragraphs, JSON, a script with timings. If the challenge genuinely has no meaningful output shape, mark this in the middle rather than punishing its absence.
- **completeness** — does it cover the whole of what the challenge asked, or only part of it?
- **creativity** — originality of angle or framing, where the challenge leaves room. If the challenge is purely functional, mark this in the middle rather than penalising a sensible plain approach.

Spelling and grammar mistakes are a minor note inside a dimension, never the reason for a band. A prompt full of typos that gives the model everything it needs beats a flawless sentence that gives it nothing.

You do NOT return an overall score. It is computed from your dimension marks and the challenge's own weighting. Mark the dimensions honestly and the number takes care of itself — and identical prompts get identical numbers, which is the point.

## What you write

Four things, all required:

- \`summary\` — why this prompt earns the marks it does. Two or three sentences. Speak to the member as "you" and "your prompt".
- \`strengths\` — one to four short, CONCRETE things this prompt actually does well, quoting or naming them. Never generic praise. If the prompt is very weak, find the one true thing and say only that; do not manufacture more.
- \`improvements\` — one to four specific things that would raise the score, each naming what is missing rather than restating the dimension.
- \`how_to_improve\` — what to do differently next time, concretely enough to act on. Where it helps, show the member a short rewritten fragment of their own prompt so they can see the difference. This is the coaching, and it is the part members come back for.

## Rules for the writing itself

1. **Write in the language the member wrote their prompt in.** If they wrote in Arabic, every word you write is in Arabic. Never tell a member to write in a different language, for any reason. Submissions in Arabic scored slightly better than English ones in this club's own history; there is nothing to fix.
2. **Never address the member by name.** You have not been given one and there is nothing to guess from. Speak to them directly instead — "your prompt", "you could".
3. Never emit template scaffolding, field labels, placeholders in brackets, or any text of the form "His/her name:". Write finished prose.
4. Never mention scores, dimensions or this rubric by their internal names. The member reads sentences, not a mark sheet.
5. If the submission is a placeholder or a non-answer, be short and kind and honest. Do not write paragraphs of coaching over one word.
6. No markdown headings, no bullets inside a field, no emoji.`,
  },

  // Mirror of SYSTEM_PROMPT in supabase/functions/promptarena-challenge/index.ts
  "promptarena-challenge": {
    system:
      `You write practice challenges for PromptArena, a prompt-engineering practice mode run by Sahaba Club. A member reads your challenge and writes a PROMPT to meet it. An AI coach then scores their prompt and teaches them.

You are writing the challenge, never the answer. Never include an example prompt, never demonstrate the technique, and never hint at what a good answer contains beyond what the brief legitimately asks for. A member who can read the answer off the challenge learns nothing.

## What a challenge is

A short, concrete, realistic situation with a stated goal, given to the member in the second person. It should read like a real task somebody actually has, not like an exam question.

Good: "A regional hospital wants to turn its 40-page discharge policy into something a newly qualified nurse can act on during a shift. Write the prompt that produces it."
Weak: "Write a prompt about healthcare."

## What makes a challenge worth setting

- **It has a real audience and a real constraint.** "Explain X" teaches nothing; "explain X to somebody who will have to repeat it to their manager in one minute" forces choices.
- **It cannot be met by restating it.** If pasting the challenge back would score well, the challenge is too thin.
- **It leaves the member the interesting decisions.** State the goal and the situation; do not pre-decide the structure, the format or the tone unless that is the point of the challenge.
- **It is answerable in one prompt.** Not a project, not a conversation — one well-built prompt.

## The axes you are given

Each challenge you write is assigned a domain, a target audience, a difficulty (1 easiest to 5 hardest), a creativity level (1 tightly specified to 5 wide open) and a **technique**. Honour all five.

The technique is the important one and it is the reason this mode exists. Write a challenge that CANNOT BE MET WELL WITHOUT USING IT — but never name it, never describe it, and never tell the member to use it. If the technique is "few_shot_examples", set a task where the required output has an idiosyncratic house style that could only be conveyed by showing examples. If it is "negative_constraints", set a task with a well-known default answer that must be avoided. The member should discover the technique because the task demands it.

## Constraints

Give each challenge one to four \`constraints\` — the rules the member's prompt must respect, shown to them as a checklist beside the brief. They must be checkable by reading the prompt ("under 80 words", "must not name a specific brand", "must specify an output format"), not by running it. Do not make a constraint that simply restates the technique.

## The rubric

Weight the eight marking dimensions from 0 to 5 for this specific challenge. 0 means it does not apply here. Be genuinely differential — a challenge about producing a structured report should weight output_format heavily; an open creative brief should weight it at 0 or 1 and creativity at 4 or 5. A rubric that is the same for every challenge is a rubric that says nothing.

The dimensions: clarity, context, goal_definition, instructions, constraints, output_format, completeness, creativity.

## Variety, which is the whole point

You are producing several challenges at once. They must differ from each other in subject, in shape and in what they demand — not five versions of one idea with the nouns swapped. You are also given the titles already in the bank: do not produce anything that duplicates or lightly rewords one of them.

The bank this replaces had 19 distinct challenges for 556 attempts, and five of them carried half the traffic — a workout plan, a futuristic-city image, a career-coaching question, a coffee-shop growth question and a healthy-eating video script. Those are the rut. Write away from them.

## Register

Write in clear, plain English. No markdown, no headings, no emoji, no exclamation marks, no marketing voice. The title is a short human label, not a sentence and not a slug.`,
  },

  // Mirror of SYSTEM_PROMPT in supabase/functions/write-member-intro/index.ts
  "write-member-intro": {
    system:
      `You write the short introduction that appears under a new member's name on the Sahaba Club feed — a public wall inside the club, where dozens of these cards sit next to each other.

Rules, in order of importance:

1. Use only the facts you are given. Do not invent achievements, employers, job titles, awards, years of experience, or enthusiasm the profile does not show. A profile with three facts in it gets a short, warm, honest introduction — that is the correct outcome, not a failure.
2. Never write "A1", "Office 365 A1", or any licence tier name. The Microsoft licences are always and only called "Microsoft 365 Cloud Licenses".
3. Repetition is the failure mode. You are writing one card among many, and the reader sees them stacked. Vary the opening line every time. You are shown the openings already on the wall; do not begin the way any of them begin, and do not reuse their sentence shape.
4. Write to the club about this person, in the second person plural: "Say hello to …", "Meet …", or another natural equivalent — but not the same one twice.
5. Two or three sentences. Specific beats effusive: one true, concrete detail is worth more than three adjectives.
6. No marketing language, no "we are thrilled", no "passionate about", no hashtags, no emoji, no exclamation marks stacked up.
7. Use the name exactly as given. If there is no name, introduce them without one rather than writing a placeholder.`,
  },

  // Mirror of SYSTEM_PROMPT in supabase/functions/write-contact-email/index.ts
  "write-contact-email": {
    system:
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

Write in the language you are asked for. If asked to match the contact, use Arabic only when their own details clearly indicate they would prefer it; otherwise English.`,
  },

  // Mirror of SYSTEM_PROMPT in supabase/functions/import-event/index.ts
  "import-event": {
    system:
      `You turn an event page into a structured record for Sahaba Club, an AI and cloud community in Dubai.

Use only what the page says. If a field is not stated, return an empty string — an event with a missing date that an admin fixes is fine; an event with an invented date is not, because it will be wrong on the public site and nobody will know why.

Dates must be YYYY-MM-DD. If the page gives a date without a year, choose the next occurrence of that date in the future rather than assuming the current year.

Tags are for filtering the events list, so keep them broad and reusable ('AI', 'Cloud', 'Hackathon', 'Workshop', 'Networking', 'Security') rather than specific to one event.

Set confidence to 'low' whenever the date or the title had to be guessed at or left empty.`,
  },

  // Mirror of CARD_BRIEF in supabase/functions/import-event/index.ts
  "import-event-card": {
    image_brief: [
      "Abstract editorial artwork for a technology community event card.",
      "Deep navy and violet with cyan accents, soft gradients, geometric shapes,",
      "subtle depth, generous negative space, modern and calm.",
      "No text, no words, no letters, no logos, no brand marks, no people's faces.",
    ].join(" "),
  },
};

// ============================================================
// The probes
// ============================================================
//
// One representative input per text service, and the service's real schema.
//
// ⚠ The schemas are mirrors of the ones in the function files, same as the
// prompts, and they are the half that actually matters: a test that validates
// against a schema the function does not use proves nothing about the function.
// Kept deliberately minimal — only what `strict: true` needs, which is `type`,
// `properties`, `required` and `additionalProperties: false`. The descriptions
// in the originals are guidance for the model and their absence here makes the
// test slightly harder to pass, not easier, which is the right direction for a
// gate.
//
// The probe input is short on purpose. A test run costs money every time staff
// press the button, and what is being tested is whether the prompt and the
// schema still agree — not whether the model is good at long documents.
type Probe = {
  schemaName: string;
  schema: Record<string, unknown>;
  input: string;
  // Appended to the edited prompt to reproduce anything the service adds at
  // call time. Empty for services that send the prompt as written.
  suffix?: string;
};

const DIMENSIONS = [
  "clarity", "context", "goal_definition", "instructions",
  "constraints", "output_format", "completeness", "creativity",
] as const;

const dimensionObject = (desc: string) => ({
  type: "object",
  properties: Object.fromEntries(DIMENSIONS.map((d) => [d, { type: "integer", description: `${desc} ${d}` }])),
  required: [...DIMENSIONS],
  additionalProperties: false,
});

const PROBES: Record<string, Probe> = {
  "parse-profile-document": {
    schemaName: "profile",
    // A reduced mirror: the fields the review step actually reads back. A
    // prompt that contradicts the schema contradicts this one too.
    schema: {
      type: "object",
      properties: {
        full_name: { type: "string" },
        headline: { type: "string" },
        company: { type: "string" },
        position: { type: "string" },
        country: { type: "string" },
        years_experience: { type: "integer" },
        skills: { type: "array", items: { type: "string" } },
        interests: { type: "array", items: { type: "string" } },
        goals: { type: "array", items: { type: "string" } },
      },
      required: [
        "full_name", "headline", "company", "position", "country",
        "years_experience", "skills", "interests", "goals",
      ],
      additionalProperties: false,
    },
    input:
      "Extract this person's profile fields.\n\nLayla Haddad\nCloud Solutions Architect, Emirates Digital, Dubai, UAE\n2021-03 to present. Previously Systems Engineer, Gulf Networks, 2018-2021.\nSkills: Azure, Power Apps, Terraform, Copilot Studio.",
    // The real function appends the country list and the tag vocabulary from
    // the database. Reproduced in shape rather than in full, so the test still
    // exercises "the prompt must not contradict an appended vocabulary block"
    // without a second copy of `loadVocabularies` living in this file.
    suffix:
      "\n\nCOUNTRIES. The value you return for \"country\" must be one of these names, copied exactly, character for character:\nUnited Arab Emirates\nSaudi Arabia\nEgypt\n\nIf the person is based in a country that is not on that list, or the document does not say where they are, return an empty string for country.\n\nTAGS. Skills and interests are filtered and matched on, so everyone has to spell them the same way. These tags are already in use:\nAzure, Power Apps, Copilot Studio, Terraform\n\nWhenever something in the document matches one of those tags, return that tag with exactly the spelling and capitalisation shown.",
  },

  "promptarena-judge": {
    schemaName: "promptarena_verdict",
    schema: {
      type: "object",
      properties: {
        on_topic: { type: "boolean" },
        language: { type: "string" },
        dimensions: dimensionObject("1 to 10 for"),
        summary: { type: "string" },
        strengths: { type: "array", items: { type: "string" } },
        improvements: { type: "array", items: { type: "string" } },
        how_to_improve: { type: "string" },
      },
      required: ["on_topic", "language", "dimensions", "summary", "strengths", "improvements", "how_to_improve"],
      additionalProperties: false,
    },
    input:
      "## The challenge the member was given\n\nWrite a prompt to create an image of a futuristic city on another planet.\n\n## The member's prompt\n\n\"City scape in mars with high rising buildings, flying taxi, make a fog of clouds above tall buildings\"\n\n## Now mark the member's prompt\n\nMark the eight dimensions, set on_topic, name the language they wrote in, and write the four pieces of feedback in that same language.",
  },

  "promptarena-challenge": {
    schemaName: "promptarena_challenges",
    schema: {
      type: "object",
      properties: {
        challenges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              brief: { type: "string" },
              domain: { type: "string" },
              target_audience: { type: "string" },
              technique: { type: "string" },
              difficulty: { type: "integer" },
              creativity: { type: "integer" },
              constraints: { type: "array", items: { type: "string" } },
              rubric: dimensionObject("weight 0 to 5 for"),
            },
            required: [
              "title", "brief", "domain", "target_audience", "technique",
              "difficulty", "creativity", "constraints", "rubric",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["challenges"],
      additionalProperties: false,
    },
    input:
      "Write 1 challenge, for the specification below.\n\n### Challenge 1\n- domain: healthcare\n- target audience: a newly qualified nurse\n- difficulty: 3\n- creativity: 2\n- technique: negative_constraints\n\nTitles already in the bank, do not duplicate or lightly reword any of them:\n- Turn a discharge policy into a shift checklist",
  },

  "write-member-intro": {
    schemaName: "member_intro",
    schema: {
      type: "object",
      properties: {
        intro: { type: "string" },
        vibe_tag: { type: "string" },
      },
      required: ["intro", "vibe_tag"],
      additionalProperties: false,
    },
    input:
      "Everything the club knows about this person (nothing else is known — do not go beyond it):\n{\n  \"full_name\": \"Layla Haddad\",\n  \"headline\": \"Cloud architect, occasional woodworker\",\n  \"skills\": [\"Azure\", \"Terraform\"],\n  \"interests\": [\"woodworking\"]\n}\n\nThese introductions are already on the wall. Do not open like any of them, and do not copy their shape:\n- Say hello to Omar, who builds things",
  },

  "write-contact-email": {
    schemaName: "email",
    schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        body_text: { type: "string" },
        personalisation_note: { type: "string" },
      },
      required: ["subject", "body_text", "personalisation_note"],
      additionalProperties: false,
    },
    input:
      "What we want to say:\nInvite them to the next Sahaba Club cloud meetup in Dubai.\n\nTone: warm. Write in English.\n\nSign off as: Ahmed\n\nEverything the club knows about this person (nothing else is known — do not go beyond it):\n{\n  \"first_name\": \"Layla\",\n  \"registered_for\": \"AI Builders Night\",\n  \"attended\": false\n}",
  },

  "import-event": {
    schemaName: "event",
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        event_date: { type: "string" },
        time_label: { type: "string" },
        location: { type: "string" },
        country: { type: "string" },
        mode: { type: "string" },
        price_label: { type: "string" },
        brand: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        confidence: { type: "string" },
      },
      required: [
        "title", "description", "event_date", "time_label", "location",
        "country", "mode", "price_label", "brand", "tags", "confidence",
      ],
      additionalProperties: false,
    },
    input:
      "Source: https://example.com/events/cloud-night\n\nCloud Native Night Dubai\nThursday 18 September, 6:30pm – 9:00pm\nIn person · Dubai Internet City · Free\nA hands-on evening on Kubernetes and platform engineering, hosted by the Dubai Cloud Guild.",
  },
};

// ============================================================
// The test run
// ============================================================

async function runTest(
  admin: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
): Promise<Response> {
  const versionId = String(body?.version_id ?? "").trim();
  if (!versionId) return json({ error: "version_id is required" }, 400);

  const { data: version, error: vErr } = await admin
    .from("ai_service_versions")
    .select("id, service_slug, parts, model, max_output_tokens, is_active, test_status")
    .eq("id", versionId)
    .maybeSingle();
  if (vErr) return json({ error: vErr.message }, 500);
  if (!version) return json({ error: "No such version" }, 404);

  // Re-testing something already live is allowed and occasionally useful — "is
  // the thing we are running still working" is a fair question — but it must
  // not be able to move a live row from 'passed' to 'failed' and leave the
  // service running on a configuration the panel now says is broken. So an
  // active version is tested and reported, never re-stamped.
  const stamp = !version.is_active;

  const { data: service, error: sErr } = await admin
    .from("ai_services")
    .select("slug, label, kind, endpoint, parts_shape, recommended_max_output_tokens")
    .eq("slug", version.service_slug)
    .maybeSingle();
  if (sErr) return json({ error: sErr.message }, 500);
  if (!service) return json({ error: "Unknown service" }, 404);

  // The parts as they will actually be used: what is stored, falling back to
  // the code default for anything blank or missing — the same merge
  // `_shared/ai-config.ts` performs. Testing the stored object alone would
  // test a prompt no service will ever send.
  const stored = (version.parts ?? {}) as Record<string, unknown>;
  const defaults = CODE_DEFAULTS[service.slug] ?? {};
  const parts: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const v = stored[key];
    if (Array.isArray(defaults[key])) {
      const want = (defaults[key] as unknown[]).length;
      if (Array.isArray(v) && v.length === want && v.every((x) => typeof x === "string" && x.trim())) {
        parts[key] = v.map((x) => String(x).trim());
      }
    } else if (typeof v === "string" && v.trim()) {
      parts[key] = v.trim();
    }
  }

  const startedAt = Date.now();
  const result = service.kind === "image"
    ? await testImage(service.slug, parts, version.model)
    : await testText(service.slug, parts, version.model, version.max_output_tokens ?? service.recommended_max_output_tokens ?? 4000);

  const detail = {
    ...result.detail,
    elapsed_ms: Date.now() - startedAt,
    endpoint: service.endpoint,
    // The prompt that was actually sent, so a staff member reading a failure
    // can see what the model saw rather than guessing at what the composition
    // did with their edit. Capped — the avatar prompt is long and this goes
    // into a jsonb column that is read whole.
    composed_prompt: String(result.composedPrompt ?? "").slice(0, 4000),
  };

  if (stamp) {
    const { error: stampErr } = await admin
      .from("ai_service_versions")
      .update({
        test_status: result.ok ? "passed" : "failed",
        tested_at: new Date().toISOString(),
        // ⚠ Recorded so `activate_ai_version` can refuse a version that was
        // tested against a different model than it stores. Written from
        // `version.model` rather than from the request, because the request is
        // not the thing being activated.
        test_model: version.model,
        test_detail: detail,
      })
      .eq("id", versionId);
    if (stampErr) {
      console.error("test stamp: " + stampErr.message);
      return json({ error: "The test ran but its result could not be saved: " + stampErr.message }, 500);
    }
  }

  return json({
    ok: result.ok,
    stamped: stamp,
    service: service.slug,
    model: version.model,
    reason: result.reason,
    output: result.output,
    detail,
  });
}

type TestResult = {
  ok: boolean;
  reason: string;
  output?: unknown;
  composedPrompt: string;
  detail: Record<string, unknown>;
};

async function testText(
  slug: string,
  parts: Record<string, unknown>,
  model: string,
  maxOutputTokens: number,
): Promise<TestResult> {
  const probe = PROBES[slug];
  if (!probe) {
    return {
      ok: false,
      reason: `No test probe is defined for the service "${slug}", so this prompt cannot be proved to work. Add one in ai-admin before this service can be edited.`,
      composedPrompt: "",
      detail: {},
    };
  }

  const instructions = String(parts.system ?? "") + (probe.suffix ?? "");

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions,
        max_output_tokens: maxOutputTokens,
        input: [{ role: "user", content: [{ type: "input_text", text: probe.input }] }],
        text: {
          format: { type: "json_schema", name: probe.schemaName, strict: true, schema: probe.schema },
        },
      }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: abort.signal.aborted
        ? `The test call did not finish inside ${TEST_TIMEOUT_MS / 1000}s. That is usually a ceiling far higher than the model needs, or a model that is very slow — it is not a pass.`
        : "The test call never completed: " + String(err instanceof Error ? err.message : err),
      composedPrompt: instructions,
      detail: {},
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`ai-admin test ${slug} ${res.status}: ${body.slice(0, 400)}`);
    return {
      ok: false,
      reason: triage(res.status, body, model),
      composedPrompt: instructions,
      detail: { http_status: res.status },
    };
  }

  const data = await res.json();
  const usage = {
    output_tokens: data?.usage?.output_tokens ?? null,
    reasoning_tokens: data?.usage?.output_tokens_details?.reasoning_tokens ?? null,
    ceiling: maxOutputTokens,
  };

  // ⚠ Checked before parsing, exactly as `promptarena-judge` does: a truncated
  // response still carries an output_text part, cut off mid-string. Parsing it
  // could succeed against a half-written object and report a pass.
  if (data?.status === "incomplete") {
    const why = data?.incomplete_details?.reason ?? "unknown";
    return {
      ok: false,
      reason: why === "content_filter"
        ? "The model's own filter stopped it partway through. This is not a ceiling problem — look at what the prompt is asking for."
        : `The model ran out of room before finishing (ceiling ${maxOutputTokens}, of which ${usage.reasoning_tokens ?? "an unreported number of"} tokens went on reasoning). On the gpt-5 family the ceiling is shared with the model's own reasoning, so this is a ceiling to raise, not a prompt to shorten.`,
      composedPrompt: instructions,
      detail: { usage, incomplete_reason: why },
    };
  }

  const message = (data?.output ?? []).find((o: { type?: string }) => o.type === "message");
  const contentParts = message?.content ?? [];

  if (contentParts.some((p: { type?: string }) => p.type === "refusal")) {
    const refusal = contentParts.find((p: { type?: string }) => p.type === "refusal");
    return {
      ok: false,
      reason: "The model declined these instructions: " + String(refusal?.refusal ?? "").slice(0, 300),
      composedPrompt: instructions,
      detail: { usage },
    };
  }

  const textPart = contentParts.find((p: { type?: string }) => p.type === "output_text");
  if (!textPart?.text) {
    return {
      ok: false,
      reason: "The call succeeded but produced no output at all. Nothing about this prompt can be relied on.",
      composedPrompt: instructions,
      detail: { usage },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textPart.text);
  } catch (err) {
    return {
      ok: false,
      reason: "The output was not valid JSON, so every call made with this prompt would fail: " +
        String(err instanceof Error ? err.message : err),
      composedPrompt: instructions,
      detail: { usage, raw: String(textPart.text).slice(0, 1000) },
    };
  }

  // The schema is `strict`, so OpenAI should already have enforced this. It is
  // checked anyway, because "should already have" is what the whole test run
  // exists to stop relying on — and because a missing required key is the
  // exact failure a contradicting prompt produces.
  const required = Array.isArray((probe.schema as { required?: unknown }).required)
    ? ((probe.schema as { required: string[] }).required)
    : [];
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const missing = required.filter((k) => !(k in obj));
  if (missing.length) {
    return {
      ok: false,
      reason: `The output was missing required fields (${missing.join(", ")}). The prompt and the schema this service reads no longer agree.`,
      composedPrompt: instructions,
      detail: { usage, missing },
    };
  }

  return {
    ok: true,
    reason: "One real call, valid JSON, every required field present.",
    output: parsed,
    composedPrompt: instructions,
    detail: { usage },
  };
}

async function testImage(
  slug: string,
  parts: Record<string, unknown>,
  model: string,
): Promise<TestResult> {
  // ⚠ Composed by the REAL composer for the avatars. `buildPrompt` is imported
  // from `_shared/avatar-art.ts` — the same function `generate-avatar` and
  // `refresh-avatars` call — so what is tested is the whole assembled prompt,
  // including the opening line, the closing guard and the month's accent, and
  // not merely the house style as typed into a box.
  let prompt: string;
  if (slug === "avatar-art") {
    const cycle = currentCycle();
    const theme = themeForCycle(cycle, (parts.themes as string[]) ?? undefined);
    prompt = buildPrompt(
      // A synthetic profile with a couple of interests, so the "weave these in
      // as subtle accents" branch is exercised rather than the empty one.
      { full_name: "Test Member", interests: ["woodworking", "aviation"], skills: ["Azure"], industry: "technology" },
      theme,
      "photo",
      0,
      { house_style: String(parts.house_style ?? ""), variants: (parts.variants as string[]) ?? undefined },
    );
  } else {
    prompt = String(parts.image_brief ?? "") + " Theme: Cloud Native Night Dubai, Cloud, Networking.";
  }

  // ⚠ /v1/images/generations, not /v1/images/edits, and the difference is
  // worth being honest about. The avatar functions send a source photograph
  // and there is no member photograph to borrow for a test — using one would
  // be a straightforward breach of the promise that no real photographs live
  // on this platform. So the test proves the model accepts this prompt and
  // this account can call it, which is what a prompt edit puts at risk; it
  // does not prove the likeness transfer, which a prompt edit cannot break.
  const payload: Record<string, unknown> = {
    model,
    prompt,
    size: "1024x1024",
    n: 1,
  };
  // The production calls ask for `quality: high`. A test asks for the cheapest
  // thing that still proves the prompt is accepted — but only where the
  // parameter exists, because the older image families reject the value.
  if (/^gpt-image/.test(model)) payload.quality = "low";

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      signal: abort.signal,
      headers: { "Authorization": "Bearer " + OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      ok: false,
      reason: abort.signal.aborted
        ? `The image call did not finish inside ${TEST_TIMEOUT_MS / 1000}s.`
        : "The image call never completed: " + String(err instanceof Error ? err.message : err),
      composedPrompt: prompt,
      detail: {},
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`ai-admin test ${slug} ${res.status}: ${body.slice(0, 400)}`);
    // A prompt the safety system declines is the single most likely way to
    // break an image prompt by editing it, and it must read as a prompt
    // problem rather than as an outage.
    if (/moderation|safety|content_policy/i.test(body)) {
      return {
        ok: false,
        reason: "The safety system declined this prompt. Something in the wording is being read as a request it will not draw — this prompt would fail for every member.",
        composedPrompt: prompt,
        detail: { http_status: res.status },
      };
    }
    return {
      ok: false,
      reason: triage(res.status, body, model),
      composedPrompt: prompt,
      detail: { http_status: res.status },
    };
  }

  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    return {
      ok: false,
      reason: "The call succeeded but no image came back.",
      composedPrompt: prompt,
      detail: {},
    };
  }

  return {
    ok: true,
    reason: "One real image call, accepted, and a picture came back.",
    // Returned for the panel to show, and deliberately NOT written to
    // `test_detail` — a base64 image in a jsonb column is several hundred
    // kilobytes read back on every history load, for ever.
    output: { image_data_url: "data:image/png;base64," + b64 },
    composedPrompt: prompt,
    detail: { image_bytes: Math.round((String(b64).length * 3) / 4) },
  };
}

// One triage for both endpoints. The remedy differs by cause and a generic
// "something went wrong" sends a staff member to the wrong screen.
function triage(status: number, detail: string, model: string): string {
  if (/model_not_found|does not exist|unknown model/i.test(detail)) {
    return `This account cannot use "${model}". Refresh the model list and pick another.`;
  }
  if (/insufficient_quota|billing_hard_limit|exceeded your current quota/i.test(detail)) {
    return "The OpenAI balance is spent. No amount of retrying will change this one — the account needs credit.";
  }
  if (status === 401) return "OpenAI rejected our credentials. Check OPENAI_API_KEY in the Edge Function secrets.";
  if (status === 429) return "OpenAI is rate-limiting us. Wait a moment and test again — this is not a verdict on the prompt.";
  if (status >= 500) return `OpenAI returned ${status}. That is their side; test again shortly.`;
  // A 400 from a structured-output call is very often the prompt or the schema.
  return `OpenAI refused the request (${status}). ${detail.slice(0, 300)}`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
