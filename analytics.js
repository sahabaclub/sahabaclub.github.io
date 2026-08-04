// Google Analytics 4 — public pages only, and only after somebody says yes.
// ============================================================================
//
// WHAT THIS FILE IS FOR. Counting visits to the pages anybody can reach:
// index, events, hackathons, podcast, membership, privacy and login. It sends
// page views and nothing else.
//
// ⚠ NEVER ADD THIS SCRIPT TO ANYTHING UNDER app/.
//
//   app/dashboard.html, app/profile.html, app/connect.html, app/member.html,
//   app/inbox.html, app/promptarena.html and everything in app/admin/ are
//   behind a login, and their URLs and titles describe REAL NAMED PEOPLE —
//   which member you opened, which hackathon placing they got, which
//   conversation you are reading. A page path like /app/member.html is
//   already a statement about a person once you know who was signed in, and
//   GA4 collects the page path by default. Member behaviour stays in the
//   club's own database, where the privacy page says it stays. It does not go
//   to Google. This is a decision, not an oversight, and it is written here so
//   that the next person adding a page knows which side of the line it is on:
//   if a visitor has to sign in to see it, it does not get this script.
//
// THE MEASUREMENT ID IS THE ONLY THING TO EDIT, and it is now set. It is the
// constant directly below, with a note on why it sits in a public file rather
// than a secret store.
//
// If it is ever emptied — a fork, a clone, a property that gets deleted — the
// whole file goes inert: no script is fetched, no cookie is set, no dataLayer
// is created, no banner is drawn and nothing is logged. That branch is kept
// and tested on purpose. A consent banner asking permission for tracking that
// cannot happen is worse than no banner at all, so a half-configured deploy
// shows nobody a prompt.
//
// HOW CONSENT WORKS HERE. The gtag.js request itself does not happen until the
// choice is "granted". This is not "load it and then respect a flag" — nothing
// reaches Google until somebody has pressed Yes. Accept and decline are the
// same size, the same weight and the same colour; the only difference between
// them is the word on them. A decline is remembered, so the banner is not
// re-asked on the next page. Do Not Track and Global Privacy Control count as
// a decline that was already given, so those visitors are never asked either.
//
// WHAT IS DELIBERATELY NOT SENT. The URL is cut at the first `?` or `#` before
// it is handed over. login.html can carry `?next=`, and an OAuth failure or an
// implicit-flow token comes back in the fragment — `#error_description=...`,
// `#access_token=...`. GA4's default `page_location` is the FULL href, so
// leaving the default in place would ship those to Google. The cost of cutting
// is real and worth knowing: utm_* campaign tags and gclid live in the query
// string too, so campaign attribution is given up along with the tokens. That
// is the right trade for a first install; an allowlist that keeps utm_* and
// drops everything else is the obvious later refinement.
//
// Nothing from a form field is ever sent — no email, no name, no member id.
// GA4's terms prohibit sending personally identifiable information, and this
// project prohibits it independently of that.

(function () {
  "use strict";

  // ==========================================================================
  //  ▼▼▼  PASTE THE GA4 MEASUREMENT ID HERE AND NOWHERE ELSE  ▼▼▼
  //
  //  Google Analytics → Admin → Data streams → your web stream → top right.
  //  It looks like "G-ABCD123456". Keep the quotes.
  //
  //  Set it back to "" and the site behaves exactly as it did before this file
  //  existed: no banner, no cookie, no request. That is the correct state for
  //  a fork or a half-configured deploy, and the tests still cover it.
  //
  //  THIS IS NOT A SECRET, and the next person will wonder, so: a GA4
  //  measurement id is served in the page source to every visitor by design —
  //  it is how the tag knows which property to report to, and anybody can read
  //  it with View Source on any site that uses Analytics. It is an address,
  //  not a key; it grants nothing. Putting it in an environment variable or a
  //  secret store would be indirection that implies a confidentiality it does
  //  not have and cannot have, so it lives here, in the committed file, in
  //  plain sight. (What IS worth guarding is access to the property itself, in
  //  the Google Analytics account — that is a login, and it is not here.)
  // ==========================================================================
  var GA_MEASUREMENT_ID = "G-34MFEPNDJH";
  // ==========================================================================
  //  ▲▲▲  PASTE THE GA4 MEASUREMENT ID HERE AND NOWHERE ELSE  ▲▲▲
  // ==========================================================================

  // localStorage, not a cookie. A cookie whose job is to record that you may
  // not have cookies is absurd, and this is a static site — there is no server
  // that could read one anyway.
  var STORAGE_KEY = "sc_analytics_consent";
  var GRANTED = "granted";
  var DENIED = "denied";

  var PRIVACY_HREF = "privacy.html#analytics";

  var banner = null;      // the banner element while it is on screen
  var started = false;    // has gtag.js actually been injected

  // --------------------------------------------------------------------------
  // Is there anything to consent to at all
  // --------------------------------------------------------------------------
  // A real GA4 id is "G-" and then ten upper-case alphanumerics. The second
  // test rejects the shape of the placeholder people paste out of a tutorial
  // ("G-XXXXXXXXXX"), which would otherwise pass the first and quietly fire
  // requests at a property that does not exist.
  function idIsUsable() {
    if (typeof GA_MEASUREMENT_ID !== "string") return false;
    if (!/^G-[A-Z0-9]{4,20}$/.test(GA_MEASUREMENT_ID)) return false;
    if (/^G-X+$/.test(GA_MEASUREMENT_ID)) return false;
    return true;
  }

  // --------------------------------------------------------------------------
  // A browser that has already answered
  // --------------------------------------------------------------------------
  // Global Privacy Control and Do Not Track are a stated preference. Treating
  // them as a decline is the whole point of them; showing a banner to somebody
  // who has already said no in their browser settings is asking a question
  // that was answered before the page loaded.
  function privacySignal() {
    try {
      if (navigator.globalPrivacyControl === true) return true;
      if (window.globalPrivacyControl === true) return true;
      var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
      if (dnt === "1" || dnt === "yes" || dnt === 1 || dnt === true) return true;
    } catch (e) {
      // A browser that throws on reading these is not one that is asking to be
      // tracked either, but it has not asked not to be, so fall through.
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // The remembered choice
  // --------------------------------------------------------------------------
  // Every access is wrapped: Safari in private mode and a locked-down
  // enterprise profile both throw on localStorage rather than returning null.
  // A storage failure must land on "we have no consent", never on "assume yes".
  function readChoice() {
    try {
      var v = window.localStorage.getItem(STORAGE_KEY);
      return v === GRANTED || v === DENIED ? v : null;
    } catch (e) {
      return null;
    }
  }

  function writeChoice(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch (e) {
      // Cannot remember it. The visit still honours what they just pressed;
      // they will simply be asked again next time, which is the safe way for
      // this to fail.
    }
  }

  function clearChoice() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
  }

  // The one string that describes where we stand. Used by the privacy page's
  // status line and by the tests.
  //   "off"      — no measurement id, so nothing can happen
  //   "signal"   — the browser sends DNT/GPC, so it is a no and we do not ask
  //   "granted"  — they said yes
  //   "denied"   — they said no
  //   "ask"      — nobody has answered yet
  function state() {
    if (!idIsUsable()) return "off";
    if (privacySignal()) return "signal";
    var choice = readChoice();
    if (choice === GRANTED) return "granted";
    if (choice === DENIED) return "denied";
    return "ask";
  }

  // --------------------------------------------------------------------------
  // The URL, with everything page-specific cut off
  // --------------------------------------------------------------------------
  // Origin and path only. `?next=`, `#error_description=`, `#access_token=`,
  // a member id somebody pasted — all of it goes, without needing a list of
  // what to remove, because the list of what to KEEP is the short one.
  function cleanUrl(href) {
    if (!href) return "";
    try {
      var u = new URL(href, window.location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return u.origin + u.pathname;
    } catch (e) {
      return String(href).split("#")[0].split("?")[0];
    }
  }

  // The page’s own origin, derived from the URL rather than read from
  // location.origin — one source of truth with cleanUrl above, and a value
  // this file computes rather than one it hopes the host object provides.
  function pageOrigin() {
    try {
      return new URL(window.location.href).origin;
    } catch (e) {
      return "";
    }
  }

  // A referrer that is one of OUR OWN signed-in pages is dropped entirely.
  //
  // Excluding app/ from the script is only half of keeping member behaviour
  // out of Google. The other half is this: follow a link from app/inbox.html
  // or app/member.html to the privacy page — which members do, it is linked
  // from the footer of every page — and the referrer says where they just
  // were. "This visitor was reading a member profile" is exactly the fact the
  // app/ exclusion exists to not send, and it would have arrived by the back
  // door. Any path with an `app` segment reports no referrer at all.
  function cleanReferrer(href) {
    var clean = cleanUrl(href);
    if (!clean) return "";
    try {
      var u = new URL(clean);
      if (u.origin === pageOrigin() &&
          u.pathname.split("/").indexOf("app") !== -1) return "";
    } catch (e) {
      return "";
    }
    return clean;
  }

  // --------------------------------------------------------------------------
  // Starting it
  // --------------------------------------------------------------------------
  function startAnalytics() {
    if (started || !idIsUsable()) return;
    started = true;

    window["ga-disable-" + GA_MEASUREMENT_ID] = false;

    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = window.gtag || gtag;

    // Said before anything else is queued. Analytics storage is granted
    // because that is exactly what was just agreed to; the advertising
    // categories are denied outright and are not offered as an option
    // anywhere, because this install does not do advertising.
    gtag("consent", "default", {
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      analytics_storage: "granted"
    });

    gtag("js", new Date());
    gtag("config", GA_MEASUREMENT_ID, {
      // The scrubbed URL, replacing GA4's default of the full href. Passed in
      // the config call so that the automatic page_view carries it too.
      page_location: cleanUrl(window.location.href),
      page_referrer: cleanReferrer(document.referrer),
      // Google Signals is cross-device tracking against a signed-in Google
      // account. Off.
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      send_page_view: true
    });

    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(GA_MEASUREMENT_ID);
    s.setAttribute("data-ga-script", "");
    document.head.appendChild(s);
  }

  // --------------------------------------------------------------------------
  // Stopping it, on this page, now, without a reload
  // --------------------------------------------------------------------------
  // `window['ga-disable-<ID>'] = true` is gtag.js's own documented kill switch
  // and it is checked before each hit, so an already-loaded tag stops sending.
  // The script element cannot be un-run, so it is left where it is rather than
  // removed to give a misleading impression that it was undone.
  function stopAnalytics() {
    if (!idIsUsable()) return;
    window["ga-disable-" + GA_MEASUREMENT_ID] = true;
    try {
      if (typeof window.gtag === "function") {
        window.gtag("consent", "update", {
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          analytics_storage: "denied"
        });
      }
    } catch (e) {}
    clearGaCookies();
  }

  // Best effort, and the limit is worth being honest about: a cookie can only
  // be expired from a page that could have set it, so `_ga` on the registrable
  // domain is reachable from here and one set on a domain this page does not
  // control is not. The browser's own site-data controls are the complete
  // answer; this is the part the page can do.
  function clearGaCookies() {
    var names = [];
    var all = "";
    try { all = document.cookie || ""; } catch (e) { return; }
    all.split(";").forEach(function (pair) {
      var name = pair.split("=")[0].trim();
      if (name.indexOf("_ga") === 0) names.push(name);
    });
    if (!names.length) return;

    var host = window.location.hostname || "";
    var parts = host.split(".");
    var domains = [""];
    for (var i = 0; i < parts.length - 1; i++) {
      domains.push(parts.slice(i).join("."));
      domains.push("." + parts.slice(i).join("."));
    }
    names.forEach(function (name) {
      domains.forEach(function (domain) {
        try {
          document.cookie = name + "=; Max-Age=0; path=/" +
            (domain ? "; domain=" + domain : "");
        } catch (e) {}
      });
    });
  }

  // --------------------------------------------------------------------------
  // The banner
  // --------------------------------------------------------------------------
  // Deliberately NOT a dialog. It does not trap focus, it does not dim the
  // page and it does not have to be answered before the site can be used —
  // it is a bar at the bottom, and the page behind it stays fully usable.
  // Because it is position: fixed, adding it moves nothing on the page.
  //
  // It is inserted as the FIRST child of <body> so that a keyboard user's next
  // Tab reaches it rather than having to cross the whole page first, and its
  // content is filled in one tick later so that screen readers see a live
  // region change and announce it politely instead of it arriving silently.
  function showBanner() {
    if (banner || !document.body) return;

    var wrap = document.createElement("div");
    wrap.className = "ga-consent";
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Analytics choice");
    wrap.setAttribute("aria-live", "polite");
    wrap.setAttribute("data-ga-banner", "");
    document.body.insertBefore(wrap, document.body.firstChild);
    banner = wrap;

    var fill = function () {
      if (!banner) return;
      var inner = document.createElement("div");
      inner.className = "ga-consent-inner";

      var copy = document.createElement("div");
      copy.className = "ga-consent-copy";

      var title = document.createElement("p");
      title.className = "ga-consent-title";
      title.textContent = "May we count this visit?";
      copy.appendChild(title);

      var text = document.createElement("p");
      text.className = "ga-consent-text";
      text.appendChild(document.createTextNode(
        "We would like to use Google Analytics to see which pages people " +
        "actually read. It records the page and sets cookies. It never runs " +
        "on the signed-in member pages, and we never send it your name or " +
        "email. Say no and nothing loads. "
      ));
      var link = document.createElement("a");
      link.className = "ga-consent-link";
      link.href = PRIVACY_HREF;
      link.textContent = "What it records";
      text.appendChild(link);
      copy.appendChild(text);

      var actions = document.createElement("div");
      actions.className = "ga-consent-actions";

      var yes = document.createElement("button");
      yes.type = "button";
      yes.className = "ga-consent-btn";
      yes.setAttribute("data-ga-accept", "");
      yes.textContent = "Yes, count it";
      yes.addEventListener("click", accept);

      var no = document.createElement("button");
      no.type = "button";
      no.className = "ga-consent-btn";
      no.setAttribute("data-ga-decline", "");
      no.textContent = "No, thank you";
      no.addEventListener("click", decline);

      // Order in the DOM is order for a keyboard and a screen reader. Yes
      // first only because it is the question's own order; both buttons are
      // the same element with the same class and the same styling, so neither
      // is the "obvious" one to press.
      actions.appendChild(yes);
      actions.appendChild(no);

      inner.appendChild(copy);
      inner.appendChild(actions);
      banner.appendChild(inner);
    };

    if (window.requestAnimationFrame) window.requestAnimationFrame(fill);
    else window.setTimeout(fill, 0);
  }

  function hideBanner() {
    if (!banner) return;
    if (banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  // --------------------------------------------------------------------------
  // The three things a person can do
  // --------------------------------------------------------------------------
  function accept() {
    writeChoice(GRANTED);
    hideBanner();
    paintPrivacyPage();
    startAnalytics();
  }

  function decline() {
    writeChoice(DENIED);
    hideBanner();
    paintPrivacyPage();
    stopAnalytics();
  }

  // The withdrawal. Clears the remembered choice, stops the tag that is
  // already running on this page — no reload needed — and puts the question
  // back so the answer can be given again.
  function withdraw() {
    clearChoice();
    stopAnalytics();
    paintPrivacyPage();
    if (state() === "ask") showBanner();
  }

  // --------------------------------------------------------------------------
  // The privacy page's own controls
  // --------------------------------------------------------------------------
  // privacy.html carries two blocks, `data-ga-when="off"` and
  // `data-ga-when="on"`. Which one is true depends on whether a measurement id
  // has been pasted in above, so the page cannot know it from markup alone and
  // this decides it. The consequence worth noticing: with JavaScript turned
  // off the "off" block is the one that shows, and that is CORRECT — with
  // JavaScript off no analytics can load either.
  function paintPrivacyPage() {
    var on = idIsUsable();
    var blocks = document.querySelectorAll("[data-ga-when]");
    for (var i = 0; i < blocks.length; i++) {
      var want = blocks[i].getAttribute("data-ga-when");
      var show = want === (on ? "on" : "off");
      blocks[i].hidden = !show;
    }
    var line = document.querySelector("[data-ga-status]");
    if (line) line.textContent = statusSentence();
  }

  function statusSentence() {
    switch (state()) {
      case "off":
        return "Analytics is not switched on, so nothing is being recorded.";
      case "signal":
        return "Your browser sends a Do Not Track or Global Privacy Control " +
               "signal. We treat that as a no, so analytics never loads and " +
               "you are never asked.";
      case "granted":
        return "You agreed to analytics on this browser.";
      case "denied":
        return "You said no to analytics on this browser. Nothing is loaded.";
      default:
        return "You have not answered yet. The question is at the bottom of the page.";
    }
  }

  // --------------------------------------------------------------------------
  // Start
  // --------------------------------------------------------------------------
  function boot() {
    // Bound before the early return, so the privacy page's control is live in
    // every state — including the state where there is nothing to withdraw.
    var withdrawers = document.querySelectorAll("[data-ga-withdraw]");
    for (var i = 0; i < withdrawers.length; i++) {
      withdrawers[i].addEventListener("click", function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        withdraw();
      });
    }
    paintPrivacyPage();

    // A small surface for the console and for the test harness. It carries no
    // data — only the four verbs and the state name.
    window.scAnalytics = {
      state: state,
      accept: accept,
      decline: decline,
      withdraw: withdraw
    };

    var now = state();
    if (now === "granted") startAnalytics();
    else if (now === "ask") showBanner();
    // "off", "signal" and "denied" all mean: do nothing, say nothing.
  }

  boot();
})();
