// Sahaba Club — notifications
// ------------------------------------------------------------
// The client half of migrations 0044 and 0045. Three jobs:
//
//   1. Read the per-department unread counts and paint them onto the menu.
//   2. Keep those counts live over Realtime, so a badge appears while the
//      member is looking at the page rather than on their next navigation.
//   3. Read and mark-read the notifications themselves, for the dashboard tab.
//
// ⚠ TEMPORAL DEAD ZONE — the rule this file exists under.
// `const` and `let` are not hoisted the way `function` is, and a top-level
// `await` suspends module evaluation, so every `const` below an awaited
// statement does not exist while that awaited work runs. In this codebase that
// bug rendered the admin panel as an empty database with no error anywhere,
// and `node --check` cannot see it because it is valid syntax. Two rules here:
// EVERY module-level binding is declared at the top, before the first
// executing statement, and there is NO top-level await in this file at all.
// `tools/check-dead-zone.mjs` enforces the first one — run it after editing.
//
// ⚠ Nothing in this file is a privacy boundary. `notifications` is readable
// only by its owner (RLS, 0044), the counts view is `security_invoker`, and
// the emit functions are revoked from every client role. A member who tampers
// with this file gets a wrong number in their own menu and nothing else.

import { supabase } from "./supabase-client.js?v=95a6e12add";

// The six departments that carry a badge, in menu order. `dashboard` is the
// aggregate of the member's own account notices; the rest are one per section.
export const DEPARTMENTS = [
  "dashboard",
  "messages",
  "connect",
  "events",
  "eduhackai",
  "podcast",
];

// Which menu item belongs to which department, keyed by the LAST path segment
// of the href. Matched this way because the same menu is served from the site
// root (`app/inbox.html`) and from inside `app/` (`inbox.html`), so the full
// href differs per page while the basename does not.
//
// ⚠ Matching is scoped by CLASS to `.nav-link` and `.mobile-menu-item` — see
// paintNavBadges. It must never be widened to "any anchor with this href":
// the signed-in identity chip is also an `<a href="app/dashboard.html">`, and
// a sweep that matched on href alone once deleted that chip from two pages.
// Match on what the element IS, not on where it points.
const HREF_TO_DEPARTMENT = {
  "dashboard.html": "dashboard",
  "inbox.html": "messages",
  "connect.html": "connect",
  "events.html": "events",
  "hackathons.html": "eduhackai",
  "podcast.html": "podcast",
};

// Which PAGE belongs to which department, for clear-on-visit.
//
// ⚠ This is why the first version was wrong. Badges were painted and never
// cleared by navigation: a member clicked "Events", read the new events, came
// back, and the 2 was still sitting there — forever, because the only things
// that marked anything read were the dashboard's own list and its "mark all"
// button. Opening the section IS reading it, and the menu has to agree.
//
// Deliberately NOT in this map:
//   messages   — the inbox marks each CONVERSATION read as it is opened
//                (markConversationRead). Landing on the inbox without opening
//                a thread has not read anything, and clearing there would lie.
//   dashboard  — the Notifications tab lists every department and styles
//                unread rows differently. Auto-clearing on arrival would erase
//                that distinction in the one place it is the whole point; it
//                has per-row click-to-read and an explicit "Mark all as read".
const PATH_TO_DEPARTMENT = {
  "events.html": "events",
  "podcast.html": "podcast",
  "hackathons.html": "eduhackai",
  "connect.html": "connect",
};

const BADGE_CLASS = "nav-badge";
const BADGE_SELECTOR = ".nav-link, .mobile-menu-item";

// Above this the exact number stops being useful and starts breaking the
// layout of a menu item.
const BADGE_MAX = 99;

// ⚠ One channel per page, and exactly one — this matters more than it looks.
//
// On app/dashboard.html TWO callers want the live feed: script.js, which
// paints the menu badges on every page, and the dashboard's own module, which
// also has to refresh the open notifications list. A browser gives both the
// SAME module instance for this file, so these bindings are shared between
// them.
//
// The first version had subscribeToCounts take a callback and store it. That
// made the two callers race: whoever subscribed last replaced the other's
// callback, and since script.js is a classic script (running during parse)
// while the dashboard's is a deferred module, the order is decided by which
// promise chain resolves first. The dashboard's list would then stop updating
// on some loads and not others — the worst kind of bug to be handed.
//
// So: subscribing is idempotent, and interest is registered separately.
// Callers say "tell me when counts change" and no caller can unhook another.
let channel = null;
let subscribedUserId = null;
const listeners = [];

// ---- Reading ------------------------------------------------------------

// Per-department unread counts. Always returns an object with every department
// present, because "no row" from the view means zero and every caller would
// otherwise have to remember that.
export async function fetchCounts() {
  const empty = {};
  DEPARTMENTS.forEach((d) => { empty[d] = 0; });

  const { data, error } = await supabase
    .from("my_notification_counts")
    .select("department, unread");

  // ⚠ Distinguish "the read failed" from "there is nothing to show". A failed
  // read that returns zeroes paints an empty menu and looks like good news —
  // this codebase has printed "Nobody in this state. That is the good outcome."
  // after a query that never returned. Null means "do not repaint".
  if (error) return null;

  (data || []).forEach((row) => {
    if (Object.prototype.hasOwnProperty.call(empty, row.department)) {
      empty[row.department] = Number(row.unread) || 0;
    }
  });
  return empty;
}

// The notifications themselves, newest first, for the dashboard tab.
export async function fetchList({ limit = 50, department = null, unreadOnly = false } = {}) {
  let query = supabase
    .from("notifications")
    // Explicit columns, never `select=*`. Under column-level grants PostgREST
    // refuses the WHOLE query if any single requested column is ungranted, so
    // a star here would turn one future revoke into a blank notifications tab.
    .select("id, department, kind, title, body, href, actor_id, subject_id, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (department) query = query.eq("department", department);
  if (unreadOnly) query = query.is("read_at", null);

  const { data, error } = await query;
  if (error) return null;
  return data || [];
}

// ---- Marking read -------------------------------------------------------

// Both of these go through the RPCs from 0044 rather than an UPDATE. Members
// hold no UPDATE grant on `notifications` at all — deliberately, so nobody can
// rewrite the title or the link of something the club sent them.
export async function markRead(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return 0;
  const { data, error } = await supabase.rpc("mark_notifications_read", { p_ids: list });
  return error ? 0 : Number(data) || 0;
}

// Clear the message notification for one conversation.
//
// 0045 gives message notifications a dedupe key that is stable per
// CONVERSATION rather than per message, so six lines in a row produce one
// badge instead of six. The cost of that choice is that the badge stays lit —
// and the next message produces no new notification — until this is called.
// Opening the thread is what clears it, which is why the inbox calls this and
// not just the messages-read RPC.
export async function markConversationRead(actorId) {
  if (!actorId) return 0;
  const { data, error } = await supabase
    .from("notifications")
    .select("id")
    .eq("department", "messages")
    .eq("actor_id", actorId)
    .is("read_at", null);
  if (error || !data || !data.length) return 0;
  return markRead(data.map((r) => r.id));
}

export async function markDepartmentRead(department) {
  if (!department) return 0;
  const { data, error } = await supabase.rpc("mark_department_read", { p_department: department });
  return error ? 0 : Number(data) || 0;
}

// ---- Preferences --------------------------------------------------------
//
// The settings page renders itself FROM notification_kinds rather than from a
// list written in the client. A kind added in a later migration appears in
// everyone's settings with no page change — which is what stops the controls
// and the engine drifting apart, the way a hardcoded list always eventually
// does.

export async function fetchKinds() {
  const { data, error } = await supabase
    .from("notification_kinds")
    .select("kind, department, label, description, default_channels, is_critical, sort_order")
    .order("sort_order", { ascending: true });
  if (error) return null;
  return data || [];
}

// The member's opt-out rows. A row means OFF; absence means ON.
export async function fetchOptOuts() {
  const { data, error } = await supabase
    .from("notification_optouts")
    .select("kind, channel");
  if (error) return null;
  return data || [];
}

// `off === true` writes the opt-out row; `false` deletes it. RLS restricts
// both to the caller's own rows, and the table has no UPDATE policy because
// everything in it is part of its own primary key.
export async function setOptOut(kind, channel, off) {
  if (off) {
    const { error } = await supabase
      .from("notification_optouts")
      // The member may already have this row — flipping a switch twice, or two
      // tabs open. Upsert so the second write is not a duplicate-key error
      // presented to them as a failure.
      .upsert({ kind, channel }, { onConflict: "user_id,kind,channel" });
    return !error;
  }
  const { error } = await supabase
    .from("notification_optouts")
    .delete()
    .eq("kind", kind)
    .eq("channel", channel);
  return !error;
}

// ---- Painting -----------------------------------------------------------

function lastSegment(href) {
  // Parsed rather than split on "/", so a query string or a hash cannot end up
  // inside the key. Relative hrefs need a base; the value is thrown away.
  try {
    return new URL(href, window.location.origin).pathname.split("/").pop() || "";
  } catch (e) {
    return "";
  }
}

function applyBadge(link, count) {
  let badge = link.querySelector("." + BADGE_CLASS);

  if (!count) {
    if (badge) badge.remove();
    // Only clear a label this file set. Removing aria-label unconditionally
    // would strip labels other code owns.
    if (link.getAttribute("data-badge-labelled") === "1") {
      link.removeAttribute("aria-label");
      link.removeAttribute("data-badge-labelled");
    }
    return;
  }

  if (!badge) {
    badge = document.createElement("span");
    badge.className = BADGE_CLASS;
    // The number is decoration for a screen reader — the count reaches it
    // through the link's own accessible name instead, so it is announced as
    // part of "Messages, 3 unread" rather than as a stray digit after it.
    badge.setAttribute("aria-hidden", "true");
    link.appendChild(badge);
  }

  badge.textContent = count > BADGE_MAX ? BADGE_MAX + "+" : String(count);

  // `textContent` of the link includes the badge we just wrote, so the label
  // is built from the element's own first text node instead.
  const label = (link.firstChild && link.firstChild.nodeType === 3)
    ? link.firstChild.nodeValue.trim()
    : link.getAttribute("data-nav-label") || "";
  if (label) {
    link.setAttribute("aria-label", label + ", " + count + " unread");
    link.setAttribute("data-badge-labelled", "1");
  }
}

// Paint every menu item, header and mobile drawer alike, from one counts
// object. Safe to call on a page that has no menu — it simply finds nothing.
export function paintNavBadges(counts) {
  if (!counts) return;
  const links = document.querySelectorAll(BADGE_SELECTOR);
  Array.prototype.forEach.call(links, (link) => {
    const href = link.getAttribute("href");
    if (!href) return;
    const department = HREF_TO_DEPARTMENT[lastSegment(href)];
    if (!department) return;
    applyBadge(link, counts[department] || 0);
  });
}

// Read and paint in one call. Returns the counts so a caller that wants them
// for something else does not have to read twice.
export async function refreshNavBadges() {
  const counts = await fetchCounts();
  paintNavBadges(counts);
  return counts;
}

// Opening a section's page marks that section read. Returns how many rows
// were cleared, so a caller can skip the repaint when there was nothing to do.
export async function markCurrentSectionRead() {
  const department = PATH_TO_DEPARTMENT[lastSegment(window.location.pathname)];
  if (!department) return 0;
  const cleared = await markDepartmentRead(department);
  if (cleared) await refreshNavBadges();
  return cleared;
}

// ---- Catching up --------------------------------------------------------
//
// ⚠ The badge is painted ONCE at load and then only moved by Realtime. That
// leaves a real hole: a tab opened BEFORE a notification existed shows the
// count from the moment it loaded, and keeps showing it. If the socket never
// connected — a sleeping laptop, a proxy that drops websockets, a phone that
// backgrounded the tab, bfcache restoring a page wholesale — nothing ever
// corrects it, and the member concludes notifications do not work.
//
// Realtime is the fast path, not the only path. These two events are the
// cheap, boring backstop: whenever the member actually LOOKS at the page
// again, re-read the counts.
export function watchForRefocus() {
  if (typeof document === "undefined") return;

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshNavBadges();
  });

  // bfcache: `pageshow` with persisted=true means the whole page came back
  // from memory, with its DOM — and its stale badge — intact. `load` does not
  // fire again, so without this the count can be minutes or hours old.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) refreshNavBadges();
  });
}

// ---- Live ---------------------------------------------------------------

// Realtime is authorised against RLS, so this subscription can only ever
// deliver rows the member could have selected anyway — their own. The filter
// is a narrowing for efficiency, not the access control.
//
// On every insert we re-read the counts rather than incrementing locally. A
// local increment drifts the moment anything else marks something read (a
// second tab, the dashboard tab, opening a message thread), and a badge that
// disagrees with the list under it is worse than one that costs a small query.
export function subscribeToCounts(userId) {
  if (!userId) return null;

  // Idempotent. Called by script.js on every page and again by the dashboard;
  // the second call is a no-op rather than a teardown and re-open.
  if (channel && subscribedUserId === userId) return channel;
  unsubscribe();
  subscribedUserId = userId;

  channel = supabase
    .channel("sc-notifications-" + userId)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "notifications",
        filter: "user_id=eq." + userId,
      },
      () => {
        refreshNavBadges().then(notifyListeners);
      }
    )
    .subscribe();

  return channel;
}

// Register interest in counts changing. Returns a function that removes this
// listener and only this one.
export function onCountsChange(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i !== -1) listeners.splice(i, 1);
  };
}

function notifyListeners(counts) {
  // Copied before iterating: a listener that removes itself while being
  // called would otherwise shorten the array mid-loop and skip the next one.
  // One listener throwing must not stop the others being told.
  listeners.slice().forEach((fn) => {
    try { fn(counts); } catch (e) {}
  });
}

export function unsubscribe() {
  if (!channel) return;
  try { supabase.removeChannel(channel); } catch (e) {}
  channel = null;
  subscribedUserId = null;
}
