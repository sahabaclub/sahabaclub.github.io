# Sahaba Club website

The Sahaba Club site — public pages (home, events, podcast) plus, as of
Phase 1, real accounts: sign-up/login, Microsoft 365 provisioning, and a
member profile. Still no build step for the frontend — it's plain HTML/JS,
now backed by Supabase for anything that needs a real database.

## Files

- `index.html`, `events.html`, `podcast.html` — public pages
- `styles.css` — all styling
- `script.js` — shared nav/theme behavior + the "Sign in" → "Dashboard" swap
- `login.html` — sign up / sign in (Google, Microsoft, phone)
- `membership.html` — public Standard vs Premium comparison
- `lib/` — Supabase client, auth helpers, tier-gating (shared by every page)
- `app/` — pages behind login (`onboarding.html`, `dashboard.html`, `profile.html`, `newsletter.html`)
- `admin.html` — event management (GitHub-token based), now also sets each event's Premium-only flag
- `supabase/` — database migrations and Edge Functions (mailbox provisioning, transactional email)

See [SETUP.md](SETUP.md) for the accounts and keys needed to make the
account/login/Microsoft 365 side actually work — none of it is live until
those are filled in.

## Editing

Page content still lives directly in the HTML files — open one, find the
text, edit, save, re-upload to GitHub (or edit in GitHub's web editor).

Events are managed from `admin.html` rather than by hand-editing
`events-data.js`, though that file is still plain JS if you'd rather.

This site is published with GitHub Pages — that continues to serve every
page here as before; Supabase only supplies the pieces GitHub Pages can't
(a database, auth, and the Microsoft/email automation), documented in
[SETUP.md](SETUP.md).
