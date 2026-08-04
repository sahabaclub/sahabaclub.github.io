// Contrast measurement for the analytics consent bar and the privacy page's
// withdrawal control. Run from the repo root:
//   node tools/analytics-checks/contrast.mjs
//
// Method, so the numbers mean something:
//   * The bar carries its own OPAQUE surface in each theme. That is the point
//     of it being opaque: the rest of this site is translucent glass over a
//     starfield, a card or a video poster, and "whatever happens to be behind
//     it" has no contrast ratio. Every number here is against a real colour.
//   * Text is held to WCAG AA 1.4.3 — 4.5:1, because none of it is large
//     (the largest is 15px bold, and "large" starts at 18.66px bold).
//   * Borders and focus rings are held to 1.4.11's 3:1 as non-text indicators,
//     and each is measured against BOTH surfaces it sits between, since a
//     border is by definition on the join.
//   * Hover states are measured too. A colour that only clears the bar until
//     the mouse arrives has not cleared it.

function hex(h) {
  h = h.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const lin = (c) => ((c /= 255), c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const L = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
function ratio(a, b) {
  const la = L(typeof a === "string" ? hex(a) : a);
  const lb = L(typeof b === "string" ? hex(b) : b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const rows = [];
function check(label, fg, bg, need) {
  const r = ratio(fg, bg);
  rows.push({ label, fg, bg, r: r.toFixed(2), need, pass: r >= need });
}

// Site tokens, from :root and html.light-mode in styles.css.
const PAGE_DARK = "#05070d";
const PAGE_LIGHT = "#f4f7fc";
const TEXT_DARK = "#f3f4f8";
const TEXT_LIGHT = "#101627";
const SUB_DARK = "#a6acc2";
const SUB_LIGHT = "#4a5570";
const CYAN_DARK = "#22d3ee";
const CYAN_LIGHT = "#0e7490";

// The bar's own colours, as declared in the .ga-* block at the end of styles.css.
const D = {
  surface: "#0d1018",
  rule: "#6b7591",          // border-top, and the button borders
  ruleHover: "#8a94ad",
  btn: "#1c2434",
  btnHover: "#27324a",
};
const Lt = {
  surface: "#ffffff",
  rule: "#7a8296",
  ruleHover: "#5d6780",
  btn: "#f2f5fa",
  btnHover: "#e3e9f4",
};

// ------------------------------------------------------------------ the bar
check("dark: bar title on the bar", TEXT_DARK, D.surface, 4.5);
check("dark: bar body text on the bar", SUB_DARK, D.surface, 4.5);
check("dark: 'What it records' link on the bar", CYAN_DARK, D.surface, 4.5);
check("light: bar title on the bar", TEXT_LIGHT, Lt.surface, 4.5);
check("light: bar body text on the bar", SUB_LIGHT, Lt.surface, 4.5);
check("light: 'What it records' link on the bar", CYAN_LIGHT, Lt.surface, 4.5);

// The bar's top edge is the only thing separating an opaque bar from a page of
// almost exactly the same lightness, so it is measured against both.
check("dark: bar top rule vs the page (graphic)", D.rule, PAGE_DARK, 3.0);
check("dark: bar top rule vs the bar (graphic)", D.rule, D.surface, 3.0);
check("light: bar top rule vs the page (graphic)", Lt.rule, PAGE_LIGHT, 3.0);
check("light: bar top rule vs the bar (graphic)", Lt.rule, Lt.surface, 3.0);

// ------------------------------------------------------- accept and decline
// One class, one set of numbers. Accept and decline are the same button with a
// different word on it, so there is deliberately no second row here to
// measure — if this ever grows a "primary" variant, that is the thing this
// file should be made to complain about.
check("dark: button label on the button face", TEXT_DARK, D.btn, 4.5);
check("dark: button label on the hovered face", TEXT_DARK, D.btnHover, 4.5);
check("dark: button border vs the bar (graphic)", D.rule, D.surface, 3.0);
check("dark: button border vs its own face (graphic)", D.rule, D.btn, 3.0);
check("dark: hovered button border vs hovered face (graphic)", D.ruleHover, D.btnHover, 3.0);
check("dark: hovered button border vs the bar (graphic)", D.ruleHover, D.surface, 3.0);
check("light: button label on the button face", TEXT_LIGHT, Lt.btn, 4.5);
check("light: button label on the hovered face", TEXT_LIGHT, Lt.btnHover, 4.5);
check("light: button border vs the bar (graphic)", Lt.rule, Lt.surface, 3.0);
check("light: button border vs its own face (graphic)", Lt.rule, Lt.btn, 3.0);
check("light: hovered button border vs hovered face (graphic)", Lt.ruleHover, Lt.btnHover, 3.0);
check("light: hovered button border vs the bar (graphic)", Lt.ruleHover, Lt.surface, 3.0);

// The focus ring is the keyboard user's only affordance, and it is the site's
// baseline `outline: 2px solid var(--cyan)` with a 2px offset — so it crosses
// the join between the button face and the bar behind it, and has to clear 3:1
// on both sides of that join rather than on the one it was drawn against.
check("dark: focus ring vs the button face (graphic)", CYAN_DARK, D.btn, 3.0);
check("dark: focus ring vs the bar (graphic)", CYAN_DARK, D.surface, 3.0);
check("light: focus ring vs the button face (graphic)", CYAN_LIGHT, Lt.btn, 3.0);
check("light: focus ring vs the bar (graphic)", CYAN_LIGHT, Lt.surface, 3.0);

// ------------------------------------- the withdrawal control on privacy.html
// Same button, different surface: this one sits on the PAGE, not on the bar.
// Its face is lighter than the dark page and darker than the light page, which
// is the opposite relationship to the one above, so the border has to be
// measured again rather than assumed to carry over.
check("dark: withdraw button label on its face", TEXT_DARK, D.btn, 4.5);
check("dark: withdraw button border vs the page (graphic)", D.rule, PAGE_DARK, 3.0);
check("dark: withdraw focus ring vs the page (graphic)", CYAN_DARK, PAGE_DARK, 3.0);
check("light: withdraw button label on its face", TEXT_LIGHT, Lt.btn, 4.5);
check("light: withdraw button border vs the page (graphic)", Lt.rule, PAGE_LIGHT, 3.0);
check("light: withdraw focus ring vs the page (graphic)", CYAN_LIGHT, PAGE_LIGHT, 3.0);

// The status sentence analytics.js writes into the page, and the storage-key
// and cookie names set in <code> — both on the page, in the legal column.
check("dark: analytics status line on the page", SUB_DARK, PAGE_DARK, 4.5);
check("light: analytics status line on the page", SUB_LIGHT, PAGE_LIGHT, 4.5);
check("dark: <code> key names on the page", TEXT_DARK, PAGE_DARK, 4.5);
check("light: <code> key names on the page", TEXT_LIGHT, PAGE_LIGHT, 4.5);

let bad = 0;
for (const r of rows) {
  if (!r.pass) bad++;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${String(r.r).padStart(6)}:1 (need ${r.need})  ${r.label} — ${r.fg} on ${r.bg}`);
}
console.log(`\n${rows.length} measurements, ${bad} failing.`);
process.exit(bad ? 1 : 0);
