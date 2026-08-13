// Sahaba Club — Supabase client
// ------------------------------------------------------------
// Loaded via esm.sh so the site keeps its no-build-step setup.
// Fill in SUPABASE_URL and SUPABASE_ANON_KEY once the project exists
// (see SETUP.md at the repo root for how to create it).
//
// The anon key is meant to be public — it only grants whatever the
// database's Row Level Security policies allow for a given user. Never
// put the Supabase *service role* key here or in any file served to
// the browser; that one only belongs in Edge Function secrets.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Base project URL only — no /rest/v1 suffix. The dashboard shows the REST
// endpoint with that path appended; supabase-js adds it itself, so leaving
// it on produces .../rest/v1/rest/v1/... and every query 404s.
//
// ⚠ THIS LINE IS THE CUSTOM-DOMAIN SWITCH, AND THE CSP SIDE IS ALREADY DONE.
// Ahmed, 11 Aug 2026: Google's sign-in prompt reads "to continue to
// sobxhcsgtimtiqtvqbag.supabase.co", which does not look like Sahaba Club to
// somebody signing up. `https://auth.sahabaclub.ai` is ALREADY permitted in the
// `connect-src` of all 31 pages and in `tools/add-security-headers.mjs`, so
// changing this one string is the whole switch on this side.
//
// ⚠ BEFORE FLIPPING IT, IN THIS ORDER:
//   1. The domain must actually resolve and serve the project — Supabase
//      Custom Domains is a PAID add-on and this project is on the free plan.
//   2. Add `https://auth.sahabaclub.ai/auth/v1/callback` to the Google OAuth
//      client's authorised redirect URIs FIRST. Both URIs can be listed at
//      once, so there is no window where sign-in is broken.
//   3. Then change this line and deploy.
//
// ⚠ AND DO NOT REMOVE THE OLD HOST FROM THE CSP when you do. Every avatar and
// event image already written into the database points at
// sobxhcsgtimtiqtvqbag.supabase.co, and those rows outlive any DNS change.
const SUPABASE_URL = "https://sobxhcsgtimtiqtvqbag.supabase.co";

// Publishable key — public by design; it ships in this file to a public repo
// and is guarded by the Row Level Security policies in supabase/migrations.
//
// Note for later: Supabase Edge Functions only verify the older JWT-style
// `anon` key. When the functions in supabase/functions/ get deployed, swap
// this for the anon key from Settings → API Keys → Legacy API Keys (or run
// those functions with --no-verify-jwt). Nothing in the public pages or the
// login flow depends on that, so this is correct as-is today.
const SUPABASE_ANON_KEY = "sb_publishable_uYzve3z4wfLF_-9fTH67Og_PJ6EhHm4";

// True once the two values above are real. Until then the public pages
// keep their old "email us to sign in" links rather than sending people
// to a login page that can't work yet — so this repo is safe to publish
// before the Supabase project exists, and starts working on its own the
// moment those values are filled in. Nothing else to switch on.
// Exported so auth.js can ask /auth/v1/settings which providers are enabled
// without a second copy of these values drifting out of sync. Both are public
// — the key ships in this file already.
export { SUPABASE_URL, SUPABASE_ANON_KEY };

export const isConfigured =
  SUPABASE_URL.indexOf("YOUR-PROJECT-REF") === -1 &&
  SUPABASE_ANON_KEY.indexOf("YOUR-ANON") === -1;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
