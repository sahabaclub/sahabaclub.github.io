// Sahaba Club — admin, EduHackAI interest
// ------------------------------------------------------------
// Who has put their hand up for the next round, from the public form on
// hackathons.html. Read-only: nothing on this page writes, because nothing
// here is the club's to change — every row is what a person typed about
// themselves, and correcting it behind their back would make the list less
// true rather than more.
//
// ⚠ AN EMPTY LIST AND A FAILED READ ARE NOT THE SAME THING, and this page is
// built around that sentence rather than merely aware of it. On 3 Aug 2026 the
// Data panel rendered a failed read as an empty one and two hours went into
// the database looking for a cause that was in the browser. Here the stakes
// are worse in one specific way: "nobody has registered yet" is a plausible,
// undramatic thing for this page to say. It is the sentence somebody would
// believe. So it is only ever produced by a read that RETURNED, and every
// other outcome says what went wrong instead — `state.loadedOk` below is the
// single flag that decides which, and it starts false.
//
// The rows themselves are typed by anonymous strangers, so every value goes
// through escapeHtml() on its way into the DOM. Same reasoning as the mail
// template in send-transactional-email: this is the second place a submitted
// `<script>` would land.
import { supabase } from "../../lib/supabase-client.js?v=2bee541930";
import { requireStaff, renderShell, escapeHtml } from "../../lib/admin-guard.js?v=2bee541930";

// ⚠ Every module-level binding is declared HERE, above the first line that
// runs, with no exceptions and no judgement about which are reachable. See
// tools/check-dead-zone.mjs for the afternoon that bought this rule.

// The round this page is about. A constant rather than a picker: there is one
// round taking registrations, and a dropdown listing four finished ones would
// invite somebody to read an empty list for eduhackai-2 as a problem.
const ROUND_SLUG = "eduhackai-5";

// Read in one go, like every other admin list. If this is ever reached the
// page says so rather than silently showing a slice — the count next to the
// heading would otherwise be a different number from the truth.
const ROW_LIMIT = 2000;

const COLUMNS = "id, full_name, email, mobile, current_job, created_at, notified_at";

const state = {
  user: null,
  round: null,
  rows: [],
  loadedOk: false, // did the read RETURN? Not: did it return rows.
  query: "",
};

const user = await requireStaff("interest");
if (user) {
  state.user = user;
  renderShell(user, "interest.html");
  wire();
  await load();
}

// ============================================================
// Loading
// ============================================================

function wire() {
  const refresh = document.getElementById("ri-refresh");
  if (refresh) refresh.addEventListener("click", load);

  const search = document.getElementById("ri-q");
  if (search) {
    search.addEventListener("input", function () {
      state.query = search.value.trim().toLowerCase();
      renderTable();
    });
  }
}

async function load() {
  state.loadedOk = false;
  state.rows = [];
  clearNotice();
  setListMessage("Loading&hellip;");

  // The round first, and by slug — the interest rows are joined to it by id,
  // and an id typed into this file would be a value nobody could check.
  const roundRes = await supabase
    .from("hackathons")
    .select("id, slug, name, round_number, status")
    .eq("slug", ROUND_SLUG)
    .maybeSingle();

  if (roundRes.error) {
    fail(
      "Couldn't look up the " + ROUND_SLUG + " round: " + roundRes.error.message,
      "so this list is not empty — it is unknown.",
    );
    return;
  }
  if (!roundRes.data) {
    fail(
      "There is no hackathon round with the slug " + ROUND_SLUG + " in the database.",
      "Registrations are stored against that round, so nothing can be shown until it exists.",
    );
    return;
  }
  state.round = roundRes.data;

  const heading = document.getElementById("ri-round");
  if (heading) {
    heading.textContent = (state.round.name || state.round.slug) +
      (state.round.status ? " — " + state.round.status.replace(/_/g, " ") : "");
  }

  const res = await supabase
    .from("hackathon_interest")
    .select(COLUMNS)
    .eq("hackathon_id", state.round.id)
    .order("created_at", { ascending: false })
    .limit(ROW_LIMIT);

  if (res.error) {
    fail("Couldn't read the registrations: " + res.error.message, hintFor(res.error));
    return;
  }

  state.rows = res.data || [];
  state.loadedOk = true;
  renderStats();
  renderTable();
}

// The two failures an operator will actually hit, told apart so the message
// points at the fix rather than at a PostgREST code.
function hintFor(error) {
  const code = String((error && error.code) || "");
  const message = String((error && error.message) || "");

  if (code === "42P01" || code === "PGRST205" || /schema cache|does not exist/i.test(message)) {
    return "If that says the table is missing or not in the schema cache, migration 0036 " +
      "has not been applied to this database yet.";
  }
  if (code === "42501" || /permission denied|row-level security/i.test(message)) {
    return "That reads as a permissions problem rather than an empty table — check the " +
      "is_staff() policy on hackathon_interest in migration 0036.";
  }
  return "So this list is not empty — it is unknown.";
}

// ============================================================
// Rendering
// ============================================================

function renderStats() {
  const box = document.getElementById("ri-stats");
  if (!box) return;

  // Deliberately not rendered at all when the read failed. A tile reading 0
  // next to an error message is the page arguing with itself, and 0 is the
  // half a reader believes.
  if (!state.loadedOk) {
    box.innerHTML = "";
    return;
  }

  const total = state.rows.length;
  const notified = state.rows.filter(function (r) { return !!r.notified_at; }).length;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = state.rows.filter(function (r) {
    const t = Date.parse(r.created_at);
    return !isNaN(t) && t >= weekAgo;
  }).length;

  box.innerHTML = [
    stat("Registered", String(total), total >= ROW_LIMIT
      ? "The page cap of " + ROW_LIMIT + " was reached — there may be more"
      : "People who asked to hear about this round"),
    stat("In the last 7 days", String(recent), ""),
    stat("Ahmed notified", notified + " of " + total,
      notified === total ? "Every registration was emailed" : (total - notified) + " never sent an email"),
  ].join("");
}

function stat(label, value, sub) {
  return '<div class="ad-stat">' +
    '<div class="ad-stat-label">' + escapeHtml(label) + "</div>" +
    '<div class="ad-stat-value">' + escapeHtml(value) + "</div>" +
    (sub ? '<div class="ad-stat-sub">' + escapeHtml(sub) + "</div>" : "") +
    "</div>";
}

function renderTable() {
  const body = document.querySelector("#ri-table tbody");
  const count = document.getElementById("ri-count");
  if (!body) return;

  // ⚠ The guard that makes the comment at the top of this file true. Anything
  // that reaches the rendering path without a successful read is shown as
  // unknown, never as none.
  if (!state.loadedOk) {
    setListMessage("Nothing loaded &mdash; see the message above for why. This is not the same as nobody having registered.");
    if (count) count.textContent = "";
    return;
  }

  const rows = state.query ? state.rows.filter(matchesQuery) : state.rows;

  if (count) {
    count.textContent = state.query
      ? rows.length + " of " + state.rows.length + " shown"
      : state.rows.length + (state.rows.length === 1 ? " registration" : " registrations");
  }

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="ad-empty">' +
      (state.query
        ? "Nothing matches that search."
        : "Nobody has registered for this round yet. The read succeeded &mdash; the list really is empty.") +
      "</td></tr>";
    return;
  }

  body.innerHTML = rows.map(rowHtml).join("");
}

function matchesQuery(r) {
  const hay = [r.full_name, r.email, r.mobile, r.current_job].join(" ").toLowerCase();
  return hay.indexOf(state.query) !== -1;
}

function rowHtml(r) {
  // Every one of these values was typed by somebody who is not signed in.
  return "<tr>" +
    '<td dir="auto"><strong>' + escapeHtml(r.full_name || "—") + "</strong></td>" +
    "<td>" + escapeHtml(r.email || "—") + "</td>" +
    // dir="auto" and nothing else: a number typed with Arabic-Indic digits is
    // stored as typed and shown as typed, because it is how its owner reads it.
    '<td dir="auto">' + escapeHtml(r.mobile || "—") + "</td>" +
    '<td dir="auto">' + escapeHtml(r.current_job || "—") + "</td>" +
    '<td class="ad-cell-dim">' + escapeHtml(formatWhen(r.created_at)) + "</td>" +
    "<td>" + notifiedPill(r) + "</td>" +
    "</tr>";
}

// `notified_at` is written by register-interest only once the mail function
// has accepted the message, so a blank here means the email genuinely did not
// go — the registration is still real and still needs following up. That is
// worth a colour rather than a dash.
function notifiedPill(r) {
  if (r.notified_at) {
    return '<span class="ad-pill ok">emailed</span> ' +
      '<span class="ad-cell-dim">' + escapeHtml(formatWhen(r.notified_at)) + "</span>";
  }
  return '<span class="ad-pill warn">not emailed</span> ' +
    '<span class="ad-cell-dim">follow this one up by hand</span>';
}

function formatWhen(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) +
    ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// ============================================================
// Saying what went wrong, where the reader is looking
// ============================================================

function fail(what, hint) {
  notice(what + " " + hint, "err");
  // The list says it too. A message at the top of the page is invisible to
  // somebody scrolled down to the table they came for.
  setListMessage("Nothing loaded &mdash; see the message above. This is not the same as nobody having registered.");
  const stats = document.getElementById("ri-stats");
  if (stats) stats.innerHTML = "";
  const count = document.getElementById("ri-count");
  if (count) count.textContent = "";
}

function notice(text, kind) {
  const box = document.getElementById("ri-notice");
  if (box) box.innerHTML = '<div class="ad-msg ' + kind + '">' + escapeHtml(text) + "</div>";
}

function clearNotice() {
  const box = document.getElementById("ri-notice");
  if (box) box.innerHTML = "";
}

function setListMessage(html) {
  const body = document.querySelector("#ri-table tbody");
  if (body) body.innerHTML = '<tr><td colspan="6" class="ad-empty">' + html + "</td></tr>";
}
