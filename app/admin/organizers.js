// Sahaba Club — admin, organizers
// ------------------------------------------------------------
// The people and companies who run the events, from 0048. An event has MANY
// organizers, so this is a table of its own rather than a column — and the
// partners section on the Events Hub is the same list seen from the other
// side: `organizers where is_partner`.
//
// Why this page had to exist. 0048 seeded nine organizers with a name, a slug
// and a category, and nothing has been able to edit one since: the Events
// screen attaches an existing organizer to an event, but cannot create one and
// cannot fill `logo_url` or `description`. Every organizer therefore had both
// as null, and "Our partners" rendered as a row of bare names with a letter in
// a box where a logo should be. This screen is what makes that section real.
//
// ⚠ THE GATE IS THE DATABASE, NOT THIS PAGE. `organizers` and
// `event_organizers` are public-read and staff-write, enforced by RLS policies
// that call is_staff() (0048). requireStaff() below decides what a person is
// SHOWN; Postgres decides what they may DO. Hiding the Save button would gate
// nothing — anyone signed in can issue the same PostgREST call from a console —
// so nothing here is written as though it were a control, and a refused write
// is reported as the database's answer rather than prevented by the form.
//
// ⚠ AN EMPTY LIST AND A FAILED READ ARE NOT THE SAME THING. Same flag, same
// reasoning, as interest.js: `state.loadedOk` starts false and is only ever set
// by a read that RETURNED. "There are no organizers yet" is a plausible,
// undramatic sentence somebody would believe, so a failed query must never be
// able to produce it. `state.countsOk` is a second flag for the same reason,
// and it carries more weight than it looks: the event count is what the delete
// confirmation quotes, and a "0 events" that actually means "the count failed"
// would talk somebody into deleting an organizer nine events depend on.
//
// ⚠ TEMPORAL DEAD ZONE: every module-level binding is declared below, above the
// first line that runs. `const` is not hoisted the way `function` is, and a
// binding declared under an awaited statement does not exist while that await
// is pending — the bug that once rendered the admin Data panel as an empty
// database with nothing on screen to say why. tools/check-dead-zone.mjs
// enforces it, and it can see this file because it is a real .js module rather
// than an inline <script type="module"> in the HTML.
import { supabase } from "../../lib/supabase-client.js?v=162f478dae";
import { describeSpec, rejectionReason, inspect, uploadEventImage } from "../../lib/event-images.js?v=162f478dae";
import {
  requireStaff, renderShell, escapeHtml, formatDate, showMessage, clearMessage,
} from "../../lib/admin-guard.js?v=162f478dae";

// Exactly the six values the CHECK constraint in 0048 allows, in the order the
// Events Hub filter shows them. Duplicated from the migration ONLY so a person
// picks from a list instead of discovering the constraint as a Postgres error;
// the constraint remains the authority, and a seventh value added here without
// a migration would be refused on save rather than silently accepted.
const CATEGORIES = [
  "Sahaba Club", "Microsoft", "AWS", "Google", "Community", "Others",
];

// Explicit column list, never select("*"): the columns this page renders are
// the columns it asks for, so adding one to the table cannot quietly widen
// what a screen full of third-party names pulls into the browser.
const ORGANIZER_COLUMNS =
  "id, name, slug, category, logo_url, website, description, is_partner, sort_order, created_at, updated_at";

// The logo sits where the banner wordmarks sit — a landscape mark on a tile —
// so it borrows `featuredLogo` rather than inventing a spec with no measured
// examples behind it. See the comment above IMAGE_SPECS in lib/event-images.js.
const LOGO_SPEC = "featuredLogo";

// Read in one go, like every other admin list. PostgREST caps a response at
// 1,000 rows unless asked otherwise; there are nine organizers today and the
// join table is small, but a silent slice would make the counts below wrong
// rather than absent, which is the harder kind of wrong to notice.
const ROW_LIMIT = 2000;

const MAX_NAME = 120;
const MAX_DESC = 1000;
const DEFAULT_SORT = 100;

// A slug goes in a URL and into the Hub's filter links. The database only
// enforces uniqueness, so this is stricter than the column is on purpose —
// "Azure Egypt Community" typed into the slug field would be accepted by
// Postgres and then have to be percent-encoded by every link that used it.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The database CHECK is `website ~ '^https?://'`. Mirrored here so the person
// sees a sentence instead of a constraint name.
const WEBSITE_PATTERN = /^https?:\/\//i;

const state = {
  rows: [],
  // organizer id -> number of events. Null until a read RETURNS, and never
  // filled in with zeroes as a stand-in.
  counts: null,
  loadedOk: false,
  countsOk: false,
  // The row currently open in the editor, as it was loaded. Kept so a changed
  // slug can be recognised — the warning is about the value MOVING, which the
  // form alone cannot see.
  editing: null,
  // False until somebody types in the slug field themselves. While false, the
  // slug follows the name; after that it is theirs and is left alone.
  slugTouched: false,
  saving: false,
};

let user = null;

// ---- Small helpers ------------------------------------------------------

function el(id) {
  return document.getElementById(id);
}

// Lowercase, non-alphanumerics to hyphens, trimmed. Deliberately the same
// shape as the seeded slugs in 0048 so a hand-made organizer looks like the
// ones that were already there.
function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function intOrDefault(value, fallback) {
  const v = String(value == null ? "" : value).trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

// A website is rendered as a link, and a link is the one place a stored string
// becomes something a click acts on. The CHECK constraint already limits this
// column to http(s), but this page also renders values that were about to be
// saved, and "the database would have refused it" is not the same as "it never
// reaches the DOM".
function isLinkable(url) {
  return WEBSITE_PATTERN.test(String(url || "").trim());
}

function countLabel(id) {
  if (!state.countsOk || !state.counts) return "—";
  return String(state.counts.get(id) || 0);
}

// ---- Rendering ----------------------------------------------------------

function renderCategories() {
  el("og-category").innerHTML = CATEGORIES
    .map((c, i) =>
      '<option value="' + escapeHtml(c) + '"' + (i === 0 ? " selected" : "") + ">" +
      escapeHtml(c) + "</option>"
    )
    .join("");
}

function setPreview(url) {
  const img = el("og-logo-preview");
  if (url) {
    img.src = url;
    img.hidden = false;
  } else {
    img.removeAttribute("src");
    img.hidden = true;
  }
}

function filteredRows() {
  const q = (el("og-q").value || "").trim().toLowerCase();
  if (!q) return state.rows;
  return state.rows.filter((o) =>
    [o.name, o.slug, o.category].filter(Boolean).join(" ").toLowerCase().includes(q)
  );
}

function renderList() {
  const body = el("og-list");

  // The failed-read branch comes FIRST, before any counting, so there is no
  // path on which a broken query reaches the "nothing here" sentence.
  if (!state.loadedOk) {
    body.innerHTML =
      '<tr><td colspan="6" class="ad-empty">Couldn\'t load the organizers. ' +
      "Nothing on this page is safe to act on until this succeeds — reload to try again.</td></tr>";
    el("og-count").textContent = "";
    return;
  }

  const rows = filteredRows();
  el("og-count").textContent =
    rows.length + " of " + state.rows.length + " shown" +
    (state.countsOk ? "" : " · event counts unavailable");

  if (!rows.length) {
    body.innerHTML =
      '<tr><td colspan="6" class="ad-empty">' +
      (state.rows.length ? "Nothing matches that search." : "There are no organizers yet.") +
      "</td></tr>";
    return;
  }

  body.innerHTML = rows
    .map((o) => {
      const site = String(o.website || "").trim();
      return (
        "<tr>" +
        '<td class="ad-cell-strong">' + escapeHtml(o.name) +
          '<div class="ad-cell-dim">' + escapeHtml(o.slug) +
          (o.logo_url ? "" : " · no logo") + "</div></td>" +
        "<td>" + escapeHtml(o.category) + "</td>" +
        "<td>" + (o.is_partner
          ? '<span class="ad-pill ok">partner</span>'
          : '<span class="ad-pill muted">—</span>') + "</td>" +
        '<td class="ad-cell-dim">' + escapeHtml(countLabel(o.id)) + "</td>" +
        "<td>" + (site && isLinkable(site)
          ? '<a href="' + escapeHtml(site) + '" target="_blank" rel="noopener noreferrer">' +
            escapeHtml(site.replace(/^https?:\/\//i, "").replace(/\/$/, "")) + "</a>"
          : '<span class="ad-cell-dim">—</span>') + "</td>" +
        '<td><button type="button" class="ad-btn ad-btn-sm" data-edit="' + escapeHtml(o.id) +
          '">Edit</button></td>' +
        "</tr>"
      );
    })
    .join("");
}

// ---- Data ---------------------------------------------------------------

async function loadOrganizers() {
  state.loadedOk = false;

  const res = await supabase
    .from("organizers")
    .select(ORGANIZER_COLUMNS)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
    .limit(ROW_LIMIT);

  if (res.error) {
    showMessage("og-notice", "Couldn't load the organizers: " + res.error.message, "err");
    renderList();
    return;
  }

  state.rows = res.data || [];
  state.loadedOk = true;
  renderList();
}

// How many events each organizer is attached to.
//
// Tallied in the browser from the raw join rows rather than asked for as a
// grouped count: PostgREST has no GROUP BY, so the alternative is one HEAD
// request per organizer, and the join table is a few dozen rows. The
// per-organizer exact count IS issued — but only at the moment it decides
// something, in the delete confirmation.
async function loadEventCounts() {
  state.countsOk = false;

  const res = await supabase
    .from("event_organizers")
    .select("event_id, organizer_id")
    .limit(ROW_LIMIT);

  if (res.error) {
    renderList();
    return;
  }

  const rows = res.data || [];

  // A tally built from a truncated read is worse than no tally: it looks like
  // a number and is not one. If the response came back at the limit, the count
  // column stays blank and says so.
  if (rows.length >= ROW_LIMIT) {
    renderList();
    return;
  }

  const map = new Map();
  rows.forEach((r) => map.set(r.organizer_id, (map.get(r.organizer_id) || 0) + 1));
  state.counts = map;
  state.countsOk = true;
  renderList();
}

// ---- Editor -------------------------------------------------------------

function openEditor(id) {
  clearMessage("og-form-msg");

  const o = id ? state.rows.find((r) => r.id === id) : null;
  state.editing = o || null;
  // A new organizer's slug follows the name; an existing one's is already its
  // own thing and must not start moving because somebody fixed a typo in the
  // name field.
  state.slugTouched = !!o;

  el("og-modal-title").textContent = o ? "Edit organizer" : "New organizer";
  el("og-modal-sub").textContent = o
    ? "Created " + formatDate(o.created_at) + " · last changed " + formatDate(o.updated_at) + "."
    : "Name and category are required. A partner with no logo is the reason this page exists.";
  el("og-delete").classList.toggle("ad-hidden", !o);

  el("og-id").value = o ? o.id : "";
  el("og-name").value = o ? o.name : "";
  el("og-slug").value = o ? o.slug : "";
  el("og-category").value = o ? o.category : CATEGORIES[0];
  el("og-website").value = o ? (o.website || "") : "";
  el("og-logo").value = o ? (o.logo_url || "") : "";
  el("og-desc").value = o ? (o.description || "") : "";
  el("og-partner").checked = o ? !!o.is_partner : false;
  el("og-sort").value = o && o.sort_order !== null && o.sort_order !== undefined
    ? o.sort_order
    : "";

  // Clear the file input and the previous organizer's upload message, or the
  // editor opens reporting somebody else's upload as if it were this one's.
  el("og-logo-file").value = "";
  el("og-logo-msg").textContent = "";
  el("og-slug-warn").textContent = "";
  setPreview(el("og-logo").value.trim());

  el("og-modal-back").classList.remove("ad-hidden");
  el("og-name").focus();
}

function closeEditor() {
  el("og-modal-back").classList.add("ad-hidden");
  state.editing = null;
}

// Shown live while typing, not only on save: by the time somebody has pressed
// Save they have stopped reading the form.
function paintSlugWarning() {
  const warn = el("og-slug-warn");
  if (!state.editing) {
    warn.textContent = "";
    return;
  }
  const next = el("og-slug").value.trim();
  warn.textContent = next && next !== state.editing.slug
    ? "⚠ You are changing an existing slug, from \"" + state.editing.slug + "\". A slug is a " +
      "promise: any link already shared that uses the old one stops working, and nothing here " +
      "can tell you who holds it."
    : "";
}

function collectPayload() {
  const name = (el("og-name").value || "").trim();
  const slug = (el("og-slug").value || "").trim();
  const category = el("og-category").value;
  const website = (el("og-website").value || "").trim();
  const logo = (el("og-logo").value || "").trim();
  const desc = (el("og-desc").value || "").trim();
  const sort = intOrDefault(el("og-sort").value, DEFAULT_SORT);

  if (!name) return { error: "A name is required — it is what a member reads on the event page." };
  if (name.length > MAX_NAME) {
    return { error: "That name is longer than " + MAX_NAME + " characters." };
  }
  if (!slug) return { error: "A slug is required. Clear the field and retype the name to regenerate one." };
  if (!SLUG_PATTERN.test(slug)) {
    return {
      error: "The slug must be lowercase letters, numbers and single hyphens — for example " +
        "\"azure-egypt-community\". It goes in a URL.",
    };
  }
  // The select cannot produce anything else, which is exactly why this is
  // checked anyway: the select is not the boundary, and a value edited in a
  // console would otherwise reach a CHECK constraint and come back as noise.
  if (CATEGORIES.indexOf(category) === -1) {
    return { error: "Pick one of the six categories." };
  }
  if (website && !WEBSITE_PATTERN.test(website)) {
    return { error: "The website must start with http:// or https:// — the database refuses anything else." };
  }
  if (desc.length > MAX_DESC) {
    return { error: "That description is " + desc.length + " characters. The limit is " + MAX_DESC + "." };
  }
  if (sort === null) {
    return { error: "Sort order must be a whole number, or blank for " + DEFAULT_SORT + "." };
  }

  return {
    payload: {
      name,
      slug,
      category,
      website: website || null,
      logo_url: logo || null,
      description: desc || null,
      is_partner: el("og-partner").checked,
      sort_order: sort,
    },
  };
}

// Postgres phrases its refusals for a DBA. These are the three a person on this
// page will actually hit, so they are translated rather than passed through.
function explainWriteError(message) {
  const msg = String(message || "");
  if (/organizers_name_key|organizers_name/i.test(msg)) {
    return "There is already an organizer with that name. Names are unique — edit the existing one instead.";
  }
  if (/organizers_slug_key|organizers_slug/i.test(msg)) {
    return "That slug is already taken by another organizer. Slugs are unique.";
  }
  if (/duplicate key/i.test(msg)) {
    return "That name or slug is already taken by another organizer.";
  }
  if (/row-level security|permission denied|policy/i.test(msg)) {
    return "The database refused the write — organizers are staff-only. That check is in Postgres, not on this page.";
  }
  if (/organizers_category_check|violates check constraint/i.test(msg)) {
    return "The database refused that value: " + msg;
  }
  return "Couldn't save: " + msg;
}

async function save(ev) {
  ev.preventDefault();
  if (state.saving) return;
  clearMessage("og-form-msg");

  const collected = collectPayload();
  if (collected.error) {
    showMessage("og-form-msg", collected.error, "err");
    return;
  }

  const id = el("og-id").value;
  const payload = collected.payload;

  // The slug warning is on screen already; this is the point at which it costs
  // something, so it is confirmed rather than merely displayed.
  if (state.editing && payload.slug !== state.editing.slug) {
    if (!window.confirm(
      "Change this organizer's slug from \"" + state.editing.slug + "\" to \"" + payload.slug + "\"?\n\n" +
      "Any link already shared that uses the old slug will stop working."
    )) return;
  }

  state.saving = true;
  el("og-save").disabled = true;
  showMessage("og-form-msg", "Saving…", "info");

  const saved = id
    ? await supabase.from("organizers").update(payload).eq("id", id).select("id").maybeSingle()
    : await supabase.from("organizers").insert(payload).select("id").maybeSingle();

  state.saving = false;
  el("og-save").disabled = false;

  if (saved.error) {
    showMessage("og-form-msg", explainWriteError(saved.error.message), "err");
    return;
  }

  // ⚠ An update that matched nothing returns no error and no row. On a
  // staff-write table that is what a policy refusal looks like from here, so it
  // is reported rather than celebrated as a save.
  if (id && !saved.data) {
    showMessage(
      "og-form-msg",
      "Nothing was updated. Either the organizer has been deleted by somebody else, or the " +
        "database refused the write.",
      "err"
    );
    return;
  }

  closeEditor();
  showMessage("og-notice", id ? "Organizer updated." : "Organizer created.", "ok");
  await Promise.all([loadOrganizers(), loadEventCounts()]);
}

async function remove() {
  const id = el("og-id").value;
  if (!id) return;
  const org = state.rows.find((r) => r.id === id);
  const label = org ? org.name : "this organizer";

  clearMessage("og-form-msg");
  showMessage("og-form-msg", "Checking what depends on this organizer…", "info");

  // Asked FRESH, exactly, at the moment it decides something — not read off the
  // tally in the table, which may be minutes old and may never have loaded.
  // `event_organizers.organizer_id` is ON DELETE CASCADE, so these rows go
  // without a further prompt from Postgres; this count is the only warning
  // anybody gets.
  const linked = await supabase
    .from("event_organizers")
    .select("event_id", { count: "exact", head: true })
    .eq("organizer_id", id);

  if (linked.error) {
    // ⚠ The whole point of the confirmation is the number in it. A failed count
    // would render as "0 events", which is the sentence most likely to get a
    // yes — so the delete stops here instead.
    showMessage(
      "og-form-msg",
      "Couldn't check how many events use this organizer, so nothing has been deleted: " +
        linked.error.message,
      "err"
    );
    return;
  }

  const n = Number(linked.count) || 0;
  clearMessage("og-form-msg");

  if (!window.confirm(
    "Delete " + label + "?\n\n" +
    (n > 0
      ? n + (n === 1 ? " event" : " events") + " lists this organizer, and " +
        (n === 1 ? "it" : "they") + " will lose it — the link rows are removed automatically. " +
        (n === 1 ? "That event" : "Those events") + " stay, without this organizer on them."
      : "No event lists this organizer.") +
    "\n\nThis cannot be undone."
  )) return;

  showMessage("og-form-msg", "Deleting…", "info");
  const res = await supabase.from("organizers").delete().eq("id", id).select("id");

  if (res.error) {
    showMessage("og-form-msg", "Couldn't delete: " + res.error.message, "err");
    return;
  }
  if (!res.data || !res.data.length) {
    // Same reasoning as the update above: a delete that removed nothing and
    // reported no error is what an RLS refusal looks like from the browser.
    showMessage(
      "og-form-msg",
      "Nothing was deleted — the database refused it, or somebody else got there first.",
      "err"
    );
    return;
  }

  closeEditor();
  showMessage("og-notice", label + " deleted.", "ok");
  await Promise.all([loadOrganizers(), loadEventCounts()]);
}

// ---- Logo ---------------------------------------------------------------

async function onLogoChosen() {
  const input = el("og-logo-file");
  const file = input.files && input.files[0];
  const msg = el("og-logo-msg");
  if (!file) return;

  const bad = rejectionReason(file);
  if (bad) {
    msg.textContent = bad;
    input.value = "";
    return;
  }

  // Advice, not refusal — too small or the wrong shape is the uploader's
  // judgement to make, and blocking it would leave them with no way forward.
  const look = await inspect(file, LOGO_SPEC);
  msg.textContent = "Uploading…";

  // `eventId` is only the folder the file lands in (see uploadEventImage), so
  // passing an organizer id is not a category error — it keeps one organizer's
  // logos together. A new organizer has no id yet and gets "unassigned".
  const res = await uploadEventImage(file, { eventId: el("og-id").value || null, spec: LOGO_SPEC });
  if (res.error) {
    msg.textContent = res.error;
    return;
  }

  el("og-logo").value = res.url;
  setPreview(res.url);
  msg.textContent = look.warning
    ? "Uploaded — but note: " + look.warning
    : "Uploaded (" + (look.size ? look.size.width + "×" + look.size.height : "ok") + "). " +
      "It is not saved until you save the organizer.";
}

// ---- Wiring -------------------------------------------------------------

function wire() {
  el("og-q").addEventListener("input", renderList);
  el("og-new").addEventListener("click", () => openEditor(null));

  el("og-list").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-edit]");
    if (btn) openEditor(btn.getAttribute("data-edit"));
  });

  el("og-name").addEventListener("input", () => {
    if (state.slugTouched) return;
    el("og-slug").value = slugify(el("og-name").value);
  });

  el("og-slug").addEventListener("input", () => {
    state.slugTouched = true;
    paintSlugWarning();
  });

  el("og-logo-file").addEventListener("change", onLogoChosen);
  el("og-logo").addEventListener("input", () => setPreview(el("og-logo").value.trim()));

  el("og-form").addEventListener("submit", save);
  el("og-cancel").addEventListener("click", closeEditor);
  el("og-delete").addEventListener("click", remove);

  el("og-modal-back").addEventListener("click", (ev) => {
    if (ev.target === el("og-modal-back")) closeEditor();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !el("og-modal-back").classList.contains("ad-hidden")) closeEditor();
  });
}

// ---- Init ---------------------------------------------------------------

(async function init() {
  user = await requireStaff("organizers");
  if (!user) return;

  renderShell(user, "organizers.html");
  renderCategories();
  el("og-logo-hint").textContent = describeSpec(LOGO_SPEC);
  wire();

  await Promise.all([loadOrganizers(), loadEventCounts()]);
})();
