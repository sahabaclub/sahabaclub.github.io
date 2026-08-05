// Sahaba Club — web push
// ------------------------------------------------------------
// The browser half of phase 2. Registers the service worker, asks for
// permission, and keeps `push_subscriptions` in step with what the browser
// actually holds.
//
// ⚠ TEMPORAL DEAD ZONE — every module-level binding is declared at the top,
// before the first executing statement, and there is no top-level await in
// this file. See lib/notifications.js for the afternoon that bought the rule.
//
// ⚠ NOTHING HERE IS A SECURITY BOUNDARY. `push_subscriptions` is own-row RLS
// with no staff policy (0047), so a member who tampers with this file can
// break their own notifications and reach nobody else's.

import { supabase } from "./supabase-client.js";

// ============================================================
// ⚠ PASTE THE VAPID PUBLIC KEY HERE — see tools/generate-vapid-keys.mjs
// ============================================================
//
// This value is PUBLIC by design: it ships to every browser, and it is how a
// browser knows which server is allowed to push to it. The matching PRIVATE
// key belongs in Supabase secrets and must never appear in this repo.
//
// Left empty on purpose rather than filled with a plausible-looking dummy.
// An empty string makes `isPushConfigured()` false and every entry point below
// return a clear "not set up yet"; a dummy would produce a browser exception
// with a vague message at subscribe time, which is much harder to diagnose.
//
// ⚠ Replacing this value later invalidates every existing subscription —
// browsers bind a subscription to the key that created it. Generate once.
const VAPID_PUBLIC_KEY = "";

// Matches what tools/generate-vapid-keys.mjs emits: base64url of the 65-byte
// uncompressed EC point.
const VAPID_KEY_LENGTH = 87;

const SW_PATH = "/sw.js";
const SW_SCOPE = "/";

// Reasons push cannot work here, as stable codes the UI turns into sentences.
export const UNSUPPORTED = "unsupported";
export const NEEDS_INSTALL = "needs-install";
export const NOT_CONFIGURED = "not-configured";
export const DENIED = "denied";

let registration = null;

// ---- What this browser can do -------------------------------------------

export function isPushConfigured() {
  return typeof VAPID_PUBLIC_KEY === "string" && VAPID_PUBLIC_KEY.length === VAPID_KEY_LENGTH;
}

function hasApis() {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

// ⚠ iOS is the case that makes this function necessary rather than a
// formality. Safari on iPhone and iPad exposes ServiceWorker and PushManager
// in an ordinary tab, so every capability check PASSES — and then
// `subscribe()` rejects, or resolves and never delivers anything. Push is only
// actually available once the site has been added to the Home Screen and is
// running standalone.
//
// Detecting it is worth the ugliness: the alternative is a member tapping
// "Turn on notifications", being told it worked, and never receiving one.
function isIos() {
  var ua = navigator.userAgent || "";
  // iPadOS 13+ reports itself as a Mac; the touch-point count is what separates
  // an iPad from a desktop Safari.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return (
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    navigator.standalone === true
  );
}

// Why push is unavailable, or null when it is available. The UI shows the
// reason rather than hiding the control, because "the button isn't there" is
// indistinguishable from "the page is broken".
export function pushUnavailableReason() {
  if (!hasApis()) return UNSUPPORTED;
  if (isIos() && !isStandalone()) return NEEDS_INSTALL;
  if (!isPushConfigured()) return NOT_CONFIGURED;
  if (Notification.permission === "denied") return DENIED;
  return null;
}

export function permissionState() {
  return hasApis() ? Notification.permission : "unsupported";
}

// ---- Key encoding -------------------------------------------------------

// applicationServerKey wants raw bytes, not the base64url string.
function urlBase64ToUint8Array(base64String) {
  var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  var raw = window.atob(base64);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bufferToBase64Url(buffer) {
  var bytes = new Uint8Array(buffer);
  var binary = "";
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return window
    .btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---- Service worker -----------------------------------------------------

export async function ensureServiceWorker() {
  if (!hasApis()) return null;
  if (registration) return registration;
  try {
    registration = await navigator.serviceWorker.register(SW_PATH, { scope: SW_SCOPE });
    // `register` resolves before the worker is usable for subscribing.
    await navigator.serviceWorker.ready;
    return registration;
  } catch (e) {
    registration = null;
    return null;
  }
}

// ---- Saving ---------------------------------------------------------------

function describeBrowser() {
  // A label a member can recognise in Settings, not a fingerprint. Truncated
  // to fit the CHECK in 0047 and to avoid storing a full UA string.
  var ua = navigator.userAgent || "";
  var browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  var platform = /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Windows/.test(ua) ? "Windows"
    : /Macintosh/.test(ua) ? "Mac"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return (browser + (platform ? " on " + platform : "")).slice(0, 300);
}

async function saveSubscription(subscription) {
  var json = subscription.toJSON ? subscription.toJSON() : null;
  var p256dh = json && json.keys ? json.keys.p256dh : bufferToBase64Url(subscription.getKey("p256dh"));
  var auth = json && json.keys ? json.keys.auth : bufferToBase64Url(subscription.getKey("auth"));
  if (!subscription.endpoint || !p256dh || !auth) return false;

  // Upsert on `endpoint`, which is unique globally in 0047. The same browser
  // re-subscribing must REFRESH its row rather than fail on the unique
  // constraint — and if that browser is now signed in as somebody else, the
  // row has to move to them, which is exactly what an upsert on endpoint does.
  // `user_id` is left out: it defaults to auth.uid() and RLS decides.
  var { error } = await supabase
    .from("push_subscriptions")
    .upsert(
      {
        endpoint: subscription.endpoint,
        p256dh: p256dh,
        auth: auth,
        user_agent: describeBrowser(),
      },
      { onConflict: "endpoint" }
    );

  return !error;
}

// ---- Turning it on and off ----------------------------------------------

// Returns true when the member is subscribed afterwards. Never throws — every
// failure path returns false and the caller shows the reason from
// pushUnavailableReason() or permissionState().
export async function enablePush() {
  if (pushUnavailableReason()) return false;

  var reg = await ensureServiceWorker();
  if (!reg) return false;

  // ⚠ Must be called from a user gesture. Chrome and Safari both refuse a
  // permission prompt that was not triggered by a click, and the refusal looks
  // like the member saying no. The Settings button is the gesture.
  var permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  try {
    var existing = await reg.pushManager.getSubscription();
    var subscription = existing;

    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        // Required to be true by every browser: a push must result in a
        // visible notification. We could not send a silent one even if we
        // wanted to, which is the right constraint.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    return await saveSubscription(subscription);
  } catch (e) {
    return false;
  }
}

export async function disablePush() {
  var reg = await ensureServiceWorker();
  if (!reg) return false;

  try {
    var subscription = await reg.pushManager.getSubscription();
    if (!subscription) return true;

    var endpoint = subscription.endpoint;

    // Delete the row FIRST. If unsubscribing succeeded and the delete then
    // failed, the club would keep pushing to an endpoint the browser has
    // already discarded — which fails silently and inflates failure_count on a
    // row the member believes they removed. This order can only leave the
    // opposite: a live browser subscription with no row, which sends nothing
    // and is repaired by reconcile() on the next visit.
    await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
    await subscription.unsubscribe();
    return true;
  } catch (e) {
    return false;
  }
}

// Is this browser subscribed right now, according to the browser itself?
export async function isSubscribedHere() {
  if (!hasApis() || Notification.permission !== "granted") return false;
  var reg = await ensureServiceWorker();
  if (!reg) return false;
  try {
    return Boolean(await reg.pushManager.getSubscription());
  } catch (e) {
    return false;
  }
}

// How many devices this member has registered. Through the definer function
// from 0047 rather than a count over the rows, because the rows themselves are
// capabilities and there is no reason for a page to hold them.
export async function deviceCount() {
  var { data, error } = await supabase.rpc("my_push_device_count");
  return error ? 0 : Number(data) || 0;
}

// ---- Reconcile ----------------------------------------------------------
//
// The browser and the database drift for reasons neither side controls: a push
// service rotates an endpoint (`pushsubscriptionchange` in sw.js fires with no
// way to reach the database), a member clears site data, a `disablePush` is
// interrupted between its two steps. This is the repair, and it is cheap
// enough to run on any page load where a session exists.
export async function reconcile() {
  if (pushUnavailableReason()) return;
  if (Notification.permission !== "granted") return;

  var reg = await ensureServiceWorker();
  if (!reg) return;

  try {
    var subscription = await reg.pushManager.getSubscription();
    if (!subscription) return;

    // Upsert is idempotent, so this is a no-op when everything already agrees
    // and a repair when it does not. Cheaper than reading first to decide.
    await saveSubscription(subscription);
  } catch (e) {
    // Never let a background repair break the page it is running on.
  }
}

// sw.js posts this after re-subscribing on its own. Persisting immediately
// closes the window where a rotated endpoint is live in the browser and
// unknown to the club.
export function listenForResubscribe() {
  if (!hasApis() || !navigator.serviceWorker) return;
  navigator.serviceWorker.addEventListener("message", function (event) {
    if (event.data && event.data.type === "sc-push-resubscribed") reconcile();
  });
}
