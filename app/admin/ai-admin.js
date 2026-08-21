// Sahaba Club — admin, AI services
// ------------------------------------------------------------
// The screen behind Ahmed's request: "control all the AI Prompts in the
// website … also to have control of which model to use for this service".
//
// ⚠ This file is a convenience, not a boundary. Everything it does is
// something the database would allow the same account to do from a REST call:
//
//   * it reads `ai_service_overview`, a view that carries `public.is_staff()`
//     inside its own body;
//   * it inserts drafts into `ai_service_versions`, on which staff hold a
//     five-column INSERT grant and no UPDATE at all;
//   * it asks `ai-admin` to run the test, because only the service role may
//     stamp `test_status` — this page cannot mark its own work as passed;
//   * it activates through `activate_ai_version`, which is security definer,
//     checks is_staff() itself, and refuses anything that has not passed.
//
// So the model dropdown being filtered by kind is a courtesy. 0031's trigger
// is what makes a text model on an image service impossible. Never move a
// check out of the database and rely on this file.
import { supabase } from "../../lib/supabase-client.js?v=7748bdbeaa";
import { requireStaff, renderShell, escapeHtml, formatDate } from "../../lib/admin-guard.js?v=7748bdbeaa";

const state = {
  services: [],
  // { text: [...], image: [...], other: [...] } — from OpenAI, via ai-admin.
  models: { text: [], image: [], other: [] },
  // The unfiltered list, kept because the price table needs every field the
  // dropdowns throw away — the rates, who set them and when.
  allModels: [],
  priceFilter: "",
  modelsLoaded: false,
  // The prompt each service uses when nothing is activated. From ai-admin,
  // which imports the avatar artwork for real and mirrors the six text
  // prompts. See that function's header for what the mirror costs.
  defaults: {},
  history: {},
  // The draft version id created by the most recent test, per service. What
  // "Activate" activates.
  tested: {},
  openSlug: null,
};

// ============================================================
// ⚠ THE CODE DEFAULT IS THE FLOOR, AND THIS PANEL HAS TO SHOW IT
// ============================================================
//
// `_shared/ai-config.ts` resolves a ceiling like this: a stored
// `max_output_tokens` that is a positive integer WINS, and anything else falls
// back to the calling function's own `MAX_OUTPUT_TOKENS`. A stored value is
// therefore not a suggestion layered on top of the code — it REPLACES it, in
// both directions, including downwards.
//
// `ai_services.recommended_max_output_tokens` is what this panel pre-fills the
// box with, and for three services 0031 seeds it BELOW the code default:
// write-member-intro (1200 against 4000), write-contact-email (2000 against
// 7000) and import-event (3000 against 6000). So a staff member could open a
// service, press Test run, press Save & activate, change nothing, and lower the
// ceiling that service runs at — by accepting the panel's own suggestion.
//
// That is not a cost saving. On the gpt-5 family the ceiling is shared with the
// model's own reasoning tokens, so a low ceiling is spent before the first
// visible character is written; the answer comes back truncated rather than
// erroring, and both writers retry a truncation at DOUBLE the ceiling. A
// ceiling set too low is paid for twice and still fails.
//
// Migration 0032 corrects the seeded numbers, but it is on an unmerged branch
// and may not be applied here — so this table is what makes the mistake
// impossible by clicking whatever the database holds. `ai_services` carries no
// column for the code ceiling (only `code_default_model`), so it is mirrored
// from the `MAX_OUTPUT_TOKENS` constant in each function, named here so the
// pair can be checked by opening one file:
//
//   supabase/functions/parse-profile-document/index.ts   MAX_OUTPUT_TOKENS
//   supabase/functions/promptarena-judge/index.ts        MAX_OUTPUT_TOKENS
//   supabase/functions/write-member-intro/index.ts       MAX_OUTPUT_TOKENS
//   supabase/functions/write-contact-email/index.ts      MAX_OUTPUT_TOKENS
//   supabase/functions/import-event/index.ts             VISIBLE_TOKENS + REASONING_TOKENS
//
// A slug that is absent sends no ceiling of its own and must not acquire one:
// the two image services, and `promptarena-challenge`, which computes its
// ceiling per call from the batch size. `ai-config.ts` ignores a stored number
// for those, and so does this file.
const CODE_DEFAULT_CEILINGS = {
  "parse-profile-document": 8000,
  "promptarena-judge": 13000,
  "write-member-intro": 4000,
  "write-contact-email": 7000,
  "import-event": 6000,
};

function codeCeiling(slug) {
  const n = CODE_DEFAULT_CEILINGS[slug];
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// What the service is ACTUALLY running at, right now — which is the number the
// box should open showing. With nothing activated that is the code default, not
// the recommendation: the recommendation is a number nothing has ever used, and
// pre-filling with it is how the low value gets saved by accident.
function effectiveCeiling(s) {
  const active = Number(s.active_max_output_tokens);
  if (Number.isInteger(active) && active > 0) return active;
  const code = codeCeiling(s.slug);
  if (code !== null) return code;
  const rec = Number(s.recommended_max_output_tokens);
  return Number.isFinite(rec) ? rec : null;
}

// True when what is stored — or what the box is about to offer — would lower
// the ceiling below what the code would have used on its own.
function belowCode(s, value) {
  const code = codeCeiling(s.slug);
  const n = Number(value);
  return code !== null && Number.isFinite(n) && n < code;
}

// The rota index is the meaning — theme 3 is what everyone regenerated in
// March gets, and variant 2 is a member's second try — so it is labelled
// rather than left to be counted.
//
// ⚠ Declared above the top-level await, not next to `rotaLabel` where it reads
// better. Top-level await SUSPENDS module evaluation, so every `const` below
// this block is still in its temporal dead zone while `load()` runs — and
// `load()` renders the avatar service, which ships a twelve-entry "themes"
// rota. Sitting further down the file, this threw
// `Cannot access 'MONTHS' before initialization` mid-render. The sibling page
// lost its entire dataset to exactly this shape.
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const user = await requireStaff("ai");
if (user) {
  renderShell(user, "ai.html");
  await load();
}

async function load() {
  renderList('<div class="ad-panel"><div class="ad-empty">Loading services…</div></div>');

  const [overview, defaults] = await Promise.all([
    supabase.from("ai_service_overview").select("*").order("sort_order", { ascending: true }),
    invoke("defaults"),
  ]);

  if (overview.error) {
    // A refused read here is almost always 0031 not being applied, and saying
    // so beats an empty page that looks like "there are no AI services".
    warn(
      "Couldn't read the AI services: " + overview.error.message +
      " — if this says the relation does not exist, migration 0031 has not been applied yet.",
      "err",
    );
    renderList('<div class="ad-panel"><div class="ad-empty">Nothing to show.</div></div>');
    return;
  }

  state.services = overview.data || [];
  state.defaults = defaults.ok ? (defaults.data.defaults || {}) : {};
  if (!defaults.ok) {
    warn(
      "Couldn't load the code defaults from the ai-admin function (" + defaults.error +
      "). You can still see what is active, but the boxes below will be empty rather than showing " +
      "the prompt a service is currently using — do not save over that.",
      "warn",
    );
  }

  renderStats();
  render();
  await refreshModels({ quiet: true });
}

// ---- Models ----------------------------------------------------------

async function refreshModels(opts) {
  const note = document.getElementById("ai-model-note");
  if (note) note.textContent = "Asking OpenAI what this account can use…";

  const res = await invoke("models");
  if (!res.ok) {
    state.modelsLoaded = false;
    if (note) {
      note.innerHTML = '<strong>The model list is unavailable.</strong> ' + escapeHtml(res.error) +
        " Until it loads you can read every setting on this page, but you cannot save one — a model has to be " +
        "on the list before the database will accept it.";
    }
    if (!opts || !opts.quiet) warn(res.error, "err");
    // The tile has to be redrawn on this path too, or a list that failed on the
    // first load and failed again on a manual retry looks like it worked.
    renderStats();
    render();
    renderPrices();
    return;
  }

  const models = res.data.models || [];
  state.allModels = models;
  state.models = {
    text: models.filter((m) => m.kind === "text" && m.available),
    image: models.filter((m) => m.kind === "image" && m.available),
    other: models.filter((m) => m.kind === "other"),
  };
  state.modelsLoaded = true;

  if (note) {
    note.innerHTML =
      "<strong>" + state.models.text.length + " text " + plural(state.models.text.length, "model") +
      " and " + state.models.image.length + " image " + plural(state.models.image.length, "model") +
      "</strong> available to this account, read from OpenAI " + escapeHtml(timeOf(res.data.refreshed_at)) + ". " +
      escapeHtml(String(state.models.other.length)) +
      " other " + plural(state.models.other.length, "model") + " (speech, embeddings, moderation and anything " +
      "this dashboard does not recognise) are not offered, because they cannot serve either of the two " +
      "endpoints these services call.";
  }
  // ⚠ The stats are drawn before this runs — the model list is fetched after
  // the services so the page is useful while it loads — so the "models
  // available" tile is "—" until it is redrawn here. Without this it stays
  // "list not loaded" on a page whose own note says three text models loaded,
  // which is the kind of contradiction that makes somebody distrust the rest
  // of the screen.
  renderStats();
  render();
  renderPrices();
}

// ---- Rendering -------------------------------------------------------

function renderStats() {
  const overridden = state.services.filter((s) => s.is_overridden).length;
  const changed = state.services
    .map((s) => s.activated_at)
    .filter(Boolean)
    .sort()
    .pop();

  const tiles = [
    { label: "Services", value: state.services.length, sub: "ongoing AI call sites" },
    { label: "Customised", value: overridden, sub: (state.services.length - overridden) + " on their code default" },
    {
      label: "Models available",
      value: state.modelsLoaded ? state.models.text.length + state.models.image.length : "—",
      sub: state.modelsLoaded ? state.models.text.length + " text, " + state.models.image.length + " image" : "list not loaded",
    },
    { label: "Last change", value: changed ? formatDate(changed) : "—", sub: changed ? "activated" : "nothing activated yet" },
  ];

  document.getElementById("ai-stats").innerHTML = tiles.map((t) =>
    '<div class="ad-stat">' +
      '<div class="ad-stat-label">' + escapeHtml(t.label) + "</div>" +
      '<div class="ad-stat-value">' + escapeHtml(String(t.value)) + "</div>" +
      '<div class="ad-stat-sub">' + escapeHtml(t.sub) + "</div>" +
    "</div>"
  ).join("");
}

function render() {
  renderList(state.services.map(card).join(""));
  wire();
}

function renderList(html) {
  document.getElementById("ai-list").innerHTML = html;
}

// ============================================================
// Model prices
// ============================================================
//
// A rate card, maintained by hand. 0060 built the columns and
// set_model_price(); this is the half that lets a person reach them.
//
// ⚠ set_model_price() is called DIRECTLY over RPC rather than through the
// ai-admin Edge Function, which every other write on this page goes through.
// That is deliberate and it is 0060's own design: the function is
// security definer and checks has_admin_section('ai') itself, so routing it
// through an Edge Function would add a second place to get the gate wrong
// without adding a gate. The database is the boundary here, as it is
// everywhere else in this project.
//
// ⚠ Only models that are AVAILABLE and of a kind a service can actually call
// are listed. The ~52 "other" models — embeddings, speech, moderation — cannot
// be selected for any service, so a price against them is a number nobody will
// ever spend.

function priceValue(v) {
  // ⚠ "" and 0 ARE DIFFERENT and the whole feature depends on it. Blank means
  // nobody has recorded a price; 0 means the model is free, which 0060
  // explicitly allows ("some models genuinely are free at some tiers"). A
  // careless `Number(x) || null` would turn every recorded zero into "unknown"
  // on the next save.
  const s = String(v == null ? "" : v).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function renderPrices() {
  const host = document.getElementById("ai-prices");
  if (!host) return;

  if (!state.modelsLoaded) {
    host.innerHTML = '<p class="ai-note">The model list has not loaded, so there is nothing to price yet.</p>';
    return;
  }

  const q = (state.priceFilter || "").trim().toLowerCase();
  const rows = (state.allModels || [])
    .filter((m) => m.available && (m.kind === "text" || m.kind === "image"))
    .filter((m) => !q || m.id.toLowerCase().includes(q) || String(m.provider || "").toLowerCase().includes(q))
    .sort((a, b) =>
      String(a.provider).localeCompare(String(b.provider)) || a.id.localeCompare(b.id)
    );

  const withPrice = (state.allModels || []).filter(
    (m) => m.input_per_1m != null || m.output_per_1m != null || m.price_per_image != null
  ).length;

  if (!rows.length) {
    host.innerHTML = '<p class="ai-note">No model matches that filter.</p>';
    return;
  }

  let out =
    '<p class="ai-note" style="margin-top:0;"><strong>' + withPrice + "</strong> of " +
    (state.allModels || []).filter((m) => m.available && (m.kind === "text" || m.kind === "image")).length +
    " priced" + (q ? " · showing " + rows.length + " matching “" + escapeHtml(q) + "”" : "") + "</p>";

  out += '<div class="ad-tablewrap"><table class="ad-table"><thead><tr>' +
    "<th>Model</th><th>Provider</th>" +
    '<th class="ad-num">Input / 1M</th><th class="ad-num">Output / 1M</th><th class="ad-num">Per image</th>' +
    "<th>Source</th><th>Updated</th><th></th>" +
    "</tr></thead><tbody>";

  for (const m of rows) {
    const isImage = m.kind === "image";
    // ⚠ A model is shown only the fields its own kind can have. Offering an
    // "input per 1M tokens" box against an image model invites a number that
    // means nothing and that nothing will ever read.
    const cell = (field, val, on) =>
      on
        ? '<td class="ad-num"><input class="ad-field ai-price-in" data-f="' + field +
          '" type="number" step="0.001" min="0" inputmode="decimal" style="width:96px;text-align:right;" value="' +
          (val == null ? "" : escapeHtml(String(val))) + '"></td>'
        : '<td class="ad-num"><span class="ad-cell-dim">n/a</span></td>';

    out +=
      '<tr data-model="' + escapeHtml(m.id) + '">' +
      '<td class="ad-cell-strong">' + escapeHtml(m.id) + "</td>" +
      "<td>" + escapeHtml(m.provider || "—") + "</td>" +
      cell("input", m.input_per_1m, !isImage) +
      cell("output", m.output_per_1m, !isImage) +
      cell("image", m.price_per_image, isImage) +
      '<td><input class="ad-field ai-price-in" data-f="source" type="text" style="width:150px;" ' +
      'placeholder="where from" value="' + escapeHtml(m.price_source || "") + '"></td>' +
      "<td>" + (m.price_updated_at
        ? escapeHtml(formatDate(m.price_updated_at))
        : '<span class="ad-cell-dim">never</span>') + "</td>" +
      '<td><button class="ad-btn ad-btn-sm ai-price-save" type="button">Save</button></td>' +
      "</tr>";
  }

  out += "</tbody></table></div>";
  host.innerHTML = out;
  wirePrices();
}

function wirePrices() {
  document.querySelectorAll(".ai-price-save").forEach((btn) => {
    btn.addEventListener("click", () => savePrice(btn));
  });
  // Enter in any field on a row saves that row — a rate card is entered a
  // number at a time and reaching for the mouse every line is what makes
  // somebody give up halfway.
  document.querySelectorAll(".ai-price-in").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const row = input.closest("tr");
      const btn = row && row.querySelector(".ai-price-save");
      if (btn) savePrice(btn);
    });
  });
}

async function savePrice(button) {
  const row = button.closest("tr");
  if (!row) return;
  const model = row.getAttribute("data-model");
  const get = (f) => {
    const el = row.querySelector('[data-f="' + f + '"]');
    return el ? el.value : "";
  };

  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Saving…";

  const { error } = await supabase.rpc("set_model_price", {
    p_model: model,
    p_input: priceValue(get("input")),
    p_output: priceValue(get("output")),
    p_per_image: priceValue(get("image")),
    p_source: String(get("source") || "").trim() || null,
  });

  button.disabled = false;
  button.textContent = label;

  if (error) {
    // 0060 raises 'Not allowed' and 'A price cannot be negative' by name; both
    // are worth showing verbatim rather than flattened into "could not save".
    warn("Could not save the price for " + model + ": " + error.message, "err");
    return;
  }

  // ⚠ Re-read rather than trusting the values just typed. `price_updated_at`
  // is set by the database, so the only way to show the truth is to ask it — a
  // screen that says "just now" because the client assumed it would is exactly
  // how a write that never landed stays hidden.
  //
  // ⚠ But re-read ONE ROW, not the whole list. The obvious call here is
  // refreshModels(), and it works — it also re-queries OpenAI AND Google before
  // it returns, which measured 10–20 seconds on the live site while the row sat
  // showing "never" and the count sat wrong. A rate card is filled in a row at
  // a time and a fifteen-second pause after each one is how a screen stops
  // being used. The model list has not changed; only this row has.
  const { data: fresh, error: readErr } = await supabase
    .from("ai_models")
    .select("id, input_per_1m, output_per_1m, price_per_image, price_source, price_updated_at")
    .eq("id", model)
    .maybeSingle();

  if (readErr || !fresh) {
    // The write succeeded — say so — but be honest that the screen is now
    // showing what was typed rather than what was stored.
    warn(
      "Saved the price for " + model + ", but could not read it back to confirm. " +
      "Refresh the model list to see what is actually stored.",
      "warn",
    );
    return;
  }

  const cached = (state.allModels || []).find((m) => m.id === model);
  if (cached) Object.assign(cached, fresh);
  renderPrices();
  warn("Saved the price for " + model + ".", "ok");
}

function card(s) {
  const open = state.openSlug === s.slug;
  const usedBy = (s.used_by || []).map((f) =>
    "<b>" + escapeHtml(f.function_name) + "</b>" + (f.usage_note ? " (" + escapeHtml(f.usage_note) + ")" : "")
  ).join(" · ");

  return '<section class="ai-card' + (open ? " is-open" : "") + '" data-slug="' + escapeHtml(s.slug) + '">' +
    '<button class="ai-card-head" type="button" data-toggle="' + escapeHtml(s.slug) + '" aria-expanded="' + (open ? "true" : "false") + '">' +
      '<div class="ai-card-title">' +
        "<strong>" + escapeHtml(s.label) + "</strong>" +
        '<span class="ad-pill ' + (s.kind === "image" ? "tier-premium" : "tier-standard") + '">' + escapeHtml(s.kind) + "</span>" +
        (s.is_overridden
          ? '<span class="ad-pill ok">customised v' + escapeHtml(String(s.active_version)) + "</span>"
          : '<span class="ad-pill muted">code default</span>') +
        (s.bumps_judge_version ? '<span class="ad-pill warn">calibrated</span>' : "") +
      "</div>" +
      '<div class="ai-card-facts">' +
        '<div><div class="ai-fact-label">Model</div><div class="ai-fact-value mono">' + escapeHtml(s.effective_model) + "</div></div>" +
        // ⚠ The EFFECTIVE ceiling, not the recommendation. With nothing
        // activated a service runs at its code default, so showing the
        // recommendation here would name a number nothing is using — and for
        // three services that number is lower than the truth.
        '<div><div class="ai-fact-label">Ceiling</div><div class="ai-fact-value">' +
          (s.max_output_tokens_editable
            ? escapeHtml(String(effectiveCeiling(s))) +
              (belowCode(s, s.active_max_output_tokens)
                ? ' <span class="ad-pill danger">below the code default of ' +
                  escapeHtml(String(codeCeiling(s.slug))) + "</span>"
                : "")
            : "n/a") +
        "</div></div>" +
        '<div><div class="ai-fact-label">Changed</div><div class="ai-fact-value">' +
          (s.activated_at ? escapeHtml(formatDate(s.activated_at)) : "never") +
        "</div></div>" +
      "</div>" +
      '<p class="ai-card-blurb">' + escapeHtml(s.blurb) + "</p>" +
      '<p class="ai-usedby">Used by ' + (usedBy || "nothing") + "</p>" +
    "</button>" +
    (open ? editor(s) : "") +
  "</section>";
}

function editor(s) {
  const shape = Array.isArray(s.parts_shape) ? s.parts_shape : [];
  const active = s.active_parts || {};
  const defaults = state.defaults[s.slug] || {};
  const models = s.kind === "image" ? state.models.image : state.models.text;
  const chosenModel = s.active_model || s.code_default_model;
  // ⚠ Pre-filled with what the service is RUNNING at, not with the stored
  // recommendation. This box's old default was `recommended_max_output_tokens`,
  // which for write-member-intro, write-contact-email and import-event is
  // seeded below the code default — so opening a service and pressing
  // Test run → Save & activate, changing nothing, silently lowered its ceiling.
  // See CODE_DEFAULT_CEILINGS.
  const ceiling = effectiveCeiling(s);

  let out = '<div class="ai-editor" id="ed-' + escapeHtml(s.slug) + '">';

  // ---- The warnings that belong above the boxes, not under them ----
  if (s.bumps_judge_version) {
    out += '<div class="ad-msg warn" style="margin-top:0;">' +
      "<strong>This judge is calibrated, and editing it moves the version stamp.</strong> " +
      "It was tuned against 294 real historical judgements — the rule about never marking a prompt down for " +
      "looking machine-written is the reason it was rewritten, and 52 measured scores say what happens when " +
      "it is missing. Every submission records which judge scored it, so activating a change here " +
      "automatically stamps a new version on everything judged afterwards. That is what keeps scores from " +
      "before and after your edit comparable — you do not need to do anything, and you cannot switch it off." +
      "</div>";
  }
  if ((s.used_by || []).length > 1) {
    out += '<div class="ad-msg info">' +
      "<strong>One configuration, " + (s.used_by || []).length + " functions.</strong> " +
      escapeHtml((s.used_by || []).map((f) => f.function_name).join(" and ")) +
      " both use what you save here, on purpose — the pictures they produce sit next to each other in the " +
      "member directory, and a house style kept in two places is a house style that drifts apart." +
      "</div>";
  }
  if (!Object.keys(defaults).length) {
    out += '<div class="ad-msg err">' +
      "<strong>The code default for this service could not be loaded.</strong> The boxes below show only what " +
      "is stored, which may be nothing. Saving from here would replace a prompt you cannot currently see. " +
      "Fix the ai-admin function first." +
      "</div>";
  }

  // ---- The parts ----
  for (const p of shape) {
    const key = String(p.key || "");
    const label = String(p.label || key);
    const hint = String(p.hint || "");
    const value = key in active ? active[key] : defaults[key];

    out += '<div class="ai-part">';
    out += "<label>" + escapeHtml(label) + "</label>";
    if (hint) out += '<span class="ad-hint">' + escapeHtml(hint) + "</span>";

    if (p.kind === "list") {
      const list = Array.isArray(value) ? value : [];
      const want = Number(p.length) || list.length;
      out += '<div class="ai-rota">';
      for (let i = 0; i < want; i++) {
        out += '<div class="ai-rota-row">' +
          "<span>" + escapeHtml(rotaLabel(key, i)) + "</span>" +
          '<textarea rows="' + (Number(p.rows) || 3) + '" data-part="' + escapeHtml(key) + '" data-index="' + i + '" ' +
            'aria-label="' + escapeHtml(label + ", " + rotaLabel(key, i)) + '">' +
            escapeHtml(String(list[i] == null ? "" : list[i])) +
          "</textarea>" +
        "</div>";
      }
      out += "</div>";
    } else {
      out += '<textarea rows="' + (Number(p.rows) || 10) + '" data-part="' + escapeHtml(key) + '">' +
        escapeHtml(String(value == null ? "" : value)) +
      "</textarea>";
    }
    out += "</div>";
  }

  // ---- Model and ceiling ----
  out += '<div class="ai-controls">';
  out += '<div class="ad-field"><label for="model-' + escapeHtml(s.slug) + '">Model</label>';
  if (!state.modelsLoaded) {
    out += '<select id="model-' + escapeHtml(s.slug) + '" disabled><option>Model list not loaded</option></select>';
    out += '<span class="ad-hint">Press “Refresh model list” at the top of the page. The database will not accept a model that is not on it.</span>';
  } else if (!models.length) {
    out += '<select id="model-' + escapeHtml(s.slug) + '" disabled><option>No ' + escapeHtml(s.kind) + ' models available</option></select>';
    out += '<span class="ad-hint">This account has no ' + escapeHtml(s.kind) + ' models that this dashboard recognises.</span>';
  } else {
    out += '<select id="model-' + escapeHtml(s.slug) + '" data-model="' + escapeHtml(s.slug) + '">';
    // The code default is always offered even if OpenAI did not list it, so
    // the dropdown can always show what is actually running.
    const ids = models.map((m) => m.id);
    if (ids.indexOf(chosenModel) === -1) {
      out += '<option value="' + escapeHtml(chosenModel) + '" selected>' + escapeHtml(chosenModel) +
        " (not currently listed by OpenAI)</option>";
    }
    for (const m of models) {
      out += '<option value="' + escapeHtml(m.id) + '"' + (m.id === chosenModel ? " selected" : "") + ">" +
        escapeHtml(m.id) + (m.id === s.code_default_model ? " — code default" : "") + "</option>";
    }
    out += "</select>";
    out += '<span class="ad-hint">Only ' + escapeHtml(s.kind) + " models are listed, because this service calls <code>" +
      escapeHtml(s.endpoint) + "</code>. The secret <code>" + escapeHtml(s.model_env) +
      "</code> is what runs when nothing is set here.</span>";
  }
  out += "</div>";

  if (s.max_output_tokens_editable) {
    const code = codeCeiling(s.slug);
    // All three numbers, named, because they are three different things and
    // the panel used to show only the one that is neither what is running nor
    // what the code would use.
    const facts = [
      code === null
        ? "" : "Code default: " + escapeHtml(String(code)) +
          " &mdash; what this service uses when nothing is saved here, and what a saved number replaces.",
      "Tuned value stored in the database: " + escapeHtml(String(s.recommended_max_output_tokens)) + ".",
      s.active_max_output_tokens
        ? "Currently saved: " + escapeHtml(String(s.active_max_output_tokens)) + "."
        : "Nothing is saved for this service, so it is running on its code default.",
    ].filter(Boolean).join(" ");

    out += '<div class="ad-field"><label for="ceil-' + escapeHtml(s.slug) + '">Max output tokens</label>' +
      '<input id="ceil-' + escapeHtml(s.slug) + '" type="number" min="256" max="128000" step="100" ' +
        'data-ceiling="' + escapeHtml(s.slug) + '" value="' + escapeHtml(String(ceiling)) + '">' +
      '<span class="ad-hint">' + facts + "</span>" +
    "</div>";
  } else {
    out += '<div class="ad-field"><label>Max output tokens</label>' +
      '<input type="text" value="not settable" disabled>' +
      '<span class="ad-hint">' + escapeHtml(s.ceiling_note) + "</span>" +
    "</div>";
  }
  out += "</div>";

  if (s.max_output_tokens_editable) {
    out += '<p class="ai-note" id="ceilnote-' + escapeHtml(s.slug) + '">' + ceilingNote(s, ceiling) + "</p>";
  } else if (s.ceiling_note) {
    out += '<p class="ai-note">' + escapeHtml(s.ceiling_note) + "</p>";
  }

  // ---- Note and actions ----
  out += '<div class="ad-field" style="margin-top:14px;"><label for="note-' + escapeHtml(s.slug) + '">Why are you changing this?</label>' +
    '<input id="note-' + escapeHtml(s.slug) + '" type="text" maxlength="200" data-note="' + escapeHtml(s.slug) + '" ' +
      'placeholder="Read back later, next to who changed it and when.">' +
  "</div>";

  const tested = state.tested[s.slug];
  out += '<div class="ai-actions">' +
    '<button class="ad-btn" type="button" data-test="' + escapeHtml(s.slug) + '"' +
      (state.modelsLoaded ? "" : " disabled") + ">Test run</button>" +
    '<button class="ad-btn ad-btn-primary" type="button" data-activate="' + escapeHtml(s.slug) + '"' +
      (tested && tested.passed ? "" : " disabled") + ">Save &amp; activate</button>" +
    '<div class="ad-spacer"></div>' +
    (s.is_overridden
      ? '<button class="ad-btn ad-btn-danger" type="button" data-reset="' + escapeHtml(s.slug) + '">Use the code default</button>'
      : "") +
  "</div>";

  out += '<p class="ai-note">' +
    (tested && tested.passed
      ? "Tested and passed. <strong>Save &amp; activate</strong> makes it live for every member."
      : "<strong>Test run</strong> saves this as a draft and makes one real call with it. " +
        "Nothing is live until it has passed and you activate it.") +
    "</p>";

  out += '<div id="test-' + escapeHtml(s.slug) + '"></div>';

  // ---- History ----
  out += '<div class="ai-history" id="hist-' + escapeHtml(s.slug) + '">' +
    "<h3>History</h3>" +
    '<div class="ad-empty" style="padding:14px;">Loading…</div>' +
  "</div>";

  out += "</div>";
  return out;
}

function rotaLabel(key, i) {
  if (key === "themes") return MONTHS[i] || "Entry " + (i + 1);
  if (key === "variants") return "Try " + (i + 1);
  return "Entry " + (i + 1);
}

// ⚠ Warns rather than blocks, which is what was asked for — but says why, with
// the number attached. `build-prospect-profile` failed 42.9% of its live calls
// at a ceiling that looked generous for the answer and was not, because on the
// gpt-5 family the reasoning is drawn from the same budget.
//
// The comparison that comes FIRST is against the code default, not against the
// stored recommendation. A number below the recommendation is a judgement call;
// a number below the code default is a regression against what the service runs
// at today, and for three services the stored recommendation IS below the code
// default — so a note that only ever compared against the recommendation stayed
// silent for exactly the click that does the damage.
function ceilingNote(s, value) {
  const n = Number(value);
  const tuned = Number(s.recommended_max_output_tokens);
  const code = codeCeiling(s.slug);

  const bits = [];

  // An emptied box is not "zero", and it is not "whatever the database thinks"
  // either — `collect()` substitutes the running ceiling. Say which number that
  // is instead of measuring 0 against the code default.
  if (String(value).trim() === "" || !Number.isFinite(n) || n <= 0) {
    return "<strong>Empty.</strong> Saving now would store " +
      escapeHtml(String(effectiveCeiling(s))) + " &mdash; what this service is running at &mdash; rather " +
      "than leaving the ceiling to the database, which would fill it from the tuned value. " +
      escapeHtml(s.ceiling_note || "");
  }

  if (code !== null && n < code) {
    bits.push(
      "<strong>This is below the code default of " + escapeHtml(String(code)) +
      ", which is what this service runs at today.</strong> " +
      "A saved ceiling does not sit alongside the code default, it replaces it — so activating " +
      escapeHtml(String(n)) + " would lower every call from " + escapeHtml(String(code)) + " to " +
      escapeHtml(String(n)) + ". On the gpt-5 family the ceiling is shared with the model's own reasoning " +
      "tokens and can be spent before the first visible character is written; the symptom is a truncated " +
      "answer rather than an error, and a truncation is retried at double the ceiling — so a ceiling set too " +
      "low is paid for twice and still fails. The prospect-profile importer lost 42.9% of its live calls " +
      "exactly this way.");
  } else if (Number.isFinite(tuned) && n < tuned) {
    bits.push(
      "<strong>Below the tuned value of " + escapeHtml(String(tuned)) + ".</strong> " +
      "On the gpt-5 family this ceiling is shared with the model's own reasoning tokens and can be spent " +
      "before the first visible character is written — the prospect-profile importer failed 42.9% of its live " +
      "calls that way, and the symptom was a truncated answer rather than an error. If this is too low the " +
      "test run below will fail with a truncation, which is the honest check.");
  } else if (Number.isFinite(tuned) && n > tuned * 4) {
    bits.push(
      "<strong>Well above the tuned value of " + escapeHtml(String(tuned)) + ".</strong> " +
      "Nothing unused is billed — OpenAI charges for tokens generated, not tokens permitted — so this is " +
      "safe, just unlikely to be needed.");
  }

  // ⚠ The database's own suggestion is wrong for this service. Said whatever
  // the operator has typed, because the number in the box came from here and
  // the next person to open the page will be offered it again. Migration 0032
  // fixes the seeded value; this fires when 0032 has not been applied.
  if (code !== null && Number.isFinite(tuned) && tuned < code) {
    bits.push(
      "<strong>The tuned value stored for this service (" + escapeHtml(String(tuned)) +
      ") is itself below the code default of " + escapeHtml(String(code)) + ".</strong> " +
      "That seeded number is wrong, and migration 0032 &mdash; which corrects it &mdash; has evidently not " +
      "been applied to this database. Do not save " + escapeHtml(String(tuned)) +
      " merely because the panel offered it.");
  }

  if (s.ceiling_note) bits.push(escapeHtml(s.ceiling_note));
  return bits.join(" ");
}

// ---- Wiring ----------------------------------------------------------

function wire() {
  document.querySelectorAll("[data-toggle]").forEach((el) => {
    el.addEventListener("click", () => {
      const slug = el.getAttribute("data-toggle");
      state.openSlug = state.openSlug === slug ? null : slug;
      render();
      if (state.openSlug) loadHistory(state.openSlug);
    });
  });

  document.querySelectorAll("[data-ceiling]").forEach((el) => {
    el.addEventListener("input", () => {
      const slug = el.getAttribute("data-ceiling");
      const s = byslug(slug);
      const note = document.getElementById("ceilnote-" + slug);
      if (s && note) note.innerHTML = ceilingNote(s, el.value);
    });
  });

  // ⚠ A pass belongs to the exact text and model that were tested, and to
  // nothing else. Without this, somebody tests a prompt, reads "passed",
  // notices a typo, fixes it, and presses Save & activate — which would
  // activate the DRAFT ROW THAT WAS TESTED, not the corrected text on screen.
  // The database would not catch it: that row genuinely passed. So any edit
  // after a test throws the pass away and the button goes back to disabled.
  //
  // The result panel is left on screen rather than cleared, because "this is
  // what the version you just changed did" is still worth reading — but the
  // note under the buttons says plainly that it no longer applies.
  document.querySelectorAll(".ai-editor").forEach((ed) => {
    const slug = ed.id.replace(/^ed-/, "");
    const invalidate = () => {
      if (!state.tested[slug]) return;
      delete state.tested[slug];
      const act = ed.querySelector("[data-activate]");
      if (act) act.disabled = true;
      const stale = ed.querySelector(".ai-test-head");
      if (stale && !stale.dataset.stale) {
        stale.dataset.stale = "1";
        stale.insertAdjacentHTML(
          "beforeend",
          '<span class="ai-test-reason"><strong>— edited since. Test again before this can go live.</strong></span>',
        );
      }
    };
    ed.querySelectorAll("[data-part], [data-model], [data-ceiling]").forEach((f) => {
      f.addEventListener("input", invalidate);
      f.addEventListener("change", invalidate);
    });
  });

  document.querySelectorAll("[data-test]").forEach((el) => {
    el.addEventListener("click", () => runTest(el.getAttribute("data-test"), el));
  });
  document.querySelectorAll("[data-activate]").forEach((el) => {
    el.addEventListener("click", () => activate(el.getAttribute("data-activate"), el));
  });
  document.querySelectorAll("[data-reset]").forEach((el) => {
    el.addEventListener("click", () => reset(el.getAttribute("data-reset"), el));
  });

  const refresh = document.getElementById("ai-refresh-models");
  if (refresh && !refresh.dataset.wired) {
    refresh.dataset.wired = "1";
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      await refreshModels({});
      refresh.disabled = false;
    });
  }

  // ⚠ `dataset.wired` for the same reason as the button above: wire() runs on
  // every render, and a filter box that gains a listener each time re-renders
  // the table once per keystroke per render.
  const filter = document.getElementById("ai-price-filter");
  if (filter && !filter.dataset.wired) {
    filter.dataset.wired = "1";
    filter.addEventListener("input", () => {
      state.priceFilter = filter.value;
      renderPrices();
      // renderPrices() replaces the table, not the box, so focus survives —
      // but the caret does not follow a value the browser did not change, so
      // nothing else is needed here.
    });
  }
}

function collect(slug) {
  const s = byslug(slug);
  const parts = {};
  const shape = Array.isArray(s.parts_shape) ? s.parts_shape : [];

  for (const p of shape) {
    const key = String(p.key || "");
    if (p.kind === "list") {
      const rows = document.querySelectorAll('#ed-' + cssEscape(slug) + ' [data-part="' + cssEscape(key) + '"]');
      parts[key] = Array.prototype.map.call(rows, (r) => r.value.trim());
    } else {
      const box = document.querySelector('#ed-' + cssEscape(slug) + ' [data-part="' + cssEscape(key) + '"]');
      parts[key] = box ? box.value.trim() : "";
    }
  }

  const modelEl = document.querySelector('[data-model="' + cssEscape(slug) + '"]');
  const ceilEl = document.querySelector('[data-ceiling="' + cssEscape(slug) + '"]');
  const noteEl = document.querySelector('[data-note="' + cssEscape(slug) + '"]');

  // ⚠ AN EMPTY BOX MUST NOT MEAN "LET THE DATABASE CHOOSE". 0031's version
  // trigger fills a null `max_output_tokens` from
  // `recommended_max_output_tokens` — the very number that is seeded too low
  // for write-member-intro, write-contact-email and import-event. So clearing
  // this field and pressing save would store 1200 for the introduction writer
  // by the back door, past every warning on this page, and the panel would
  // then correctly report a ceiling nobody chose.
  //
  // A service that has an editable ceiling therefore always sends a number, and
  // an empty or nonsensical box falls back to what the service is running at
  // now rather than to the seed. A service with no editable ceiling still sends
  // null, which is what the trigger wants: it nulls the column anyway, because
  // an image call carries no ceiling.
  let ceiling = null;
  if (ceilEl) {
    const typed = Number(ceilEl.value);
    ceiling = Number.isInteger(typed) && typed > 0 ? typed : effectiveCeiling(s);
  }

  return {
    service_slug: slug,
    parts,
    model: modelEl ? modelEl.value : (s.active_model || s.code_default_model),
    max_output_tokens: ceiling,
    note: noteEl ? noteEl.value.trim().slice(0, 200) : "",
  };
}

// The whole flow, in one button, because splitting "save a draft" from "test
// it" would let somebody save and walk away thinking they had changed
// something.
async function runTest(slug, button) {
  const box = document.getElementById("test-" + slug);
  button.disabled = true;
  box.innerHTML = '<div class="ad-msg info">Composing the prompt and making one real call. This can take up to a minute on a reasoning model.</div>';

  const draft = collect(slug);

  // Insert as staff. The trigger assigns the version number and the digest,
  // and refuses a model of the wrong kind, an unknown part key or a model that
  // is not on the list — so a failure here is usually a real answer rather
  // than a bug, and its message is written to be read.
  const { data: inserted, error: insErr } = await supabase
    .from("ai_service_versions")
    .insert(draft)
    .select("id, version, config_digest")
    .single();

  if (insErr) {
    box.innerHTML = '<div class="ad-msg err"><strong>The draft was refused.</strong> ' + escapeHtml(insErr.message) + "</div>";
    button.disabled = false;
    return;
  }

  const res = await invoke("test", { version_id: inserted.id });
  button.disabled = false;

  if (!res.ok) {
    box.innerHTML = '<div class="ad-msg err"><strong>The test could not be run.</strong> ' + escapeHtml(res.error) + "</div>";
    return;
  }

  const r = res.data;
  state.tested[slug] = { id: inserted.id, passed: !!r.ok, version: inserted.version, digest: inserted.config_digest };

  box.innerHTML = testHtml(slug, inserted, r);

  // Re-enable the activate button in place rather than re-rendering, so the
  // result the person is reading does not vanish underneath them.
  const act = document.querySelector('[data-activate="' + cssEscape(slug) + '"]');
  if (act) act.disabled = !r.ok;

  loadHistory(slug);
}

function testHtml(slug, inserted, r) {
  const pill = r.ok
    ? '<span class="ad-pill ok">passed</span>'
    : '<span class="ad-pill danger">failed</span>';

  let out = '<div class="ai-test">' +
    '<div class="ai-test-head">' + pill +
      '<span class="ai-test-reason">' + escapeHtml(r.reason || "") + "</span>" +
    "</div>" +
    '<div class="ai-test-body">';

  out += "<h4>Version</h4><p class=\"ai-note\" style=\"margin-top:0;\">v" + escapeHtml(String(inserted.version)) +
    ', model <code>' + escapeHtml(String(r.model || "")) + "</code>, digest " +
    '<span class="ai-digest">' + escapeHtml(String(inserted.config_digest || "")) + "</span>";
  const s = byslug(slug);
  if (s && s.bumps_judge_version) {
    out += " — this is what will be stamped on every submission judged after you activate it.";
  }
  out += "</p>";

  if (r.output && r.output.image_data_url) {
    out += "<h4>What it drew</h4>";
    out += '<img src="' + escapeHtml(r.output.image_data_url) + '" alt="Test image produced by this prompt">';
    out += '<p class="ai-note">Drawn at low quality from the composed prompt, with no member photograph involved — ' +
      "the club stores none, so a test cannot use one. What this proves is that the model accepts this prompt " +
      "and this account can call it, which is what an edit puts at risk.</p>";
  } else if (r.output) {
    out += "<h4>What came back</h4>";
    out += "<pre>" + escapeHtml(JSON.stringify(r.output, null, 2)) + "</pre>";
  }

  if (r.detail && r.detail.composed_prompt) {
    out += "<h4>The prompt that was actually sent</h4>";
    out += "<pre>" + escapeHtml(r.detail.composed_prompt) + "</pre>";
  }

  if (r.detail && r.detail.usage) {
    const u = r.detail.usage;
    out += "<h4>Cost of this one call</h4>";
    out += '<p class="ai-note" style="margin-top:0;">' +
      escapeHtml(String(u.output_tokens == null ? "?" : u.output_tokens)) + " output tokens" +
      (u.reasoning_tokens == null ? "" : ", of which " + escapeHtml(String(u.reasoning_tokens)) + " went on reasoning") +
      ", against a ceiling of " + escapeHtml(String(u.ceiling)) + "." +
      "</p>";
  }

  out += "</div></div>";
  return out;
}

async function activate(slug, button) {
  const tested = state.tested[slug];
  if (!tested || !tested.passed) return;

  button.disabled = true;
  const { error } = await supabase.rpc("activate_ai_version", { p_version_id: tested.id });
  if (error) {
    warn("Couldn't activate: " + error.message, "err");
    button.disabled = false;
    return;
  }
  delete state.tested[slug];
  warn("Version " + tested.version + " of " + slug + " is live.", "ok");
  await reload(slug);
}

async function reset(slug, button) {
  button.disabled = true;
  const { error } = await supabase.rpc("reset_ai_service_to_code", { p_slug: slug });
  if (error) {
    warn("Couldn't reset: " + error.message, "err");
    button.disabled = false;
    return;
  }
  warn(slug + " is back on the prompt in its source file. Nothing was deleted — the history is still there.", "ok");
  await reload(slug);
}

async function rollback(id) {
  const { error } = await supabase.rpc("rollback_ai_version", { p_source_version_id: id });
  if (error) {
    warn("Couldn't roll back: " + error.message, "err");
    return;
  }
  warn("Rolled back. The earlier configuration is live again, and the history now shows both.", "ok");
  await reload(state.openSlug);
}

async function reload(slug) {
  const { data, error } = await supabase.from("ai_service_overview").select("*").order("sort_order", { ascending: true });
  if (error) {
    warn("Couldn't reload: " + error.message, "err");
    return;
  }
  state.services = data || [];
  renderStats();
  render();
  if (slug) loadHistory(slug);
}

// ---- History ---------------------------------------------------------

async function loadHistory(slug) {
  const box = document.getElementById("hist-" + slug);
  if (!box) return;

  const { data, error } = await supabase
    .from("ai_service_versions")
    .select("id, version, model, max_output_tokens, note, created_at, activated_at, is_active, test_status, rolled_back_from, config_digest, created_by")
    .eq("service_slug", slug)
    .order("version", { ascending: false })
    .limit(40);

  if (error) {
    box.innerHTML = "<h3>History</h3>" + '<div class="ad-msg err">' + escapeHtml(error.message) + "</div>";
    return;
  }
  if (!data || !data.length) {
    box.innerHTML = "<h3>History</h3>" +
      '<p class="ai-note">Nothing has ever been saved for this service. It is running on the prompt in its ' +
      "source file, which is where it started.</p>";
    return;
  }

  // Names for whoever made each change. One lookup for the whole list.
  const ids = Array.from(new Set(data.map((v) => v.created_by).filter(Boolean)));
  const names = {};
  if (ids.length) {
    const { data: people } = await supabase.from("profiles").select("user_id, full_name").in("user_id", ids);
    (people || []).forEach((p) => { names[p.user_id] = p.full_name; });
  }

  box.innerHTML = "<h3>History</h3>" + data.map((v) => {
    const who = names[v.created_by] || "somebody";
    const status = v.is_active
      ? '<span class="ad-pill ok">live</span>'
      : v.test_status === "passed"
      ? '<span class="ad-pill muted">passed</span>'
      : v.test_status === "failed"
      ? '<span class="ad-pill danger">failed its test</span>'
      : '<span class="ad-pill warn">untested</span>';

    return '<div class="ai-hist-row">' +
      '<span class="ai-hist-v">v' + escapeHtml(String(v.version)) + " " + status + "</span>" +
      '<span class="ai-hist-note">' +
        escapeHtml(v.note || "(no note)") +
        '<br><span class="ai-hist-when">' + escapeHtml(who) + " · " + escapeHtml(formatDate(v.created_at)) +
        " · " + escapeHtml(v.model || "") +
        (v.max_output_tokens ? " · ceiling " + escapeHtml(String(v.max_output_tokens)) : "") +
        (v.rolled_back_from ? " · a rollback to v" + escapeHtml(String(v.rolled_back_from)) : "") +
        ' · <span class="ai-digest">' + escapeHtml(v.config_digest || "") + "</span></span>" +
      "</span>" +
      (v.is_active || v.test_status !== "passed"
        ? "<span></span>"
        : '<button class="ad-btn ad-btn-sm" type="button" data-rollback="' + escapeHtml(v.id) + '">Roll back to this</button>') +
    "</div>";
  }).join("") +
  '<p class="ai-note">Only a version that passed its test can be rolled back to, and rolling back needs no ' +
  "fresh call — the moment you most need it is the moment the model is most likely to be the thing that is " +
  "broken. A rollback is added as a new entry rather than reviving an old one, so the timeline stays honest.</p>";

  box.querySelectorAll("[data-rollback]").forEach((el) => {
    el.addEventListener("click", () => {
      el.disabled = true;
      rollback(el.getAttribute("data-rollback"));
    });
  });
}

// ---- Plumbing --------------------------------------------------------

async function invoke(action, extra) {
  const { data, error } = await supabase.functions.invoke("ai-admin", {
    body: Object.assign({ action: action }, extra || {}),
  });

  // functions.invoke surfaces a non-2xx as a generic FunctionsHttpError with
  // the useful part in `context`, which is the same problem app/onboarding.html
  // documents. Dig it out rather than showing "Edge Function returned a
  // non-2xx status code" to a staff member.
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

function byslug(slug) {
  return state.services.filter((s) => s.slug === slug)[0];
}

function warn(text, kind) {
  const box = document.getElementById("ai-warnings");
  box.innerHTML = '<div class="ad-msg ' + kind + '">' + escapeHtml(text) + "</div>";
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Slugs here are our own and match /^[a-z0-9-]+$/, but they are concatenated
// into selectors, so they are escaped rather than trusted to stay that way.
function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

function plural(n, word) {
  return n === 1 ? word : word + "s";
}

function timeOf(iso) {
  if (!iso) return "just now";
  const d = new Date(iso);
  return isNaN(d) ? "just now" : "at " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
