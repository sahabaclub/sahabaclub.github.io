// Back to top
// ------------------------------------------------------------
// Ahmed, 8 Aug 2026: "a widget which you can click and jump to the top of the
// screen, simple and elegant, in the full website."
//
// One file, no dependencies, no stylesheet edit and no markup on any page. It
// injects its own <style> and its own button, so adding it to a page is one
// <script defer> tag — which is what makes "the full website" a change of 31
// lines rather than 31 pages of CSS and HTML kept in step by hand.
//
// ⚠ IT MUST WORK ON THE ADMIN PAGES TOO, and those load a different stylesheet
// with a different set of custom properties. `styles.css` defines --violet /
// --text / --glass-border; `app/admin/admin.css` defines --ad-violet /
// --ad-text / --ad-line. Rather than ship two versions, every colour below is
// a chain of var() fallbacks ending in a literal, so the button takes the
// palette of whichever stylesheet is present and still renders on a page with
// neither.
//
// ============================================================
// Where it sits, and what it must never cover
// ============================================================
//
// The z-index is read off the other layers in styles.css rather than guessed,
// exactly as the consent bar's own comment does:
//
//   header 2 · mobile menu 8/9 · filter dropdowns 119/120
//   → the button must be ABOVE these, or it is unreachable over a sticky bar
//
//   consent bar 180 · podcast modal 200 · hackathon video 240 · lightbox 999
//   → the button must be BELOW these. A floating circle painted over an open
//     dialog is the same mistake as a consent bar painted over one.
//
// 170 satisfies both.
//
// ⚠ Below the consent bar is not enough on its own: that bar is full width at
// bottom:0, so a button at bottom:24px would sit UNDERNEATH it and show as a
// half-circle poking out. The button measures the bar and lifts itself above
// it instead. Measured, not a constant — the bar wraps to two and three lines
// on a phone.
//
// ⚠ And when the page cannot scroll, a scroll-to-top button is noise. Rather
// than enumerate `.menu-open`, `.lightbox-open` and whatever the next modal
// calls itself, it reads the body's COMPUTED overflow. Anything that locks the
// page hides the button, including modals nobody has written yet.

(function () {
  "use strict";

  // Nothing to scroll back to on a page that is one screen tall; the button
  // simply never crosses the threshold, so there is no page to exclude.
  var SHOW_AFTER = 400;

  if (document.getElementById("sc-to-top")) return;

  var style = document.createElement("style");
  style.textContent = [
    "#sc-to-top{",
    "position:fixed;right:20px;bottom:24px;z-index:170;",
    "width:44px;height:44px;padding:0;border-radius:50%;",
    "display:grid;place-items:center;cursor:pointer;",
    // The palette of whichever stylesheet loaded. See the header note.
    "color:var(--text,var(--ad-text,#e9e7f5));",
    "background:var(--glass,var(--ad-panel,rgba(22,20,42,.82)));",
    "border:1px solid var(--glass-border,var(--ad-line,rgba(255,255,255,.14)));",
    "-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);",
    "box-shadow:0 6px 22px rgba(0,0,0,.32);",
    // Hidden state. `visibility` rather than `display` so the fade can run —
    // and unlike opacity alone it also takes the button out of the tab order
    // and off the accessibility tree, so a keyboard user never tabs into an
    // invisible control.
    "opacity:0;visibility:hidden;transform:translateY(8px);",
    "transition:opacity .18s ease,transform .18s ease,visibility 0s linear .18s;",
    "}",
    "#sc-to-top.is-on{opacity:1;visibility:visible;transform:none;transition-delay:0s;}",
    "#sc-to-top:hover{",
    "border-color:var(--violet,var(--ad-violet,#7c5cff));",
    "color:var(--violet,var(--ad-violet,#7c5cff));",
    "transform:translateY(-2px);",
    "}",
    // Keyboard focus must be obvious. :focus-visible so a mouse click does not
    // leave a ring behind.
    "#sc-to-top:focus-visible{",
    "outline:2px solid var(--violet,var(--ad-violet,#7c5cff));outline-offset:3px;",
    "}",
    "#sc-to-top svg{width:19px;height:19px;display:block;}",
    // iOS home-bar clearance, and a little more room on a phone.
    "@media (max-width:720px){#sc-to-top{right:14px;bottom:calc(16px + env(safe-area-inset-bottom,0px));width:42px;height:42px;}}",
    // Both signals, the OS one and the site's own switch in Settings — the
    // same pair events-ui.js and hackathons-ui.js already honour.
    "@media (prefers-reduced-motion:reduce){#sc-to-top{transition:none;}#sc-to-top:hover{transform:none;}}",
    "html.reduce-motion #sc-to-top{transition:none;}",
    "html.reduce-motion #sc-to-top:hover{transform:none;}",
  ].join("");
  document.head.appendChild(style);

  var btn = document.createElement("button");
  btn.id = "sc-to-top";
  btn.type = "button";
  // Not a link to #top: there is no such anchor on most pages, and a link
  // would put a stray "#top" in the address bar and in history.
  btn.setAttribute("aria-label", "Back to top");
  btn.title = "Back to top";
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
  document.body.appendChild(btn);

  function motionIsReduced() {
    var root = document.documentElement;
    if (root && root.classList && root.classList.contains("reduce-motion")) return true;
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function pageIsLocked() {
    // A modal is open and the page is not scrollable. Reading the computed
    // value rather than testing for class names means this keeps working for
    // dialogs that do not exist yet.
    try {
      return getComputedStyle(document.body).overflow === "hidden";
    } catch (e) {
      return false;
    }
  }

  // The consent bar is full width at bottom:0 and its height changes with the
  // viewport, so it is measured every time rather than assumed.
  function liftAboveConsentBar() {
    var bar = document.querySelector(".ga-consent");
    if (!bar) return 0;
    var h = bar.offsetHeight || 0;
    // `.ga-consent:empty` is display:none until it is filled a frame later.
    return h > 0 ? h + 12 : 0;
  }

  var ticking = false;
  function update() {
    ticking = false;
    var show = window.scrollY > SHOW_AFTER && !pageIsLocked();
    btn.classList.toggle("is-on", show);
    if (show) {
      var lift = liftAboveConsentBar();
      btn.style.bottom = lift ? "calc(24px + " + lift + "px)" : "";
    }
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(update);
  }

  btn.addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: motionIsReduced() ? "auto" : "smooth" });

    // ⚠ Moving the viewport is only half of it. A keyboard or screen-reader
    // user who presses this and gets no focus change is still parked at the
    // bottom of the document — the next Tab carries on from the footer, and
    // the jump they just asked for did nothing for them. So focus moves to the
    // top of the page as well.
    //
    // tabindex is added only to make the target focusable and removed straight
    // after, so nothing permanent is left in the tab order.
    var target = document.querySelector("h1, main, header, [role='main']");
    if (!target) return;
    var hadTabIndex = target.hasAttribute("tabindex");
    if (!hadTabIndex) target.setAttribute("tabindex", "-1");
    // preventScroll, or the browser jumps instantly and undoes the smooth
    // scroll that was the point of the button.
    try {
      target.focus({ preventScroll: true });
    } catch (e) {
      target.focus();
    }
    if (!hadTabIndex) {
      target.addEventListener("blur", function handler() {
        target.removeAttribute("tabindex");
        target.removeEventListener("blur", handler);
      });
    }
  });

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  update();
})();
