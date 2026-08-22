// Sahaba Club — admin, send a notification
// ------------------------------------------------------------
// Ahmed's ask: "from the control panel, send push notifications to specific
// people in the club." This is that panel. It writes rows into
// `notifications` through `staff_send_notification` (0045) — it does not send
// email, and it does not send phone push, because neither is switched on for
// hand-sent announcements yet. The page says so rather than implying reach it
// does not have.
//
// ⚠ THIS PAGE IS NOT THE SECURITY BOUNDARY, and that matters more here than
// on the read-only screens. `staff_send_notification` is `security definer`,
// so it bypasses RLS — and it therefore checks `is_staff()` INSIDE its own
// body. Hiding the button would not gate anything: anyone signed in can call
// an RPC. The gate is in the function; this page is a convenience so the
// wrong person gets a polite message instead of a confusing error.
//
// ⚠ ONE SEND IS NOT UNDOABLE. There is no unsend, no edit and no recall — the
// rows are in people's dashboards the moment the call returns. Everything
// below is built around making the last step deliberate: an explicit summary
// of who is about to be written to, and a confirm that names the number.
import { supabase } from "../../lib/supabase-client.js?v=15ea1b3425";
import {
  requireStaff, renderShell, escapeHtml, formatDate, showMessage, clearMessage,
} from "../../lib/admin-guard.js?v=15ea1b3425";

// ⚠ Every module-level binding is declared HERE, above the first line that
// runs. `const` is not hoisted the way `function` is, and a binding declared
// below an awaited statement does not exist while that await is pending — the
// bug that once rendered the admin Data panel as an empty database with
// nothing on screen to say why. tools/check-dead-zone.mjs enforces this, and
// it CAN see this file because it is a real .js module rather than an inline
// <script type="module"> in the HTML.

// The only two kinds a human may send by hand. This list must match the
// `p_kind not in (...)` guard inside staff_send_notification — the function
// rejects anything else, so a mismatch here shows up as an error rather than
// as a wrong send, but there is no reason to offer a choice that will fail.
//
// Deliberately excluded: the licence and renewal kinds. A hand-sent "your
// Microsoft 365 expires in 3 days" that does not match what the database
// believes is worse than no warning at all, because the member has no way to
// tell which one is lying.
const SENDABLE_KINDS = [
  {
    kind: "system_message",
    label: "Club announcement",
    hint: "Lands under Notifications on the member's dashboard.",
  },
  {
    kind: "eduhackai_launch",
    label: "EduHackAI announcement",
    hint: "Badges the EduHackAI item in the menu.",
  },
];

// Suggested destinations. Free text is allowed too, but 0044 constrains `href`
// to a single leading slash — a site-relative path and nothing else — so a
// pasted https:// link is rejected by the database. Offering the common ones
// stops that being discovered the hard way.
const LINK_SUGGESTIONS = [
  { href: "", label: "No link" },
  { href: "/events.html", label: "Events" },
  { href: "/hackathons.html", label: "EduHackAI" },
  { href: "/podcast.html", label: "Podcast" },
  { href: "/membership.html", label: "Membership" },
  { href: "/app/dashboard.html", label: "Dashboard" },
  { href: "/app/connect.html", label: "Connect" },
];

const MEMBER_COLUMNS = "user_id, full_name, created_at";

// Read in one go, like every other admin list. PostgREST silently caps a
// response at 1,000 rows unless asked otherwise, and a picker that quietly
// omitted the 1,001st member would be a very quiet way to leave somebody out.
const ROW_LIMIT = 2000;

const MAX_TITLE = 200;
const MAX_BODY = 1000;

const state = {
  members: [],
  selected: new Set(),
  // ⚠ Starts false and is only ever set by a read that RETURNED. "No members
  // found" is a plausible, undramatic sentence that somebody would believe,
  // so it must never be produced by a failed query. Same flag, same reasoning,
  // as interest.js.
  loadedOk: false,
  audience: "everyone",
  sending: false,
};

let user = null;

// ---- Small helpers ------------------------------------------------------

function el(id) {
  return document.getElementById(id);
}

function nameOf(m) {
  const n = (m.full_name || "").trim();
  return n || "(no name yet)";
}

// A member is identified in the picker by name, and names are not unique.
// Showing a fragment of the id alongside is what lets somebody tell two
// Ahmeds apart before writing to one of them.
function shortId(id) {
  return String(id || "").slice(0, 8);
}

function validHref(href) {
  const v = (href || "").trim();
  if (!v) return true;
  // Mirrors the CHECK constraint in 0044: site-relative, one leading slash.
  // Checked here so the member sees a sentence rather than a Postgres error.
  return v.startsWith("/") && !v.startsWith("//");
}

// ---- Rendering ----------------------------------------------------------

function renderKinds() {
  el("nt-kind").innerHTML = SENDABLE_KINDS
    .map((k, i) =>
      '<option value="' + escapeHtml(k.kind) + '"' + (i === 0 ? " selected" : "") + ">" +
      escapeHtml(k.label) + "</option>"
    )
    .join("");
  renderKindHint();
}

function renderKindHint() {
  const chosen = SENDABLE_KINDS.find((k) => k.kind === el("nt-kind").value);
  el("nt-kind-hint").textContent = chosen ? chosen.hint : "";
}

function renderLinks() {
  el("nt-link-suggest").innerHTML = LINK_SUGGESTIONS
    .map((l) =>
      '<button type="button" class="ad-btn ad-btn-sm" data-link="' + escapeHtml(l.href) + '">' +
      escapeHtml(l.label) + "</button>"
    )
    .join("");
}

function filteredMembers() {
  const q = (el("nt-q").value || "").trim().toLowerCase();
  if (!q) return state.members;
  return state.members.filter(
    (m) =>
      nameOf(m).toLowerCase().includes(q) ||
      String(m.user_id).toLowerCase().includes(q)
  );
}

function renderMembers() {
  const body = el("nt-members");

  if (!state.loadedOk) {
    body.innerHTML =
      '<tr><td colspan="3" class="ad-empty">Couldn\'t load the member list. ' +
      "Nothing can be sent to named people until this succeeds — use Refresh.</td></tr>";
    return;
  }

  const rows = filteredMembers();
  el("nt-count").textContent =
    rows.length + " of " + state.members.length + " shown · " + state.selected.size + " selected";

  if (!rows.length) {
    body.innerHTML =
      '<tr><td colspan="3" class="ad-empty">' +
      (state.members.length ? "Nobody matches that search." : "There are no members yet.") +
      "</td></tr>";
    return;
  }

  body.innerHTML = rows
    .map((m) => {
      const on = state.selected.has(m.user_id);
      return (
        '<tr><td><label class="ad-check"><input type="checkbox" data-uid="' +
        escapeHtml(m.user_id) + '"' + (on ? " checked" : "") + "> " +
        escapeHtml(nameOf(m)) + "</label></td>" +
        '<td class="ad-cell-dim">' + escapeHtml(shortId(m.user_id)) + "…</td>" +
        '<td class="ad-cell-dim">' + formatDate(m.created_at) + "</td></tr>"
      );
    })
    .join("");
}

// What the send button is about to do, in words, immediately above it.
function renderSummary() {
  const everyone = state.audience === "everyone";
  const n = everyone ? state.members.length : state.selected.size;
  const target = everyone
    ? "every member of the club"
    : n + (n === 1 ? " selected member" : " selected members");

  // ⚠ "Up to" is not hedging — it is the truth. Opt-outs live in
  // notification_optouts, which is readable only by the member it belongs to
  // (own-row RLS, 0044). Staff cannot see who has switched a kind off, so this
  // page CANNOT know the delivered number in advance. The function returns the
  // real count; this is a ceiling. Saying a precise number here would be
  // inventing one.
  el("nt-summary").innerHTML = state.loadedOk
    ? "This will write a notification to <strong>up to " + escapeHtml(String(n)) +
      "</strong> " + (everyone ? "members" : "of them") +
      " — " + escapeHtml(target) +
      ". Members who have switched this kind off will not receive it, and this page " +
      "cannot see who they are."
    : "The member list hasn't loaded, so nothing can be sent yet.";

  el("nt-send").disabled = state.sending || !state.loadedOk || (!everyone && n === 0);
}

function renderAudience() {
  const everyone = state.audience === "everyone";
  el("nt-aud-everyone").classList.toggle("is-active", everyone);
  el("nt-aud-picked").classList.toggle("is-active", !everyone);
  el("nt-picker").hidden = everyone;
  renderSummary();
}

function renderHistory(rows) {
  const body = el("nt-history");

  if (rows === null) {
    body.innerHTML =
      '<tr><td colspan="5" class="ad-empty">Couldn\'t load what has been sent before.</td></tr>';
    return;
  }
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5" class="ad-empty">Nothing has been sent yet.</td></tr>';
    return;
  }

  body.innerHTML = rows
    .map(
      (r) =>
        "<tr><td>" + escapeHtml(r.title) + "</td>" +
        '<td class="ad-cell-dim">' + escapeHtml(r.kind) + "</td>" +
        '<td class="ad-cell-dim">' +
        (r.target_user_ids && r.target_user_ids.length
          ? escapeHtml(String(r.target_user_ids.length)) + " picked"
          : "Everyone") +
        "</td>" +
        '<td class="ad-cell-dim">' + escapeHtml(String(r.recipients_written)) + "</td>" +
        '<td class="ad-cell-dim">' + formatDate(r.created_at) + "</td></tr>"
    )
    .join("");
}

// ---- Data ---------------------------------------------------------------

async function loadMembers() {
  state.loadedOk = false;
  const res = await supabase
    .from("profiles")
    .select(MEMBER_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(ROW_LIMIT);

  if (res.error) {
    renderMembers();
    renderSummary();
    return;
  }

  state.members = res.data || [];
  state.loadedOk = true;

  // Anyone selected who is no longer in the list should stop being selected,
  // or the count above the send button would promise people who are not there.
  const present = new Set(state.members.map((m) => m.user_id));
  Array.from(state.selected).forEach((id) => {
    if (!present.has(id)) state.selected.delete(id);
  });

  renderMembers();
  renderSummary();
}

async function loadHistory() {
  const res = await supabase
    .from("notification_broadcasts")
    .select("id, kind, title, target_user_ids, recipients_written, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  renderHistory(res.error ? null : res.data || []);
}

// ---- Sending ------------------------------------------------------------

async function send() {
  clearMessage("nt-notice");

  const kind = el("nt-kind").value;
  const title = (el("nt-title").value || "").trim();
  const body = (el("nt-body").value || "").trim();
  const href = (el("nt-link").value || "").trim();
  const everyone = state.audience === "everyone";
  const ids = everyone ? null : Array.from(state.selected);

  if (!title) {
    showMessage("nt-notice", "A title is required — it is the line members actually read.", "err");
    return;
  }
  if (title.length > MAX_TITLE) {
    showMessage("nt-notice", "That title is longer than " + MAX_TITLE + " characters.", "err");
    return;
  }
  if (body.length > MAX_BODY) {
    showMessage("nt-notice", "That message is longer than " + MAX_BODY + " characters.", "err");
    return;
  }
  if (!validHref(href)) {
    showMessage(
      "nt-notice",
      "The link must be a path on this site starting with a single \"/\" — for example " +
        "/events.html. Full https:// addresses are refused by the database.",
      "err"
    );
    return;
  }
  if (!everyone && !ids.length) {
    showMessage("nt-notice", "Nobody is selected.", "err");
    return;
  }

  // The last gate before something irreversible. It names the number and the
  // audience, because "are you sure?" on its own is a button people learn to
  // click without reading.
  const who = everyone
    ? "every member of the club (up to " + state.members.length + ")"
    : ids.length + (ids.length === 1 ? " selected member" : " selected members");
  if (!window.confirm(
    "Send this notification to " + who + "?\n\n" +
    title + "\n\n" +
    "This cannot be undone — there is no unsend."
  )) return;

  state.sending = true;
  renderSummary();
  showMessage("nt-notice", "Sending…", "info");

  const res = await supabase.rpc("staff_send_notification", {
    p_user_ids: ids,
    p_kind: kind,
    p_title: title,
    p_body: body || null,
    p_href: href || null,
  });

  state.sending = false;

  if (res.error) {
    // The function's own message is more useful than anything invented here —
    // "staff only", or the name of a kind it refused.
    showMessage("nt-notice", res.error.message || "That didn't send.", "err");
    renderSummary();
    return;
  }

  const written = Number(res.data) || 0;
  const skipped = (everyone ? state.members.length : ids.length) - written;

  showMessage(
    "nt-notice",
    "Sent. " + written + (written === 1 ? " member" : " members") + " received it" +
      (skipped > 0
        ? ", and " + skipped + " did not — either they have this kind switched off, " +
          "or they already had this exact notification."
        : ".") ,
    "ok"
  );

  el("nt-title").value = "";
  el("nt-body").value = "";
  state.selected.clear();
  renderMembers();
  renderSummary();
  loadHistory();
}

// ---- Wiring -------------------------------------------------------------

function wire() {
  el("nt-kind").addEventListener("change", renderKindHint);

  el("nt-aud-everyone").addEventListener("click", () => {
    state.audience = "everyone";
    renderAudience();
  });
  el("nt-aud-picked").addEventListener("click", () => {
    state.audience = "picked";
    renderAudience();
  });

  el("nt-q").addEventListener("input", renderMembers);
  el("nt-refresh").addEventListener("click", loadMembers);

  el("nt-members").addEventListener("change", (ev) => {
    const box = ev.target.closest("[data-uid]");
    if (!box) return;
    const id = box.getAttribute("data-uid");
    if (box.checked) state.selected.add(id);
    else state.selected.delete(id);
    renderSummary();
    el("nt-count").textContent =
      filteredMembers().length + " of " + state.members.length +
      " shown · " + state.selected.size + " selected";
  });

  // Selects what is CURRENTLY FILTERED, not the whole club — the button sits
  // beside a search box, and selecting 400 people when the screen shows 3
  // would be a genuinely dangerous surprise. The label says so too.
  el("nt-select-shown").addEventListener("click", () => {
    filteredMembers().forEach((m) => state.selected.add(m.user_id));
    renderMembers();
    renderSummary();
  });
  el("nt-clear").addEventListener("click", () => {
    state.selected.clear();
    renderMembers();
    renderSummary();
  });

  el("nt-link-suggest").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-link]");
    if (!btn) return;
    el("nt-link").value = btn.getAttribute("data-link");
  });

  el("nt-send").addEventListener("click", send);
}

// ---- Init ---------------------------------------------------------------

(async function init() {
  user = await requireStaff("notify");
  if (!user) return;

  renderShell(user, "notify.html");
  renderKinds();
  renderLinks();
  wire();
  renderAudience();

  await Promise.all([loadMembers(), loadHistory()]);
})();
