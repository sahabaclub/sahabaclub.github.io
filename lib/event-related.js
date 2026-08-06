// Sahaba Club — events related to THIS event
// ------------------------------------------------------------
// "Based on this event some recommended events should show up."
//
// ⚠ This is NOT `recommendEvents` from lib/event-social.js, and the difference
// matters. That one is personal: it reads a member's favourites, registrations
// and view history and returns `{ needsSignal: true }` when it has nothing to
// learn from. The event page is PUBLIC — most people opening a shared link
// have no session and no history at all — so a taste-based recommender would
// show an empty box to nearly every visitor it was built for.
//
// This asks a different question: what else is like the thing you are looking
// at? It needs no session, no history and no network beyond the events already
// loaded, so it works for a stranger arriving from WhatsApp.
//
// ⚠ Pure on purpose — no DOM, no Supabase, no clock of its own (today is
// passed in). That is what makes it testable without a browser, which matters
// in a project where nothing else on this page can be.
//
// ⚠ TEMPORAL DEAD ZONE: every module-level binding is declared before the
// first executing statement, and there is no top-level await.

// Weights. Ordered by how strongly each one predicts "you would also want
// this", not by how easy it is to compute.
//
// An organizer outranks a tag deliberately: tags are broad and self-assigned
// ("AI" is on nearly everything), while a shared organizer means the same
// people, the same room and usually the same crowd. Two events tagged "AI"
// have almost nothing in common; two events run by Azure Egypt Community do.
const W_ORGANIZER = 5;
const W_TAG = 3;
const W_TAG_CAP = 9;      // three shared tags is already a strong match
const W_SAME_MODE = 1;
const W_SAME_COUNTRY = 2;
const W_UPCOMING = 4;
const W_SAME_PRESENTER = 3;

// Below this, "related" is a stretch and an honest empty space is better than
// a filler row. A visitor who sees three unrelated events learns that the
// section is noise and stops reading it.
const MIN_SCORE = 3;

function tagSet(event) {
  const tags = (event && event.tags) || [];
  return new Set(tags.map((t) => String(t || "").trim().toLowerCase()).filter(Boolean));
}

function organizerSet(event) {
  const ids = (event && event.organizerIds) || [];
  return new Set(ids.filter(Boolean));
}

function intersectionSize(a, b) {
  let n = 0;
  a.forEach((v) => { if (b.has(v)) n += 1; });
  return n;
}

// `events` is every event, `event` the one being viewed, `today` an ISO date
// string. Returns the best matches, highest score first, soonest first on a
// tie.
export function relatedEvents(event, events, today, limit) {
  if (!event || !Array.isArray(events)) return [];
  const cap = limit || 3;
  const now = today || new Date().toISOString().slice(0, 10);

  const myTags = tagSet(event);
  const myOrgs = organizerSet(event);
  const myPresenter = String((event.presenter || "")).trim().toLowerCase();

  const scored = [];

  for (const other of events) {
    if (!other || other.id === event.id) continue;
    // Never surface a draft to a visitor who happens to be staff — the related
    // list is public furniture and should read the same for everybody.
    if (other.isPublished === false) continue;

    let score = 0;

    const sharedOrgs = intersectionSize(myOrgs, organizerSet(other));
    if (sharedOrgs) score += W_ORGANIZER * Math.min(sharedOrgs, 2);

    const sharedTags = intersectionSize(myTags, tagSet(other));
    if (sharedTags) score += Math.min(W_TAG * sharedTags, W_TAG_CAP);

    if (myPresenter && String(other.presenter || "").trim().toLowerCase() === myPresenter) {
      score += W_SAME_PRESENTER;
    }

    if (event.mode && other.mode === event.mode) score += W_SAME_MODE;
    if (event.country && other.country === event.country) score += W_SAME_COUNTRY;

    // An event somebody can still attend is worth more than one they cannot,
    // but a past event is not worthless — the archive is half this catalogue,
    // and a recording of a related talk is a real answer to "what else?".
    const upcoming = other.eventDate >= now;
    if (upcoming) score += W_UPCOMING;

    if (score >= MIN_SCORE) scored.push({ event: other, score, upcoming });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Same score: the soonest upcoming first, then the most recent past.
    if (a.upcoming && b.upcoming) return a.event.eventDate < b.event.eventDate ? -1 : 1;
    if (a.upcoming !== b.upcoming) return a.upcoming ? -1 : 1;
    return a.event.eventDate > b.event.eventDate ? -1 : 1;
  });

  return scored.slice(0, cap).map((s) => s.event);
}

export const WEIGHTS = {
  W_ORGANIZER, W_TAG, W_TAG_CAP, W_SAME_MODE,
  W_SAME_COUNTRY, W_UPCOMING, W_SAME_PRESENTER, MIN_SCORE,
};
