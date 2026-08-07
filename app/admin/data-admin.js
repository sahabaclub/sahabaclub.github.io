// Sahaba Club — admin, data management
// ------------------------------------------------------------
// The screen behind Ahmed's request: "I want full control of my users data
// from the control panel … the control to add or edit data based on my need
// … organize the data visibility … add data using excel import and export the
// current data … some cases of the current users of Microsoft 365 not mapped
// to the personal email".
//
// ⚠ THIS FILE IS A CONVENIENCE, NOT A BOUNDARY, and on this page in particular
// that sentence has to be true rather than merely written. Everything here is
// something the same account could do with a REST call:
//
//   * it reads `marketing_contacts`, `profiles` and `contact_link_status`,
//     each of which is `is_staff()`-gated in the database — the last one
//     inside its own body, because it reads with the owner's rights;
//   * it writes NOTHING directly. Every save goes through a `security definer`
//     function that checks `is_staff()` on its first line (migration 0033).
//     `profiles` has had its table-wide UPDATE revoked from `authenticated`
//     since 0002 and this page did not widen that allowlist to get around it;
//   * import and export go through the `data-admin` Edge Function, which runs
//     them with the caller's own JWT so the database sees the real person;
//   * every write is recorded by a trigger, not by this file. Deleting a line
//     here does not stop the audit.
//
// Never move a check out of the database and rely on this file.
import { supabase } from "../../lib/supabase-client.js?v=1696b16761";
import { requireStaff, renderShell, escapeHtml, formatDate, showMessage, clearMessage }
  from "../../lib/admin-guard.js?v=1696b16761";

const DATASETS = {
  marketing_contacts: {
    key: "id",
    label: "Marketing contacts",
    note: "People who have engaged with the club. Most of them have never signed up.",
    // Kept in step with `data_admin_fields` by hand, and only for the table
    // header: the editor and the importer both read the catalogue itself.
    defaultColumns: ["full_name", "email", "country", "sahaba_mailbox", "engagement_count"],
    searchable: ["full_name", "email", "phone_raw", "university_or_company", "sahaba_mailbox"],
    segments: [
      { v: "all", l: "Everyone" },
      { v: "needs_email", l: "Needs a personal email" },
      { v: "mailbox", l: "Has a Microsoft 365 mailbox" },
      { v: "linked", l: "Joined the site" },
      { v: "unsubscribed", l: "Unsubscribed or bounced" },
      { v: "test", l: "Test records" },
    ],
  },
  profiles: {
    key: "user_id",
    label: "Members",
    note: "Everyone with an account. Members cannot be created here — only a real signup creates an account.",
    defaultColumns: ["full_name", "headline", "country", "industry", "is_discoverable"],
    searchable: ["full_name", "headline", "bio", "company", "position", "city", "country"],
    segments: [
      { v: "all", l: "Everyone" },
      { v: "discoverable", l: "Visible in Connect" },
      { v: "hidden", l: "Not in Connect" },
      { v: "incomplete", l: "Profile unfinished" },
    ],
  },
};

const state = {
  user: null,
  dataset: "marketing_contacts",
  tab: "fix",
  fields: [],            // from data_field_stats()
  rows: [],              // the table itself
  linkStatus: [],        // contact_link_status, contacts only
  linkStatusOk: false,   // did that read SUCCEED? empty and failed are not the same
  columns: [],           // which columns the table shows
  limit: 100,
  total: null,           // rows in the table itself, from data_field_stats
  editing: null,
  plan: null,            // the dry run currently on screen
  planFileName: "",
  planCsv: "",
};

// Declared before the top-level await below, because `loadDataset` reads it on
// its first line and `const` bindings are not available before their
// declaration is evaluated. See the note above `loadDataset` itself.
const ROW_LIMIT = 3000;

// PostgREST caps one response at its own max-rows (1000 here) whatever `limit`
// asks for, so reads are paged in batches of this size up to ROW_LIMIT.
const PAGE_ROWS = 1000;

// Only read from the keyboard handler, so it was never actually reachable
// during module evaluation — but it lives here anyway so that
// `tools/check-dead-zone.mjs` can enforce one flat rule with no judgement
// calls: every module constant is declared before anything runs. Two
// dead-zone bugs in this file in one afternoon is enough evidence that
// "is this one reachable?" is not a question worth asking each time.
const TAB_ORDER = ["fix", "browse", "fields", "import", "export", "history"];

const user = await requireStaff("data");
if (user) {
  state.user = user;
  renderShell(user, "data.html");
  wire();
  await loadDataset();
}

// ============================================================
// Loading
// ============================================================

// ⚠ EVERY NUMBER ON THIS PAGE IS COMPUTED FROM THE ROWS THE BROWSER HOLDS.
// The stat tiles, the segment counts, the search, and — the one that matters —
// the key list an export is built from all read `state.rows`. So a cap here is
// not "the table is paged", it is "every count on this screen is wrong and
// nothing says so". The cap stays, because 2,200 rows of ~30 columns is
// already several megabytes of personal data in a tab and the alternative is a
// rewrite onto server-side paging; what changes is that exceeding it is now
// stated, in the one place the operator cannot miss, rather than silently
// truncating.
//
// `data_field_stats` already returns the real `count(*)` of the table, so the
// comparison costs nothing extra — and it is exact, rather than the usual
// "we got back exactly the limit, so there is probably more" guess.
//
// ⚠ ROW_LIMIT is declared ABOVE the top-level `await loadDataset()`, not here.
// It was here, and `const` is not hoisted the way `function` is: the module
// body ran `loadDataset()` first, hit the temporal dead zone on the very first
// query, and threw `Cannot access 'ROW_LIMIT' before initialization` before a
// single request left the browser. The page then sat on its placeholders with
// no data and no failed request to point at. Anything `loadDataset` reads at
// call time has to be initialised before line 80.

// ⚠ PostgREST caps a single response at its own `max-rows` setting — 1000 on
// this project — no matter what `limit` the client asks for. So
// `.limit(3000)` returned 1000 and the page could not tell that from "there
// are only 1000 rows": it reported "showing 1000 of 1134, the browser loads at
// most 3000 and the club has passed that", which is three claims of which only
// the first is true. Measured in the browser, not deduced — the request said
// limit=3000 and 1000 rows came back.
//
// It mattered beyond the wording. Every count on this page is computed from
// the rows the browser holds, so "6 people need a personal email" was six out
// of the first thousand, with 134 records never examined. An undercount on
// that particular tile is people who cannot sign in and do not appear on the
// list of people who cannot sign in.
//
// Paging explicitly is the fix. A stable sort key is required or `range()`
// windows can overlap and miss rows between requests — the same defect 0028
// paid for with `sort_id`.
//
// PAGE_ROWS lives up with ROW_LIMIT, above the top-level await, for the reason
// written there. It was declared here first and threw the same dead-zone error
// the constant above had just been moved to escape.
async function readAllRows(table, orderBy) {
  const rows = [];
  for (let from = 0; from < ROW_LIMIT; from += PAGE_ROWS) {
    const to = Math.min(from + PAGE_ROWS, ROW_LIMIT) - 1;
    const res = await supabase.from(table).select("*").order(orderBy).range(from, to);
    if (res.error) return { data: null, error: res.error };
    const batch = res.data || [];
    rows.push(...batch);
    if (batch.length < to - from + 1) break;   // last page
  }
  return { data: rows, error: null };
}

async function loadDataset() {
  const ds = DATASETS[state.dataset];
  document.getElementById("dm-dataset-note").textContent = ds.note;
  state.limit = 100;
  state.rows = [];
  state.linkStatus = [];
  state.total = null;

  // The field catalogue and the populated counts in one call. It is the same
  // list the editor builds itself from and the same list the importer honours,
  // so a field that is not here is a field nothing on this page can write.
  const [fieldRes, rowRes] = await Promise.all([
    supabase.rpc("data_field_stats", { p_table: state.dataset }),
    readAllRows(state.dataset, ds.key),
  ]);

  if (fieldRes.error) {
    warn(
      "Couldn't read the field catalogue: " + fieldRes.error.message +
      " — if this says the function does not exist, migration 0033 has not been applied yet.",
      "err",
    );
    stopLoading("the field catalogue could not be read");
    return;
  }
  if (rowRes.error) {
    warn("Couldn't read " + ds.label.toLowerCase() + ": " + rowRes.error.message, "err");
    stopLoading("the records could not be read");
    return;
  }

  state.fields = fieldRes.data || [];
  state.rows = rowRes.data || [];
  // Every catalogue row carries the same `count(*)`; the first one will do.
  state.total = state.fields.length ? Number(state.fields[0].total) : null;
  state.columns = ds.defaultColumns.filter((c) => state.fields.some((f) => f.column_name === c));

  // ⚠ Whether this read SUCCEEDED is not the same question as whether it
  // returned rows, and this panel is the one place where confusing the two is
  // dangerous. An empty list renders as "Nobody in this state. That is the
  // good outcome." — a sentence that must never be produced by a failed read.
  // `contact_link_status` is `where public.is_staff()` over the whole contact
  // table, so it returns everything or nothing; nothing is far more likely to
  // mean "the view is missing or the predicate was false" than "every record
  // is healthy".
  state.linkStatusOk = false;
  if (state.dataset === "marketing_contacts") {
    const link = await readAllRows("contact_link_status", "id");
    if (link.error) {
      warn(
        "Couldn't read the Microsoft 365 mapping: " + link.error.message +
        " — if this says the relation does not exist, migration 0033 is not fully applied.",
        "err",
      );
    } else {
      state.linkStatus = link.data || [];
      state.linkStatusOk = true;
    }
  }

  renderTruncation();
  renderSegments();
  renderStats();
  renderFix();
  renderFields();
  renderColumnPickers();
  renderTable();
  renderImportScope();
  loadLogs();
}

async function loadLogs() {
  const [audit, exports] = await Promise.all([
    supabase.from("data_admin_audit").select("*")
      .eq("table_name", state.dataset).order("occurred_at", { ascending: false }).limit(150),
    supabase.from("data_export_log").select("*")
      .order("exported_at", { ascending: false }).limit(50),
  ]);
  renderAudit(audit.error ? null : (audit.data || []), audit.error);
  renderExportLog(exports.error ? [] : (exports.data || []));
}

// ============================================================
// "You are not looking at everybody"
// ============================================================
//
// Said out loud, and left on screen, because the alternative is a page whose
// every number is quietly wrong. Nothing here is a guess: `state.total` is the
// database's own `count(*)`.
function renderTruncation() {
  const box = document.getElementById("dm-truncation");
  const ds = DATASETS[state.dataset];
  const total = state.total;
  const got = state.rows.length;

  if (total === null || !Number.isFinite(total) || got >= total) {
    box.innerHTML = "";
    return;
  }

  box.innerHTML =
    '<div class="ad-msg warn">' +
      "<strong>This page is showing " + got + " of " + total + " " +
      escapeHtml(ds.label.toLowerCase()) + ".</strong> " +
      "The page reads in batches and stops at " + ROW_LIMIT + " records, because beyond that it is " +
      "several megabytes of personal data sitting in a browser tab. " +
      "Everything computed from the list &mdash; the counts above, the search, the segments, and " +
      "<em>the records an export contains</em> &mdash; covers those " + got + " only. " +
      "Export with <em>the whole table</em> ticked to get all " + total + ", and treat the tiles above as " +
      "a count of what is loaded rather than of the club. Raising " + ROW_LIMIT + " is a one-line change; " +
      "showing everything without holding it all at once is not." +
    "</div>";
}

// ============================================================
// Stat tiles
// ============================================================

function renderStats() {
  let tiles;

  if (state.dataset === "marketing_contacts") {
    // Three of these five are computed from `contact_link_status`. If that read
    // failed they are not zero, they are unknown — and a tile reading 0 next to
    // the words "needs a personal email" is an all-clear nobody measured.
    const ok = state.linkStatusOk;
    const withBox = ok ? state.linkStatus.filter((c) => c.sahaba_mailbox).length : "—";
    const needsEmail = ok ? needsEmailRows().length : "—";
    const orphanAccounts = ok
      ? state.linkStatus.filter((c) => c.link_state === "account_exists").length : "—";
    tiles = [
      // The one tile that can be honest whatever the browser holds: it is the
      // database's own count, not a length of a truncated array.
      { l: "contacts", v: state.total === null ? state.rows.length : state.total },
      { l: "has a mailbox", v: withBox },
      { l: "needs a personal email", v: needsEmail, warn: ok && needsEmail > 0 },
      { l: "signed up, not linked", v: orphanAccounts, warn: ok && orphanAccounts > 0 },
      { l: "unsubscribed", v: state.rows.filter((r) => r.unsubscribed_at).length },
    ];
  } else {
    tiles = [
      { l: "members", v: state.total === null ? state.rows.length : state.total },
      { l: "in Connect", v: state.rows.filter((r) => r.is_discoverable).length },
      { l: "wrote a bio", v: state.rows.filter((r) => (r.bio || "").trim()).length },
      { l: "finished onboarding", v: state.rows.filter((r) => r.onboarding_completed_at).length },
    ];
  }

  document.getElementById("dm-stats").innerHTML = tiles.map((s) =>
    '<div class="ad-stat">' +
    '<div class="ad-stat-label">' + escapeHtml(s.l) + "</div>" +
    '<div class="ad-stat-value"' + (s.warn ? ' style="color:var(--ad-warn);"' : "") + ">" + s.v + "</div>" +
    "</div>"
  ).join("");
}

// ============================================================
// The Microsoft 365 mapping
// ============================================================
//
// ⚠ The whole point of this section, and the sentence to keep in mind while
// changing it: `link_contact_to_user` runs ONCE, at signup. Somebody who has
// already signed up will never be matched again by anything automatic, so
// saving an address here has to re-run it explicitly — which is what
// `admin_update_contact` does. Without that, Ahmed types an address, presses
// save, and nothing happens anywhere, which is indistinguishable from the
// feature being broken.

// The population the request is about: a mailbox on record, and no address
// they could actually sign in with. `email_state` is computed in the database
// (0033 §5) rather than here, so the count on this page and the count in a
// verification query cannot disagree.
function needsEmailRows() {
  return state.linkStatus.filter((c) =>
    c.sahaba_mailbox && c.email_state !== "personal" && !c.linked_user_id);
}

function renderFix() {
  const wrap = document.getElementById("dm-fix-list");
  if (state.dataset !== "marketing_contacts") {
    wrap.innerHTML = '<p class="ad-empty">This only applies to marketing contacts.</p>';
    document.getElementById("dm-fix-count").textContent = "";
    document.getElementById("dm-count-fix").textContent = "";
    return;
  }

  // Never let a failed read wear the clothes of a clean bill of health.
  if (!state.linkStatusOk) {
    wrap.innerHTML = msg(
      "The Microsoft 365 mapping could not be read, so this list is not empty — it is unknown. " +
      "See the message at the top of this page. Nothing here should be taken as \"nobody needs fixing\".",
      "err",
    );
    document.getElementById("dm-fix-count").textContent = "unknown";
    document.getElementById("dm-count-fix").textContent = "";
    return;
  }

  const filter = document.getElementById("dm-fix-filter").value;
  let list;
  if (filter === "needs_email") list = needsEmailRows();
  else if (filter === "account_exists") list = state.linkStatus.filter((c) => c.link_state === "account_exists");
  else list = state.linkStatus.filter((c) => c.sahaba_mailbox);

  list = list.slice().sort((a, b) => (b.engagement_count || 0) - (a.engagement_count || 0));

  document.getElementById("dm-fix-count").textContent = list.length + " people";
  const needs = needsEmailRows().length;
  document.getElementById("dm-count-fix").textContent = needs ? String(needs) : "";

  if (!list.length) {
    wrap.innerHTML = '<p class="ad-empty">Nobody in this state. That is the good outcome.</p>';
    return;
  }

  wrap.innerHTML = list.slice(0, 200).map((c) => {
    const badge = c.linked_user_id
      ? '<span class="ad-pill ok">linked</span>'
      : c.link_state === "account_exists"
        ? '<span class="ad-pill warn">signed up, not linked</span>'
        : '<span class="ad-pill muted">no account yet</span>';

    // The sentence that tells the operator which of the two cases they are in
    // BEFORE they type, rather than explaining it afterwards.
    const what = c.linked_user_id
      ? "Already linked" + (c.has_ms365_account ? " and their mailbox is claimed." : ". They will be offered their mailbox on their next visit.")
      : c.link_state === "account_exists"
        ? "They have already signed up, so the automatic match has been and gone. Saving an address here re-runs it now."
        : "Nobody has signed up with this record yet. Saving an address here means they are matched the moment they do.";

    const current = c.email_state === "personal" ? c.email
      : c.email_state === "is_mailbox" ? "(only their mailbox is on record)"
        : "(no address on record)";

    return '<div class="dm-plan-row">' +
      '<div class="dm-fix">' +
        "<div>" +
          '<div class="ad-cell-strong">' + escapeHtml(c.full_name || "(no name recorded)") + " " + badge + "</div>" +
          '<div class="dm-mailbox">' + escapeHtml(c.sahaba_mailbox || "—") + "</div>" +
          '<div class="ad-cell-dim">' + escapeHtml(current) + " · " + (c.engagement_count || 0) + " engagements</div>" +
          '<div class="ad-cell-dim" style="margin-top:4px;">' + escapeHtml(what) + "</div>" +
        "</div>" +
        '<div><input type="email" placeholder="their personal email" data-fix-input="' + escapeHtml(c.id) + '"' +
          (c.email_state === "personal" ? ' value="' + escapeHtml(c.email || "") + '"' : "") +
          ' aria-label="Personal email for ' + escapeHtml(c.full_name || "this contact") + '"></div>' +
        "<div style=\"display:flex;gap:8px;\">" +
          '<button class="ad-btn ad-btn-sm ad-btn-primary" type="button" data-fix-save="' + escapeHtml(c.id) + '">Save</button>' +
          (c.link_state === "account_exists" && !c.linked_user_id
            ? '<button class="ad-btn ad-btn-sm" type="button" data-fix-link="' + escapeHtml(c.id) + '">Link now</button>'
            : "") +
        "</div>" +
      "</div>" +
      '<div data-fix-msg="' + escapeHtml(c.id) + '"></div>' +
    "</div>";
  }).join("") + (list.length > 200
    ? '<p class="ad-empty">Showing the 200 most engaged of ' + list.length + ". Use Browse &amp; edit for the rest.</p>"
    : "");

  wrap.querySelectorAll("[data-fix-save]").forEach((b) => {
    b.addEventListener("click", () => saveFixEmail(b.getAttribute("data-fix-save"), b));
  });
  wrap.querySelectorAll("[data-fix-link]").forEach((b) => {
    b.addEventListener("click", () => linkNow(b.getAttribute("data-fix-link"), b));
  });
}

async function saveFixEmail(id, btn) {
  const input = document.querySelector('[data-fix-input="' + cssEscape(id) + '"]');
  const box = document.querySelector('[data-fix-msg="' + cssEscape(id) + '"]');
  const value = (input.value || "").trim();
  if (!value) { box.innerHTML = msg("Type their personal email address first.", "warn"); return; }

  btn.disabled = true;
  box.innerHTML = msg("Saving, and re-running the match…", "info");

  const { data, error } = await supabase.rpc("admin_update_contact", {
    p_contact_id: id,
    p_patch: { email: value },
  });

  btn.disabled = false;
  if (error) { box.innerHTML = msg(error.message, "err"); return; }

  // The result says what actually happened to the link rather than assuming it
  // worked, because "the address saved but nobody was matched" is a real and
  // perfectly ordinary outcome.
  //
  // ⚠ `ms365_note` is the database's own sentence and is the best one to show —
  // but 0033 returns it as NULL in two ordinary cases: when the address did not
  // actually change, and when the contact has no `sahaba_mailbox` at all (which
  // the "signed up but never linked" filter above is full of). The fallback
  // therefore has to answer for every outcome `admin_link_contact` can report.
  // It previously said "Nobody has signed up with that address yet" for all of
  // them, which told an operator who had just linked somebody the opposite of
  // what had happened.
  const link = (data && data.link) || null;
  const outcome = link && link.outcome;
  const note = (data && data.ms365_note) || {
    linked: "Saved, and linked. Their history is now attached to their account.",
    already_linked: "Saved. They were already linked to an account.",
    no_account: "Saved. Nobody has signed up with either address yet — the match runs by itself the moment they do.",
    no_match: "Saved. No confirmed account uses that address, so there was nothing to link.",
  }[outcome] || (data && data.email_changed === false
    ? "Saved. That is the address already on the record, so the match was not re-run."
    : "Saved.");
  const linkedNow = outcome === "linked" || outcome === "already_linked";
  box.innerHTML = msg(note, linkedNow ? "ok" : "info");

  await refreshRow(id, false);
}

async function linkNow(id, btn) {
  const box = document.querySelector('[data-fix-msg="' + cssEscape(id) + '"]');
  btn.disabled = true;
  box.innerHTML = msg("Re-running the match…", "info");

  const { data, error } = await supabase.rpc("admin_link_contact", { p_contact_id: id });
  btn.disabled = false;
  if (error) { box.innerHTML = msg(error.message, "err"); return; }

  const outcome = (data && data.outcome) || "no_match";
  box.innerHTML = msg({
    linked: "Linked. Their history is now attached to their account.",
    already_linked: "Already linked.",
    no_account: "Nobody has signed up with either address, so there is nothing to link yet.",
    no_match: "No match. The address on this record does not belong to any confirmed account.",
  }[outcome] || outcome, outcome === "linked" || outcome === "already_linked" ? "ok" : "info");

  await refreshRow(id, false);
}

// ⚠ ONE ROW CHANGED, SO ONE ROW IS RE-READ. This used to re-pull the whole of
// `marketing_contacts` AND the whole of `contact_link_status` — up to 6,000
// rows of personal data over the network — after every single-field save, so
// correcting six email addresses in the list above moved 36,000 rows. The
// database has already told us what it did; the only thing this page does not
// know afterwards is the state of the one record it just wrote.
//
// `isNew` is separate because an insert has no row to replace and moves the
// table's count, which the "you are not looking at everybody" banner reads.
//
// The known and accepted staleness: `link_contact_to_user` (0010) links EVERY
// unlinked contact matching the address, so where two records share one
// `sahaba_mailbox` a second row can change too. 0033 §5 documents that edge and
// deliberately keeps it; switching dataset and back re-reads everything.
async function refreshRow(keyValue, isNew) {
  const key = DATASETS[state.dataset].key;
  const id = String(keyValue);

  const reads = [supabase.from(state.dataset).select("*").eq(key, id).maybeSingle()];
  if (state.dataset === "marketing_contacts") {
    reads.push(supabase.from("contact_link_status").select("*").eq("id", id).maybeSingle());
  }
  const [rowRes, linkRes] = await Promise.all(reads);

  if (!rowRes.error && rowRes.data) {
    splice(state.rows, key, rowRes.data);
    if (isNew && state.total !== null) {
      state.total += 1;
      renderTruncation();
    }
  }
  if (linkRes && !linkRes.error && linkRes.data) {
    splice(state.linkStatus, "id", linkRes.data);
  }

  renderStats();
  renderFix();
  renderTable();
  loadLogs();
}

function splice(list, key, row) {
  const at = list.findIndex((r) => String(r[key]) === String(row[key]));
  if (at === -1) list.unshift(row); else list[at] = row;
}

// ============================================================
// Browse and edit
// ============================================================

function renderSegments() {
  const sel = document.getElementById("dm-seg");
  sel.innerHTML = DATASETS[state.dataset].segments
    .map((s) => '<option value="' + s.v + '">' + escapeHtml(s.l) + "</option>").join("");
  document.getElementById("dm-q").placeholder =
    "Search " + DATASETS[state.dataset].label.toLowerCase() + "…";
  document.getElementById("dm-new").classList.toggle("ad-hidden", state.dataset !== "marketing_contacts");
}

function linkFor(id) {
  return state.linkStatus.find((c) => c.id === id) || {};
}

function visibleRows() {
  const q = document.getElementById("dm-q").value.trim().toLowerCase();
  const seg = document.getElementById("dm-seg").value;
  const ds = DATASETS[state.dataset];

  return state.rows.filter((r) => {
    if (state.dataset === "marketing_contacts") {
      if (seg === "needs_email") {
        const l = linkFor(r.id);
        if (!(l.sahaba_mailbox && l.email_state !== "personal" && !l.linked_user_id)) return false;
      }
      if (seg === "mailbox" && !r.sahaba_mailbox) return false;
      if (seg === "linked" && !r.linked_user_id) return false;
      if (seg === "unsubscribed" && !(r.unsubscribed_at || r.bounced_at)) return false;
      if (seg === "test" && !r.is_test) return false;
    } else {
      if (seg === "discoverable" && !r.is_discoverable) return false;
      if (seg === "hidden" && r.is_discoverable) return false;
      if (seg === "incomplete" && r.onboarding_completed_at) return false;
    }
    if (!q) return true;
    return ds.searchable.map((c) => r[c]).filter(Boolean).join(" ").toLowerCase().includes(q);
  });
}

function renderTable() {
  const rows = visibleRows();
  const key = DATASETS[state.dataset].key;

  document.getElementById("dm-browse-count").textContent =
    rows.length === state.rows.length ? state.rows.length + " records" : rows.length + " of " + state.rows.length;

  document.querySelector("#dm-table thead tr").innerHTML =
    state.columns.map((c) => "<th>" + escapeHtml(labelOf(c)) + "</th>").join("") + "<th></th>";

  document.querySelector("#dm-table tbody").innerHTML = rows.slice(0, state.limit).map((r) =>
    "<tr>" + state.columns.map((c) => "<td>" + cell(r, c) + "</td>").join("") +
    '<td><button class="ad-btn ad-btn-sm" type="button" data-edit="' + escapeHtml(String(r[key])) + '">Edit</button></td>' +
    "</tr>"
  ).join("");

  document.getElementById("dm-browse-empty").classList.toggle("ad-hidden", rows.length > 0);
  document.getElementById("dm-more-wrap").style.display = rows.length > state.limit ? "" : "none";

  document.querySelectorAll("[data-edit]").forEach((b) => {
    b.addEventListener("click", () => openEditor(b.getAttribute("data-edit")));
  });
}

function labelOf(col) {
  const f = state.fields.find((x) => x.column_name === col);
  return f ? f.label : col;
}

function cell(row, col) {
  const f = state.fields.find((x) => x.column_name === col);
  const v = row[col];

  if (v === null || v === undefined || v === "") return '<span class="ad-cell-dim">—</span>';
  if (f && f.kind === "bool") {
    return v ? '<span class="ad-pill ok">yes</span>' : '<span class="ad-pill muted">no</span>';
  }
  if (Array.isArray(v)) {
    return v.length ? escapeHtml(v.join(", ")) : '<span class="ad-cell-dim">—</span>';
  }
  if (f && f.kind === "timestamp") return formatDate(v);
  if (typeof v === "object") return '<span class="ad-cell-dim">' + escapeHtml(JSON.stringify(v)) + "</span>";

  const s = String(v);
  return escapeHtml(s.length > 90 ? s.slice(0, 90) + "…" : s);
}

function renderColumnPickers() {
  const pick = document.getElementById("dm-col-picker");
  pick.innerHTML = state.fields.map((f) =>
    '<label class="dm-col-pick"><input type="checkbox" data-col="' + escapeHtml(f.column_name) + '"' +
    (state.columns.includes(f.column_name) ? " checked" : "") + "> " + escapeHtml(f.label) + "</label>"
  ).join("");

  pick.querySelectorAll("[data-col]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const c = cb.getAttribute("data-col");
      state.columns = cb.checked
        ? state.columns.concat([c])
        : state.columns.filter((x) => x !== c);
      renderTable();
    });
  });

  // ⚠ The export starts from the columns ON SCREEN, not from everything. The
  // opposite default would mean every export carried email addresses, phone
  // numbers and dates of birth whether or not the job needed them — and the
  // easiest thing to do is always the thing people do. The record key is added
  // by the Edge Function regardless, because a file without it cannot be
  // edited and imported back.
  const exp = document.getElementById("dm-exp-cols");
  exp.innerHTML = state.fields.map((f) =>
    '<label class="dm-col-pick"><input type="checkbox" data-expcol="' + escapeHtml(f.column_name) + '"' +
    (state.columns.includes(f.column_name) ? " checked" : "") + "> " + escapeHtml(f.label) + "</label>"
  ).join("");
}

// ============================================================
// The row editor
// ============================================================
//
// Built from the field catalogue rather than from a hand-written form, so a
// field that migration 0033 marks as not editable has no input rendered for it
// — and, more importantly, so the read-only ones are still SHOWN, with the
// reason, instead of quietly missing.

function openEditor(keyValue) {
  const key = DATASETS[state.dataset].key;
  const row = keyValue === null
    ? null
    : state.rows.find((r) => String(r[key]) === String(keyValue));
  if (keyValue !== null && !row) return;

  state.editing = { key: keyValue, row: row };
  clearMessage("dm-edit-msg");
  document.getElementById("dm-edit-warnings").innerHTML = "";

  const isNew = keyValue === null;
  document.getElementById("dm-edit-title").textContent = isNew
    ? "New contact"
    : (row.full_name || row.email || "Record");
  document.getElementById("dm-edit-sub").textContent = isNew
    ? "They will be matched against any existing account as soon as you save."
    : DATASETS[state.dataset].label + " · " + String(row[key]);

  if (!isNew && state.dataset === "marketing_contacts") {
    const l = linkFor(row.id);
    const notes = [];
    if (l.email_state === "is_mailbox") {
      notes.push("The only address on this record is their Microsoft 365 mailbox, so they can never be matched by a normal sign-in. Their personal address is the field to fill in.");
    }
    if (l.link_state === "account_exists" && !l.linked_user_id) {
      notes.push("Somebody has already signed up with one of these addresses but this record was never linked to them. Saving an email re-runs the match.");
    }
    if (row.unsubscribed_at) notes.push("Unsubscribed. Do not include them in any send.");
    document.getElementById("dm-edit-warnings").innerHTML =
      notes.map((n) => '<div class="ad-msg warn">' + escapeHtml(n) + "</div>").join("");
  }

  const editable = state.fields.filter((f) => f.editable && (!isNew || f.column_name !== "id"));
  const plain = editable.filter((f) => !f.visibility_control);
  const vis = editable.filter((f) => f.visibility_control);
  const readOnly = state.fields.filter((f) => !f.editable);

  const parts = [];
  parts.push(group("Details", plain.map((f) => field(f, row)).join("")));
  if (vis.length) {
    parts.push(group(
      "What other people can see",
      '<p class="dm-note" style="margin-bottom:12px;">These decide whether this person appears to other members, and whether the club may write to them.</p>' +
      vis.map((f) => field(f, row)).join("")));
  }
  if (readOnly.length && !isNew) {
    parts.push(group(
      "Not editable here",
      '<dl class="dm-readonly-grid">' + readOnly.map((f) =>
        "<dt>" + escapeHtml(f.label) + "</dt><dd>" + cell(row, f.column_name) +
        (f.note ? '<div class="ad-cell-dim">' + escapeHtml(f.note) + "</div>" : "") +
        "</dd>").join("") + "</dl>"));
  }

  document.getElementById("dm-edit-body").innerHTML = parts.join("");
  document.getElementById("dm-modal-back").classList.remove("ad-hidden");
}

function group(title, inner) {
  return '<div class="dm-editor-group"><h3>' + escapeHtml(title) + "</h3>" + inner + "</div>";
}

function field(f, row) {
  const v = row ? row[f.column_name] : null;
  const id = "dmf-" + f.column_name;
  const authored = f.member_authored
    ? '<span class="dm-authored" title="Written by the member themselves">member-written</span>' : "";

  if (f.kind === "bool") {
    return '<label class="ad-check"><input type="checkbox" id="' + id + '" data-f="' + escapeHtml(f.column_name) + '"' +
      (v ? " checked" : "") + "> <span>" + escapeHtml(f.label) + authored +
      (f.note ? '<div class="ad-cell-dim">' + escapeHtml(f.note) + "</div>" : "") + "</span></label>";
  }

  const val = Array.isArray(v) ? v.join("; ")
    : (v && typeof v === "object") ? JSON.stringify(v)
      : (v === null || v === undefined) ? "" : String(v);

  const input = f.kind === "longtext"
    ? '<textarea id="' + id + '" data-f="' + escapeHtml(f.column_name) + '">' + escapeHtml(val) + "</textarea>"
    : '<input id="' + id + '" data-f="' + escapeHtml(f.column_name) + '" type="' +
      (f.kind === "email" ? "email" : f.kind === "date" ? "text" : "text") +
      '" value="' + escapeHtml(val) + '"' +
      (f.kind === "date" ? ' placeholder="YYYY-MM-DD"' : "") + ">";

  const hint = f.kind === "text[]" ? "Separate with semicolons."
    : f.kind === "date" ? "Written as YYYY-MM-DD. Anything else is refused rather than guessed at."
      : f.note || "";

  return '<div class="ad-field"><label for="' + id + '">' + escapeHtml(f.label) + authored + "</label>" +
    input + (hint ? '<span class="ad-hint">' + escapeHtml(hint) + "</span>" : "") + "</div>";
}

async function saveEditor() {
  const btn = document.getElementById("dm-edit-save");
  const isNew = state.editing.key === null;
  const row = state.editing.row;

  // Only what actually changed. Sending the whole form would write an audit
  // entry naming every field on the record every time somebody fixed a typo,
  // which would make the audit useless for the thing it is for.
  const patch = {};
  document.querySelectorAll("#dm-edit-body [data-f]").forEach((el) => {
    const col = el.getAttribute("data-f");
    const f = state.fields.find((x) => x.column_name === col);
    const now = el.type === "checkbox" ? (el.checked ? "true" : "false") : el.value.trim();

    let before = row ? row[col] : null;
    if (Array.isArray(before)) before = before.join("; ");
    else if (before && typeof before === "object") before = JSON.stringify(before);
    else if (f && f.kind === "bool") before = before ? "true" : "false";
    else before = before === null || before === undefined ? "" : String(before);

    if (now !== before) patch[col] = now;
  });

  if (!isNew && !Object.keys(patch).length) {
    showMessage("dm-edit-msg", "Nothing changed.", "info");
    return;
  }

  btn.disabled = true;
  showMessage("dm-edit-msg", "Saving…", "info");

  const { data, error } = isNew
    ? await supabase.rpc("admin_create_contact", { p_patch: patch })
    : await supabase.rpc(
      state.dataset === "profiles" ? "admin_update_profile" : "admin_update_contact",
      state.dataset === "profiles"
        ? { p_user_id: state.editing.key, p_patch: patch }
        : { p_contact_id: state.editing.key, p_patch: patch });

  btn.disabled = false;
  if (error) { showMessage("dm-edit-msg", error.message, "err"); return; }

  // `admin_create_contact` returns the id it minted; the update functions echo
  // the key back. Either way the one row to re-read is known, so nothing here
  // needs the whole table again.
  const savedKey = isNew ? (data && data.id) : state.editing.key;
  const link = (data && data.link) || null;

  closeEditor();

  // `ms365_note` is only written by the update path. A create says nothing
  // about the mailbox, so the link outcome is reported instead of a bare
  // "Saved." that leaves the operator guessing whether the match ran.
  const note = (data && data.ms365_note) || (isNew
    ? ({
      linked: "Contact added, and linked to the account that already uses that address.",
      no_account: "Contact added. Nobody has signed up with that address yet — the match runs by itself when they do.",
      no_match: "Contact added. No confirmed account uses that address, so nothing was linked.",
    }[link && link.outcome] || "Contact added.")
    : "Saved.");
  warn(note, "ok");

  if (savedKey) await refreshRow(savedKey, isNew);
  else await loadDataset();
}

function closeEditor() {
  document.getElementById("dm-modal-back").classList.add("ad-hidden");
  state.editing = null;
}

// ============================================================
// Fields
// ============================================================

function renderFields() {
  document.getElementById("dm-fields-title").textContent =
    DATASETS[state.dataset].label + " — " + state.fields.length + " fields";

  document.querySelector("#dm-fields-table tbody").innerHTML = state.fields.map((f) => {
    const pct = f.total ? Math.round((f.populated / f.total) * 100) : 0;
    const who = f.member_authored
      ? '<span class="ad-pill warn">the member</span>'
      : f.editable
        ? '<span class="ad-pill ok">staff</span>'
        : '<span class="ad-pill muted">the system</span>';

    return "<tr>" +
      "<td><span class=\"ad-cell-strong\">" + escapeHtml(f.label) + "</span>" +
        '<div class="ad-cell-dim" style="font-family:var(--ad-mono);">' + escapeHtml(f.column_name) + "</div>" +
        (f.visibility_control ? ' <span class="ad-pill warn">visibility</span>' : "") + "</td>" +
      '<td><span class="ad-cell-dim">' + escapeHtml(f.kind) + "</span></td>" +
      '<td><div class="dm-pop"><div class="dm-bar"><span style="width:' + pct + '%"></span></div>' +
        '<span class="dm-pop-n">' + f.populated + " / " + f.total + "</span></div></td>" +
      "<td>" + who + "</td>" +
      "<td>" + (f.importable ? '<span class="ad-pill ok">yes</span>' : '<span class="ad-pill muted">no</span>') + "</td>" +
      '<td class="ad-cell-dim">' + escapeHtml(f.note || "") + "</td>" +
    "</tr>";
  }).join("");
}

// ============================================================
// Import
// ============================================================

function renderImportScope() {
  document.getElementById("dm-import-scope").innerHTML = state.dataset === "marketing_contacts"
    ? "<strong>Contacts can be added as well as updated.</strong> A row whose email address is new to the club creates a new contact."
    : "<strong>Members cannot be created from a file, only updated.</strong> A profile needs an account behind it, and only a real signup creates one — inventing accounts for people who never asked would make them reachable by password-reset mail.";
}

// ⚠ THE OPTIONS ARE PART OF THE PLAN HASH, SO PREVIEW AND COMMIT MUST SEND THE
// SAME OBJECT. 0033 computes the confirm token as
// `md5(plan::text || p_options::text || p_table)` and refuses a commit whose
// hash does not match. The preview used to be sent with no `options` key at all
// — which the Edge Function turns into `{}` — while the commit always sent
// `{"overwrite_member_authored": false}`. Those hash differently.
//
// The consequence was total and silent: on the ordinary path — a file with no
// conflicts, where the tick box below stays hidden and is never touched — every
// single Apply was refused with "this is not the change you were shown — re-run
// the preview", and re-running the preview could not fix it, because the
// preview kept sending `{}`. The import worked only if the operator happened to
// tick the overwrite box and untick it again, which is not a workflow, it is a
// coincidence.
//
// One function, called by all three request sites, so they cannot disagree.
function importOptions() {
  return { overwrite_member_authored: document.getElementById("dm-overwrite").checked };
}

async function previewImport(file) {
  const box = "dm-import-msg";
  showMessage(box, "Reading " + file.name + "…", "info");
  const text = await file.text();

  // A new file has its own conflicts, so the decision about somebody else's
  // file does not carry over into this one. Reset before the options are read,
  // or the plan is computed under a setting the operator cannot see.
  document.getElementById("dm-overwrite").checked = false;

  const res = await invoke("import_preview", { csv: text, options: importOptions() });
  if (!res.ok) { showMessage(box, res.error, "err"); return; }

  state.plan = res.data;
  state.planCsv = text;
  state.planFileName = file.name;
  clearMessage(box);
  renderPlan();
}

function renderPlan() {
  const plan = state.plan;
  const counts = plan.counts || {};
  document.getElementById("dm-plan-panel").classList.remove("ad-hidden");
  // A freshly computed plan is appliable again, whatever the last one did.
  document.getElementById("dm-plan-apply").disabled = false;

  const conflicts = (plan.plan || []).filter((p) => Object.keys(p.conflicts || {}).length);
  const raggedNote = (plan.ragged || []).length
    ? '<div class="ad-msg warn">' + plan.ragged.length + " row(s) have the wrong number of columns — usually a quote left open earlier in the file. Line(s): " +
      plan.ragged.map((r) => r.line).join(", ") + "</div>"
    : "";

  document.getElementById("dm-plan-summary").innerHTML =
    '<p class="dm-note"><strong>' + escapeHtml(state.planFileName) + "</strong> — " +
      plan.parsed_rows + " rows read.</p>" +
    '<div class="ad-stats" style="margin-bottom:0;">' + [
      { l: "would be added", v: counts.insert || 0 },
      { l: "would be updated", v: counts.update || 0 },
      { l: "already match", v: counts.unchanged || 0 },
      { l: "conflict", v: conflicts.length, warn: conflicts.length > 0 },
      { l: "rejected", v: counts.rejected || 0, warn: (counts.rejected || 0) > 0 },
    ].map((s) =>
      '<div class="ad-stat"><div class="ad-stat-label">' + s.l + "</div>" +
      '<div class="ad-stat-value"' + (s.warn ? ' style="color:var(--ad-warn);"' : "") + ">" + s.v + "</div></div>"
    ).join("") + "</div>" + raggedNote;

  const owWrap = document.getElementById("dm-overwrite-wrap");
  owWrap.classList.toggle("ad-hidden", conflicts.length === 0);
  document.getElementById("dm-overwrite-label").textContent =
    "Replace what " + conflicts.length + " " + (conflicts.length === 1 ? "person" : "people") +
    " wrote about themselves with what the file says. Read the comparisons below first — this is their own writing.";

  document.getElementById("dm-plan-rows").innerHTML =
    (plan.plan || []).map(planRow).join("") ||
    '<p class="ad-empty">Nothing to show.</p>';
}

function planRow(p) {
  const pill = {
    insert: '<span class="ad-pill ok">add</span>',
    update: '<span class="ad-pill ok">update</span>',
    unchanged: '<span class="ad-pill muted">no change</span>',
    conflict: '<span class="ad-pill warn">conflict</span>',
    rejected: '<span class="ad-pill danger">rejected</span>',
    skipped: '<span class="ad-pill muted">skipped</span>',
  }[p.action] || escapeHtml(p.action);

  const changes = Object.entries(p.changes || {}).map(([col, d]) =>
    "<dt>" + escapeHtml(labelOf(col)) + "</dt><dd>" +
    (d.from === null || d.from === undefined || d.from === ""
      ? '<span class="ad-cell-dim">(empty)</span>'
      : '<span class="dm-was">' + escapeHtml(short(d.from)) + "</span>") +
    '<span class="dm-arrow">→</span><span class="dm-now">' + escapeHtml(short(d.to)) + "</span></dd>"
  ).join("");

  // ⚠ The member's own words first and labelled as theirs. Whoever is about to
  // tick "replace" must read what they are replacing, in their words, not a
  // count of conflicts.
  const conflicts = Object.entries(p.conflicts || {}).map(([col, d]) =>
    "<dt>" + escapeHtml(labelOf(col)) + "</dt><dd>" +
    '<div class="dm-theirs">they wrote: ' + escapeHtml(short(d.theirs)) + "</div>" +
    '<div class="ad-cell-dim">the file says: ' + escapeHtml(short(d.yours)) + "</div></dd>"
  ).join("");

  return '<div class="dm-plan-row">' +
    '<div class="dm-plan-head">' + pill +
      '<span class="dm-plan-key">' + escapeHtml(p.key || "—") + "</span>" +
      '<span class="dm-plan-line">row ' + p.row + (p.keyed_by ? " · matched on " + escapeHtml(p.keyed_by) : "") + "</span>" +
    "</div>" +
    (p.reason ? '<div class="ad-msg err" style="margin-top:0;">' + escapeHtml(p.reason) + "</div>" : "") +
    (changes ? '<dl class="dm-diff">' + changes + "</dl>" : "") +
    (conflicts ? '<dl class="dm-diff" style="margin-top:6px;">' + conflicts + "</dl>" : "") +
  "</div>";
}

function short(v) {
  if (v === null || v === undefined) return "(empty)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
}

async function applyImport() {
  const btn = document.getElementById("dm-plan-apply");
  btn.disabled = true;
  showMessage("dm-import-msg", "Applying…", "info");

  const res = await invoke("import_commit", {
    csv: state.planCsv,
    // ⚠ The hash of the plan that is on screen. If anything has moved
    // underneath it — the file, the options, or one of the records because a
    // colleague edited it — the database refuses rather than applying
    // something the operator has not read.
    plan_hash: state.plan.plan_hash,
    // ⚠ Must be byte-identical to what the preview sent. See `importOptions`.
    options: importOptions(),
  });

  btn.disabled = false;
  if (!res.ok) { showMessage("dm-import-msg", res.error, "err"); return; }

  // `applied` holds one entry per row the plan tried to write, successful or
  // not; `failed` counts the ones the database refused. See 0033's commit loop.
  const failed = res.data.failed || 0;
  const applied = (res.data.applied || []).length;
  showMessage("dm-import-msg",
    applied - failed + " record(s) written" + (failed ? ", " + failed + " refused by the database — see below" : "") + ".",
    failed ? "warn" : "ok");

  // ⚠ A PLAN CAN ONLY BE APPLIED ONCE. The hash is over the plan, and the plan
  // was computed against rows this commit has just changed — so a second press
  // is guaranteed to be refused with "this is not the change you were shown",
  // which reads like a fault rather than like the safety rule it is. Take the
  // button away instead of letting somebody earn that message.
  btn.disabled = true;

  if (failed) {
    document.getElementById("dm-plan-rows").innerHTML =
      (res.data.applied || []).filter((a) => !a.ok).map((a) =>
        '<div class="dm-plan-row"><div class="dm-plan-head">' +
        '<span class="ad-pill danger">refused</span>' +
        '<span class="dm-plan-key">' + escapeHtml(String(a.key)) + "</span>" +
        '<span class="dm-plan-line">row ' + a.row + "</span></div>" +
        '<div class="ad-msg err" style="margin-top:0;">' + escapeHtml(a.error || "") + "</div></div>").join("") +
      '<p class="ad-empty">Fix these rows in the file and choose it again — this plan has been applied and ' +
      "cannot be applied a second time.</p>";
  } else {
    discardPlan();
  }

  // A bulk write changes rows all over the table, so this is the one path where
  // reading everything again is the right amount of work. Once, not twice:
  // `loadDataset` already re-reads the rows, the mapping and the logs.
  await loadDataset();
}

function discardPlan() {
  state.plan = null;
  state.planCsv = "";
  document.getElementById("dm-plan-panel").classList.add("ad-hidden");
  document.getElementById("dm-file").value = "";
  // Part of the plan, so it goes with the plan. Left ticked it would silently
  // become the setting the next file's preview is computed under.
  document.getElementById("dm-overwrite").checked = false;
  document.getElementById("dm-plan-apply").disabled = false;
}

// ============================================================
// Export
// ============================================================

async function doExport() {
  const box = "dm-export-msg";
  const all = document.getElementById("dm-exp-all").checked;
  const columns = [...document.querySelectorAll("[data-expcol]")]
    .filter((cb) => cb.checked).map((cb) => cb.getAttribute("data-expcol"));

  if (!columns.length) { showMessage(box, "Choose at least one column.", "warn"); return; }

  const rows = visibleRows();
  if (!all && !rows.length) { showMessage(box, "The list you are looking at is empty.", "warn"); return; }

  const key = DATASETS[state.dataset].key;
  const seg = document.getElementById("dm-seg");
  const q = document.getElementById("dm-q").value.trim();

  showMessage(box, "Preparing " + (all ? "the whole table" : rows.length + " records") + "…", "info");

  const res = await invoke("export", {
    scope: all ? "all" : "filtered",
    // ⚠ The exact keys on screen, not a description of the filter. A filter
    // re-run on the server would drift from the one in front of the operator,
    // and the first time it drifted they would export a different set of
    // people without any sign of it.
    keys: all ? [] : rows.map((r) => String(r[key])),
    columns,
    text_safe: document.getElementById("dm-exp-safe").checked,
    filter_label: all
      ? "the whole table"
      : seg.options[seg.selectedIndex].text + (q ? ' matching "' + q + '"' : ""),
  });

  if (!res.ok) { showMessage(box, res.error, "err"); return; }

  // The BOM is already the first character of the string; a Blob built from a
  // JS string is encoded as UTF-8, so it lands in the file as EF BB BF.
  const blob = new Blob([res.data.csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = res.data.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  showMessage(box, res.data.row_count + " records exported, and recorded in the log below.", "ok");
  await loadLogs();
}

function renderExportLog(rows) {
  document.querySelector("#dm-export-log tbody").innerHTML = rows.length
    ? rows.map((r) =>
      "<tr>" +
      '<td class="dm-log-when">' + escapeHtml(new Date(r.exported_at).toLocaleString("en-GB")) + "</td>" +
      "<td>" + escapeHtml(r.actor_email || "—") + "</td>" +
      "<td>" + escapeHtml(r.dataset) +
        '<div class="ad-cell-dim">' + escapeHtml(r.filter_label || "") + "</div></td>" +
      '<td class="ad-num">' + r.row_count + "</td>" +
      "<td>" + (r.includes_email ? '<span class="ad-pill warn">email</span> ' : "") +
        (r.includes_phone ? '<span class="ad-pill warn">phone</span>' : "") +
        (!r.includes_email && !r.includes_phone ? '<span class="ad-cell-dim">—</span>' : "") + "</td>" +
      "</tr>").join("")
    : '<tr><td colspan="5" class="ad-empty">Nothing exported yet.</td></tr>';
}

// ============================================================
// The audit trail
// ============================================================

function renderAudit(rows, error) {
  const box = document.getElementById("dm-audit-list");
  if (error) {
    box.innerHTML = '<div class="ad-msg err" style="margin:14px 17px;">Couldn\'t read the audit trail: ' +
      escapeHtml(error.message) + "</div>";
    return;
  }
  if (!rows || !rows.length) {
    box.innerHTML = '<p class="ad-empty">Nothing recorded yet for this data.</p>';
    return;
  }

  box.innerHTML = rows.map((r) => {
    // The member editing their own record, which is the case that matters when
    // asking later whether a bio was written by the person it describes.
    const self = r.actor_id && String(r.actor_id) === String(r.row_pk);
    const who = !r.actor_id
      ? '<span class="ad-pill muted">not a signed-in session</span>'
      : self
        ? '<span class="ad-pill ok">the member themselves</span>'
        : escapeHtml(r.actor_email || r.actor_id);

    const diff = Object.entries(r.changes || {}).map(([col, d]) =>
      "<dt>" + escapeHtml(labelOf(col)) + "</dt><dd>" +
      (d.from === null || d.from === undefined
        ? '<span class="ad-cell-dim">(empty)</span>'
        : '<span class="dm-was">' + escapeHtml(short(d.from)) + "</span>") +
      '<span class="dm-arrow">→</span>' +
      (d.to === null || d.to === undefined
        ? '<span class="ad-cell-dim">(cleared)</span>'
        : '<span class="dm-now">' + escapeHtml(short(d.to)) + "</span>") +
      "</dd>").join("");

    return '<div class="dm-plan-row">' +
      '<div class="dm-plan-head">' +
        '<span class="ad-pill ' + (r.operation === "delete" ? "danger" : "muted") + '">' + escapeHtml(r.operation) + "</span>" +
        '<span class="ad-cell-strong">' + escapeHtml(r.row_label || r.row_pk) + "</span>" +
        '<span class="dm-plan-line">' + escapeHtml(new Date(r.occurred_at).toLocaleString("en-GB")) + "</span>" +
        '<span class="dm-plan-line">via ' + escapeHtml(r.source) + "</span>" +
      "</div>" +
      '<div class="ad-cell-dim" style="margin-bottom:5px;">' + who + "</div>" +
      (diff ? '<dl class="dm-diff">' + diff + "</dl>" : "") +
    "</div>";
  }).join("");
}

// ============================================================
// Plumbing
// ============================================================

async function invoke(action, extra) {
  const { data, error } = await supabase.functions.invoke("data-admin", {
    body: Object.assign({ action: action, dataset: state.dataset }, extra || {}),
  });

  // functions.invoke surfaces a non-2xx as a generic FunctionsHttpError with
  // the useful part buried in `context` — the same problem app/onboarding.html
  // and ai-admin.js both document. Dig it out rather than showing a staff
  // member "Edge Function returned a non-2xx status code".
  if (error) {
    let message = error.message || String(error);
    try {
      const body = await error.context.json();
      if (body && body.error) message = body.error;
    } catch (e) {}
    return { ok: false, error: message };
  }
  if (data && data.error) return { ok: false, error: data.error };
  return { ok: true, data: data || {} };
}

function msg(text, kind) {
  return '<div class="ad-msg ' + kind + '">' + escapeHtml(text) + "</div>";
}

function warn(text, kind) {
  const box = document.getElementById("dm-warnings");
  box.innerHTML = msg(text, kind);
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ⚠ A panel that says "Loading…" for ever is worse than one that says it
// failed. `loadDataset` returns early when the catalogue or the records cannot
// be read, and it does say why — but into `#dm-warnings`, at the very top of
// the page, above the tab strip. Anyone scrolled down to the list they came
// for sees a spinner that never resolves and reasonably concludes the page is
// still working. This puts the outcome where the person is looking, and points
// at the message that carries the detail.
function stopLoading(reason) {
  const note = '<p class="ad-empty">Nothing loaded — ' + escapeHtml(reason) +
    ". See the message at the top of this page for the reason.</p>";
  ["dm-fix-list", "dm-audit-list"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = note;
  });
  const body = document.querySelector("#dm-table tbody");
  if (body) {
    body.innerHTML = '<tr><td colspan="99" class="ad-empty">Nothing loaded — ' +
      escapeHtml(reason) + ". See the message at the top of this page.</td></tr>";
  }
  const count = document.getElementById("dm-fix-count");
  if (count) count.textContent = "";
}

// uuids and column names are our own and match a narrow character set, but
// they are concatenated into selectors, so they are escaped rather than
// trusted to stay that way.
function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

// ⚠ THE CLASS AND THE ARIA STATE ARE SET IN THE SAME STATEMENT, deliberately.
// `.is-active` is a colour; `aria-selected` is the only thing that tells
// somebody listening to this page which of six panes of 2,200 people's contact
// details they are in. Setting them apart is how they drift.
//
// `tabindex` is roving: exactly one tab is in the tab order and the other five
// are reached with the arrow keys (see `wire()`), which is what the tablist
// pattern requires. Six tab stops would be the wrong shape and would put the
// panel itself five presses away from the first tab.
function showTab(name, opts) {
  state.tab = name;
  document.querySelectorAll(".dm-tab").forEach((t) => {
    const on = t.getAttribute("data-tab") === name;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.setAttribute("tabindex", on ? "0" : "-1");
    // Only when the move came from the keyboard. Focusing on every click would
    // steal focus from whatever was clicked inside the pane.
    if (on && opts && opts.focus) t.focus();
  });
  document.querySelectorAll(".dm-pane").forEach((p) =>
    p.classList.toggle("ad-hidden", p.id !== "dm-pane-" + name));
}

// Left/Right move between tabs and open as they go — the pattern's
// "automatic activation", which is right here because every pane is already
// rendered and switching costs nothing. Home/End jump to the ends.
function onTabKey(e) {
  const from = TAB_ORDER.indexOf(state.tab);
  if (from === -1) return;
  let to = null;
  if (e.key === "ArrowRight") to = (from + 1) % TAB_ORDER.length;
  else if (e.key === "ArrowLeft") to = (from - 1 + TAB_ORDER.length) % TAB_ORDER.length;
  else if (e.key === "Home") to = 0;
  else if (e.key === "End") to = TAB_ORDER.length - 1;
  if (to === null) return;
  e.preventDefault();
  showTab(TAB_ORDER[to], { focus: true });
}

function wire() {
  document.getElementById("dm-dataset").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-ds]");
    if (!btn) return;
    // Same rule as the tabs: the pressed state is announced, not merely
    // coloured, and it is written where the class is written.
    document.querySelectorAll("#dm-dataset button").forEach((b) => {
      const on = b === btn;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    state.dataset = btn.getAttribute("data-ds");
    discardPlan();
    // Contacts is the only dataset the mapping tab means anything for.
    if (state.dataset === "profiles" && state.tab === "fix") showTab("browse");
    await loadDataset();
  });

  const tabs = document.getElementById("dm-tabs");
  tabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (btn) showTab(btn.getAttribute("data-tab"));
  });
  tabs.addEventListener("keydown", onTabKey);

  document.getElementById("dm-fix-filter").addEventListener("change", renderFix);

  ["dm-q", "dm-seg"].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener("input", () => { state.limit = 100; renderTable(); });
    el.addEventListener("change", () => { state.limit = 100; renderTable(); });
  });
  document.getElementById("dm-more").addEventListener("click", () => { state.limit += 200; renderTable(); });
  document.getElementById("dm-choose-cols").addEventListener("click", () => {
    document.getElementById("dm-col-picker").classList.toggle("ad-hidden");
  });
  document.getElementById("dm-new").addEventListener("click", () => openEditor(null));

  document.getElementById("dm-edit-save").addEventListener("click", saveEditor);
  document.getElementById("dm-edit-close").addEventListener("click", closeEditor);
  document.getElementById("dm-modal-back").addEventListener("click", (e) => {
    if (e.target.id === "dm-modal-back") closeEditor();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("dm-modal-back").classList.contains("ad-hidden")) closeEditor();
  });

  const drop = document.getElementById("dm-drop");
  const file = document.getElementById("dm-file");
  drop.addEventListener("click", () => file.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") file.click(); });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("is-over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("is-over");
    if (e.dataTransfer.files[0]) previewImport(e.dataTransfer.files[0]);
  });
  file.addEventListener("change", () => { if (file.files[0]) previewImport(file.files[0]); });

  document.getElementById("dm-plan-cancel").addEventListener("click", discardPlan);
  document.getElementById("dm-plan-apply").addEventListener("click", applyImport);
  // Ticking "replace what they wrote" changes the plan, so the plan is
  // recomputed rather than applied with an option the preview did not include.
  document.getElementById("dm-overwrite").addEventListener("change", async () => {
    if (!state.planCsv) return;
    const res = await invoke("import_preview", { csv: state.planCsv, options: importOptions() });
    if (res.ok) {
      state.plan = res.data;
      renderPlan();
    } else {
      // The plan on screen is now the one for the OTHER setting of this box, so
      // applying it would apply something that was not read. Say so rather than
      // leaving a stale plan behind a changed tick box.
      showMessage("dm-import-msg",
        "Couldn't recompute the plan for that setting: " + res.error +
        " — the plan below is the one for the previous setting. Choose the file again.", "err");
    }
  });

  document.getElementById("dm-do-export").addEventListener("click", doExport);
  document.getElementById("dm-exp-all-cols").addEventListener("click", () =>
    document.querySelectorAll("[data-expcol]").forEach((cb) => { cb.checked = true; }));
  document.getElementById("dm-exp-no-cols").addEventListener("click", () =>
    document.querySelectorAll("[data-expcol]").forEach((cb) => { cb.checked = false; }));

  document.getElementById("dm-audit-refresh").addEventListener("click", loadLogs);
}
