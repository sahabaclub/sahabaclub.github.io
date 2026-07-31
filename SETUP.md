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

```bash
supabase functions secrets set \
  MS_GRAPH_TENANT_ID=... \
  MS_GRAPH_CLIENT_ID=... \
  MS_GRAPH_CLIENT_SECRET=... \
  MS_GRAPH_LICENSE_SKU_ID=... \
  MS365_DOMAIN=sahabaclub.com \
  RESEND_API_KEY=... \
  RESEND_FROM="Sahaba Club <hello@sahabaclub.com>" \
  SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=...

supabase functions deploy provision-ms365
supabase functions deploy send-transactional-email
```

`SUPABASE_SERVICE_ROLE_KEY` is in Project Settings → API — it's the
"secret" key, never the anon one. It's what lets `provision-ms365` write
`ms365_accounts` rows on a member's behalf and bypass Row Level Security.

## 5. Phase 2 — AI profile import and newsletters

**Anthropic API key** for reading CVs and LinkedIn PDF exports: create one
at [console.anthropic.com](https://console.anthropic.com).

```bash
supabase functions secrets set ANTHROPIC_API_KEY=...

supabase functions deploy parse-profile-document
supabase functions deploy send-newsletter
```

**Make yourself an admin.** The newsletter page is gated on
`profiles.role = 'admin'`, and members can't change their own role — the
migration revokes that column from browser clients specifically so nobody
can promote themselves. So the first admin has to be set from the
Supabase dashboard: Table Editor → `profiles` → find your row → set
`role` to `admin`. The dashboard connects as the service role, which is
what the revoke exempts.

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
