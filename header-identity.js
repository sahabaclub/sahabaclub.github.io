// Sahaba Club — the member's identity in the header
// ------------------------------------------------------------
// The right-hand slot of the header used to be the dark/light switch. It now
// carries who you are: a circular avatar with your name beside it when you're
// signed in, and the "Join the Club" call to action when you're not. The
// avatar is a plain link straight to the dashboard — not a dropdown, on
// purpose. The theme switch moved to the footer, where it is available to
// signed-out visitors too (see .footer-theme in styles.css).
//
// Loaded as a plain <script> immediately after </header>, deliberately NOT
// type="module" and NOT deferred. Both of those defer execution until after
// the document is parsed, which is late enough for the browser to have
// painted — and what it would have painted is "Join the Club" for a member
// who is already signed in. Running here, synchronously, the header is in the
// DOM and nothing has been painted yet.
//
// Two passes:
//
//   1. Synchronous, from localStorage: is there a Supabase session at all,
//      and what did we last know this member to be called? This is the pass
//      that removes the flash.
//   2. Asynchronous, from Supabase: confirm the session really is live and
//      refresh the name and picture, then write the cache back for next time.
//      This is the pass that makes it true.
//
// Nothing on the page waits for pass 2 — getSession() is a network call, and
// a header is not worth a blank page. With no session, or no Supabase config
// at all, pass 1 does nothing and the markup's own signed-out state stands.
// That is the common case: these are public pages, and most people reading
// them have never signed in.
//
// ---- Why this file also answers "is anyone signed in?" -------------------
//
// The registration gates (the event Register control, Connect, PromptArena)
// need the same answer this file already works out, at the same moment: before
// the first paint. A second mechanism would be a second chance to disagree,
// and the way it would disagree is the expensive way round — a member seeing a
// lock on something they already have. So the answer is published once, as a
// class on <html>, and everything else reads it through CSS:
//
//   html.sc-signed-in    a session is believed to exist
//   html.sc-signed-out   no session
//   neither              this page never loaded this file
//
// One of the two is set by pass 1, synchronously, from the tag that sits
// immediately after </header> — which is before the browser has parsed a
// single gated element, let alone painted one. There is no window in which a
// member's page is laid out under the wrong class.
//
// "Neither" is the ungated state, on purpose: no lock is drawn until
// something says one belongs there. That is safe because these gates are not
// what keeps anyone's data private. Every table and view behind them is
// granted to `authenticated` only with `anon` revoked, so a signed-out
// visitor gets nothing from the database whatever this class says. The gate
// is an invitation; the lock is in Postgres.
(function () {
  "use strict";

  var CACHE_KEY = "sc_identity";
  var SIGNED_IN_CLASS = "sc-signed-in";
  var SIGNED_OUT_CLASS = "sc-signed-out";
  var root = document.documentElement;

  // Where this file is, so the dynamic imports below resolve against it rather
  // than against whichever page pulled it in. app/connect.html and
  // app/promptarena.html load it one directory down, and "./lib/..." read from
  // there would be app/lib/... — a 404, caught silently, leaving pass 2 to
  // never run and pass 1's guess to stand for the whole visit.
  var here = (document.currentScript && document.currentScript.src) || "";
  function moduleUrl(path) {
    return here ? new URL(path, here).toString() : "./" + path;
  }

  // Every element that belongs to one state or the other, header and mobile
  // drawer alike. Marked with data attributes rather than looked up by id,
  // because the drawer and the header both carry a Join affordance and both
  // have to move together. A page with neither — an app page that has no Join
  // CTA to swap — still runs everything else here for the class alone.
  var mes = document.querySelectorAll("[data-identity-me]");

  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function trim(value) { return String(value == null ? "" : value).trim(); }

  function storage() {
    // Safari in private mode, and any browser with storage blocked for this
    // origin, throws on access rather than returning null.
    try { return window.localStorage; } catch (e) { return null; }
  }

  // Supabase persists the session under `sb-<project-ref>-auth-token` and
  // removes that key on sign-out. Matched by shape rather than by a
  // hard-coded project ref, and deliberately never parsed: recent
  // supabase-js versions base64-wrap the value, so its contents are not a
  // format worth reading. Presence alone is the signal, and only as a hint —
  // an expired token still sits in storage, which is exactly what pass 2 is
  // for.
  function hasStoredSession() {
    var ls = storage();
    if (!ls) return false;
    try {
      for (var i = 0; i < ls.length; i++) {
        var key = ls.key(i);
        if (key && /^sb-.+-auth-token$/.test(key) && ls.getItem(key)) return true;
      }
    } catch (e) {}
    return false;
  }

  function readCache() {
    var ls = storage();
    if (!ls) return null;
    try {
      var raw = ls.getItem(CACHE_KEY);
      var value = raw ? JSON.parse(raw) : null;
      return value && typeof value === "object" ? value : null;
    } catch (e) { return null; }
  }

  function writeCache(value) {
    var ls = storage();
    if (!ls) return;
    try {
      if (value) ls.setItem(CACHE_KEY, JSON.stringify(value));
      else ls.removeItem(CACHE_KEY);
    } catch (e) {}
  }

  // What was drawn last, so the second pass can leave the avatar alone when
  // it agrees with the first and no image is re-fetched mid-scroll.
  var painted = null;

  function sameAs(identity) {
    if (!painted || !identity) return false;
    return painted.name === identity.name
      && painted.initial === identity.initial
      && painted.avatar === identity.avatar;
  }

  function paintAvatar(el, identity) {
    el.textContent = "";
    if (identity.avatar) {
      var img = document.createElement("img");
      // Assigned as a property, never interpolated into markup: this URL
      // comes out of the member's own profile row.
      img.src = identity.avatar;
      img.alt = "";
      img.width = 34;
      img.height = 34;
      // A picture that 404s should leave an initial behind, not the browser's
      // broken-image glyph in the middle of the header.
      img.addEventListener("error", function () {
        el.textContent = identity.initial || "";
      });
      el.appendChild(img);
      el.classList.add("has-image");
    } else {
      el.classList.remove("has-image");
      el.textContent = identity.initial || "";
    }
  }

  function render(identity) {
    if (!identity) {
      painted = null;
      root.classList.remove(SIGNED_IN_CLASS);
      root.classList.add(SIGNED_OUT_CLASS);
      return;
    }
    root.classList.remove(SIGNED_OUT_CLASS);
    if (sameAs(identity)) {
      root.classList.add(SIGNED_IN_CLASS);
      return;
    }
    each(mes, function (el) {
      var nameEl = el.querySelector("[data-identity-name]");
      var avatarEl = el.querySelector("[data-identity-avatar]");
      // textContent, never innerHTML. full_name is typed by the member, and
      // this is the one place it reaches a page a stranger can open.
      if (nameEl) nameEl.textContent = identity.name || "";
      if (avatarEl) paintAvatar(avatarEl, identity);
      // The visible name is the accessible name where there is one, so the
      // label a screen reader hears matches the label an eye reads. Without
      // a name the link would otherwise announce as its bare URL.
      el.setAttribute(
        "aria-label",
        identity.name ? identity.name + " — your dashboard" : "Your dashboard"
      );
    });
    painted = identity;
    root.classList.add(SIGNED_IN_CLASS);
  }

  // What we show, in the order we would rather show it.
  //
  // Name: the profile's own full_name first, then whatever the sign-in
  // provider handed over, then the local part of the email address, then the
  // phone number. A member who has given us none of those — a phone-only
  // account that never finished onboarding — is called "Member", because the
  // alternatives are a blank gap in the header or the word "undefined".
  //
  // Picture: profiles.avatar_url and nothing else. Club avatars are generated
  // illustrations, so there is no correct fallback to a real photograph, and
  // the provider's picture claim is not read here even though the session
  // carries one. No avatar means the first letter of the name instead.
  function build(helpers, session, profile) {
    var user = session.user || {};
    var meta = user.user_metadata || {};
    var name =
      trim(profile.full_name) ||
      trim(meta.full_name) ||
      trim(meta.name) ||
      trim(String(user.email || "").split("@")[0]) ||
      trim(user.phone) ||
      "Member";
    return {
      name: name,
      initial: helpers.initialOf(name),
      avatar: helpers.safeUrl(profile.avatar_url) || "",
    };
  }

  // ---- Pass 1: synchronous, before this page paints ---------------------

  if (hasStoredSession()) {
    var cached = readCache();
    // On the very first public page a member opens after signing in there is
    // no cache yet, so this draws an empty ring and no name for the moment it
    // takes pass 2 to answer. That is a partial header, not a wrong one — it
    // never says "Join the Club" to someone who already has.
    render({
      name: (cached && cached.name) || "",
      initial: (cached && cached.initial) || "",
      avatar: (cached && cached.avatar) || "",
    });
  } else {
    // Signed out somewhere else — another tab, or the dashboard. Their name
    // should not be sitting in this browser waiting to be drawn again.
    writeCache(null);
    // Supabase keeps its session in localStorage, so a browser that will not
    // give us localStorage cannot be holding a session either. "No stored
    // token" and "no storage at all" are the same answer here.
    root.classList.add(SIGNED_OUT_CLASS);
  }

  // ---- Pass 2: asynchronous, from Supabase ------------------------------

  Promise.resolve()
    .then(function () { return import(moduleUrl("lib/supabase-client.js")); })
    .then(function (client) {
      // The repo can be published before the Supabase project exists. Without
      // config there is no session to have, so the signed-out header is right.
      if (!client.isConfigured) return null;
      return import(moduleUrl("lib/auth.js"))
        .then(function (auth) { return auth.getSession(); })
        .then(function (session) {
          return session ? { client: client, session: session } : null;
        });
    })
    .then(function (context) {
      if (!context) {
        render(null);
        writeCache(null);
        return null;
      }
      // initialOf and safeUrl come from lib/connect.js rather than being
      // written again here — the rule about what a missing name looks like,
      // and about which URLs are safe to render, belongs in one place.
      return import(moduleUrl("lib/connect.js")).then(function (helpers) {
        return context.client.supabase
          .from("profiles")
          .select("full_name, avatar_url")
          .eq("user_id", context.session.user.id)
          .maybeSingle()
          .then(function (result) {
            var identity = build(helpers, context.session, result.data || {});
            render(identity);
            writeCache(identity);
          });
      });
    })
    .catch(function () {
      // Offline, or the module CDN is unreachable. Pass 1's answer stands: a
      // member keeps their header, a visitor keeps the Join CTA, and nothing
      // throws on a page whose whole job is to be readable by strangers.
    });
})();
