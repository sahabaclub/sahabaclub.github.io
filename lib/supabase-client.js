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
