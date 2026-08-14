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
`generate-avatar` and `refresh-avatars`. `send-newsletter` needs no AI key —
it only needs the Resend secrets from step 4.

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
rather than the CLI, deploy its `index.deploy.ts` rather than `index.ts`, for
the same reason as `generate-avatar` below. That file is generated, not
written by hand:

```bash
node tools/deploy-twin.mjs write     # regenerate the twins from their index.ts
node tools/deploy-twin.mjs verify    # exit 1 if one of them is out of date
```

The script needs Node 18 and nothing else; this repo still has no
`package.json` and no dependencies. It covers every
`supabase/functions/*/index.deploy.ts` — it finds them by looking, so a new
function with a twin is covered the moment it exists — except
`provision-ms365` and `send-transactional-email`, whose twins predate the
script and carry an older banner and layout; `verify` lists those two as
`skipped` rather than passing them over silently.

Run `write` after editing one of those `index.ts` files or anything in
`supabase/functions/_shared/`, and `verify` before a dashboard deploy. A
stale twin does not fail to deploy — it deploys the previous version of the
function, silently, which is the whole reason the check exists.

**EduHackAI-5 interest form.** `register-interest` takes the popup form on
the public hackathons page, stores it, and emails the club. It is the only
**anonymous** function in the project, and that changes how it deploys:

```bash
supabase functions deploy register-interest --no-verify-jwt
```

**`--no-verify-jwt` is not optional here.** Every other function is called
by a signed-in member or by the service role, so the gateway's JWT check is
free protection. This one is called by a visitor who has no account, using
the `sb_publishable_…` key in `lib/supabase-client.js` — and a publishable
key is not a JWT. Deploy it without the flag and the gateway returns 401
before the function runs, so the form fails for everyone and **nothing
appears in the function logs to say why**. The auth that matters is inside
the function: it writes only through `register_hackathon_interest()`, and
`send-transactional-email` ignores the caller's `to` for this template, so
it cannot be turned into a mailer for anyone but the club.

Needs migration `0036` applied first — the function calls an RPC that
`0036` creates, and reports that by name if it is missing.

Optional: `INTEREST_NOTIFY_EMAIL` overrides where the notification goes.
Both functions default to the club address if it is unset.

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
`index.ts`. It is the same function with `_shared/cors.ts`,
`_shared/ai-config.ts` and `_shared/avatar-art.ts` pasted inline, because the
editor deploys one function directory at a time and cannot reach a shared
parent file — the same arrangement `parse-profile-document` already uses. It
is generated by `node tools/deploy-twin.mjs write` (above), which is also
what keeps it in step with `index.ts` and with those three shared files;
`verify` says whether it still is.

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

## 6. Google Analytics

Already wired, and unlike everything above it needs no key, no secret and no
deploy — the whole of it is `analytics.js` in the repo root, included by the
seven public pages.

**The measurement id is in the file, in plain sight, and that is correct.** It
is the constant `GA_MEASUREMENT_ID` at the top of `analytics.js`. A GA4
measurement id is served to every visitor in the page source by design — it is
an address telling the tag which property to report to, not a key that grants
anything — so it does not belong in an environment variable or a secret store,
and hiding it would imply a confidentiality it cannot have. What does need
guarding is the Google Analytics account itself, which is a login and is not
in this repository.

To point the site at a different property, change that one constant. To switch
analytics off entirely, set it to `""` — the file then goes completely inert:
no script fetched, no cookie, no consent bar. That branch is deliberate, so
that a fork or a half-configured deploy never shows anyone a consent prompt
for tracking that cannot happen, and it is covered by the tests.

**Two things to set in the Google Analytics admin, not here.**

1. **Data retention** — Admin → Data settings → Data retention. The privacy
   page deliberately does not quote a number; it says the setting lives in the
   property and offers to tell anyone who asks. Set it, and then that sentence
   is answerable.
2. **Nothing else.** Do not switch on Google Signals or ad personalisation.
   `analytics.js` sends `allow_google_signals: false` on every page, and the
   privacy page tells people so.

**What it will and will not show you.** Page views on the public pages only.
There is no click tracking, no scroll depth, no site-search capture and no
custom events. Two absences that will look like bugs in the reports if nobody
writes them down:

- **No campaign attribution.** The URL is cut at the first `?`, so `utm_*`
  tags and `gclid` never arrive and everything lands under direct/organic.
  That cut exists because `login.html` can carry `?next=` and an OAuth failure
  returns `#error_description=` or an access token in the fragment. If
  campaign reporting is wanted later, the fix is an allowlist that keeps
  `utm_*` and drops the rest — not removing the cut.
- **No member pages.** Nothing under `app/` carries the script, and a referrer
  from one of those pages is dropped rather than reported. Sessions will look
  short for members because the half of their visit that happens after sign-in
  is invisible on purpose.

**Checking it.** `node tools/analytics-checks/check.mjs` drives the consent
state machine through every state and asserts that a `<script>` for
googletagmanager is created in exactly one of them.
`node tools/analytics-checks/contrast.mjs` measures the consent bar in both
themes. Neither needs a browser.

## 7. The nightly events brief

Every night at 22:00 Dubai, `linkedin-daily-events` emails Ghadir a
ready-to-paste LinkedIn post about **the next day's** events, with the event
images attached. She posts it by hand. Ahmed is copied.

⚠ **This replaced an API-posting job on 11 Aug, the same day it was built.**
Posting as a company page needs LinkedIn's Community Management API — an
approval measured in days, for a token that then expires on LinkedIn's schedule
and takes the job down when it does. Email needs no approval and no token, and
it puts a person between the database and the company page, which for a post
naming other organisations' events is where a person should be.

**What the email contains**

- The post, in one block she can select in a single drag.
- Every published event on that date, whoever runs it.
- One call to action, pointing at the events page. Not a link per event:
  LinkedIn favours a single link, and every event is on that page anyway.
- The event images, **attached** — so she can drag them straight into LinkedIn.
- On a night with nothing on: a one-line note saying so. ⚠ Silence and a broken
  job look identical to the person waiting for the email.

**The secrets**

`RESEND_API_KEY` and `RESEND_FROM` are already set and shared with the other
senders. Two more control the recipients, so an address can be changed in one
command with no deploy:

⚠ **Write the addresses to a file outside this repository and set from the
file** — `secrets set KEY=value` puts them in your shell history, and this repo
is public. A personal address in a `BRIEF_TO=` example is a personal address on
GitHub.

```bash
supabase secrets set --env-file C:\sctools\brief.env --project-ref sobxhcsgtimtiqtvqbag
```

…where `brief.env` holds `BRIEF_TO=…` and `BRIEF_CC=…`, one per line, and is
deleted afterwards. `BRIEF_TO` **is set** as of 14 Aug; before that it was
unset, so the fallback inside `linkedin-daily-events` was the live recipient
list — and that fallback named a personal address, in public. It no longer
does.

⚠ **Both of Ghadir's addresses are in `BRIEF_TO` on purpose.**
`ghadir@sahabaclub.com` is the address Ahmed asked for and **nothing has
confirmed it exists** — it is not in `ms365_accounts`, where every other club
mailbox is. Until somebody checks the tenant, the gmail address is what
guarantees she actually receives it. Drop it from the secret once the club
mailbox is confirmed to deliver, and see the note below about linking the two.

⚠ **Linking `ghadir@sahabaclub.com` to her personal address is an admin action
in Microsoft 365, not something this repository can do.** It is one of three
different things depending on what exists today — create the mailbox, add the
address as an alias on an existing one, or set forwarding to the gmail account
— and guessing wrong in a live tenant is worse than asking. Microsoft 365 admin
centre → Users → the account → Manage email aliases, or Mail → Forwarding.

**Check it before trusting it**

```
POST /functions/v1/linkedin-daily-events?dry=1                  compose, send nothing
POST /functions/v1/linkedin-daily-events?test=1                 send to the CC only
POST /functions/v1/linkedin-daily-events?dry=1&date=2026-08-15  a specific day
```

⚠ `test=1` sends to **BRIEF_CC only** and **claims no day**. Ghadir is
deliberately not on a test: an unexpected "post this tomorrow" email at the
wrong hour is the confusion this job exists to remove. And a test must not
consume tomorrow, or the one action somebody takes to check the job is the
action that stops it running.

**The schedule**

```sql
select cron.schedule(
  'events-brief-nightly',
  '0 18 * * *',                                  -- 18:00 UTC = 22:00 Asia/Dubai
  $$ select net.http_post(
       url := 'https://sobxhcsgtimtiqtvqbag.supabase.co/functions/v1/linkedin-daily-events',
       headers := jsonb_build_object(
         'Authorization', 'Bearer <SENDER_TOKEN>',
         'Content-Type', 'application/json')
     ); $$
);
```

⚠ **`SENDER_TOKEN`, not the service role key, and this project paid to learn
it.** The value Supabase injects as `SUPABASE_SERVICE_ROLE_KEY` matches none of
the keys the dashboard offers, so a scheduled job gated on it returns 403 every
time — see the note in `send-notification-emails`, which hit exactly this. The
function is deployed with `--no-verify-jwt` for the same reason the other two
scheduled senders are: a shared token is not a JWT and the gateway would reject
it before the function ran. A staff session still works and is still verified
inside the function.

⚠ **It cannot email the same day twice.** `linkedin_daily_posts.post_date` is
the primary key and the day is claimed *before* the send, so a retry or an
overlapping run collides on the constraint instead of sending a second copy.

## 8. The two-hour event reminder, and the `events@` mailbox

A member who marks themselves **going** to an event gets an email about two
hours before it starts, from **events@sahabaclub.com**.

**Nothing needs scheduling.** The whole chain was already automated and this
only retargets it: `notification-sweeps` runs `sweep_event_reminders()` every
15 minutes (0046) → `email_queue()` filters it (0051) → `send-notification-emails`
sends it (0052). Migration **0065** moved the lead time from one hour to two,
pointed the link at the event's own page, and gave it its own sender.

### ⚠ It sends nothing until `events.starts_at` is filled in

`starts_at` is a real timestamp; `event_date` + `time_label` cannot be computed
with, because `time_label` is free text ("8:00 AM onwards"). The sweep skips any
event without it rather than guess.

**Measured 13 Aug 2026: 39 upcoming published events, 0 with a start time —
and nothing in the product writes that column.** Not `app/admin/events.html`,
not the `import-event` importer. Until that changes the reminder is real code
that can never fire.

```
node tools/check-event-reminders.mjs
```

fails while that is true, on purpose. Check it before believing a reminder went
out, and after any backfill.

⚠ **Do not backfill by parsing `time_label` alone.** The upcoming list spans
more than one country, so reading "7:00 PM" as Dubai time makes an Egyptian
event's reminder two hours wrong — the club stating the wrong hour in its own
voice, which is worse than staying quiet. A backfill needs a per-event time
zone.

### Filling in the events that predate the field

**Admin → Events → "Start times · N missing".** The button only appears while
some upcoming event has no start time, and the count is deliberately taken from
every event rather than the filtered rows, so a search cannot hide it.

**Read** asks the AI importer to find the start time on the organiser's own
page — it reads both the clock time and the city, which is what makes the time
zone real rather than assumed. One model call per event. **Nothing is saved
until you press Apply**, and Apply writes only `start_time_local` and
`time_zone`, never the rest of the event.

Expect some to fail honestly, and the reason is shown per row:

| what it says | why |
|---|---|
| *page needs pasting* | LinkedIn, Microsoft Events, AWS and Kaggle hide everything from a server-side fetch. Open the event and use the normal form. |
| *no start time stated on the page* | Some listings genuinely never say. Ask the organiser, or leave it — no reminder is the honest outcome. |

New events need none of this: the importer fills both fields, and the form has
them.

### The sender address

| | |
|---|---|
| Secret | `EVENTS_FROM` — optional, defaults to `Sahaba Club Events <events@sahabaclub.com>` |
| Resend | **nothing to do.** Resend verifies a *domain*; `sahabaclub.com` is already verified, so any address on it can send. |
| Microsoft 365 | **create `events@sahabaclub.com` as a SHARED MAILBOX.** |

⚠ **Shared, not a licensed user.** Resend does the sending, so the mailbox is
only needed to *receive* — and a reminder is exactly the mail somebody replies
to ("can't make it", "is it still on?"). A shared mailbox costs **no licence**,
has **no password to leak**, and lets several staff read and reply as
`events@`. A normal user mailbox would cost a licence per month and create a
sign-in nobody needs; a distribution list cannot store replies at all.

In the Microsoft 365 admin centre: **Teams & groups → Shared mailboxes → Add a
shared mailbox**, name it `events@sahabaclub.com`, then add the staff who
should read it as members.

⚠ **If that mailbox does not exist, replies bounce.** The reminder still sends —
Resend never checks — so this fails silently in the one direction nobody tests.

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
   `app/admin/events.html` and confirm it shows locked when signed out, and when
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
