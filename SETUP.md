# Setup — accounts, login, Microsoft 365, profiles, newsletter

This is the checklist for turning on what's already scaffolded in the repo
(`lib/`, `app/`, `supabase/`, `login.html`). Nothing here works yet —
every file has a placeholder value that needs a real one. This doc is
the map of exactly which ones and where they come from.

Steps 1–4 cover Phase 1 (accounts, login, Microsoft 365). Step 5 covers
Phase 2 (AI profile import and newsletters) — skip it if you only want
signups working first.

## 1. Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. Project Settings → API → copy the **Project URL** and **anon public**
   key into [lib/supabase-client.js](lib/supabase-client.js) (`SUPABASE_URL`, `SUPABASE_ANON_KEY`).
3. SQL Editor → run [supabase/migrations/0001_phase1_schema.sql](supabase/migrations/0001_phase1_schema.sql),
   then [0002_phase2_roles.sql](supabase/migrations/0002_phase2_roles.sql), in that order.
   (Or install the Supabase CLI and run `supabase db push` — either way, same result.)
4. Authentication → Providers:
   - **Google** — enable it, following Supabase's guide to create a Google
     OAuth client and paste its client ID/secret in.
   - **Azure** — enable it the same way, with its own Azure AD app
     registration. This is *separate* from the Graph API app registration
     in step 3 below — this one only confirms identity (name/email),
     it never touches mailboxes.
   - **Phone** — enable it and connect an SMS provider (Twilio is
     Supabase's built-in option). Confirm it can send to the countries
     your members actually sign up from.
5. Authentication → URL Configuration — add `login.html` (both the
   `https://sahabaclub.github.io/login.html` production URL and whatever
   you're testing locally) to the allowed redirect URLs.

## 2. Microsoft Graph — mailbox provisioning

This is a *different* Azure AD app registration from the login one above —
this one runs unattended (no signed-in user) and needs real admin
authority, since it creates, licenses, disables, and eventually deletes
real mailboxes.

1. In the Azure portal → App registrations → New registration.
2. API permissions → add **Application** permissions (not Delegated):
   `User.ReadWrite.All`, `Organization.Read.All`. Click
   **Grant admin consent** — this is the step that requires your Global
   Admin access.
3. Certificates & secrets → new client secret.
4. You'll need: the **Tenant ID**, this app's **Client ID**, the
   **Client secret**, and the **license SKU ID** you want assigned to new
   members (Azure portal → Licenses → All products → copy the SKU ID for
   whichever Microsoft 365 plan is the free-3-months one).
5. These four values, plus your domain, become Edge Function secrets —
   see step 4 below. They never go in any file the browser loads.

## 3. Resend — transactional email

1. Create an account at [resend.com](https://resend.com), verify the
   `sahabaclub.com` sending domain.
2. Create an API key.

## 4. Wire the secrets into Supabase Edge Functions

Using the [Supabase CLI](https://supabase.com/docs/guides/cli):

Do **not** add `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` here. The CLI rejects the
reserved `SUPABASE_` prefix, and because every variable goes in one command, adding them
means *none* of the others get set either. Both are injected into every Edge Function
automatically, so they are not needed.

```bash
supabase functions secrets set \
  MS_GRAPH_TENANT_ID=... \
  MS_GRAPH_CLIENT_ID=... \
  MS_GRAPH_CLIENT_SECRET=... \
  MS_GRAPH_LICENSE_SKU_ID=... \
  MS_GRAPH_USAGE_LOCATION=AE \
  MS365_DOMAIN=sahabaclub.com \
  MS365_OPS_EMAIL=members@sahabaclub.com \
  RESEND_API_KEY=... \
  RESEND_FROM="Sahaba Club <members@sahabaclub.com>"

supabase functions deploy provision-ms365
supabase functions deploy send-transactional-email
supabase functions deploy notify-ms365-reset
```

`MS_GRAPH_USAGE_LOCATION` defaults to `AE` in code. Microsoft Graph refuses to assign a
licence to a user with no usage location, so it has to be set to something.

`MS365_OPS_EMAIL` is where a member's "I've forgotten my mailbox password" request is sent.
It defaults to `members@sahabaclub.com`.

`SUPABASE_SERVICE_ROLE_KEY` is in Project Settings → API — it's the
"secret" key, never the anon one. It's what lets `provision-ms365` write
`ms365_accounts` rows on a member's behalf and bypass Row Level Security.

## 5. Phase 2 — AI profile import and newsletters

**OpenAI API key.** Every AI function in the project reads `OPENAI_API_KEY` —
there is no Anthropic key anywhere in the code. Create one at
[platform.openai.com](https://platform.openai.com/api-keys).

This one secret covers `parse-profile-document` (reading CVs and LinkedIn PDF
exports), `write-member-intro`, `write-contact-email`, `import-event`,
`generate-avatar`, `refresh-avatars`, the two PromptArena functions
(`promptarena-judge` and `promptarena-challenge`) and `ai-admin`.
`send-newsletter` needs no AI key — it only needs the Resend secrets from
step 4.

```bash
supabase functions secrets set OPENAI_API_KEY=...

# Optional, and read by four functions: parse-profile-document,
# import-event, write-contact-email and write-member-intro. Defaults to
# gpt-5 in all four. Set it if your account cannot use that name, so a
# model rename is a dashboard edit rather than a redeploy — the functions
# say so by name when OpenAI rejects the model.
supabase functions secrets set OPENAI_MODEL=gpt-5

# Optional, for the two image functions (generate-avatar, import-event).
# Defaults to gpt-image-1; set it if your account uses another image model.
supabase functions secrets set OPENAI_IMAGE_MODEL=gpt-image-1

supabase functions deploy parse-profile-document
supabase functions deploy send-newsletter
```

If `parse-profile-document` reports "Document import isn't configured yet"
with a key apparently set, it is looking for `OPENAI_API_KEY` — an
`ANTHROPIC_API_KEY` secret does nothing here.

**Run migration `0023` for work history.** `parse-profile-document` reads a
CV's whole employment history and returns it as `work_history`, but it never
writes to `profiles` itself — the member's Save does. That needs
`0023_profile_history_and_hackathons.sql`, both for the column and for the
`grant update (work_history)` on it. Until 0023 is applied the import still
works and the dashboard refuses the save with a message naming this migration,
rather than reporting "Saved." over a career it quietly dropped.

If you are deploying `parse-profile-document` from the **dashboard editor**
rather than the CLI, deploy its `index.deploy.ts` rather than `index.ts`. It is
not the only function with a twin — see **Deploying from the dashboard editor**
at the end of this step for the full list and the reason.

**Avatars.** `generate-avatar` turns a member's photo into an illustrated
club-style portrait and then discards the photo. It uses the same
`OPENAI_API_KEY` as everything above, plus `OPENAI_IMAGE_MODEL`:

```bash
supabase functions deploy generate-avatar
supabase functions deploy refresh-avatars
```

**Run migration `0026` first.** `generate-avatar` writes `avatar_status`,
`avatar_error` and `avatar_gallery` on every run, including the very first
UPDATE that reserves the attempt. Deploy it against a database that has not
had `0026_avatar_gallery_and_status.sql` applied and every generation fails
with "column avatar_status does not exist" before it reaches OpenAI.

If you are deploying from the **dashboard editor** rather than the CLI,
deploy `supabase/functions/generate-avatar/index.deploy.ts` instead of
`index.ts`, and `refresh-avatars`' twin alongside it — the two share
`_shared/avatar-art.ts` and a house style in two copies is a house style
that drifts. See **Deploying from the dashboard editor** at the end of this
step; it applies to twelve functions, not just these.

Check it landed:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  https://<project>.supabase.co/functions/v1/generate-avatar
# 401 = deployed (it wants a signed-in caller). 404 = not deployed.
```

Until it is deployed, the avatar control still works: "Skip — use a tile
with my initials" draws the themed fallback in the browser and uploads it
to the `avatars` bucket, so members can complete their profile and appear
in Connect without any OpenAI call. The two photo routes report that the
service isn't switched on yet rather than failing silently.

**Make yourself an admin.** The newsletter page is gated on
`profiles.role = 'admin'`, and members can't change their own role — the
migration revokes that column from browser clients specifically so nobody
can promote themselves. So the first admin has to be set from the
Supabase dashboard: Table Editor → `profiles` → find your row → set
`role` to `admin`. The dashboard connects as the service role, which is
what the revoke exempts.

**Admin → AI services.** [app/admin/ai.html](app/admin/ai.html) is where staff
edit the prompts and pick the models for the AI the club keeps paying for month
after month — the avatars, the CV reader, the PromptArena coach and challenge
writer, the member introduction, the outreach email and the event importer. It
is gated on the same `admin` (or `staff`) role as the newsletter page above.

**Run migration `0031` first.** `0031_ai_service_control.sql` creates the
service catalogue, the model cache and the append-only version history the
panel reads. There is no `0030` in this directory and that is deliberate — the
migration's own header says which proposal is holding the number.

The panel talks to the `ai-admin` Edge Function, which does the three things a
browser cannot: ask OpenAI which models this account may actually use, show the
prompt a service is running on when nothing is stored, and make one real model
call to prove an edited prompt still works before it is allowed to go live. It
needs `OPENAI_API_KEY` and nothing else of its own — `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are injected automatically, for the reason step 4
gives.

```bash
supabase functions deploy ai-admin
```

**Then open Admin → AI services once and press "Refresh model list", before
trying to save any prompt.** The model list is fetched live from OpenAI's
`/v1/models` with your own key rather than hardcoded — a list of model names
typed into a migration in August is wrong by November — so the table starts
empty, and `0031` validates every model you save against it with a real foreign
key. Until that button has been pressed the model dropdowns are empty and every
save is refused with "Model … is not in the model list. Refresh the model list
first."

None of this is required for the platform to run. Every service uses the prompt
in its own source file until somebody activates a version here, and falls back
to it the moment that version is removed — so no rows in `ai_service_versions`
is the normal working state, not an unfinished one.

**Deploying from the dashboard editor.** Twelve functions ship a second file,
`index.deploy.ts`, beside `index.ts`. Deploy that one instead if you are pasting
into the Supabase dashboard editor rather than using the CLI: the editor deploys
one function directory at a time and cannot reach a shared parent file, so every
`../_shared/…` import in `index.ts` is unresolvable there and the deploy fails.
Each twin is its `index.ts` with those imports pasted inline and nothing else
changed, so regenerate it whenever `index.ts` changes — the two have to stay in
step.

- `generate-avatar`, `refresh-avatars` — `cors.ts`, `avatar-art.ts`, `ai-config.ts`
- `parse-profile-document`, `import-event`, `promptarena-judge`,
  `promptarena-challenge`, `write-member-intro`, `write-contact-email` —
  `cors.ts`, `ai-config.ts`
- `ai-admin` — `cors.ts`, `avatar-art.ts`
- `provision-ms365` — `cors.ts`, `graph.ts`
- `build-prospect-profile`, `send-transactional-email` — `cors.ts`

`send-newsletter`, `send-campaign` and `send-license-reminders` import
`_shared/cors.ts` and have no twin, so those three are CLI-only until one is
written. `notify-ms365-reset` imports nothing shared and deploys either way.

## What's deliberately not built yet

- **`ms365-lifecycle`** (the license revoke → grace → deactivate → delete
  automation) is a Phase 6 item — it doesn't need to exist until the
  first cohort's 3-month trials are actually approaching expiry.
- **Payments** — no processor is wired in yet; membership tier is a
  manual flag an admin can flip in the `subscriptions` table until
  Phase 4.
- **Coach profiles, booking, and AI matching** are Phases 3–5.

## Sanity-checking it works

1. Run the site locally (any static file server — GitHub Pages doesn't
   need a build step, so `npx serve` from the repo root is enough).
2. Visit `login.html`, sign in with one provider.
3. You should land on `app/onboarding.html`. Try both the "I've had an
   account before" and "first time" paths — each should end with an
   email (check Resend's dashboard/logs if it doesn't arrive) and land
   you on the profile form.
4. Submitting the profile form should redirect to `app/dashboard.html`
   and show your name, tier, and mailbox status.
5. On `events.html`, mark one event `tierRequired: "premium"` from
   `admin.html` and confirm it shows locked when signed out, and when
   signed in as a Standard member — then flip your own `subscriptions.tier`
   to `premium` in the Supabase table editor and confirm it unlocks.

Phase 2, once step 5 above is done:

6. In onboarding, choose "Upload a CV or LinkedIn PDF" and upload a real
   CV. The form should come back pre-filled with a review banner, and
   every field should be editable before you save.
7. Set your own `profiles.role` to `admin`, reload `app/dashboard.html`,
   and confirm a **Newsletter** link appears. On that page, "Check
   audience size" should return a count before you send anything.
8. Send a test newsletter to a narrow interest tag that only your own
   account matches, and confirm it arrives.
9. Open **Admin → AI services** and press "Refresh model list" — it should
   report a count of text and image models. Then edit one prompt, run its
   test, and confirm it cannot go live until that test passes. Put the
   service back with "Use the code default" afterwards — nothing on the
   platform should notice.
