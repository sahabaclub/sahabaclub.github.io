// Sahaba Club — sign-up / sign-in
// ------------------------------------------------------------
// One flow for everyone: Google, Microsoft, or a phone number. Whichever
// one someone uses, Supabase creates the account on first use, and a
// database trigger (see supabase/migrations/0001_phase1_schema.sql)
// gives it an empty `profiles` row and a Standard `subscriptions` row —
// there's no separate "sign up" step to keep in sync with "sign in".
import { supabase } from "./supabase-client.js";

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
