// Sahaba Club — sign-up / sign-in
// ------------------------------------------------------------
// One flow for everyone: Google, Microsoft, or a phone number. Whichever
// one someone uses, Supabase creates the account on first use, and a
// database trigger (see supabase/migrations/0001_phase1_schema.sql)
// gives it an empty `profiles` row and a Standard `subscriptions` row —
// there's no separate "sign up" step to keep in sync with "sign in".
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-client.js?v=4bf9f935fb";

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
// mailer_autoconfirm off — so a new account gets a confirmation email and
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
// real while Supabase rejected them — Microsoft with a raw JSON error page,
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

// ---- "Take me back to where I was going" ------------------------------
//
// The gates on the app pages send a signed-out visitor to
// `../login.html?next=<encoded relative path>` so that finishing sign-in lands
// them on the page they actually wanted rather than on the dashboard.
//
// The whole risk of that feature is in one line: whatever ends up in
// `location.href` after authentication. A `next` that is allowed to be an
// absolute URL is an open redirect on the login page of a site that keeps its
// session in origin-scoped localStorage — the classic phishing shape, where a
// real sahabaclub.ai link with a real sign-in ends on somebody else's server.
// So this does not try to detect bad values. It accepts one narrow shape and
// rejects everything else, including things that are probably harmless.
//
// The shape: a path relative to the site root, ending in `.html`, optionally
// followed by a query string and/or a fragment. Nothing else. In particular:
//
//   * No ":" anywhere. That is `https://evil.com`, `javascript:alert(1)` and
//     `data:text/html,…` all at once, and it is cheaper to ban the character
//     than to enumerate the schemes.
//   * No leading "/" or "\". `//evil.com` is protocol-relative and browsers
//     treat `\` as `/` in URLs, so `/\evil.com` and `\\evil.com` are the same
//     attack wearing a hat. One leading "/" is stripped and then the rest has
//     to pass on its own; a second one is a rejection.
//   * No "%", so a value that was encoded twice cannot be decoded into
//     something else after this function has approved it. `URLSearchParams`
//     has already decoded once by the time we see the value; a "%" left in it
//     means somebody is trying for a second round.
//   * No ".." segment, no whitespace, no control characters. Browsers strip
//     tab, CR and LF out of URLs before parsing them, which turns "/<TAB>/x"
//     into "//x" after this function would have looked at it.
//
// Returns the safe path, or null. Callers must treat null as "no next" and
// carry on to their default destination — never as "use it anyway".
const NEXT_KEY = "sc_next";
const NEXT_MAX = 256;

// Path: starts with a letter or digit, then only the characters a static
// site's file paths are made of, and ends in .html.
const NEXT_PATH = /^[A-Za-z0-9][A-Za-z0-9._\-/]*\.html$/;
// Query and fragment: deliberately narrower than the RFC allows. These carry
// tab ids and anchors on this site, nothing that needs punctuation.
const NEXT_QUERY = /^[A-Za-z0-9._\-~=&+]*$/;
const NEXT_HASH = /^[A-Za-z0-9._\-~]*$/;

export function safeNextPath(value) {
  if (typeof value !== "string") return null;
  if (!value || value.length > NEXT_MAX) return null;

  // Anything outside printable ASCII, and every space-like character in it.
  if (/[^\x21-\x7e]/.test(value)) return null;
  if (value.indexOf(":") !== -1) return null;
  if (value.indexOf("%") !== -1) return null;
  if (value.indexOf("\\") !== -1) return null;

  // A single leading slash is forgiven — it still names a path on this origin,
  // and it is the likeliest honest mistake for the caller building these links
  // to make. Two is not: that is another host.
  let path = value;
  if (path.charAt(0) === "/") {
    if (path.charAt(1) === "/") return null;
    path = path.slice(1);
  }

  // Split off the fragment first, then the query — the same order a browser
  // does, so "a.html#x?y" is a fragment containing "?y" rather than a query.
  let hash = "";
  const hashAt = path.indexOf("#");
  if (hashAt !== -1) {
    hash = path.slice(hashAt + 1);
    path = path.slice(0, hashAt);
  }
  let query = "";
  const queryAt = path.indexOf("?");
  if (queryAt !== -1) {
    query = path.slice(queryAt + 1);
    path = path.slice(0, queryAt);
  }

  if (!NEXT_PATH.test(path)) return null;
  // No traversal. The regex above already forbids a leading dot, but not
  // "app/../../x.html".
  if (path.split("/").some((seg) => seg === "." || seg === "..")) return null;
  if (!NEXT_QUERY.test(query)) return null;
  if (!NEXT_HASH.test(hash)) return null;

  return path + (query ? "?" + query : "") + (hash ? "#" + hash : "");
}

// Read `next` off a location's query string and keep it for later, in
// sessionStorage rather than in a variable or in the URL.
//
// It has to survive a full page load in the same tab, because the OAuth
// providers bounce through their own domain and come back to a fresh
// login.html — and `loginCallbackUrl()` above is registered with Supabase and
// with three identity providers as an exact string, so it cannot carry the
// value round the trip itself. sessionStorage is the right scope: per tab, so
// two tabs mid-sign-in don't steal each other's destination, and gone when the
// tab closes rather than waiting to surprise somebody next week.
//
// An invalid value is dropped silently. There is no useful thing to tell
// somebody who did not construct that URL themselves, and telling the person
// who *did* construct it what the filter rejected is only helping them tune it.
export function stashNextPath(search) {
  let raw = null;
  try {
    raw = new URLSearchParams(search || "").get("next");
  } catch (err) {
    return null;
  }
  const safe = safeNextPath(raw);
  if (!safe) return null;
  try { window.sessionStorage.setItem(NEXT_KEY, safe); } catch (err) {}
  return safe;
}

// Consume it. Re-validated on the way out as well as on the way in: what comes
// back from sessionStorage is not necessarily what this file put there — any
// script on this origin can write that key — and the cost of checking twice is
// a regex.
export function takeNextPath() {
  let stored = null;
  try {
    stored = window.sessionStorage.getItem(NEXT_KEY);
    window.sessionStorage.removeItem(NEXT_KEY);
  } catch (err) {
    return null;
  }
  return safeNextPath(stored);
}

// Look without consuming — for a page that is only passing through, like
// onboarding, and must leave the destination intact for whoever lands last.
export function peekNextPath() {
  try {
    return safeNextPath(window.sessionStorage.getItem(NEXT_KEY));
  } catch (err) {
    return null;
  }
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

// Which of this session's linked providers actually handed us a photo.
//
// syncAvatar above only ever fires once, on a profile that has no avatar yet,
// and only for whoever signed in — so a member who signed up by email and
// later linked Google has no route to that picture at all. The avatar control
// offers it as an explicit choice instead, and offers it only when it is
// really there: a "Use my Microsoft photo" button that 404s is worse than no
// button, and Azure's OIDC response frequently carries no picture claim.
//
// `identity_data` is read per identity rather than from user_metadata,
// because user_metadata holds one picture — whichever provider signed in most
// recently — while a member with both Google and Microsoft linked has two.
// The single-identity case falls back to user_metadata, which is where older
// sessions kept it.
//
// `source` is the vocabulary generate-avatar accepts (upload | google |
// microsoft | linkedin), not Supabase's provider id, so 'azure' has to be
// translated here or the function rejects the request as an unknown source.
const PHOTO_PROVIDERS = {
  google: { label: "Google", source: "google" },
  azure: { label: "Microsoft", source: "microsoft" },
  linkedin_oidc: { label: "LinkedIn", source: "linkedin" },
};

export function sessionPhotoProviders(session) {
  if (!session || !session.user) return [];
  const meta = session.user.user_metadata || {};
  const identities = Array.isArray(session.user.identities) ? session.user.identities : [];
  const metaUrl = meta.avatar_url || meta.picture || "";
  const seen = {};
  const out = [];

  identities.forEach((identity) => {
    const provider = identity && identity.provider;
    const known = PHOTO_PROVIDERS[provider];
    if (!known || seen[provider]) return;
    const data = (identity && identity.identity_data) || {};
    const url = data.avatar_url || data.picture ||
      (identities.length === 1 ? metaUrl : "");
    if (!url) return;
    seen[provider] = true;
    out.push({ provider, label: known.label, source: known.source, url });
  });

  return out;
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
