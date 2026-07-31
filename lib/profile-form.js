// Sahaba Club — the profile form, in one place
// ------------------------------------------------------------
// profile.html and the dashboard's Profile section ask for the same thing.
// They used to ask for it twice, in two hand-maintained copies, and they had
// already drifted: the dashboard had no headline, city or country, so a
// member who filled it in there could not understand why Connect still said
// their profile was incomplete. Everything both pages need to agree on lives
// here — the field list, the vocabularies, the completeness rule, and the
// merge the document import uses.
//
// Storage is unchanged and must stay unchanged: `skills` and `interests` are
// still text[] on `profiles`. The recommender scores against those columns, so
// the tag picker below is an input affordance, not a schema change.
import { supabase } from "./supabase-client.js";
import { isMissingSchema } from "./connect.js";

// ---- Vocabularies -----------------------------------------------------

// Both lookups are advisory. A member must be able to finish this form when
// `countries` or `tag_suggestions` is empty, or missing entirely, so every
// caller here returns [] rather than throwing and the UI degrades to "no
// suggestions" instead of "broken page".
export async function loadCountries() {
  const res = await supabase
    .from("countries")
    .select("code, name, sort_order")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (res.error) return [];
  return res.data || [];
}

export async function loadTagSuggestions() {
  const res = await supabase
    .from("tag_suggestions")
    .select("tag, kind")
    .order("uses", { ascending: false })
    .order("tag", { ascending: true });
  if (res.error) return [];
  return res.data || [];
}

// `kind` is 'skill', 'interest' or 'both' — a picker asks for the ones that
// apply to it and gets the 'both' entries either way.
export function suggestionsFor(rows, kind) {
  return (rows || [])
    .filter((r) => r.kind === kind || r.kind === "both")
    .map((r) => r.tag);
}

export const OPEN_TO = [
  { value: "mentoring", label: "Mentoring" },
  { value: "collaborating", label: "Collaborating" },
  { value: "hiring", label: "Hiring" },
  { value: "speaking", label: "Speaking" },
];

// The country `<select>` is the only way to set a country — free text is what
// produced "UAE", "Dubai" and "united arab emirates" as three different
// places. One exception, and it matters: if this member already has a country
// that is not in the table (a legacy value, or the table is empty), it is
// added as an option and pre-selected. Dropping it would silently erase
// something they typed, which is worse than one untidy option.
export function fillCountrySelect(select, countries, current) {
  const value = String(current || "").trim();
  const names = (countries || []).map((c) => c.name);
  const options = ['<option value="">Select one</option>'];

  names.forEach((name) => {
    options.push('<option value="' + escapeAttr(name) + '">' + escapeHtml(name) + "</option>");
  });
  if (value && names.indexOf(value) === -1) {
    options.push('<option value="' + escapeAttr(value) + '">' + escapeHtml(value) + "</option>");
  }
  select.innerHTML = options.join("");
  select.value = value;
}

// ---- Completeness -----------------------------------------------------

// Mirrors public.profile_is_complete (0018), which since 0019 is also what
// decides whether a row appears in member_directory. The database is the
// authority; this exists so the page can say what is still missing *before*
// the member wonders why they cannot find themselves.
//
// Nothing here blocks a save. Since 0019 dropped the gate trigger there is no
// error path left to report — an incomplete profile saves fine, it just is not
// listed yet.
export function missingForConnect(p) {
  const need = [];
  const has = (v) => String((p && v) || "").trim().length > 0;
  if (!has(p && p.full_name)) need.push("your name");
  if (!has(p && p.avatar_url)) need.push("a photo");
  if (!has(p && p.bio) && !has(p && p.headline)) need.push("a short bio or headline");
  if (!(Array.isArray(p && p.interests) && p.interests.length)) need.push("at least one interest");
  return need;
}

export function joinList(items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  return list.slice(0, -1).join(", ") + " and " + list[list.length - 1];
}

// The one line under the form. Three states, none of them a failure:
// not listed yet and here is why, ready but switched off, or listed.
export function connectHint(p) {
  const need = missingForConnect(p);
  if (need.length) {
    return {
      kind: "info",
      text: "You'll appear in Connect once you add " + joinList(need) + ".",
    };
  }
  if (!(p && p.is_discoverable)) {
    return {
      kind: "info",
      text: "Your profile is ready. Switch on “Show me in Connect” above and other members can find you.",
    };
  }
  return {
    kind: "ok",
    text: "You're listed in Connect — other members can find you, follow you and say hello.",
  };
}

// ---- The document import ----------------------------------------------

// Layered onto whatever is already in the form, never replacing it wholesale:
// the member usually has a profile already and a sparse CV must not blank out
// details they typed themselves.
//
// Deliberately generic. It copies every key the extractor returns that the
// form knows how to hold, so when parse-profile-document starts returning
// headline, company, position, years_experience, city or country, they land
// here with no change to this file. Unknown keys are ignored rather than
// posted to `profiles`, because an UPDATE naming a column that does not exist
// fails the whole save — including the fields that were fine.
export function mergeExtracted(base, extracted, allowedKeys) {
  const out = Object.assign({}, base);
  if (!extracted || typeof extracted !== "object") return out;
  const allowed = allowedKeys && allowedKeys.length ? allowedKeys : Object.keys(base);

  Object.keys(extracted).forEach((key) => {
    if (allowed.indexOf(key) === -1) return;
    const value = extracted[key];
    if (value === null || value === undefined || value === "") return;
    if (Array.isArray(value)) {
      const cleaned = value.map((v) => String(v).trim()).filter(Boolean);
      if (!cleaned.length) return;
      out[key] = cleaned;
      return;
    }
    if (typeof value === "string" && !value.trim()) return;
    out[key] = value;
  });
  return out;
}

// ---- The tag picker ---------------------------------------------------

// Discrete chips over a comma-separated box. The old input stored whatever was
// typed, so "Power Apps", "power apps" and "PowerApps" were three tags and the
// recommender scored them as three unrelated things. This keeps the same
// text[] storage and steers people onto one spelling by suggesting the
// vocabulary first — while still letting them type something new, because a
// club that cannot name a thing it has not seen before stops learning.
export function createTagPicker(options) {
  const root = options.root;
  const inputId = options.inputId;
  const label = options.label || "tags";
  let tags = [];
  let suggestions = options.suggestions || [];
  let activeIndex = -1;

  root.classList.add("tagpick");
  root.innerHTML =
    '<div class="tagpick-box">' +
    '<span class="tagpick-chips"></span>' +
    '<input type="text" class="tagpick-input" id="' + escapeAttr(inputId) + '" ' +
    'autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list" ' +
    'placeholder="' + escapeAttr(options.placeholder || "Type to search, Enter to add") + '">' +
    "</div>" +
    '<ul class="tagpick-menu" role="listbox" hidden></ul>';

  const chipsEl = root.querySelector(".tagpick-chips");
  const inputEl = root.querySelector(".tagpick-input");
  const menuEl = root.querySelector(".tagpick-menu");

  function norm(s) {
    return String(s || "").trim().toLowerCase();
  }
  function notify() {
    if (typeof options.onChange === "function") options.onChange(tags.slice());
  }

  function renderChips() {
    chipsEl.innerHTML = tags
      .map(
        (t, i) =>
          '<span class="tagpick-chip">' +
          escapeHtml(t) +
          '<button type="button" class="tagpick-x" data-i="' + i + '" ' +
          'aria-label="Remove ' + escapeAttr(t) + '">&times;</button></span>'
      )
      .join("");
  }

  function addTag(value) {
    const text = String(value || "").trim();
    if (!text) return;
    // Case-insensitive: the whole point is that one tag has one spelling.
    if (tags.some((t) => norm(t) === norm(text))) {
      inputEl.value = "";
      closeMenu();
      return;
    }
    tags.push(text);
    inputEl.value = "";
    renderChips();
    closeMenu();
    notify();
  }

  function removeAt(i) {
    tags.splice(i, 1);
    renderChips();
    notify();
  }

  function matches() {
    const q = norm(inputEl.value);
    const chosen = tags.map(norm);
    return suggestions
      .filter((s) => chosen.indexOf(norm(s)) === -1)
      .filter((s) => (q ? norm(s).indexOf(q) !== -1 : true))
      .slice(0, 8);
  }

  function closeMenu() {
    menuEl.hidden = true;
    menuEl.innerHTML = "";
    activeIndex = -1;
    inputEl.setAttribute("aria-expanded", "false");
  }

  function openMenu() {
    const list = matches();
    const typed = inputEl.value.trim();
    const isNew =
      typed && !suggestions.some((s) => norm(s) === norm(typed)) &&
      !tags.some((t) => norm(t) === norm(typed));

    if (!list.length && !isNew) return closeMenu();

    const rows = list.map(
      (s, i) =>
        '<li role="option" class="tagpick-opt" data-v="' + escapeAttr(s) + '" ' +
        'id="' + escapeAttr(inputId) + '-o' + i + '">' + escapeHtml(s) + "</li>"
    );
    if (isNew) {
      rows.push(
        '<li role="option" class="tagpick-opt tagpick-new" data-v="' + escapeAttr(typed) + '" ' +
        'id="' + escapeAttr(inputId) + '-onew">Add “' + escapeHtml(typed) + '”</li>'
      );
    }
    menuEl.innerHTML = rows.join("");
    menuEl.hidden = false;
    activeIndex = -1;
    inputEl.setAttribute("aria-expanded", "true");
  }

  function setActive(next) {
    const opts = menuEl.querySelectorAll(".tagpick-opt");
    if (!opts.length) return;
    activeIndex = (next + opts.length) % opts.length;
    Array.prototype.forEach.call(opts, (el, i) => {
      el.classList.toggle("is-active", i === activeIndex);
    });
    inputEl.setAttribute("aria-activedescendant", opts[activeIndex].id);
  }

  chipsEl.addEventListener("click", function (ev) {
    const btn = ev.target.closest(".tagpick-x");
    if (btn) removeAt(Number(btn.getAttribute("data-i")));
  });

  menuEl.addEventListener("mousedown", function (ev) {
    // mousedown, not click: blur would close the menu before click landed.
    const opt = ev.target.closest(".tagpick-opt");
    if (!opt) return;
    ev.preventDefault();
    addTag(opt.getAttribute("data-v"));
  });

  inputEl.addEventListener("input", openMenu);
  inputEl.addEventListener("focus", openMenu);
  inputEl.addEventListener("blur", function () {
    window.setTimeout(closeMenu, 120);
  });

  inputEl.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowDown") { ev.preventDefault(); openMenu(); setActive(activeIndex + 1); return; }
    if (ev.key === "ArrowUp") { ev.preventDefault(); setActive(activeIndex - 1); return; }
    if (ev.key === "Escape") { closeMenu(); return; }
    if (ev.key === "Enter") {
      // Enter inside the picker adds a tag; it must never submit the form.
      ev.preventDefault();
      const opts = menuEl.querySelectorAll(".tagpick-opt");
      if (activeIndex >= 0 && opts[activeIndex]) addTag(opts[activeIndex].getAttribute("data-v"));
      else addTag(inputEl.value);
      return;
    }
    if (ev.key === "," ) { ev.preventDefault(); addTag(inputEl.value); return; }
    if (ev.key === "Backspace" && !inputEl.value && tags.length) {
      removeAt(tags.length - 1);
    }
  });

  renderChips();

  return {
    get: function () { return tags.slice(); },
    set: function (next) {
      tags = (next || []).map((t) => String(t).trim()).filter(Boolean);
      renderChips();
    },
    setSuggestions: function (next) { suggestions = next || []; },
    // A tag left half-typed in the box is a tag the member meant to add.
    // Saving without it is the single most annoying thing a picker can do.
    flush: function () { if (inputEl.value.trim()) addTag(inputEl.value); },
    label: label,
  };
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

function escapeAttr(value) {
  return escapeHtml(value);
}

// Empty text boxes should store NULL, not "". The distinction leaks: a
// country of "" is not null, so it fails `country in (select name from
// countries)` and shows up as a bogus "variant" — there is already one such
// row in the table from the old free-text field.
export function nullIfBlank(value) {
  const s = String(value == null ? "" : value).trim();
  return s ? s : null;
}

export function intOrNull(value) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  if (isNaN(n) || n < 0 || n > 60) return null;
  return n;
}

export { isMissingSchema };
