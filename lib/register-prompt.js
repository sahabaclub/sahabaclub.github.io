// ============================================================
// Sahaba Club — "Did you register?" on the way back
// ------------------------------------------------------------
// Shared by the events LIST (events-ui.js) and the event DETAIL
// page (event.html). Both show a Register button, both send the
// member out to somebody else's ticketing site, and both have to
// ask the same question when they come back.
// ============================================================
//
// WHY WE ASK AT ALL. The registration page belongs to the organiser, not to
// us. Nothing reports back, no webhook exists, and there is no honest way to
// observe whether somebody completed a form on another company's site. So the
// only truthful source is the member, and the only moment they will answer is
// the moment they return. Everything below exists because we cannot measure
// the thing we want to know.
//
// ⚠ THIS FILE WAS EXTRACTED, NOT WRITTEN FRESH (13 Aug). The flow lived inline
// in events-ui.js and the detail page had nothing at all — so the same event
// asked the question on one screen and silently dropped it on the other, and
// the detail page is the one that gets shared, so it is the one strangers and
// invitees actually land on. Copying the block would have created the shape
// this project keeps getting caught by: two sides of one rule, drifting apart
// with every edit, and nothing comparing them. There is now one definition and
// `tools/check-register-prompt.mjs` fails if a caller stops using it.
//
// WHAT IS SHARED and what is not: this module owns the pending record, the
// expiry, the dialogs and their copy. It owns no page state. Each caller
// passes handlers for what an answer means to it — the list re-renders a grid
// of cards, the detail page updates one button — because that is the part that
// genuinely differs.

// One key for the whole site, deliberately. A member can press Register on the
// list and come back to the detail page, or the reverse; if each page kept its
// own note, the question would be asked twice or not at all. sessionStorage is
// per-tab, so two tabs cannot tread on each other.
const PENDING_KEY = "sc_pending_registration";

// Older than a couple of hours is not a return from the registration page any
// more, it is a new visit. Asking then is worse than not asking: it is a
// question about something they no longer remember doing.
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// ⚠ Every storage call is wrapped. Private mode and a full quota both throw on
// write, and a browser that cannot take a note is not a reason to fail to open
// the organiser's page — the registration itself still works, we just lose the
// chance to ask about it.
export function rememberPending(eventId, title) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({
      id: eventId,
      title: title,
      at: Date.now()
    }));
  } catch (err) {}
}

export function readPending() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || !p.id) return null;
    if (Date.now() - p.at > MAX_AGE_MS) {
      sessionStorage.removeItem(PENDING_KEY);
      return null;
    }
    return p;
  } catch (err) { return null; }
}

export function clearPending() {
  try { sessionStorage.removeItem(PENDING_KEY); } catch (err) {}
}

// Handlers, all optional:
//   isFavourite(id) -> bool   is this event already saved? decides whether the
//                             second dialog is worth showing at all
//   onRegistered(id)          they said yes
//   onFavourite(id)           they said no, then chose to save it
//   onInterested(id)          they said no and did not save it — a weaker
//                             signal than a favourite, and the recommender
//                             weights it accordingly
export function createRegisterPrompt(handlers) {
  const h = handlers || {};

  function askDialog(html) {
    const back = document.createElement("div");
    back.className = "ev-ask-back";
    back.innerHTML = '<div class="ev-ask" role="dialog" aria-modal="true">' + html + "</div>";
    document.body.appendChild(back);
    return back;
  }

  // ⚠ NEITHER ANSWER IS "CANCEL", and there is no close button, on purpose.
  // Both branches record something true: yes is a registration, no is interest
  // in an event they went and looked at. A dismissable third option would be
  // the one most people press, and it would teach us nothing.
  //
  // ⚠ Known gap, carried over unchanged from the inline version rather than
  // introduced here: the dialog does not move focus into itself and Escape
  // does not close it. It should do both. Fixing it changes the live events
  // page as well as this one, so it is written down instead of smuggled in
  // under a different task.
  function askDidYouRegister(p) {
    const back = askDialog(
      "<h3>Did you register?</h3>" +
      '<p>You opened the registration page for <span class="ev-ask-event">' +
      escapeHtml(p.title) + "</span>.</p>" +
      '<div class="ev-ask-actions">' +
        '<button type="button" class="btn btn-glow" data-yes>Yes, I registered</button>' +
        '<button type="button" class="btn btn-outline" data-no>Not yet</button>' +
      "</div>"
    );

    back.querySelector("[data-yes]").addEventListener("click", function () {
      back.remove();
      clearPending();
      if (h.onRegistered) h.onRegistered(p.id);
    });

    back.querySelector("[data-no]").addEventListener("click", function () {
      back.remove();
      clearPending();
      askAddToFavourites(p);
    });
  }

  function askAddToFavourites(p) {
    // Already saved — offering to save it again is a question with one useless
    // answer, and addFavourite() is a plain insert that would fail on the
    // duplicate anyway.
    if (h.isFavourite && h.isFavourite(p.id)) return;

    const back = askDialog(
      "<h3>Save it for later?</h3>" +
      '<p>We can keep <span class="ev-ask-event">' + escapeHtml(p.title) +
      "</span> in your favourites, and use it to suggest events like it.</p>" +
      '<div class="ev-ask-actions">' +
        '<button type="button" class="btn btn-glow" data-yes>Add to favourites</button>' +
        '<button type="button" class="btn btn-outline" data-no>No thanks</button>' +
      "</div>"
    );

    back.querySelector("[data-yes]").addEventListener("click", function () {
      back.remove();
      if (h.onFavourite) h.onFavourite(p.id);
    });

    back.querySelector("[data-no]").addEventListener("click", function () {
      back.remove();
      if (h.onInterested) h.onInterested(p.id);
    });
  }

  // ⚠ BOTH events are needed and neither is redundant. Returning from a tab
  // fires visibilitychange; returning from another window or app fires focus
  // and may not fire visibilitychange at all. The guard on an already-open
  // dialog is what stops the pair producing two.
  function check() {
    if (document.visibilityState !== "visible") return;
    if (document.querySelector(".ev-ask-back")) return;
    const p = readPending();
    if (p) askDidYouRegister(p);
  }

  function start() {
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
  }

  return { remember: rememberPending, start: start, check: check };
}
