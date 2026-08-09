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
import { supabase } from "./supabase-client.js?v=8917e84e6a";
import { isMissingSchema } from "./connect.js?v=8917e84e6a";

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

// What a member is open to being approached about. `mentoring` and
// `collaborating` were the original two; they are kept in OPEN_TO_LEGACY so a
// profile saved before this list changed still renders its old choices
// instead of silently losing them, but they are no longer offered.
export const OPEN_TO = [
  { value: "coaching", label: "Coaching" },
  { value: "work", label: "Work" },
  // ⚠ LABEL ONLY. The stored value has always been `freelance`; the label read
  // "Free Lance" and that is the string that reached the rendered page. Nothing
  // in the database holds the label — `open_to` is a text[] of these `value`s,
  // written by readOpenTo() off the checkbox `value` attribute on both hosts —
  // so there is no row to migrate and no vocabulary table entry to correct.
  { value: "freelance", label: "Freelance" },
  { value: "hiring", label: "Hiring" },
  { value: "investing", label: "Investing" },
  { value: "speaking", label: "Speaking" },
];

export const OPEN_TO_LEGACY = [
  { value: "mentoring", label: "Mentoring" },
  { value: "collaborating", label: "Collaborating" },
];

// Label for a stored value, whether it is current or legacy. Falls back to the
// raw value so an unknown one shows as itself rather than disappearing.
export function openToLabel(value) {
  const hit = OPEN_TO.concat(OPEN_TO_LEGACY).find((o) => o.value === value);
  return hit ? hit.label : String(value || "");
}

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

// ---- Field limits -----------------------------------------------------

// Bio 900 characters · skills 50 · interests 10.
//
// The limits live here because they have to be true in three places that do
// not share code: the database CHECK constraints in 0037, the save path, and
// the counters the member sees while typing. A `maxlength` attribute is NOT
// enforcement — it constrains typing and nothing else. It does not apply to a
// value set programmatically, it is absent from the dashboard's copy of this
// form, and neither of those matters next to the plain fact that the save path
// is a PostgREST UPDATE that anything holding the member's token can call
// without ever loading the page. 0037 is the only layer that cannot be walked
// around; these two are what stop a member being told "23514" by Postgres for
// something the form should have said in words.
//
// ⚠ NOTHING HERE TRUNCATES, and nothing that calls it may either. A profile
// written before these limits existed holds the member's own words, and
// silently cutting them to fit is data loss dressed up as validation. Over the
// line is a thing the owner is TOLD about and asked to shorten themselves.
export const FIELD_LIMITS = {
  bio: 900,
  skills: 50,
  interests: 10,
};

// The counter appears at 750 and turns amber at 850 — far enough back that a
// member finds out they are near the end while there is still something they
// can do about it, rather than mid-word at 899.
export const BIO_COUNTER_FROM = 750;
export const BIO_COUNTER_AMBER = 850;

// ⚠ Code points, not UTF-16 code units. `char_length()` in Postgres counts
// characters; JavaScript's `.length` counts code units, so one emoji is 1 to
// the constraint and 2 to `.length`. Counting the same way as the database is
// what stops the form refusing a bio the database would have accepted — and
// stops it accepting one the database will then reject with a SQLSTATE the
// member cannot act on.
//
// The `maxlength="900"` on the textarea still counts code units and is
// therefore very slightly stricter in the astral-character case. That is the
// safe direction — it stops typing early, it never trims what is already
// there — and it is the one part of this that HTML will not let us count
// differently.
export function bioLength(value) {
  return Array.from(String(value == null ? "" : value)).length;
}

// What a tag picker needs to know to draw itself, in one place so the picker
// and its host cannot disagree. `max` of 0/undefined means no limit, which is
// what `#f-goals-input` deliberately still has — see the note on §5 in the
// spec: no cap was ever specified for "what you're open to", so none is
// invented here.
export function tagCountState(tags, max) {
  const count = Array.isArray(tags) ? tags.length : 0;
  const limit = Number(max) > 0 ? Number(max) : 0;
  if (!limit) return { count: count, max: 0, left: Infinity, atLimit: false, over: 0 };
  return {
    count: count,
    max: limit,
    left: Math.max(0, limit - count),
    atLimit: count >= limit,
    over: Math.max(0, count - limit),
  };
}

// Adding is refused AT the limit, not one past it — the 51st skill is the one
// that gets stopped, and the member is told which one to remove.
export function canAddTag(tags, max) {
  return !tagCountState(tags, max).atLimit;
}

// The save path's question: is anything over? Returns one entry per field that
// is, each carrying the numbers rather than a pre-baked sentence, so a caller
// can say it its own way. An empty array means the save may go ahead.
//
// A field that is EXACTLY at its limit is fine. Only strictly over is a
// problem — 900 characters is nine hundred characters, not eight hundred and
// ninety-nine.
export function limitProblems(view) {
  const v = view || {};
  const out = [];

  const bioChars = bioLength(v.bio);
  if (bioChars > FIELD_LIMITS.bio) {
    out.push({
      field: "bio", label: "short bio", unit: "characters",
      limit: FIELD_LIMITS.bio, actual: bioChars, excess: bioChars - FIELD_LIMITS.bio,
    });
  }

  [["skills", "skills", "skills"], ["interests", "interests", "interests"]].forEach(function (spec) {
    const key = spec[0];
    const state = tagCountState(v[key], FIELD_LIMITS[key]);
    if (state.over > 0) {
      out.push({
        field: key, label: spec[1], unit: spec[2],
        limit: state.max, actual: state.count, excess: state.over,
      });
    }
  });

  return out;
}

// One sentence naming every field that is over and by how much. Written to be
// shown to the member as-is: it says what to do, and — the part that matters —
// it says their words are still there. A member who reads "too long" and then
// reloads to find the field empty will never trust the form again, so the
// message promises the opposite and the code keeps that promise.
export function limitBlockMessage(problems) {
  // No commas inside a clause. joinList already separates the clauses with
  // them, and "you have 52 skills, 2 over the limit of 50" inside a
  // comma-joined list reads as four things wrong rather than two.
  const list = (problems || []).map(function (p) {
    if (p.field === "bio") {
      return "your short bio is " + p.excess + " " + plural(p.excess, "character") +
        " over the " + p.limit + " allowed";
    }
    return "your " + p.label + " list is " + p.excess + " over the " + p.limit + " allowed";
  });
  if (!list.length) return "";
  return "Nothing was saved — " + joinList(list) + ". Shorten " +
    (list.length === 1 ? "it" : "them") +
    " and save again; everything you have written is still here.";
}

function plural(n, word) {
  return Number(n) === 1 ? word : word + "s";
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

// Requirements that have somewhere to go. Naming a requirement without a
// route to satisfying it is how five of six profiles ended up stuck: the line
// said "add a photo" and there was no control anywhere in the app that set
// one. The word is now the way in.
const NEED_JUMPS = { "a photo": "photo" };

function needHtml(need) {
  const jump = NEED_JUMPS[need];
  if (!jump) return escapeHtml(need);
  return '<button type="button" class="connect-jump" data-jump="' +
    escapeAttr(jump) + '">' + escapeHtml(need) + "</button>";
}

// Same joining as joinList, over fragments that are already escaped.
function joinHtmlList(items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  return list.slice(0, -1).join(", ") + " and " + list[list.length - 1];
}

// The one line under the form. Three states, none of them a failure:
// not listed yet and here is why, ready but switched off, or listed.
//
// Returns `text` and `html`. They say the same thing; `html` is the one to
// render, because in it the missing requirements that can be acted on are
// buttons. A caller that only has a text node still gets a correct sentence.
export function connectHint(p) {
  const need = missingForConnect(p);
  if (need.length) {
    return {
      kind: "info",
      text: "You'll appear in Connect once you add " + joinList(need) + ".",
      html: "You'll appear in Connect once you add " +
        joinHtmlList(need.map(needHtml)) + ".",
    };
  }
  if (!(p && p.is_discoverable)) {
    const ready = "Your profile is ready. Switch on “Show me in Connect” above and other members can find you.";
    return { kind: "info", text: ready, html: escapeHtml(ready) };
  }
  const listed = "You're listed in Connect — other members can find you, follow you and say hello.";
  return { kind: "ok", text: listed, html: escapeHtml(listed) };
}

// Wires the buttons connectHint puts in the sentence. Delegated, so it
// survives the line being re-rendered on every keystroke.
export function onConnectHintJump(container, handler) {
  container.addEventListener("click", function (ev) {
    const btn = ev.target.closest("[data-jump]");
    if (!btn || !container.contains(btn)) return;
    ev.preventDefault();
    handler(btn.getAttribute("data-jump"));
  });
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
      // Two kinds of array arrive here. The tag arrays (skills, interests,
      // goals, open_to) are strings and get trimmed. work_history is an array
      // of objects, and String()-ing one of those writes "[object Object]"
      // into a member's career, so objects pass through untouched —
      // parse-profile-document has already normalised, capped and ordered
      // them, and nothing on this side knows their shape.
      const cleaned = value
        .map((v) => (v && typeof v === "object" ? v : String(v).trim()))
        .filter(Boolean);
      if (!cleaned.length) return;
      out[key] = cleaned;
      return;
    }
    if (typeof value === "string" && !value.trim()) return;
    out[key] = value;
  });
  return out;
}

// The `profiles` save is a PostgREST call rather than an Edge Function, so it
// fails differently from readInvokeError below: what comes back is a
// PostgrestError carrying a SQLSTATE in `code`, and there is no Response to
// read a body off. The idea is the same though — `error.message` is the
// database talking to whoever wrote the query, and pasting it at a member
// tells them nothing they can act on.
//
// Two failures matter here and both mean "an operator has something to do":
//
//   the column isn't there    — the migration that adds it hasn't been run.
//                               isMissingSchema already knows every shape this
//                               takes; note PGRST204 is the common one,
//                               because PostgREST rejects an unknown column
//                               against its schema cache before Postgres ever
//                               sees the statement.
//   the column isn't granted  — 42501. `profiles` has a column-level UPDATE
//                               allowlist (0002 → 0005 → 0017 → 0019 → 0022 →
//                               0023) and a new column whose grant was
//                               forgotten is the most repeated bug in this
//                               project. "permission denied for column
//                               work_history of relation profiles" reads like
//                               the member did something wrong. They did not.
export function saveErrorMessage(error) {
  if (!error) return "";
  const code = String(error.code || "");
  const raw = String(error.message || "");

  // Postgres writes `column profiles.work_history`, PostgREST writes
  // `Could not find the 'work_history' column of 'profiles'`. Naming the
  // column is what makes the message actionable, so both spellings are worth
  // reading, and the table qualifier is dropped.
  //
  // The quoted form is tried first on purpose: the looser pattern would read
  // PostgREST's "column of 'profiles'" as a column called "of".
  const hit = raw.match(/["']([a-z_.]+)["'] column/i) ||
              raw.match(/column ["']?([a-z_.]+)["']?/i);
  const column = hit ? hit[1].split(".").pop() : "";
  const named = column ? " (" + column + ")" : "";

  if (isMissingSchema(error)) {
    return "This site is asking for a profile field" + named + " the database " +
      "doesn't have yet — a migration hasn't been applied. Nothing was saved, " +
      "and nothing is broken on your side.";
  }
  if (code === "42501" || /permission denied/i.test(raw)) {
    return "The database refused one of these fields" + named + ". It's a " +
      "missing column grant rather than anything you did — nothing was saved.";
  }
  // 23514 check_violation — a value outside what the column will accept.
  //
  // Since 0037 three of these are field limits, and Postgres names the
  // constraint in the message: `violates check constraint
  // "profiles_bio_length"`. A save path that validated first should never get
  // here (see limitProblems), but the dashboard's form and anything else
  // holding the member's token can, and "check the numbers and dropdowns" is
  // no help at all when the actual problem is a bio written before the cap
  // existed. Naming the field and the number is.
  const limitHit = raw.match(/profiles_(bio|skills|interests)_(?:length|count)/);
  if (limitHit) {
    const which = limitHit[1];
    if (which === "bio") {
      return "Your short bio is longer than the " + FIELD_LIMITS.bio + " characters a profile " +
        "will hold. Nothing was saved and nothing was shortened — trim it yourself and save again.";
    }
    return "You have more " + which + " than the " + FIELD_LIMITS[which] + " a profile will hold. " +
      "Nothing was saved and nothing was removed — take some off and save again.";
  }
  if (code === "23514") {
    return "One of these values isn't one the profile accepts" + named + ". " +
      "Check the numbers and dropdowns, then try again.";
  }
  return "Couldn't save your profile just now. Try again in a moment.";
}

// ---- The tag picker ---------------------------------------------------

// Discrete chips over a comma-separated box. The old input stored whatever was
// typed, so "Power Apps", "power apps" and "PowerApps" were three tags and the
// recommender scored them as three unrelated things. This keeps the same
// text[] storage and steers people onto one spelling by suggesting the
// vocabulary first — while still letting them type something new, because a
// club that cannot name a thing it has not seen before stops learning.
// `options.max` caps how many tags may be ADDED. It is optional and defaults
// to no limit, which is what `#f-goals-input` still has — the brief set caps
// for skills and interests and said nothing about "what you're open to", and
// inventing one here would be inventing a rule nobody asked for.
//
// ⚠ `max` never applies to `set()`. A profile that already holds 60 skills
// shows all 60 to its owner, in full, with a line asking them to reduce. The
// alternative — loading the first 50 and dropping ten of their words on the
// floor — would be silent, irreversible, and would happen to the people who
// filled the form in most carefully.
export function createTagPicker(options) {
  const root = options.root;
  const inputId = options.inputId;
  const label = options.label || "tags";
  const max = Number(options.max) > 0 ? Number(options.max) : 0;
  // What one of these is called in a sentence: "the 50-skill limit".
  const noun = options.limitNoun || String(label).replace(/s$/, "");
  const onLimit = typeof options.onLimit === "function" ? options.onLimit : function () {};
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
    '<ul class="tagpick-menu" role="listbox" hidden></ul>' +
    // The count line. Styled inline rather than through a class, because this
    // control is mounted by two pages whose field styling lives in their own
    // <style> blocks, and a limit that only looks like a limit on one of them
    // is the kind of half-shipped rule this whole section exists to avoid.
    // The colours are theme variables, so it follows light mode with the page.
    '<p class="tagpick-note" role="status" aria-live="polite" hidden ' +
    'style="font-size:12px;line-height:1.5;margin:6px 0 0;color:var(--text-muted)"></p>';

  const chipsEl = root.querySelector(".tagpick-chips");
  const inputEl = root.querySelector(".tagpick-input");
  const menuEl = root.querySelector(".tagpick-menu");
  const noteEl = root.querySelector(".tagpick-note");

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

  // The count line under the box. Four states, and only one of them is a
  // complaint:
  //
  //   over the limit   this profile was written before the cap existed. Say how
  //                    many to remove. Never removes any.
  //   at the limit     the next one is refused, so say so before they type it.
  //   getting close    a plain count, from five out.
  //   nowhere near     nothing at all. A counter on an empty box is noise.
  function renderNote(extra) {
    if (!noteEl) return;
    const state = tagCountState(tags, max);
    let text = "";
    let colour = "var(--text-muted)";

    if (state.over > 0) {
      text = "You have " + state.count + " " + label + " — " + state.over + " more than the " +
        state.max + " allowed. Remove " + state.over + " to save.";
      colour = "#fbbf24";
    } else if (state.atLimit) {
      text = "That's all " + state.max + " " + label + ". Remove one to add another.";
      colour = "#fbbf24";
    } else if (state.max && state.left <= 5) {
      text = state.count + " of " + state.max + " " + label + ".";
    }

    if (extra) {
      text = extra + (text ? " " + text : "");
      colour = "#fbbf24";
    }

    noteEl.textContent = text;
    noteEl.hidden = !text;
    noteEl.style.color = colour;
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
    // The limit is checked HERE rather than on the keydown handlers, because
    // there are four ways into this function — Enter, comma, clicking a
    // suggestion, and flush() on save — and a rule enforced at three of them
    // is not a rule. The typed text is deliberately LEFT IN THE BOX: it is
    // still what the member meant to add, and clearing it would make the
    // refusal look like the tag was taken.
    if (!canAddTag(tags, max)) {
      closeMenu();
      renderNote("You've reached the " + max + "-" + noun + " limit.");
      onLimit(tags.slice(), max);
      return;
    }
    tags.push(text);
    inputEl.value = "";
    renderChips();
    closeMenu();
    renderNote("");
    notify();
  }

  function removeAt(i) {
    tags.splice(i, 1);
    renderChips();
    renderNote("");
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
    // At or over the limit there is nothing to offer — every option in the
    // menu would be refused on click. Showing the reason instead of a list of
    // dead choices is the whole difference between "full" and "broken".
    if (!canAddTag(tags, max)) {
      closeMenu();
      renderNote("");
      return;
    }
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
  renderNote("");

  return {
    get: function () { return tags.slice(); },
    // ⚠ Loads everything it is given, whatever `max` says. See the note above
    // the function: an over-limit profile is shown to its owner in full.
    set: function (next) {
      tags = (next || []).map((t) => String(t).trim()).filter(Boolean);
      renderChips();
      renderNote("");
    },
    setSuggestions: function (next) { suggestions = next || []; },
    // A tag left half-typed in the box is a tag the member meant to add.
    // Saving without it is the single most annoying thing a picker can do.
    // At the limit this refuses and says why, exactly as Enter would.
    flush: function () { if (inputEl.value.trim()) addTag(inputEl.value); },
    // What the save path asks before it builds a payload.
    count: function () { return tags.length; },
    max: max,
    isOver: function () { return tagCountState(tags, max).over > 0; },
    // So a host can scroll to and focus the picker it is complaining about.
    focus: function () { inputEl.focus(); },
    label: label,
  };
}

// ---- The avatar control -----------------------------------------------

// Until this existed, `avatar_url` was written in exactly one place —
// syncAvatar, on a first OAuth sign-in — so a member who joined by email had
// no way to set a photo at all, and Connect's gate (0018: a listed profile
// needs a non-empty avatar_url) locked them out permanently with a hint that
// named the requirement and offered no route to it.
//
// Three ways in, one result. Upload, borrow the photo a linked provider
// already has, or take a themed tile drawn from your initials. The first two
// go through generate-avatar; the third does not, and the reason is worth
// stating plainly rather than hiding: the deployed function only produces a
// fallback tile on the path where a member is out of tries, so there is no
// request that asks it for one. Rather than change a function whose whole
// value is that it is careful, the tile is drawn here and uploaded to the
// member's own folder — which is a thing 0016's storage policy already allows
// them to do, and which costs nothing.
//
// What that path deliberately does NOT do is claim to be a generated avatar.
// `avatar_is_generated`, `avatar_source` and `source_purged_at` are ungranted
// to `authenticated` on purpose (0017) — they are the platform's evidence
// that no real photograph is stored, and a member who could set them could
// claim the evidence while keeping a photo. So the tile writes `avatar_url`
// and nothing else. The row understates itself, which is the safe direction,
// and it self-corrects: `avatars_due_refresh` (0018) selects on a stale
// `avatar_cycle`, which the client cannot write either, so the next monthly
// run of refresh-avatars picks the member up and draws them properly.

export const AVATAR_MAX_ATTEMPTS = 3;   // mirrors MAX_ATTEMPTS in _shared/avatar-art.ts
const AVATAR_BUCKET = "avatars";
const AVATAR_MAX_EDGE = 1024;
const AVATAR_MAX_BYTES = 1000000;       // ~1 MB; the function's own ceiling is 8 MB decoded

// 'YYYY-MM', UTC. A fourth copy of one rule, and the only reason it is here is
// that the page has to say "2 more tries this month" before it has called
// anything. Must agree with to_char(now(),'YYYY-MM') in 0018 and with
// currentCycle() in _shared/avatar-art.ts — UTC, not the local clock, or this
// and the database disagree for a few hours around each month boundary.
export function avatarCycle(now) {
  return (now || new Date()).toISOString().slice(0, 7);
}

// An `avatar_attempts` of 3 stamped with last month's cycle is a member with
// three tries in hand, not a member out of them. Mirrors
// public.avatar_attempts_this_cycle (0018).
export function attemptsUsedThisCycle(p) {
  if (!p) return 0;
  if (p.avatar_cycle !== avatarCycle()) return 0;
  const n = Number(p.avatar_attempts || 0);
  return isNaN(n) || n < 0 ? 0 : Math.min(n, AVATAR_MAX_ATTEMPTS);
}

// ---- Watching a drawing that is happening somewhere else ---------------

// Since 0026 the drawing does not happen on the member's connection.
// generate-avatar answers 202 the moment the attempt is RESERVED and draws in
// the background, so that response carries no `avatarUrl` and never will. The
// answer arrives on `profiles.avatar_status` instead — the member's own row,
// which the "read own" policy already lets them select, so this needs no new
// endpoint and no grant that was not already there.
//
// The status vocabulary is 0026's CHECK constraint. This is the second place
// it is written down, so it is worth restating what each value means here:
//
//   'idle'        nothing has been asked for. Also every row predating 0026.
//   'queued'      accepted, not started. NOTHING WRITES THIS TODAY —
//                 generate-avatar starts the work in the same instance that
//                 took the request, so an accepted attempt is already
//                 generating. It is in the constraint against a real queue
//                 arriving later, and a page that only knows the values in use
//                 today is a page that breaks when that lands. Handled now.
//   'generating'  the image call is in flight.
//   'ready'       `avatar_url` is the new picture and `avatar_gallery[0]` is
//                 its entry. Both are written in the same UPDATE as the status,
//                 so a poll can never read 'ready' beside the old URL.
//   'failed'      `avatar_error` is a sentence written for the member, and THE
//                 ATTEMPT WAS REFUNDED. The allowance therefore has to be
//                 re-read off the row rather than assumed from what the 202
//                 said, or the member is told they spent a try they got back.
//
// There is no stale-'ready' race to guard against, and the reason is in the
// function rather than here: the reservation UPDATE sets 'generating' in the
// same statement that spends the attempt, and that statement completes before
// the 202 is written. By the time a caller starts polling, the row has already
// moved off whatever it said before.
export const AVATAR_POLL_COLUMNS =
  "avatar_status, avatar_error, avatar_url, avatar_gallery, avatar_attempts, avatar_cycle";

// 'ready' and 'failed' are the only two that mean stop. Everything else —
// including a status this file has never heard of — means "not finished".
// Treating an unknown value as a failure would turn a future migration into a
// broken page on every client nobody thought to redeploy.
export function avatarPollVerdict(row) {
  const status = String((row && row.avatar_status) || "");
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  return "wait";
}

// Is there a drawing in flight for this row right now? Used to pick the watch
// back up when a page loads mid-generation — a member who started one, closed
// the tab and came back should not have to guess.
export function avatarIsDrawing(row) {
  const status = String((row && row.avatar_status) || "");
  return status === "generating" || status === "queued";
}

// ⚠ A HIDDEN BROWSER TAB THROTTLES setTimeout HARD. Chrome clamps a background
// page's timers to roughly once a minute, and after five minutes of that it
// throttles further still. That has bitten this project before, so nothing
// below counts polls or assumes a timer fired when it was asked to:
//
//   * the gap grows, so a slow drawing is not hammered;
//   * the cap is elapsed time, never a number of iterations;
//   * the elapsed time that counts is time the page was VISIBLE. A member who
//     switched tabs is not waiting on anything, so there is nothing to give up
//     on — and giving up on their behalf would mean telling them "still
//     drawing" when they come back to a picture that landed two minutes ago;
//   * a hard wall-clock ceiling still stops a forgotten tab polling for ever;
//   * becoming visible wakes the sleep immediately, so returning to the page
//     shows the result at once rather than after the rest of a clamped minute.
//
// And the thing that makes all of this safe to get wrong: the generation
// completes server-side whether or not anything is still watching. Giving up
// here costs the member a page reload, never the picture.
export const AVATAR_POLL_FIRST_MS = 1500;
export const AVATAR_POLL_MAX_GAP_MS = 8000;
export const AVATAR_POLL_CAP_MS = 150000;      // 2½ minutes of the member actually looking
export const AVATAR_POLL_CEILING_MS = 900000;  // 15 minutes of wall clock, watched or not

// Pure and exported, because the shape of the backoff is the part worth
// checking without a browser to run it in.
export function nextAvatarPollDelay(previous) {
  const ms = Number(previous) > 0 ? Number(previous) : AVATAR_POLL_FIRST_MS;
  return Math.min(AVATAR_POLL_MAX_GAP_MS, Math.round(ms * 1.4));
}

// A sleep that gives up early the moment the page is looked at again.
function avatarSleep(ms) {
  return new Promise(function (resolve) {
    let timer = 0;
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShow);
      resolve();
    }
    function onShow() { if (!document.hidden) finish(); }
    timer = window.setTimeout(finish, ms);
    document.addEventListener("visibilitychange", onShow);
  });
}

// Accumulates only the time the page spent visible. See the note above for why
// that, and not wall clock, is what the cap is measured against.
function avatarVisibleClock() {
  let banked = 0;
  let since = document.hidden ? 0 : Date.now();
  function onChange() {
    if (document.hidden) {
      if (since) { banked += Date.now() - since; since = 0; }
    } else if (!since) {
      since = Date.now();
    }
  }
  document.addEventListener("visibilitychange", onChange);
  return {
    elapsed: function () { return banked + (since ? Date.now() - since : 0); },
    stop: function () { document.removeEventListener("visibilitychange", onChange); },
  };
}

// Polls the caller's own profile row until the drawing settles.
//
// Resolves — never rejects — with one of:
//   { outcome: 'ready',   row }  avatar_url is the new picture
//   { outcome: 'failed',  row }  avatar_error says why, and the try was refunded
//   { outcome: 'timeout', row }  we stopped watching. The drawing has NOT
//                                stopped; say so rather than reporting failure.
//   { outcome: 'blocked', error} the columns aren't there — 0026 isn't applied
//   { outcome: 'stopped', row }  the caller asked to stop
//
// A transient read error is not an outcome. It is swallowed and retried,
// because one failed fetch on a phone changing cell is not a failed avatar.
export async function awaitAvatarSettled(userId, options) {
  const opts = options || {};
  const capMs = typeof opts.capMs === "number" ? opts.capMs : AVATAR_POLL_CAP_MS;
  const ceilingMs = typeof opts.ceilingMs === "number" ? opts.ceilingMs : AVATAR_POLL_CEILING_MS;
  const stopped = typeof opts.stopped === "function" ? opts.stopped : function () { return false; };
  const startedAt = Date.now();
  const watched = avatarVisibleClock();
  let delay = AVATAR_POLL_FIRST_MS;
  let row = null;

  try {
    for (;;) {
      await avatarSleep(delay);
      if (stopped()) return { outcome: "stopped", row: row };

      const res = await supabase
        .from("profiles")
        .select(AVATAR_POLL_COLUMNS)
        .eq("user_id", userId)
        .maybeSingle();

      if (res.error) {
        // The one read error worth stopping for: the columns do not exist, so
        // no amount of retrying will produce an answer.
        if (isMissingSchema(res.error)) {
          return { outcome: "blocked", row: row, error: res.error };
        }
      } else if (res.data) {
        row = res.data;
        const verdict = avatarPollVerdict(row);
        if (verdict !== "wait") return { outcome: verdict, row: row };
        if (typeof opts.onTick === "function") opts.onTick(row);
      }

      if (watched.elapsed() >= capMs || Date.now() - startedAt >= ceilingMs) {
        return { outcome: "timeout", row: row };
      }
      delay = nextAvatarPollDelay(delay);
    }
  } finally {
    watched.stop();
  }
}

// ---- The fallback tile, drawn client-side ------------------------------
// A deliberate port of fallbackSvg() in _shared/avatar-art.ts. It has to be a
// port rather than an approximation: this tile and the one refresh-avatars
// draws sit next to each other in the same directory, and a member whose tile
// changes shape the month the server takes over would reasonably think
// something broke. Same palettes, same FNV-1a seed, same rotation.
const AVATAR_PALETTES = [
  ["#a78bfa", "#22d3ee"],
  ["#8b5cf6", "#38bdf8"],
  ["#c4b5fd", "#06b6d4"],
  ["#7c3aed", "#22d3ee"],
  ["#a78bfa", "#0ea5e9"],
  ["#818cf8", "#2dd4bf"],
];

function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function initialsOf(fullName) {
  const words = String(fullName == null ? "" : fullName).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "SC";
  const first = Array.from(words[0])[0] || "";
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] || "" : "";
  return (first + last).toUpperCase();
}

function escapeXml(s) {
  return String(s == null ? "" : s).replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] || c));
}

export function fallbackAvatarSvg(userId, fullName, cycle) {
  const seed = userId + ":" + cycle;
  const pair = AVATAR_PALETTES[fnv1a(seed) % AVATAR_PALETTES.length];
  const initials = initialsOf(fullName);
  const angle = fnv1a(seed + "angle") % 360;

  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="' +
    escapeXml(initials) + '">\n' +
    '  <defs>\n' +
    '    <linearGradient id="g" gradientTransform="rotate(' + angle + ' 0.5 0.5)">\n' +
    '      <stop offset="0%" stop-color="' + pair[0] + '"/>\n' +
    '      <stop offset="100%" stop-color="' + pair[1] + '"/>\n' +
    '    </linearGradient>\n' +
    '  </defs>\n' +
    '  <rect width="512" height="512" fill="url(#g)"/>\n' +
    '  <circle cx="256" cy="256" r="150" fill="#ffffff" fill-opacity="0.14"/>\n' +
    '  <text x="256" y="256" fill="#ffffff" font-family="Inter, Segoe UI, system-ui, sans-serif"\n' +
    '        font-size="180" font-weight="600" text-anchor="middle" dominant-baseline="central"\n' +
    '        letter-spacing="4">' + escapeXml(initials) + "</text>\n" +
    "</svg>";
}

// ---- Getting a photo down to a sendable size --------------------------
// generate-avatar takes base64 in a JSON body. A 12 MP phone photo is ~4 MB
// of JPEG, which is ~5.3 MB of base64 — over the function's 8 MB decoded
// ceiling once a couple of them are in flight, and slow enough on a phone
// connection that the member assumes it hung. Everything is resized to a
// 1024px long edge first, which is also the size the model works at.

function canvasBlob(canvas, quality) {
  return new Promise(function (resolve) {
    if (canvas.toBlob) canvas.toBlob(resolve, "image/jpeg", quality);
    else resolve(null);
  });
}

function blobBase64(blob) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result).split(",")[1] || ""); };
    reader.onerror = function () { reject(new Error("Couldn't read that image.")); };
    reader.readAsDataURL(blob);
  });
}

async function decodeImage(blob) {
  // `imageOrientation: "from-image"` is what stops a portrait taken on a
  // phone arriving sideways — the EXIF rotation is not baked into the pixels.
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(blob, { imageOrientation: "from-image" }); } catch (e) {}
    try { return await createImageBitmap(blob); } catch (e) {}
  }
  return await new Promise(function (resolve, reject) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("That file didn't look like an image.")); };
    img.src = url;
  });
}

export async function prepareAvatarImage(blob) {
  const img = await decodeImage(blob);
  const w = img.width || img.naturalWidth;
  const h = img.height || img.naturalHeight;
  if (!w || !h) throw new Error("That file didn't look like an image.");

  const scale = Math.min(1, AVATAR_MAX_EDGE / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't resize images — try a different one.");
  // A PNG with transparency flattens to black in JPEG otherwise, which the
  // model then reads as a dark background rather than as nothing.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(img, 0, 0, cw, ch);
  if (typeof img.close === "function") img.close();

  let quality = 0.9;
  let out = await canvasBlob(canvas, quality);
  while (out && out.size > AVATAR_MAX_BYTES && quality > 0.4) {
    quality = Math.round((quality - 0.15) * 100) / 100;
    out = await canvasBlob(canvas, quality);
  }
  if (!out) throw new Error("This browser couldn't process that photo — try a different one.");
  if (out.size > AVATAR_MAX_BYTES) {
    throw new Error("That photo is too detailed to send. Try a smaller or simpler one.");
  }
  return { base64: await blobBase64(out), mediaType: "image/jpeg" };
}

// ---- The control ------------------------------------------------------

// options: {
//   root, session, profile, providers,
//   onChange(avatarUrl)      the avatar actually changed
//   onStatus(row, outcome)   a poll of the member's own row settled or ticked.
//                            The dashboard uses it to repaint the profile card
//                            behind the form, so the finished drawing appears
//                            without the member reloading anything.
//   deferOnSave              stage a chosen photo instead of drawing it now,
//                            and let the page start the drawing on save. See
//                            the note on stagePhoto below.
// }
export function createAvatarControl(options) {
  const root = options.root;
  const session = options.session;
  const providers = options.providers || [];
  const onChange = typeof options.onChange === "function" ? options.onChange : function () {};
  const onStatus = typeof options.onStatus === "function" ? options.onStatus : function () {};
  const deferOnSave = Boolean(options.deferOnSave);

  const userId = session && session.user ? session.user.id : "";
  let profile = options.profile || {};
  let avatarUrl = profile.avatar_url || "";
  let used = attemptsUsedThisCycle(profile);
  let busy = false;
  // Kept so "Try another" does not make the member find the file again. It is
  // the resized copy, never written anywhere, and dropped when the control is
  // done with it.
  let lastPhoto = null;
  // Where that photo came from, which decides what "keep it" means. An upload
  // has to be stored; a provider picture is a link to somebody else's server
  // and must NOT be copied. Held separately from lastPhoto because by the time
  // a member decides to keep it, the resized base64 is no longer enough — the
  // provider's own URL is the thing worth storing, and it is not in there.
  let lastOrigin = null;
  // The photo chosen but not yet sent, when `deferOnSave` is on. Same resized
  // copy as lastPhoto; held separately because "there is something waiting for
  // the Save button" is a different question from "there is something to redraw
  // from".
  let stagedPhoto = null;
  // One watcher at a time. Two would poll the same row twice and race each
  // other into the state line.
  let watching = false;
  // Which destination the file picker is currently serving: draw it, or keep
  // it as it is. One <input type="file"> for both, because two would mean two
  // change handlers doing almost the same work.
  let plainMode = false;

  root.classList.add("av");
  root.innerHTML =
    '<div class="av-head">' +
      '<span class="av-shot" id="av-shot"></span>' +
      '<div class="av-head-copy">' +
        '<p class="av-title">Your photo</p>' +
        '<p class="av-why">Connect only lists members who have one. We turn it into an ' +
          'illustrated portrait in the club style — that drawing is what other members see.</p>' +
      "</div>" +
    "</div>" +
    '<div class="av-ways" id="av-ways"></div>' +
    // The plain-photo route, always visible rather than hidden behind a
    // rejected drawing. Three reasons it is its own row: a member who is out of
    // tries this month has no working drawing button left and must still be
    // able to set a picture; a member who simply does not want to be an
    // illustration should not have to make one first to escape it; and keeping
    // it visually quiet keeps the drawing the default without making it a
    // trap.
    '<div class="av-plain" id="av-plain">' +
      '<p class="av-plain-title">Prefer a real photo?</p>' +
      '<div class="av-plain-ways" id="av-plain-ways"></div>' +
    "</div>" +
    '<p class="av-privacy" id="av-privacy">Photos sent for a drawing are never stored — only the ' +
      "illustration is kept. A photo you choose to keep as your picture is stored, because it " +
      "is your picture.</p>" +
    '<div class="av-staged" id="av-staged" hidden>' +
      '<img class="av-staged-img" id="av-staged-img" alt="" width="72" height="72">' +
      '<div class="av-staged-side">' +
        '<p class="av-staged-note" id="av-staged-note"></p>' +
        '<div class="av-staged-actions">' +
          '<button type="button" class="av-btn" data-act="draw">Draw it now instead</button>' +
          '<button type="button" class="av-btn av-btn-quiet" data-act="unstage">Cancel</button>' +
        "</div>" +
      "</div>" +
    "</div>" +
    '<div class="av-state" id="av-state" role="status" aria-live="polite" hidden></div>' +
    '<div class="av-result" id="av-result" hidden>' +
      '<img class="av-result-img" id="av-result-img" alt="Your new avatar" width="120" height="120">' +
      '<div class="av-result-side">' +
        '<p class="av-result-note" id="av-result-note"></p>' +
        '<div class="av-result-actions">' +
          '<button type="button" class="av-btn av-btn-go" data-act="keep">Use this</button>' +
          '<button type="button" class="av-btn" data-act="retry">Try another</button>' +
          // The way out for somebody who simply does not want to be a drawing.
          // Hidden until there is a photo to fall back TO — see showResult.
          '<button type="button" class="av-btn" data-act="photo" hidden>Use my photo instead</button>' +
          '<button type="button" class="av-btn" data-act="download">Download</button>' +
        "</div>" +
      "</div>" +
    "</div>" +
    // The gallery. Hidden, not empty-stated: a member with nothing in it has
    // never had a drawing made, and a row of empty boxes captioned "your past
    // drawings" tells them only that something is missing.
    '<div class="av-gallery" id="av-gallery" hidden>' +
      '<p class="av-gallery-title" id="av-gallery-title">Your past drawings</p>' +
      '<p class="av-gallery-why">Each try this month is framed and coloured differently, so ' +
        "these are real alternatives rather than near-copies. Pick any one to put it back.</p>" +
      '<div class="av-gallery-strip" id="av-gallery-strip" role="group" aria-labelledby="av-gallery-title"></div>' +
    "</div>" +
    '<input type="file" class="av-file" id="av-file" accept="image/png,image/jpeg,image/webp" hidden>';

  const shotEl = root.querySelector("#av-shot");
  const waysEl = root.querySelector("#av-ways");
  const plainWaysEl = root.querySelector("#av-plain-ways");
  const stateEl = root.querySelector("#av-state");
  const stagedEl = root.querySelector("#av-staged");
  const stagedImg = root.querySelector("#av-staged-img");
  const stagedNote = root.querySelector("#av-staged-note");
  const resultEl = root.querySelector("#av-result");
  const resultImg = root.querySelector("#av-result-img");
  const resultNote = root.querySelector("#av-result-note");
  const galleryEl = root.querySelector("#av-gallery");
  const stripEl = root.querySelector("#av-gallery-strip");
  const fileEl = root.querySelector("#av-file");

  function left() { return Math.max(0, AVATAR_MAX_ATTEMPTS - used); }

  function tries(n) { return n === 1 ? "1 more try" : n + " more tries"; }

  function setState(kind, message) {
    stateEl.hidden = !message;
    stateEl.className = "av-state" + (kind ? " " + kind : "");
    stateEl.textContent = message || "";
  }

  function renderShot() {
    if (avatarUrl) {
      shotEl.innerHTML = '<img src="' + escapeAttr(avatarUrl) + '" alt="">';
    } else {
      shotEl.textContent = initialsOf(profile.full_name || (session && session.user && session.user.email) || "");
    }
  }

  // The buttons are rebuilt rather than toggled, because which of them exist
  // depends on the session (a member with no linked provider must not see a
  // provider button at all) and on the allowance.
  function renderWays() {
    const spent = left() === 0;
    const rows = [];

    rows.push(
      '<button type="button" class="av-btn av-btn-go" data-act="upload"' +
      (spent ? " disabled" : "") + ">Upload a photo</button>"
    );

    providers.forEach(function (p) {
      rows.push(
        '<button type="button" class="av-btn" data-act="provider" data-p="' +
        escapeAttr(p.provider) + '"' + (spent ? " disabled" : "") + ">Use my " +
        escapeHtml(p.label) + " photo</button>"
      );
    });

    rows.push(
      '<button type="button" class="av-btn av-btn-quiet" data-act="tile">' +
      (avatarUrl ? "Use a tile with my initials" : "Skip — use a tile with my initials") +
      "</button>"
    );

    waysEl.innerHTML = rows.join("");

    // The plain-photo row. Never disabled by the allowance — none of these
    // spends a try, because none of them draws anything. A provider photo here
    // does not even get fetched: only the link is stored, so the cross-origin
    // read that defeats fromProvider() on some accounts cannot fail here.
    const plain = [
      '<button type="button" class="av-btn av-btn-quiet" data-act="plain-upload">' +
      "Upload a photo, keep it as it is</button>",
    ];
    providers.forEach(function (p) {
      plain.push(
        '<button type="button" class="av-btn av-btn-quiet" data-act="plain-provider" data-p="' +
        escapeAttr(p.provider) + '">Use my ' + escapeHtml(p.label) + " photo as it is</button>"
      );
    });
    // Only when there is something to remove. On a profile with no picture this
    // is a button that does nothing, captioned as though it might.
    if (avatarUrl) {
      plain.push(
        '<button type="button" class="av-btn av-btn-quiet" data-act="clear">Remove my picture</button>'
      );
    }
    plainWaysEl.innerHTML = plain.join("");

    // The allowance, said plainly, whichever way it falls.
    if (spent) {
      setState(
        "info",
        "You've used all " + AVATAR_MAX_ATTEMPTS + " drawings this month — they reset on the 1st. " +
        "A tile with your initials still works, and costs nothing."
      );
    } else if (used > 0) {
      setState("info", "You have " + tries(left()) + " this month.");
    } else {
      setState("", "");
    }
  }

  // ---- The gallery ------------------------------------------------------

  // `avatar_gallery` is a newest-first jsonb array of
  // { url, prompt, theme, variant, cycle, created_at }, capped at twelve by
  // generate-avatar. Since the three tries in a cycle differ in framing,
  // palette and background, the previous two are genuine alternatives rather
  // than near-misses — which is the whole reason 0026 stopped throwing them
  // away. This is where a member gets to change their mind.
  //
  // Read defensively. It is jsonb, so anything at all could be in the column
  // as far as this side knows, and an entry without a usable `url` is a
  // thumbnail that renders as a broken image and a button that raises when
  // pressed. Those are dropped rather than shown.
  function galleryEntries() {
    const held = profile.avatar_gallery;
    if (!Array.isArray(held)) return [];
    return held.filter(function (entry) {
      return entry && typeof entry === "object" && String(entry.url || "").trim();
    });
  }

  function galleryLabel(entry, isCurrent) {
    const when = String(entry.cycle || "").trim();
    const theme = String(entry.theme || "").trim();
    const parts = [theme || "Drawing"];
    if (when) parts.push(when);
    return (isCurrent ? "Current avatar — " : "Use this drawing — ") + parts.join(", ");
  }

  function renderGallery() {
    const entries = galleryEntries();
    // An empty gallery renders nothing at all. No strip, no placeholder row.
    galleryEl.hidden = entries.length === 0;
    if (!entries.length) {
      stripEl.innerHTML = "";
      return;
    }

    // Buttons with aria-pressed rather than a listbox: each thumbnail does
    // something when pressed, Tab already moves between them, and a real
    // listbox would owe the member arrow-key roving this control has nowhere
    // to put. `aria-pressed` on the current one is what tells a screen reader
    // which avatar is live.
    stripEl.innerHTML = entries
      .map(function (entry) {
        const url = String(entry.url);
        const isCurrent = url === avatarUrl;
        return '<button type="button" class="av-thumb' + (isCurrent ? " is-on" : "") + '" ' +
          'data-url="' + escapeAttr(url) + '" aria-pressed="' + (isCurrent ? "true" : "false") + '" ' +
          'title="' + escapeAttr(galleryLabel(entry, isCurrent)) + '">' +
          '<img src="' + escapeAttr(url) + '" alt="" loading="lazy" width="72" height="72">' +
          '<span class="av-thumb-label">' + escapeHtml(galleryLabel(entry, isCurrent)) + "</span>" +
          "</button>";
      })
      .join("");
  }

  // The RPC is the only way to do this. A member holds UPDATE on `avatar_url`
  // (0005) and could set it to anything at all; what they cannot do is prove
  // the URL is one the club drew, because `avatar_gallery` is ungranted on
  // purpose (0026). select_avatar_from_gallery() checks the URL against the
  // caller's OWN gallery under security definer and raises if it is not there
  // — deliberately with the same message whether the gallery is empty, the URL
  // was never ours, or it belongs to somebody else.
  function galleryErrorMessage(error) {
    if (isMissingSchema(error)) {
      return "Choosing an older drawing isn't switched on yet — the database update it needs " +
        "hasn't been applied. Nothing was changed.";
    }
    const raw = String((error && error.message) || "");
    if (/not in your avatar gallery/i.test(raw)) {
      return "That drawing isn't one of yours any more — it may have dropped off the end of " +
        "your gallery. Reload the page to see the current list.";
    }
    if (/not signed in/i.test(raw)) {
      return "Your session has expired. Sign in again and try once more.";
    }
    return "Couldn't switch to that drawing just now. Try again in a moment.";
  }

  async function selectFromGallery(url) {
    if (busy || !url) return;
    if (url === avatarUrl) {
      setState("info", "That's the one you're using already.");
      return;
    }
    resultEl.hidden = true;
    setBusy(true, "Putting that drawing back…");

    const res = await supabase.rpc("select_avatar_from_gallery", { p_url: url });

    setBusy(false);
    if (res.error) {
      setState("err", galleryErrorMessage(res.error));
      return;
    }

    applyAvatar(url);
    setState("ok", "Done — that's your avatar again. No try was spent: it was already drawn.");
  }

  // One place where a new avatar_url takes effect, so the shot, the gallery's
  // selected state and whoever owns the page all move together.
  function applyAvatar(url) {
    avatarUrl = url;
    profile = Object.assign({}, profile, { avatar_url: url });
    render();
    onChange(url);
  }

  function render() {
    renderShot();
    renderGallery();
    renderWays();
  }

  // Anything that talks to the server takes the whole control down for the
  // duration and the state line says what is happening — a member who can
  // press "Upload a photo" again while the first one is still drawing will,
  // and will then be told two requests are racing.
  function setBusy(on, message) {
    busy = on;
    if (on) {
      Array.prototype.forEach.call(root.querySelectorAll(".av-btn, .av-thumb"), function (b) {
        b.disabled = true;
      });
      root.classList.add("is-busy");
      setState("busy", message || "Working…");
      return;
    }
    root.classList.remove("is-busy");
    // renderWays() rebuilds the entry buttons with the right disabled state;
    // the result panel, the staged panel and the gallery are not in it, so
    // they are released here.
    Array.prototype.forEach.call(
      root.querySelectorAll(".av-result .av-btn, .av-staged .av-btn, .av-thumb"),
      function (b) { b.disabled = false; }
    );
    renderWays();
  }

  // Everything that can come back from supabase.functions.invoke, turned into
  // one sentence a member can act on. Nothing here is allowed to be silent or
  // raw: "the function is not deployed" and "the model refused your photo"
  // look similar from the call site and mean completely different things.
  //
  // supabase-js distinguishes them by error *name*, not by status, and that
  // distinction is the whole triage:
  //
  //   FunctionsHttpError  — it ran and returned non-2xx. context is a
  //                         Response, so context.status is real and
  //                         context.json() holds the function's own wording,
  //                         which is always better than anything written here.
  //   FunctionsFetchError — the request never completed. A function that is
  //                         not deployed lands here rather than on a 404,
  //                         because the CORS preflight gets no headers back
  //                         and the browser reports a network failure. Being
  //                         offline looks the same, hence one message that is
  //                         true of both.
  //
  // error.message is never shown. Every one of them ("Failed to send a request
  // to the Edge Function") is written for whoever wrote the call, not for the
  // member reading it.
  async function readInvokeError(error, data) {
    if (data && data.error) return String(data.error);

    const name = (error && error.name) || "";
    const ctx = error && error.context;

    if (name === "FunctionsHttpError" && ctx) {
      try {
        const body = await ctx.json();
        if (body && body.error) return String(body.error);
      } catch (e) {}
      const status = ctx.status || 0;
      if (status === 401 || status === 403) {
        return "Your session has expired. Sign in again and try once more.";
      }
      if (status === 404) {
        return "Your profile couldn't be found, so there was nothing to attach an avatar to.";
      }
      if (status === 409) {
        return "Another drawing is already being made. Give it a moment and try again.";
      }
      if (status === 413) {
        return "That photo is too large even after resizing. Try a smaller one.";
      }
      if (status === 503) {
        return "Avatar generation isn't configured on the server yet. " +
          "A tile with your initials still works.";
      }
      // Since 0026 a non-2xx from this function is always a PRE-FLIGHT
      // failure — the drawing itself no longer reports on this connection, so
      // "couldn't finish that one" would name the wrong thing entirely. A
      // drawing that fails after the 202 arrives on `avatar_status` and is
      // worded by watch() instead.
      return "The drawing service couldn't take that request. Try again shortly, " +
        "or use a tile with your initials.";
    }

    return "We couldn't reach the drawing service — it may not be switched on yet, " +
      "or you may be offline. A tile with your initials works either way.";
  }

  // Two answers come back from generate-avatar since 0026, and only one of
  // them carries a picture:
  //
  //   202 {ok, queued:true, attemptsUsed, attemptsLeft, cycle}
  //       the attempt is reserved and the drawing has started somewhere else.
  //       THERE IS NO avatarUrl, and there never will be on this response.
  //   200 {ok, queued:false, avatarUrl, ..., isFallback:true}
  //       out of tries this month, so a themed tile was drawn synchronously.
  //       Already finished; nothing to wait for.
  //
  // The old test here was `!data.ok || !data.avatarUrl`, and it is worth
  // recording why that was so bad rather than just deleting it: supabase-js
  // treats 202 as success, so `error` was null and `data.ok` was true, and the
  // only thing missing was the URL — which meant every successful generation
  // told the member "the drawing service couldn't finish that one" while their
  // portrait was being drawn perfectly well and would silently turn up on the
  // next page load. A wrong error is worse than no error: it sends someone to
  // spend another of three monthly tries on a problem that does not exist.
  async function generateFrom(photo) {
    if (busy) return;
    lastPhoto = photo;
    stagedPhoto = null;
    renderStaged();
    resultEl.hidden = true;
    setBusy(true, "Sending your photo…");

    let data = null;
    let error = null;
    try {
      const res = await supabase.functions.invoke("generate-avatar", {
        body: { imageBase64: photo.base64, mediaType: photo.mediaType, source: photo.source },
      });
      data = res.data;
      error = res.error;
    } catch (err) {
      error = err;
    }

    // Only pre-flight failures reach here now — a bad photo, no session, no
    // profile, a clash with a generation already running, or the function not
    // being deployed. A drawing that fails after the 202 does not come back on
    // the wire at all; it arrives on `avatar_status` and is handled in watch().
    if (error || !data || !data.ok) {
      setBusy(false);
      setState("err", await readInvokeError(error, data));
      // A refused request still reports the allowance the function gave back,
      // so the member is not told they have three tries left after spending
      // one — or that they have none after a refunded failure.
      if (data && typeof data.attemptsUsed === "number") {
        used = data.attemptsUsed;
        renderWays();
      }
      return;
    }

    if (typeof data.attemptsUsed === "number") used = data.attemptsUsed;

    // The synchronous path: out of tries, tile already drawn and saved.
    if (!data.queued && data.avatarUrl) {
      setBusy(false);
      applyAvatar(data.avatarUrl);
      showResult(Boolean(data.isFallback));
      return;
    }

    // 202. The attempt is spent, the drawing is running, and the member is
    // free to go — the point of the whole rework.
    //
    // Deliberately NOT awaited. This function resolves the moment the request
    // is accepted, so a page that starts a drawing on save can return the
    // member to wherever they were going immediately; watch() stays behind on
    // its own and reports whatever the row eventually settles on. Awaiting it
    // here would put the wait back exactly where 0026 took it out.
    watch(true);
  }

  // Follows a drawing that is happening on the server. Called after a 202, and
  // again on load if the row says one was already in flight when this page
  // opened — a member who started a drawing, closed the tab and came back
  // should not have to guess whether it is still going.
  //
  // Nothing in here is allowed to report a failure it does not have. The one
  // outcome that is genuinely uncertain is the timeout, and the truth about it
  // is simple: the drawing carries on server-side whether or not this page is
  // still looking, so the honest thing to say is that it is still being drawn.
  async function watch(fresh) {
    if (watching) return;
    watching = true;
    setBusy(
      true,
      fresh
        ? "Drawing your portrait. You can carry on — it'll appear on your profile when it's done, " +
          "even if you leave this page."
        : "A portrait is being drawn for you. It'll appear here when it's done."
    );

    let result;
    try {
      result = await awaitAvatarSettled(userId, {
        onTick: function (row) { onStatus(row, "wait"); },
      });
    } catch (err) {
      // Nothing here runs on the member's behalf any more — the drawing is
      // already someone else's job — so a thrown read is "we stopped
      // watching", not "it failed". Saying otherwise would be a lie about
      // something that is very probably about to succeed.
      console.error("avatar watch", err);
      result = { outcome: "timeout", row: null };
    } finally {
      watching = false;
    }

    setBusy(false);
    onStatus(result.row || null, result.outcome);

    if (result.outcome === "blocked") {
      setState(
        "err",
        "Your portrait is being drawn, but this page can't follow it — the database update it " +
        "needs hasn't been applied. Reload in a minute and it should be there."
      );
      return;
    }

    if (result.outcome === "timeout" || result.outcome === "stopped") {
      // Deliberately not an error. Nothing has gone wrong; we simply stopped
      // watching, and the generation completes regardless.
      setState(
        "info",
        "Still drawing — it'll appear on your profile shortly. There's nothing to wait for here; " +
        "reload the page in a moment to see it."
      );
      return;
    }

    // Both remaining outcomes carry the allowance in the row. Re-read it
    // rather than trusting what the 202 said: a failure REFUNDS the attempt
    // (0026's fail() puts `avatar_attempts` back), so the count the member was
    // given when the request was accepted is no longer true.
    const row = result.row || {};
    profile = Object.assign({}, profile, {
      avatar_attempts: row.avatar_attempts,
      avatar_cycle: row.avatar_cycle,
      avatar_status: row.avatar_status,
      avatar_gallery: Array.isArray(row.avatar_gallery) ? row.avatar_gallery : profile.avatar_gallery,
    });
    used = attemptsUsedThisCycle(profile);

    if (result.outcome === "failed") {
      render();
      // `avatar_error` is already a sentence written for the member — 0026's
      // column comment says so and generate-avatar's triage writes it that
      // way — so it is shown as it stands rather than translated again here.
      setState(
        "err",
        String(row.avatar_error || "That drawing didn't work out. Try another photo.") +
        (left() > 0 ? " Your try has been given back — you still have " + tries(left()) + " this month." : "")
      );
      return;
    }

    applyAvatar(row.avatar_url || avatarUrl);
    showResult(false);
  }

  function showResult(isFallback) {
    resultImg.src = avatarUrl;
    resultEl.hidden = false;
    // "Try another" on a fallback is a button that redraws the same tile —
    // it is deterministic per member per month by design — so it is not
    // offered there.
    const retry = resultEl.querySelector('[data-act="retry"]');
    retry.hidden = isFallback || left() === 0;
    retry.textContent = "Try another (" + tries(left()) + ")";

    // Only offered when there is a photo to fall back to. A member who took a
    // tile of their initials never supplied one, and a button promising to use
    // a photo that does not exist is worse than no button.
    const photoBtn = resultEl.querySelector('[data-act="photo"]');
    photoBtn.hidden = !lastOrigin;
    if (lastOrigin) photoBtn.textContent = "Use " + lastOrigin.label + " instead";

    // "Discarded" is precise and has to stay precise, because the button next
    // to it offers the photo back. The server did discard it — generate-avatar
    // wipes the source and stamps `source_purged_at`. What is still here is the
    // copy in this browser tab, which is where "use my photo instead" reads
    // from, and which goes when the tab does. Saying only "discarded" next to a
    // button that undoes it reads as a contradiction; saying where it survives
    // is both truthful and the thing a member needs to know.
    resultNote.textContent = isFallback
      ? "Saved. This is your tile for this month — it's on your profile now."
      : "Saved. This is your avatar now, and the server has discarded your photo." +
        (lastOrigin
          ? " Your browser still has it until you leave this page — use " +
            lastOrigin.label + " instead if you prefer it."
          : "") +
        (left() > 0 ? " You have " + tries(left()) + " this month." : "");
  }

  // ---- Staging, so the drawing starts when they save --------------------

  // Ahmed's ask, in his words: "images are generated on demand while the member
  // waits — generating on save and revealing the result when ready removes the
  // wait entirely." Both pages that host this control have a Save button and a
  // form the member is in the middle of filling in, so the photo is held until
  // that button is pressed and the drawing starts as they leave.
  //
  // "Draw it now instead" is offered beside it because a member who came here
  // only to change their picture should not have to press Save on a form they
  // did not touch to make anything happen.
  //
  // The staged photo is the resized copy prepareAvatarImage returned. It is
  // never written anywhere, and the preview below is a data: URL built from
  // bytes that are already in this tab — the original still only leaves the
  // browser when the drawing is actually requested.
  function renderStaged() {
    stagedEl.hidden = !stagedPhoto;
    if (!stagedPhoto) {
      stagedImg.removeAttribute("src");
      return;
    }
    stagedImg.src = "data:" + stagedPhoto.mediaType + ";base64," + stagedPhoto.base64;
    stagedNote.textContent =
      "Ready. We'll draw your portrait when you save this profile — you won't have to wait for it, " +
      "and it appears on your profile when it's done.";
  }

  function stagePhoto(photo) {
    stagedPhoto = photo;
    lastPhoto = photo;
    resultEl.hidden = true;
    renderStaged();
    setState("info", "Photo chosen. Press Save and we'll get on with the drawing.");
  }

  // What a page does with a chosen photo: hold it for the save, or send it now.
  function takePhoto(photo) {
    if (deferOnSave) {
      stagePhoto(photo);
      return Promise.resolve();
    }
    return generateFrom(photo);
  }

  // ---- The three ways in ----------------------------------------------

  fileEl.addEventListener("change", async function () {
    const file = fileEl.files && fileEl.files[0];
    fileEl.value = "";                       // so picking the same file twice re-fires
    if (!file) return;
    if (!/^image\//.test(file.type || "")) {
      setState("err", "That needs to be an image — PNG, JPEG or WebP.");
      return;
    }
    setBusy(true, "Preparing your photo…");
    let photo;
    try {
      photo = await prepareAvatarImage(file);
    } catch (err) {
      setBusy(false);
      setState("err", err && err.message ? err.message : "Couldn't read that photo.");
      return;
    }
    setBusy(false);
    lastOrigin = { source: "upload", label: "the photo you uploaded", url: null };
    lastPhoto = { base64: photo.base64, mediaType: photo.mediaType, source: "upload" };

    // Same picker, two destinations. The flag is cleared here rather than in
    // the click handler that set it, because the member may cancel the file
    // dialog — which fires no event at all — and a flag left set would send
    // the NEXT upload down the wrong path.
    if (plainMode) {
      plainMode = false;
      await keepPhoto();
      return;
    }
    await takePhoto(lastPhoto);
  });

  async function fromProvider(entry) {
    setBusy(true, "Fetching your " + entry.label + " photo…");
    let blob;
    try {
      const res = await fetch(entry.url, { mode: "cors", credentials: "omit" });
      if (!res.ok) throw new Error("status " + res.status);
      blob = await res.blob();
    } catch (err) {
      setBusy(false);
      // Both providers serve these from hosts we do not control, and either
      // may refuse a cross-origin read. That is not something the member can
      // fix, so the message points at the thing that does work.
      setState(
        "err",
        entry.label + " wouldn't let us fetch that photo from your browser. " +
        "Save it to your device and upload it instead."
      );
      return;
    }
    let photo;
    try {
      photo = await prepareAvatarImage(blob);
    } catch (err) {
      setBusy(false);
      setState("err", "That " + entry.label + " photo couldn't be read. Try uploading one instead.");
      return;
    }
    setBusy(false);
    // `entry.url` is the picture on Google's / Microsoft's / LinkedIn's own
    // server. Kept here so "use my photo instead" can store the LINK rather
    // than a copy — which is what privacy.html has always said we do.
    lastOrigin = { source: entry.source, label: "your " + entry.label + " photo", url: entry.url };
    await takePhoto({ base64: photo.base64, mediaType: photo.mediaType, source: entry.source });
  }

  // ---- Keeping the photograph itself ------------------------------------
  //
  // Ahmed's decision, 4 Aug 2026: a member who does not like their drawing may
  // keep the photo. Two different things happen depending on where it came
  // from, and the difference matters enough to be worth stating:
  //
  //   provider  we store the LINK. The picture stays on Google's, Microsoft's
  //             or LinkedIn's server and nothing is copied — the case
  //             privacy.html has always documented.
  //   upload    we store the FILE, in the member's own folder in the avatars
  //             bucket (0016's insert policy allows that and only that). This
  //             is new, and it is why privacy.html no longer claims there is
  //             nowhere in this system a photograph of you could be sitting.
  //
  // Either way the row is stamped through keep_photo_as_avatar() (0038) rather
  // than by writing `avatar_url` directly, because the columns that record
  // "this is a photograph and it was not drawn" are ungranted to members — and
  // one of them, `avatar_is_photo`, is what stops the monthly refresh job
  // replacing this with the drawing they just rejected.
  function base64ToBlob(base64, mediaType) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mediaType });
  }

  function photoExtension(mediaType) {
    if (/png/i.test(mediaType)) return "png";
    if (/webp/i.test(mediaType)) return "webp";
    return "jpg";
  }

  async function keepPhoto() {
    if (busy || !lastOrigin) return;
    resultEl.hidden = true;
    setBusy(true, "Setting your photo…");

    let url = lastOrigin.url;

    // An upload has to be somewhere public before it can be an avatar.
    if (!url) {
      if (!lastPhoto) {
        setBusy(false);
        setState("err", "That photo is no longer in this page. Choose it again and we'll keep it.");
        return;
      }
      const path = userId + "/photo." + photoExtension(lastPhoto.mediaType);
      const up = await supabase.storage
        .from(AVATAR_BUCKET)
        .upload(path, base64ToBlob(lastPhoto.base64, lastPhoto.mediaType), {
          contentType: lastPhoto.mediaType,
          upsert: true,
        });

      if (up.error) {
        setBusy(false);
        const msg = String(up.error.message || "");
        setState("err", /bucket/i.test(msg)
          ? "Photo storage isn't set up yet on the server, so your photo couldn't be saved."
          : "Couldn't save your photo: " + msg);
        return;
      }

      // Fixed path plus upsert means the CDN is still serving the previous
      // bytes under the same URL — the same trick useTile() needs, except the
      // version has to change per upload rather than per month, or choosing a
      // different photo twice in one month shows the first one.
      const pub = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl;
      url = pub + (pub.indexOf("?") !== -1 ? "&" : "?") + "v=" + Date.now();
    }

    const res = await supabase.rpc("keep_photo_as_avatar", {
      p_url: url,
      p_source: lastOrigin.source,
    });

    setBusy(false);

    if (res.error) {
      setState("err", isMissingSchema(res.error)
        ? "Keeping your own photo isn't switched on yet — the database update it needs hasn't " +
          "been applied. Your drawing is unchanged."
        : "Couldn't set that photo just now. Try again in a moment.");
      return;
    }

    applyAvatar(url);
    setState(
      "ok",
      "Done — " + lastOrigin.label + " is your picture now. It won't be redrawn. " +
      "You can go back to a drawing whenever you like."
    );
  }

  // Removing it altogether. The storage delete comes first and its failure is
  // NOT fatal: the object may not exist (a drawing, a provider link, a member
  // who never uploaded anything), and the important half is the row. What must
  // not happen is the row being cleared while a photograph stays on disk, so
  // the order is delete-then-clear and a delete that genuinely failed is
  // reported even though the row went through.
  async function clearAvatar() {
    if (busy) return;
    resultEl.hidden = true;
    setBusy(true, "Removing your picture…");

    // Every extension keepPhoto() can produce. Removing a key that isn't there
    // is not an error in the storage API, so this is one call, not three.
    const paths = ["png", "jpg", "webp"].map(function (ext) { return userId + "/photo." + ext; });
    let storageFailed = false;
    try {
      const del = await supabase.storage.from(AVATAR_BUCKET).remove(paths);
      if (del.error) storageFailed = true;
    } catch (err) {
      storageFailed = true;
    }

    const res = await supabase.rpc("clear_my_avatar");
    setBusy(false);

    if (res.error) {
      setState("err", isMissingSchema(res.error)
        ? "Removing your picture isn't switched on yet — the database update it needs hasn't " +
          "been applied. Nothing was changed."
        : "Couldn't remove your picture just now. Try again in a moment.");
      return;
    }

    lastPhoto = null;
    lastOrigin = null;
    stagedPhoto = null;
    renderStaged();
    profile = Object.assign({}, profile, {
      avatar_is_photo: false, avatar_status: null, avatar_cycle: null,
    });
    applyAvatar("");

    setState(
      storageFailed ? "err" : "ok",
      storageFailed
        ? "Your profile no longer shows a picture, but the stored file could not be deleted. " +
          "Email info@sahabaclub.com and we'll remove it."
        : "Removed. You're showing initials again, and any photo we stored has been deleted."
    );
  }

  // The tile. No OpenAI call, no attempt spent, and it works when
  // generate-avatar is unreachable — which is the point of it being here
  // rather than behind the function.
  async function useTile() {
    if (busy) return;
    // A tile answers the same question the staged photo was waiting to answer,
    // so holding on to the photo would leave a save quietly redrawing over the
    // tile the member just chose.
    stagedPhoto = null;
    renderStaged();
    resultEl.hidden = true;
    setBusy(true, "Making your tile…");

    const cycle = avatarCycle();
    const name = profile.full_name || (session && session.user && session.user.email) || "";
    const svg = fallbackAvatarSvg(userId, name, cycle);
    const path = userId + "/fallback.svg";

    const up = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(path, new Blob([svg], { type: "image/svg+xml" }), {
        contentType: "image/svg+xml",
        upsert: true,
      });

    if (up.error) {
      setBusy(false);
      const msg = String(up.error.message || "");
      setState(
        "err",
        /bucket/i.test(msg)
          ? "Avatar storage isn't set up yet on the server, so the tile couldn't be saved."
          : "Couldn't save your tile: " + msg
      );
      return;
    }

    const pub = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl;
    // The path is fixed and overwritten, so the CDN is still holding last
    // month's bytes under the same URL. Same trick as uploadFallback().
    const url = pub + (pub.indexOf("?") !== -1 ? "&" : "?") + "v=" + encodeURIComponent(cycle);

    // `.select()` so a zero-row update is visible. Without it PostgREST
    // reports success and changes nothing when the column grant is missing —
    // the exact silent failure 0017 was written to fix.
    const res = await supabase
      .from("profiles")
      .update({ avatar_url: url })
      .eq("user_id", userId)
      .select("user_id");

    setBusy(false);

    if (res.error) {
      setState("err", isMissingSchema(res.error)
        ? "Photos aren't switched on for this account yet."
        : "Couldn't save your tile: " + res.error.message);
      return;
    }
    if (!res.data || !res.data.length) {
      setState("err", "Your tile was made but the profile wouldn't accept it. Nothing was changed.");
      return;
    }

    applyAvatar(url);
    showResult(true);
  }

  async function download() {
    if (!avatarUrl) return;
    const name = "sahaba-avatar" + (/\.svg(\?|$)/.test(avatarUrl) ? ".svg" : ".png");
    try {
      const res = await fetch(avatarUrl, { mode: "cors" });
      if (!res.ok) throw new Error("status");
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(function () { URL.revokeObjectURL(href); }, 4000);
    } catch (err) {
      // `download` is ignored cross-origin, so this opens it instead of
      // saving it. Saying so beats a button that silently does nothing.
      window.open(avatarUrl, "_blank", "noopener");
      setState("info", "Opened your avatar in a new tab — save it from there.");
    }
  }

  root.addEventListener("click", function (ev) {
    const thumb = ev.target.closest(".av-thumb");
    if (thumb && !thumb.disabled) {
      selectFromGallery(thumb.getAttribute("data-url"));
      return;
    }

    const btn = ev.target.closest(".av-btn");
    if (!btn || btn.disabled) return;
    const act = btn.getAttribute("data-act");

    if (act === "upload") { plainMode = false; fileEl.click(); return; }
    if (act === "plain-upload") { plainMode = true; fileEl.click(); return; }
    if (act === "plain-provider") {
      const wantPlain = btn.getAttribute("data-p");
      const plainEntry = providers.filter(function (p) { return p.provider === wantPlain; })[0];
      if (!plainEntry) return;
      // No fetch, no resize, no drawing — the provider's own URL goes straight
      // into the profile. Nothing is copied from their server.
      lastOrigin = {
        source: plainEntry.source,
        label: "your " + plainEntry.label + " photo",
        url: plainEntry.url,
      };
      keepPhoto();
      return;
    }
    if (act === "tile") { useTile(); return; }
    if (act === "clear") { clearAvatar(); return; }
    if (act === "provider") {
      const want = btn.getAttribute("data-p");
      const entry = providers.filter(function (p) { return p.provider === want; })[0];
      if (entry) fromProvider(entry);
      return;
    }
    if (act === "keep") { resultEl.hidden = true; setState("ok", "Saved."); return; }
    if (act === "photo") { keepPhoto(); return; }
    if (act === "retry") {
      // Redrawing is the one thing a member does while they are watching, so
      // it goes now rather than waiting for a save even where staging is on.
      if (lastPhoto) generateFrom(lastPhoto);
      else setState("info", "Choose a photo to draw from first.");
      return;
    }
    if (act === "draw") {
      if (stagedPhoto) generateFrom(stagedPhoto);
      return;
    }
    if (act === "unstage") {
      stagedPhoto = null;
      renderStaged();
      setState("", "");
      renderWays();
      return;
    }
    if (act === "download") { download(); return; }
  });

  render();
  renderStaged();

  // A drawing already in flight when this page opened. The member started it,
  // went somewhere, and came back; picking the watch up here is what stops
  // them seeing a stale picture with no indication anything is happening.
  if (avatarIsDrawing(profile)) watch(false);

  return {
    // The pages re-read the row after a save; the control has to follow it or
    // it will keep showing an avatar the member has since changed elsewhere.
    setProfile: function (next) {
      profile = next || {};
      avatarUrl = profile.avatar_url || "";
      used = attemptsUsedThisCycle(profile);
      render();
      // The re-read row may be mid-drawing — a member who started one on the
      // other page, or the save that has just kicked one off.
      if (avatarIsDrawing(profile)) watch(false);
    },
    get: function () { return avatarUrl; },
    // Is there a photo waiting for the Save button? The pages ask before
    // promising the member anything about a drawing.
    hasStagedPhoto: function () { return Boolean(stagedPhoto); },
    // What a page calls once its own save has succeeded. It returns as soon as
    // the request is accepted — the 202 — and NOT when the picture is
    // finished, which is the entire point: the member is free to leave, and
    // whichever page is still open follows the row to the end on its own.
    startStagedGeneration: function () {
      if (!stagedPhoto) return Promise.resolve(false);
      return generateFrom(stagedPhoto).then(function () { return true; });
    },
    // What the "a photo" button in the Connect line calls.
    focus: function () {
      root.scrollIntoView({ behavior: "smooth", block: "center" });
      const first = root.querySelector(".av-btn:not([disabled])");
      if (first) window.setTimeout(function () { first.focus({ preventScroll: true }); }, 300);
      root.classList.add("is-called");
      window.setTimeout(function () { root.classList.remove("is-called"); }, 1600);
    },
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
