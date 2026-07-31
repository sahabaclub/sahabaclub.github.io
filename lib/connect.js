// Sahaba Club — Connect: members reading other members
// ------------------------------------------------------------
// One module for everything the three Connect pages need, so the rules about
// *what may be read about another person* live in one file rather than being
// re-decided on each page.
//
// The rules, restated from supabase/migrations/0013_connect_and_profiles.sql:
//
//   * Another member is only ever read through `member_directory`. Nothing
//     here selects from `profiles` for anybody but the signed-in user, because
//     members hold no SELECT on that table at all — a query would fail, and if
//     it ever stopped failing it would be leaking email and phone.
//   * `member_directory` already excludes members who haven't opted in, so
//     "not found" is the correct and only answer for someone who isn't
//     discoverable. We deliberately cannot tell the difference between "no
//     such account" and "opted out", and the pages must not try.
//   * Email and phone are not in the views. Do not join them back in.
//
// Everything returns a plain `{ data, error, off }` shape. `off` is true when
// migration 0013 hasn't been applied yet, so a page can say "Connect isn't
// switched on yet" instead of rendering a stack trace.
import { supabase } from "./supabase-client.js";

// ---- Failure shapes ---------------------------------------------------

// PostgREST answers a missing table two different ways depending on whether
// the schema cache has been reloaded: a Postgres 42P01, or its own PGRST205.
// A missing *column* (profiles.headline before 0013) shows up as 42703 or
// PGRST204. Treat the lot as "the migration hasn't run", because from a
// member's point of view they mean the same thing.
export function isMissingSchema(error) {
  if (!error) return false;
  const code = String(error.code || "");
  if (code === "42P01" || code === "42703") return true;
  if (code === "PGRST205" || code === "PGRST204") return true;
  const msg = String(error.message || "");
  return /schema cache|does not exist|Could not find the (table|column)/i.test(msg);
}

function wrap(res) {
  if (res.error && isMissingSchema(res.error)) {
    return { data: null, error: res.error, off: true };
  }
  return { data: res.data, error: res.error || null, off: false };
}

export const CONNECT_OFF_MESSAGE =
  "Connect isn't switched on yet. The database update it needs hasn't been applied — nothing is broken on your side.";

// ---- Who am I ---------------------------------------------------------

let cachedUser = null;
let resolvedUser = false;

export async function currentUser() {
  if (resolvedUser) return cachedUser;
  const { data } = await supabase.auth.getSession();
  cachedUser = data.session ? data.session.user : null;
  resolvedUser = true;
  return cachedUser;
}

// Every Connect page is members-only. Sends signed-out visitors to the login
// page and returns null so the caller can stop.
export async function requireUser(loginPath) {
  const user = await currentUser();
  if (!user) {
    window.location.replace(loginPath || "../login.html");
    return null;
  }
  return user;
}

// ---- The directory ----------------------------------------------------

const DIRECTORY_COLUMNS =
  "user_id, full_name, headline, avatar_url, city, country, experience_level, " +
  "industry, skills, interests, links, accepts_messages, member_since, followers, following";

// One member, as everyone else sees them. `data: null` with no error means
// "not in the directory" — the page shows the same state for that as it would
// for an id that was never real.
export async function getMember(userId) {
  if (!userId) return { data: null, error: null, off: false };
  return wrap(
    await supabase
      .from("member_directory")
      .select(DIRECTORY_COLUMNS)
      .eq("user_id", userId)
      .maybeSingle()
  );
}

// The whole directory, newest members first, paged so one slow query doesn't
// hold the page. Capped: past this many the page should be teaching people to
// search rather than scroll, and a browser holding every member in memory is
// not the shape of that problem.
export const DIRECTORY_CAP = 1000;
const PAGE = 200;

export async function listDirectory(cap) {
  const limit = cap || DIRECTORY_CAP;
  const rows = [];
  for (let from = 0; from < limit; from += PAGE) {
    const res = wrap(
      await supabase
        .from("member_directory")
        .select(DIRECTORY_COLUMNS)
        .order("member_since", { ascending: false })
        .range(from, Math.min(from + PAGE, limit) - 1)
    );
    if (res.off) return { data: null, error: res.error, off: true, capped: false };
    if (res.error) return { data: null, error: res.error, off: false, capped: false };
    const batch = res.data || [];
    rows.push(...batch);
    if (batch.length < PAGE) return { data: rows, error: null, off: false, capped: false };
  }
  return { data: rows, error: null, off: false, capped: true };
}

// ---- The live half ----------------------------------------------------

const ACTIVITY_COLUMNS =
  "user_id, events_attended, events_upcoming, first_event, latest_event, top_topics";

export async function getActivity(userId) {
  if (!userId) return { data: null, error: null, off: false };
  return wrap(
    await supabase
      .from("member_activity")
      .select(ACTIVITY_COLUMNS)
      .eq("user_id", userId)
      .maybeSingle()
  );
}

// Activity for a list of members, keyed by user_id. Members with no event
// history simply have no row in the view, so a missing key is normal and
// means zero — never an error.
export async function getActivityFor(userIds) {
  const ids = (userIds || []).filter(Boolean);
  if (!ids.length) return { data: {}, error: null, off: false };

  const byUser = {};
  for (let i = 0; i < ids.length; i += PAGE) {
    const res = wrap(
      await supabase
        .from("member_activity")
        .select(ACTIVITY_COLUMNS)
        .in("user_id", ids.slice(i, i + PAGE))
    );
    // Activity is a bonus, not the page. If this view is missing while the
    // directory is present, show the directory and skip the extras.
    if (res.off || res.error) return { data: {}, error: res.error, off: res.off };
    (res.data || []).forEach((row) => { byUser[row.user_id] = row; });
  }
  return { data: byUser, error: null, off: false };
}

// ---- Follows ----------------------------------------------------------

// The ids the signed-in member follows, as a Set.
export async function myFollowing() {
  const user = await currentUser();
  if (!user) return { data: new Set(), error: null, off: false };
  const res = wrap(
    await supabase
      .from("member_follows")
      .select("following_id")
      .eq("follower_id", user.id)
  );
  if (res.off || res.error) return { data: new Set(), error: res.error, off: res.off };
  return { data: new Set((res.data || []).map((r) => r.following_id)), error: null, off: false };
}

export async function follow(userId) {
  const user = await currentUser();
  if (!user) return { error: "not signed in", off: false };
  const res = wrap(
    await supabase
      .from("member_follows")
      .insert({ follower_id: user.id, following_id: userId })
  );
  // Following twice is not a failure worth showing anyone — the end state is
  // the one they asked for either way.
  if (res.error && String(res.error.code) === "23505") return { error: null, off: false };
  return { error: res.error ? res.error.message : null, off: res.off };
}

export async function unfollow(userId) {
  const user = await currentUser();
  if (!user) return { error: "not signed in", off: false };
  const res = wrap(
    await supabase
      .from("member_follows")
      .delete()
      .eq("follower_id", user.id)
      .eq("following_id", userId)
  );
  return { error: res.error ? res.error.message : null, off: res.off };
}

// ---- Messages ---------------------------------------------------------

const MESSAGE_COLUMNS =
  "id, sender_id, recipient_id, body, read_at, hidden_by_sender, hidden_by_recipient, created_at";

// Everything either side of me, oldest first. RLS already restricts this to
// conversations I'm part of; the filter is here so the request is honest
// about what it wants rather than relying on the policy to trim it.
export async function loadMessages() {
  const user = await currentUser();
  if (!user) return { data: [], error: null, off: false };
  const res = wrap(
    await supabase
      .from("member_messages")
      .select(MESSAGE_COLUMNS)
      .or("sender_id.eq." + user.id + ",recipient_id.eq." + user.id)
      .order("created_at", { ascending: true })
  );
  if (res.off || res.error) return { data: [], error: res.error, off: res.off };

  // Hiding is per-side: drop the ones I hid, keep the ones they hid.
  const mine = (res.data || []).filter((m) =>
    m.sender_id === user.id ? !m.hidden_by_sender : !m.hidden_by_recipient
  );
  return { data: mine, error: null, off: false };
}

// Group a flat message list into one thread per counterpart, newest thread
// first, with the unread count from my side only.
export function groupThreads(messages, myId) {
  const threads = new Map();
  (messages || []).forEach((m) => {
    const other = m.sender_id === myId ? m.recipient_id : m.sender_id;
    let t = threads.get(other);
    if (!t) {
      t = { userId: other, messages: [], unread: 0, last: null };
      threads.set(other, t);
    }
    t.messages.push(m);
    t.last = m;
    if (m.recipient_id === myId && !m.read_at) t.unread++;
  });
  return [...threads.values()].sort(
    (a, b) => new Date(b.last.created_at) - new Date(a.last.created_at)
  );
}

export async function sendMessage(recipientId, body) {
  const user = await currentUser();
  if (!user) return { error: "not signed in", off: false };
  const text = String(body || "").trim();
  if (!text) return { error: "Nothing to send.", off: false };
  if (text.length > 4000) return { error: "That's longer than 4000 characters.", off: false };

  const res = wrap(
    await supabase
      .from("member_messages")
      .insert({ sender_id: user.id, recipient_id: recipientId, body: text })
      .select(MESSAGE_COLUMNS)
      .single()
  );
  if (res.off) return { error: null, off: true };
  if (res.error) {
    // The send policy checks the recipient is discoverable and accepts
    // messages, so a rejection here usually means they've since turned one of
    // those off. Say that, rather than showing a policy violation.
    const msg = String(res.error.message || "");
    if (/row-level security|violates/i.test(msg)) {
      return { error: "This member isn't accepting messages any more.", off: false };
    }
    return { error: msg, off: false };
  }
  return { data: res.data, error: null, off: false };
}

// Mark the messages *they* sent *me* as read. The column grant only allows
// read_at and the hidden flags, so this cannot touch anything else even by
// mistake.
export async function markRead(otherId) {
  const user = await currentUser();
  if (!user) return { error: "not signed in" };
  const res = wrap(
    await supabase
      .from("member_messages")
      .update({ read_at: new Date().toISOString() })
      .eq("recipient_id", user.id)
      .eq("sender_id", otherId)
      .is("read_at", null)
  );
  return { error: res.error ? res.error.message : null, off: res.off };
}

// Remove a conversation from MY inbox. Two updates, each touching only my own
// side's flag — the other person keeps their copy, and nothing is deleted.
export async function hideThread(otherId) {
  const user = await currentUser();
  if (!user) return { error: "not signed in" };

  const sent = wrap(
    await supabase
      .from("member_messages")
      .update({ hidden_by_sender: true })
      .eq("sender_id", user.id)
      .eq("recipient_id", otherId)
  );
  if (sent.error) return { error: sent.error.message, off: sent.off };

  const received = wrap(
    await supabase
      .from("member_messages")
      .update({ hidden_by_recipient: true })
      .eq("recipient_id", user.id)
      .eq("sender_id", otherId)
  );
  return { error: received.error ? received.error.message : null, off: received.off };
}

// ---- Deriving the one-liner -------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthYear(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d)) return "";
  return MONTHS[d.getMonth()] + " " + d.getFullYear();
}

export function joinWords(list) {
  const items = (list || []).filter(Boolean);
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

// The line under the name: "Been around since Mar 2025 · 7 events · mostly AI
// and Power Platform".
//
// Plain arithmetic on numbers the database already computed — no model call,
// so it renders with the rest of the page and costs nothing per view. It also
// means it can never say something the counts don't support, which a generated
// sentence eventually would.
export function summarise(member, activity) {
  const bits = [];
  const since = monthYear(member && member.member_since) ||
                monthYear(activity && activity.first_event);
  if (since) bits.push("Been around since " + since);

  const attended = Number((activity && activity.events_attended) || 0);
  const upcoming = Number((activity && activity.events_upcoming) || 0);
  if (attended > 0) {
    bits.push(attended === 1 ? "1 event" : attended + " events");
  } else if (upcoming > 0) {
    bits.push(upcoming === 1 ? "first event coming up" : upcoming + " events coming up");
  }

  const topics = (activity && activity.top_topics) || [];
  if (attended > 0 && topics.length) {
    bits.push("mostly " + joinWords(topics.slice(0, 2)));
  }

  // Someone who joined ten minutes ago and hasn't been anywhere yet. Better to
  // say so plainly than to pad it into something that sounds like a bio.
  if (!bits.length) return "New here — nothing to go on yet.";
  return bits.join(" · ");
}

// The shorter version for a directory card.
export function shortSummary(member, activity) {
  const attended = Number((activity && activity.events_attended) || 0);
  const topics = (activity && activity.top_topics) || [];
  if (attended > 0 && topics.length) {
    return (attended === 1 ? "1 event" : attended + " events") +
           " · mostly " + joinWords(topics.slice(0, 2));
  }
  if (attended > 0) return attended === 1 ? "1 event" : attended + " events";
  const since = monthYear(member && member.member_since);
  return since ? "Member since " + since : "";
}

// ---- Small shared helpers ---------------------------------------------

export function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function initialOf(name) {
  const s = String(name || "").trim();
  return s ? s.charAt(0).toUpperCase() : "?";
}

// Only http(s) links are rendered. A `javascript:` value typed into the links
// field would otherwise become a working script the moment someone clicked it.
export function safeUrl(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : "https://" + s;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch (e) {
    return null;
  }
}

export function linkLabel(key, url) {
  const named = { linkedin: "LinkedIn", github: "GitHub", site: "Website",
                  website: "Website", x: "X", twitter: "X" };
  if (named[String(key).toLowerCase()]) return named[String(key).toLowerCase()];
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (e) {
    return String(key);
  }
}

// `links` is jsonb, so it arrives as an object. Anything that isn't a usable
// http(s) link is dropped rather than rendered as a dead chip.
export function linkList(links) {
  if (!links || typeof links !== "object") return [];
  return Object.keys(links)
    .map((key) => {
      const url = safeUrl(links[key]);
      return url ? { key: key, url: url, label: linkLabel(key, url) } : null;
    })
    .filter(Boolean);
}

export function placeOf(member) {
  return [member && member.city, member && member.country].filter(Boolean).join(", ");
}

const EXPERIENCE_LABELS = {
  "student": "Student",
  "early-career": "Early career",
  "mid-career": "Mid career",
  "senior": "Senior / leadership",
};

export function experienceLabel(value) {
  if (!value) return "";
  return EXPERIENCE_LABELS[value] || String(value);
}

export function relativeTime(value) {
  if (!value) return "";
  const then = new Date(value);
  if (isNaN(then)) return "";
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.round(hours / 24);
  if (days < 7) return days + "d ago";
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
