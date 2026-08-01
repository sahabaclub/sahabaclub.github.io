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

// What a member is open to being approached about. `mentoring` and
// `collaborating` were the original two; they are kept in OPEN_TO_LEGACY so a
// profile saved before this list changed still renders its old choices
// instead of silently losing them, but they are no longer offered.
export const OPEN_TO = [
  { value: "coaching", label: "Coaching" },
  { value: "work", label: "Work" },
  { value: "freelance", label: "Free Lance" },
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

// options: { root, session, profile, providers, onChange(avatarUrl) }
export function createAvatarControl(options) {
  const root = options.root;
  const session = options.session;
  const providers = options.providers || [];
  const onChange = typeof options.onChange === "function" ? options.onChange : function () {};

  const userId = session && session.user ? session.user.id : "";
  let profile = options.profile || {};
  let avatarUrl = profile.avatar_url || "";
  let used = attemptsUsedThisCycle(profile);
  let busy = false;
  // Kept so "Try another" does not make the member find the file again. It is
  // the resized copy, never written anywhere, and dropped when the control is
  // done with it.
  let lastPhoto = null;

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
    '<p class="av-privacy">Your original photo is sent for the drawing and is never stored — ' +
      "only the illustration is kept.</p>" +
    '<div class="av-state" id="av-state" role="status" aria-live="polite" hidden></div>' +
    '<div class="av-result" id="av-result" hidden>' +
      '<img class="av-result-img" id="av-result-img" alt="Your new avatar" width="120" height="120">' +
      '<div class="av-result-side">' +
        '<p class="av-result-note" id="av-result-note"></p>' +
        '<div class="av-result-actions">' +
          '<button type="button" class="av-btn av-btn-go" data-act="keep">Use this</button>' +
          '<button type="button" class="av-btn" data-act="retry">Try another</button>' +
          '<button type="button" class="av-btn" data-act="download">Download</button>' +
        "</div>" +
      "</div>" +
    "</div>" +
    '<input type="file" class="av-file" id="av-file" accept="image/png,image/jpeg,image/webp" hidden>';

  const shotEl = root.querySelector("#av-shot");
  const waysEl = root.querySelector("#av-ways");
  const stateEl = root.querySelector("#av-state");
  const resultEl = root.querySelector("#av-result");
  const resultImg = root.querySelector("#av-result-img");
  const resultNote = root.querySelector("#av-result-note");
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

  function render() {
    renderShot();
    renderWays();
  }

  // Image generation takes tens of seconds. Every button in the control goes
  // down for the duration and the state line says what is happening — a
  // member who can press "Upload a photo" again while the first one is still
  // drawing will, and will then be told two requests are racing.
  function setBusy(on, message) {
    busy = on;
    if (on) {
      Array.prototype.forEach.call(root.querySelectorAll(".av-btn"), function (b) {
        b.disabled = true;
      });
      root.classList.add("is-busy");
      setState("busy", message || "Working…");
      return;
    }
    root.classList.remove("is-busy");
    // renderWays() rebuilds the three entry buttons with the right disabled
    // state; the result panel's buttons are not in it, so they are released
    // here.
    Array.prototype.forEach.call(resultEl.querySelectorAll(".av-btn"), function (b) {
      b.disabled = false;
    });
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
      return "The drawing service couldn't finish that one. Try again shortly, " +
        "or use a tile with your initials.";
    }

    return "We couldn't reach the drawing service — it may not be switched on yet, " +
      "or you may be offline. A tile with your initials works either way.";
  }

  async function generateFrom(photo) {
    if (busy) return;
    lastPhoto = photo;
    resultEl.hidden = true;
    setBusy(true, "Drawing your portrait — this takes up to a minute. Don't close this page.");

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

    setBusy(false);

    if (error || !data || !data.ok || !data.avatarUrl) {
      setState("err", await readInvokeError(error, data));
      // A failed generation still reports the allowance the function gave
      // back, so the member is not told they have three tries left after
      // spending one — or that they have none after a refunded failure.
      if (data && typeof data.attemptsUsed === "number") {
        used = data.attemptsUsed;
        renderWays();
      }
      return;
    }

    if (typeof data.attemptsUsed === "number") used = data.attemptsUsed;
    avatarUrl = data.avatarUrl;
    profile = Object.assign({}, profile, { avatar_url: avatarUrl });
    render();
    showResult(Boolean(data.isFallback));
    onChange(avatarUrl);
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

    resultNote.textContent = isFallback
      ? "Saved. This is your tile for this month — it's on your profile now."
      : "Saved. This is your avatar now, and your photo has been discarded." +
        (left() > 0 ? " You have " + tries(left()) + " this month." : "");
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
    await generateFrom({ base64: photo.base64, mediaType: photo.mediaType, source: "upload" });
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
    await generateFrom({ base64: photo.base64, mediaType: photo.mediaType, source: entry.source });
  }

  // The tile. No OpenAI call, no attempt spent, and it works when
  // generate-avatar is unreachable — which is the point of it being here
  // rather than behind the function.
  async function useTile() {
    if (busy) return;
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

    avatarUrl = url;
    profile = Object.assign({}, profile, { avatar_url: url });
    render();
    showResult(true);
    onChange(url);
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
    const btn = ev.target.closest(".av-btn");
    if (!btn || btn.disabled) return;
    const act = btn.getAttribute("data-act");

    if (act === "upload") { fileEl.click(); return; }
    if (act === "tile") { useTile(); return; }
    if (act === "provider") {
      const want = btn.getAttribute("data-p");
      const entry = providers.filter(function (p) { return p.provider === want; })[0];
      if (entry) fromProvider(entry);
      return;
    }
    if (act === "keep") { resultEl.hidden = true; setState("ok", "Saved."); return; }
    if (act === "retry") {
      if (lastPhoto) generateFrom(lastPhoto);
      else setState("info", "Choose a photo to draw from first.");
      return;
    }
    if (act === "download") { download(); return; }
  });

  render();

  return {
    // The pages re-read the row after a save; the control has to follow it or
    // it will keep showing an avatar the member has since changed elsewhere.
    setProfile: function (next) {
      profile = next || {};
      avatarUrl = profile.avatar_url || "";
      used = attemptsUsedThisCycle(profile);
      render();
    },
    get: function () { return avatarUrl; },
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
