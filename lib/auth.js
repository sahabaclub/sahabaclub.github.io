// Sahaba Club — sign-up / sign-in
// ------------------------------------------------------------
// One flow for everyone: Google, Microsoft, or a phone number. Whichever
// one someone uses, Supabase creates the account on first use, and a
// database trigger (see supabase/migrations/0001_phase1_schema.sql)
// gives it an empty `profiles` row and a Standard `subscriptions` row —
// there's no separate "sign up" step to keep in sync with "sign in".
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-client.js";

// Where OAuth providers send people back to. login.html itself does the
// "what happens next" routing (onboarding vs. dashboard) once it sees a
// session, so every provider can share one redirect target.
function loginCallbackUrl() {
  return new URL("../login.html", import.meta.url).toString();
}

export function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: loginCallbackUrl() },
  });
}

// Requires the "Azure" provider to be enabled under Authentication →
// Providers in the Supabase dashboard. That's a separate app registration
// from the one used for Microsoft 365 mailbox provisioning (see
// supabase/functions/provision-ms365) — this one only needs to confirm
// "who is this person", not manage mailboxes.
export function signInWithMicrosoft() {
  return supabase.auth.signInWithOAuth({
    provider: "azure",
    options: { redirectTo: loginCallbackUrl(), scopes: "email" },
  });
}

// Requires the "LinkedIn (OIDC)" provider — the newer one, not the legacy
// "LinkedIn" entry — to be enabled in the Supabase dashboard.
//
// Worth being clear about what this does and doesn't get us. LinkedIn's
// OpenID Connect product returns name, email, picture and locale, and nothing
// else: no positions, no skills, no education. Those need LinkedIn Partner
// Program approval, which is a business partnership rather than a signup. So
// this is a login button that saves someone typing their name — the actual
// profile import still comes from the LinkedIn PDF export, through
// parse-profile-document, the same path a CV takes.
export function signInWithLinkedIn() {
  return supabase.auth.signInWithOAuth({
    provider: "linkedin_oidc",
    options: { redirectTo: loginCallbackUrl() },
  });
}

// Email and password. Supabase has the email provider on already, but with
// mailer_autoconfirm off - so a new account gets a confirmation email and
// cannot sign in until it is clicked. Until custom SMTP is configured that
// goes out through Supabase's built-in sender, which is rate limited to a
// handful an hour and is explicitly not for production. See SETUP.md.
//
// Chosen over a magic link deliberately: a magic link needs an email for
// *every* sign-in, which the built-in sender cannot support. A password needs
// one at sign-up and one per reset.
export function signUpWithEmail(email, password) {
  return supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: loginCallbackUrl() },
  });
}

export function signInWithEmail(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

export function sendPasswordReset(email) {
  return supabase.auth.resetPasswordForEmail(email, {
    redirectTo: new URL("../app/profile.html", import.meta.url).toString(),
  });
}

// Which sign-in methods this project actually has switched on.
//
// The buttons used to be hard-coded, so Microsoft and phone sat there looking
// real while Supabase rejected them - Microsoft with a raw JSON error page,
// because a disabled provider is refused at the authorize endpoint and never
// redirects back for our error handler to catch. Asking the server what is
// enabled means the page can only ever offer what works, and a provider
// switched on later appears without a code change.
export async function enabledProviders() {
  const fallback = { google: true, azure: false, linkedin_oidc: true, phone: false, email: true };
  try {
    const res = await fetch(SUPABASE_URL + "/auth/v1/settings", {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY },
    });
    if (!res.ok) return fallback;
    const settings = await res.json();
    return settings.external || fallback;
  } catch (err) {
    return fallback;
  }
}

// Phone sign-in is two steps: send a code, then verify it. Requires an
// SMS provider (e.g. Twilio) configured under Authentication → Providers
// → Phone in Supabase — see SETUP.md.
export function sendPhoneCode(phone) {
  return supabase.auth.signInWithOtp({ phone });
}

export function verifyPhoneCode(phone, code) {
  return supabase.auth.verifyOtp({ phone, token: code, type: "sms" });
}

export function signOut() {
  return supabase.auth.signOut();
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// Fires immediately with the current state, then again on every
// sign-in / sign-out — handy for a nav bar that needs to react live.
export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => callback(session));
}

// Google and Microsoft both hand back a profile picture at sign-in, but the
// signup trigger predates the avatar_url column, so it never gets stored.
// Copy it across once, the first time we see a profile without one — after
// that the member's own choice (including clearing it) stands.
//
// Silent by design: a missing photo is a placeholder initial, not an error
// worth putting in front of anyone.
export async function syncAvatar(session) {
  if (!session) return;
  const meta = session.user.user_metadata || {};
  const url = meta.avatar_url || meta.picture;
  if (!url) return;

  const { data } = await supabase
    .from("profiles")
    .select("avatar_url")
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (!data || data.avatar_url) return;
  await supabase
    .from("profiles")
    .update({ avatar_url: url })
    .eq("user_id", session.user.id);
}

// Every logged-in member has exactly one of these; false only until the
// Phase 1 onboarding form (M365 step + profile) has been completed once.
export async function hasCompletedOnboarding(userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("onboarding_completed_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return false;
  return Boolean(data.onboarding_completed_at);
}
