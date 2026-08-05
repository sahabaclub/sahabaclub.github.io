// Sahaba Club — service worker
// ------------------------------------------------------------
// This exists for ONE reason: to receive web push. That is the whole job.
//
// ============================================================
// ⚠ THERE IS DELIBERATELY NO `fetch` HANDLER, AND ADDING ONE IS DANGEROUS
// ============================================================
//
// The moment a service worker handles `fetch`, it decides what every page,
// script and stylesheet on this origin resolves to — for every visitor, on
// every visit, until it is replaced. The obvious next step ("while we're here,
// let's cache for offline") would mean:
//
//   * A member could be served a cached `app/dashboard.html` from weeks ago,
//     querying columns a migration has since renamed, with no way to tell that
//     is what happened. The page would look fine and be wrong.
//   * This site deploys by pushing to `main` and letting GitHub Pages rebuild.
//     A stale-serving worker breaks the one deploy mechanism the project has.
//   * A worker that caches badly is unusually hard to undo: it is already
//     installed in browsers you cannot reach, and the fix has to arrive
//     through the same worker that is broken.
//
// So: no `fetch` handler, no caches, no `skipWaiting` races over page content.
// If offline support is ever wanted it should be its own decision, taken
// deliberately, with a cache-busting story written down first.
//
// Registered by lib/push.js, from the site root so its scope covers the whole
// origin — a worker at /app/sw.js could not receive push for a member sitting
// on the homepage.

// A fresh worker takes over immediately rather than waiting for every tab to
// close. Safe here precisely BECAUSE this worker does not serve content: the
// only thing that changes is which code handles the next push.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

var FALLBACK_TITLE = "Sahaba Club";

// The existing 512×512 app icon, which browsers scale down themselves. Checked
// rather than assumed: assets/icon-512.png is real and is 512×512.
//
// ⚠ There is deliberately no `badge`. A badge is the small monochrome glyph
// Android puts in the status bar, and it is MASKED to a silhouette — pointing
// it at a full-colour logo produces a grey blob. Omitting it gives the
// browser's own default, which is worse than a purpose-made badge and much
// better than a smudge. If one is wanted later it needs to be drawn for the
// job: single colour, transparent background, 96×96.
var ICON = "/assets/icon-512.png";

// ---- Receiving a push ---------------------------------------------------

self.addEventListener("push", function (event) {
  var payload = {};

  // ⚠ The payload is whatever arrived over the wire. Parse defensively: a
  // malformed one must still produce a notification, because the browser
  // penalises a push that resolves without showing anything — some show a
  // generic "This site has been updated in the background" instead, which is
  // worse than our own fallback.
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {};
  }

  var title = typeof payload.title === "string" && payload.title.trim()
    ? payload.title.trim()
    : FALLBACK_TITLE;

  var options = {
    body: typeof payload.body === "string" ? payload.body : "",
    icon: ICON,
    // Same tag replaces an existing notification rather than stacking. The
    // sender uses the notification's dedupe key, so six messages in one
    // conversation do not become six banners.
    tag: typeof payload.tag === "string" && payload.tag ? payload.tag : "sahaba-club",
    renotify: false,
    // Never silently steal focus or vibrate for something that is, at most, a
    // club announcement.
    requireInteraction: false,
    data: {
      // ⚠ Site-relative only. The database CHECK on notifications.href already
      // enforces one leading slash, but a push payload arrives over the
      // network and this worker is the last thing between it and a click.
      // Anything else is discarded and the click just opens the dashboard.
      href: sanitisePath(payload.href),
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// A path on this origin, or null. Rejects absolute URLs, protocol-relative
// "//evil.example", and anything that is not a plain path — so a tampered or
// mis-built payload cannot turn a club notification into a link off-site.
function sanitisePath(value) {
  if (typeof value !== "string") return null;
  var v = value.trim();
  if (!v) return null;
  if (v.charAt(0) !== "/") return null;
  if (v.charAt(1) === "/") return null;
  if (v.indexOf("\\") !== -1) return null;
  return v;
}

// ---- Clicking one -------------------------------------------------------

self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  var path = sanitisePath(event.notification.data && event.notification.data.href)
    || "/app/dashboard.html#notifications";
  var target = new URL(path, self.location.origin).href;

  // Prefer an existing tab over opening a fourth copy of the site. Matching on
  // origin rather than on exact URL: a member with the dashboard already open
  // should have that tab brought forward and navigated, not a new one spawned
  // beside it.
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (windowClients) {
        for (var i = 0; i < windowClients.length; i++) {
          var client = windowClients[i];
          if (client.url.indexOf(self.location.origin) === 0 && "focus" in client) {
            if ("navigate" in client) {
              return client.navigate(target).then(function (c) {
                return c && c.focus ? c.focus() : undefined;
              });
            }
            return client.focus();
          }
        }
        return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
      })
      .catch(function () {
        // A failed focus must not leave the click doing nothing at all.
        return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
      })
  );
});

// ---- The subscription rotating underneath us ----------------------------
//
// Push services rotate endpoints. When that happens the browser fires this and
// the OLD subscription stops working — so without handling it, push quietly
// dies for that member and nothing anywhere says so.
//
// ⚠ This worker cannot write to the database: it has no Supabase session,
// because the auth token lives in localStorage and a service worker cannot
// read it. So it re-subscribes with the same application server key and leaves
// a marker; lib/push.js reconciles on the member's next visit. That means a
// rotation costs one missed window rather than a silent permanent failure.
self.addEventListener("pushsubscriptionchange", function (event) {
  event.waitUntil(
    (function () {
      var oldSub = event.oldSubscription || null;
      var key = oldSub && oldSub.options && oldSub.options.applicationServerKey;
      if (!key) return Promise.resolve();

      return self.registration.pushManager
        .subscribe({ userVisibleOnly: true, applicationServerKey: key })
        .then(function () {
          // Tell any open tab so it can persist the new endpoint immediately.
          return self.clients.matchAll({ type: "window", includeUncontrolled: true });
        })
        .then(function (windowClients) {
          windowClients.forEach(function (c) {
            c.postMessage({ type: "sc-push-resubscribed" });
          });
        })
        .catch(function () {
          // Nothing useful to do from here. The reconcile on next visit in
          // lib/push.js is the backstop.
        });
    })()
  );
});
