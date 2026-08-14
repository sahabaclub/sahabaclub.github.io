// Sahaba Club — the social and personal layer over events
// ------------------------------------------------------------
// Favourites, who's going, what a member has looked at, and the scoring
// that turns all three into recommendations. Kept apart from events-ui.js
// so the rendering code stays about rendering.
//
// Everything here degrades to nothing when signed out: a visitor sees the
// events and no personal state, with no errors in between.
import { supabase } from "./supabase-client.js?v=f0eaba8a71";

// How many ids may go into one PostgREST `.in(...)` filter.
//
// This is a URL-length limit, not a row limit. A `.in()` becomes a query
// string: `user_id=in.(uuid,uuid,…)`, and a UUID costs 37 characters once the
// comma is counted. An events page showing 500 registrants therefore builds a
// request line of roughly 18.5KB — and Kong, which fronts every Supabase
// project, defaults to about 8KB for request headers. Past that the query does
// not return fewer rows, it returns HTTP 414 and the faces vanish from every
// card at once, on the busiest events, which is precisely where they matter.
//
// 100 keeps a batch near 3.7KB, comfortably inside the limit with room for the
// rest of the URL and the auth header, at the cost of one extra round trip per
// hundred people. `lib/connect.js` has the same constant for the same reason.
const IN_BATCH = 100;

let cachedUserId = null;
let resolvedUser = false;

export async function currentUserId() {
  if (resolvedUser) return cachedUserId;
  const { data } = await supabase.auth.getSession();
  cachedUserId = data.session ? data.session.user.id : null;
  resolvedUser = true;
  return cachedUserId;
}

// ---- Favourites -------------------------------------------------------

export async function loadFavourites() {
  const uid = await currentUserId();
  if (!uid) return new Set();
  const { data, error } = await supabase
    .from("event_favourites")
    .select("event_id")
    .eq("user_id", uid);
  if (error) return new Set();
  return new Set((data || []).map(r => r.event_id));
}

export async function addFavourite(eventId) {
  const uid = await currentUserId();
  if (!uid) return { error: "not signed in" };
  const { error } = await supabase
    .from("event_favourites")
    .insert({ user_id: uid, event_id: eventId });
  return { error: error ? error.message : null };
}

export async function removeFavourite(eventId) {
  const uid = await currentUserId();
  if (!uid) return { error: "not signed in" };
  const { error } = await supabase
    .from("event_favourites")
    .delete()
    .eq("user_id", uid)
    .eq("event_id", eventId);
  return { error: error ? error.message : null };
}

// ---- Registrations ----------------------------------------------------

// A member's own status per event: 'registered', 'interested', or absent.
export async function loadMyRegistrations() {
  const uid = await currentUserId();
  if (!uid) return {};
  const { data, error } = await supabase
    .from("event_registrations")
    .select("event_id, status")
    .eq("user_id", uid);
  if (error) return {};
  const out = {};
  (data || []).forEach(r => { out[r.event_id] = r.status; });
  return out;
}

export async function setMyRegistration(eventId, status) {
  const uid = await currentUserId();
  if (!uid) return { error: "not signed in" };
  // upsert rather than insert: a member may open the same event twice, and
  // the unique (event_id, user_id) constraint would reject the second.
  const { error } = await supabase
    .from("event_registrations")
    .upsert({ user_id: uid, event_id: eventId, status: status },
            { onConflict: "event_id,user_id" });
  return { error: error ? error.message : null };
}

// ---- Who's going ------------------------------------------------------

// Returns { eventId: [{ id, name, avatar }] } for members who confirmed and
// who haven't hidden themselves. Names and photos come from member_cards, a
// view that exposes only those two columns — a plain join to profiles would
// have carried bios and goals with it.
//
// `id` is the user_id member_cards already returns, and it's here so a face
// can link to that member's Connect profile. It exposes nothing new: the id
// was always in this response, and app/member.html reads member_directory,
// which shows nothing at all for someone who hasn't opted into Connect.
export async function loadAttendees(eventIds) {
  const uid = await currentUserId();
  if (!uid || !eventIds.length) return {};

  // Both `.in()` filters below are batched. The event list is bounded by what
  // the page chose to render, but the registrant list is bounded by how
  // popular those events turned out to be — which is not a number this file
  // gets to decide. See IN_BATCH above.
  const regs = [];
  for (let i = 0; i < eventIds.length; i += IN_BATCH) {
    const { data, error } = await supabase
      .from("event_registrations")
      .select("event_id, user_id")
      .in("event_id", eventIds.slice(i, i + IN_BATCH))
      .eq("status", "registered");
    // One failed batch means an incomplete answer, and a partial "who's going"
    // is worse than none: it silently tells a member their friends aren't
    // coming. Everything here already degrades to {} when signed out.
    if (error) return {};
    regs.push(...(data || []));
  }
  if (!regs.length) return {};

  const userIds = [...new Set(regs.map(r => r.user_id))];
  const cardBy = {};
  for (let i = 0; i < userIds.length; i += IN_BATCH) {
    const { data, error } = await supabase
      .from("member_cards")
      .select("user_id, full_name, avatar_url")
      .in("user_id", userIds.slice(i, i + IN_BATCH));
    if (error) return {};
    (data || []).forEach(c => { cardBy[c.user_id] = c; });
  }

  const out = {};
  regs.forEach(r => {
    const card = cardBy[r.user_id];
    if (!card) return; // opted out of being listed
    (out[r.event_id] = out[r.event_id] || []).push({
      id: r.user_id,
      name: card.full_name || "Member",
      avatar: card.avatar_url || null,
    });
  });
  return out;
}

// ---- Browsing signal --------------------------------------------------

// Called when a member actually engages with an event (expands it, opens the
// registration page), not merely scrolls past — otherwise every event on
// screen would look equally interesting and the signal would be worthless.
// What we last knew each event's count to be, so recording a view costs one
// request instead of two. Filled by loadViewCounts below, which every page
// that records views already calls before it can record one.
const knownViewCount = new Map();

// One upsert, on the table's own primary key — `(user_id, event_id)`, see
// migration 0005. This used to be a select followed by an update-or-insert:
// two round trips on a control that fires while somebody is mid-click, and a
// race between them, because two tabs reading 3 both write 4.
//
// `view_count` is only ever sent when we already know the current value.
// PostgREST's merge-duplicates resolution updates *only the columns present in
// the body*, so omitting it leaves an existing row's count exactly as it was
// and lets a new row take the column default of 1. That is the important
// property: not knowing the count can cost us an increment, but it can never
// overwrite a real count with a wrong one — which is what sending a guess
// would do on any page that didn't load the counts first.
//
// An exact server-side `view_count = event_views.view_count + 1` is not
// expressible through PostgREST; it needs a Postgres function to call over
// RPC. That belongs in supabase/migrations, not here, and the signal this
// feeds — a 0.5-weight nudge capped at 2 in recommendEvents — does not justify
// one. Worth revisiting only if view counts ever become something a member is
// shown rather than something the ranking reads.
export async function recordView(eventId) {
  const uid = await currentUserId();
  if (!uid) return;

  const seen = knownViewCount.get(eventId);
  const row = {
    user_id: uid,
    event_id: eventId,
    last_viewed_at: new Date().toISOString(),
  };
  if (typeof seen === "number") row.view_count = seen + 1;

  const { error } = await supabase
    .from("event_views")
    .upsert(row, { onConflict: "user_id,event_id" });

  // Only believe the new number if the write actually landed, or a failed
  // request would leave the cache one ahead of the database for the rest of
  // the visit and every later view would keep that drift.
  if (!error && typeof seen === "number") knownViewCount.set(eventId, seen + 1);
}

export async function loadViewCounts() {
  const uid = await currentUserId();
  if (!uid) return {};
  const { data, error } = await supabase
    .from("event_views")
    .select("event_id, view_count")
    .eq("user_id", uid);
  if (error) return {};
  const out = {};
  (data || []).forEach(v => {
    out[v.event_id] = v.view_count;
    knownViewCount.set(v.event_id, v.view_count);
  });
  return out;
}

// ---- Recommendations --------------------------------------------------

// Builds a taste profile from what the member has favourited, registered for
// and looked at, then scores every upcoming event against it.
//
// This is deliberately a transparent scoring model rather than a language
// model: it runs instantly, costs nothing per view, and — the part that
// actually matters — can explain itself, so the card can say *why* an event
// was suggested. A model call could be layered on later for subtler matching,
// but it would need a server function and would still want these signals as
// its input.
//
// Weights reflect how much each action really says. Saving something is a
// deliberate act; opening a page is barely a whisper.
const W = {
  favourite: 5,
  registered: 4,
  interested: 2,
  viewPerVisit: 0.5,
  viewCap: 2,
};

function buildTaste(events, favourites, registrations, viewCounts) {
  const tags = {};
  const locations = {};
  const modes = {};
  let weekendish = 0;
  let signals = 0;

  events.forEach(e => {
    let weight = 0;
    if (favourites.has(e.id)) weight += W.favourite;
    const reg = registrations[e.id];
    if (reg === "registered") weight += W.registered;
    else if (reg === "interested") weight += W.interested;
    const views = viewCounts[e.id] || 0;
    if (views) weight += Math.min(views * W.viewPerVisit, W.viewCap);
    if (weight <= 0) return;

    signals++;
    (e.tags || []).forEach(t => {
      const k = String(t).toLowerCase();
      tags[k] = (tags[k] || 0) + weight;
    });
    if (e.country) {
      const k = String(e.country).toLowerCase();
      locations[k] = (locations[k] || 0) + weight;
    }
    if (e.mode) modes[e.mode] = (modes[e.mode] || 0) + weight;

    // Day-of-week preference: someone who only ever saves weekend events
    // shouldn't be pushed Tuesday-morning webinars.
    const day = new Date(e.date + "T12:00:00").getDay();
    if (day === 5 || day === 6 || day === 0) weekendish += weight;
  });

  return { tags, locations, modes, weekendish, signals };
}

export function recommendEvents(events, favourites, registrations, viewCounts, limit) {
  const taste = buildTaste(events, favourites, registrations, viewCounts);

  // Nothing to learn from yet. Better to say so than to dress up an arbitrary
  // list as a personal recommendation.
  if (taste.signals === 0) return { needsSignal: true, items: [] };

  const maxTag = Math.max(1, ...Object.values(taste.tags));
  const maxLoc = Math.max(1, ...Object.values(taste.locations));
  const maxMode = Math.max(1, ...Object.values(taste.modes));

  const scored = events
    // Never recommend something they've already saved or signed up for.
    .filter(e => !favourites.has(e.id) && !registrations[e.id])
    .map(e => {
      let score = 0;
      let substance = false; // did anything about the event itself match?
      const why = [];

      const tagHits = (e.tags || [])
        .map(t => ({ t: t, v: taste.tags[String(t).toLowerCase()] || 0 }))
        .filter(x => x.v > 0)
        .sort((a, b) => b.v - a.v);
      if (tagHits.length) {
        score += (tagHits.reduce((s, x) => s + x.v, 0) / maxTag) * 3;
        why.push(tagHits.slice(0, 2).map(x => x.t).join(" and "));
        substance = true;
      }

      if (e.country) {
        const lv = taste.locations[String(e.country).toLowerCase()] || 0;
        if (lv > 0) {
          score += (lv / maxLoc) * 1.2;
          why.push("in " + e.country);
          substance = true;
        }
      }

      if (e.mode) {
        const mv = taste.modes[e.mode] || 0;
        if (mv > 0) {
          score += (mv / maxMode) * 0.8;
          if (!why.length) why.push(e.mode.toLowerCase() + " events");
        }
      }

      const day = new Date(e.date + "T12:00:00").getDay();
      const isWeekendish = day === 5 || day === 6 || day === 0;
      if (taste.weekendish > 0 && isWeekendish) score += 0.5;

      // Gentle nudge toward things happening soon — a perfect match six
      // months out is less useful than a good one next week.
      const days = Math.max(0, (new Date(e.date) - new Date()) / 86400000);
      score += Math.max(0, 1 - days / 90) * 0.6;

      return { event: e, score: score, substance: substance, why: why.slice(0, 2).join(", ") };
    })
    // Format and timing alone are not a reason. Without a matching topic or
    // city, "recommended for you" would be recommending a cookery evening
    // because the last thing you saved also happened to be in a room — which
    // is worse than showing nothing, because it teaches people to ignore the
    // section. Better a short list than a padded one.
    .filter(x => x.substance && x.score > 0.4)
    .sort((a, b) => b.score - a.score);

  return { needsSignal: false, items: scored.slice(0, limit || 4) };
}
