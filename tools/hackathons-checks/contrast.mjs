// Contrast measurement for the new medal-tier cards (hackathons page).
//
// Method, so the numbers mean something:
//   * Text on a gradient is measured against the WORST stop of that gradient —
//     the lightest stop in dark theme, the darkest stop in light theme.
//   * The white sheen overlay is composited on top of that worst stop at its
//     maximum alpha before measuring, because the sheen sweeps across the card.
//   * The trophy is a graphic, so it is held to WCAG 1.4.11's 3:1, measured
//     against the medallion disc it actually sits on (a flat colour), and the
//     disc is measured against the card.

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
const rgb = (c) => (typeof c === "string" ? hex(c) : c);
function over(base, ov, al) {
  const b = rgb(base), o = rgb(ov);
  return [0, 1, 2].map((i) => Math.round(b[i] * (1 - al) + o[i] * al));
}
// Several of the new surfaces are three or four layers deep — a tinted card
// on a glass panel on the page. stack() composites them in paint order so the
// number measured is the colour that is actually behind the text.
function stack(base, layers) {
  return layers.reduce((acc, [colour, alpha]) => over(acc, colour, alpha), rgb(base));
}
const toHex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
const lightest = (a) => a.reduce((x, y) => (L(hex(x)) > L(hex(y)) ? x : y));
const darkest = (a) => a.reduce((x, y) => (L(hex(x)) < L(hex(y)) ? x : y));

const SHEEN_DARK = 0.10;
const SHEEN_LIGHT = 0.55;

const rows = [];
function check(label, fg, bg, need) {
  const r = ratio(fg, bg);
  rows.push({
    label, fg,
    bg: typeof bg === "string" ? bg : toHex(bg),
    r: r.toFixed(2), need, pass: r >= need,
  });
}

const TROPHY = {
  gold:   ["#fff3cf", "#f0c65a", "#c08b1e"],
  silver: ["#ffffff", "#d5dbe8", "#9aa3b8"],
  bronze: ["#ffe2c4", "#e39a5c", "#b06a2c"],
};

// Bright metallic rim around the medallion — the edge that identifies it.
const RIM = { gold: "#f0c65a", silver: "#d5dbe8", bronze: "#e39a5c" };

// ---------------------------------------------------------------- DARK THEME
const DISC_DARK = "#07080c";
const dark = {
  gold:   { stops: ["#2b1f07", "#4d3a0e", "#1d1405"], label: "#f6dda2" },
  silver: { stops: ["#272c3a", "#414963", "#1b1f2a"], label: "#e3e8f2" },
  bronze: { stops: ["#2e2011", "#4e3520", "#221709"], label: "#f0c6a0" },
};
for (const [k, t] of Object.entries(dark)) {
  const worst = over(lightest(t.stops), "#ffffff", SHEEN_DARK);
  check(`dark ${k}: team name (--text)`, "#f3f4f8", worst, 4.5);
  check(`dark ${k}: place label`, t.label, worst, 4.5);
  check(`dark ${k}: sub text`, "#cfd4e2", worst, 4.5);
  // The medallion's identifying boundary is its bright metallic rim, not the
  // dark disc behind it: no shade of dark reaches 3:1 against a card this
  // light, so the rim carries 1.4.11 and the disc is depth only.
  check(`dark ${k}: medallion rim vs card (graphic)`, RIM[k], worst, 3.0);
  check(`dark ${k}: trophy darkest stop on disc (graphic)`, darkest(TROPHY[k]), DISC_DARK, 3.0);
}

// --------------------------------------------------------------- LIGHT THEME
const DISC_LIGHT = "#20232c";
const light = {
  gold:   { stops: ["#fdf6e2", "#eed898", "#fbefc9"], label: "#5a3f06" },
  silver: { stops: ["#f9fafc", "#d3dae7", "#eff2f7"], label: "#2f3646" },
  bronze: { stops: ["#fdf3ea", "#e7c49d", "#f8ebdf"], label: "#63380f" },
};
for (const [k, t] of Object.entries(light)) {
  const worst = darkest(t.stops);                       // sheen only lightens
  const sheened = over(worst, "#ffffff", SHEEN_LIGHT);
  check(`light ${k}: team name (--text)`, "#101627", worst, 4.5);
  check(`light ${k}: team name over sheen`, "#101627", sheened, 4.5);
  check(`light ${k}: place label`, t.label, worst, 4.5);
  check(`light ${k}: place label over sheen`, t.label, sheened, 4.5);
  check(`light ${k}: sub text`, "#3f4759", worst, 4.5);
  check(`light ${k}: disc vs card (graphic)`, DISC_LIGHT, lightest(t.stops), 3.0);
  check(`light ${k}: medallion rim vs disc (graphic)`, RIM[k], DISC_LIGHT, 3.0);
  check(`light ${k}: trophy darkest stop on disc (graphic)`, darkest(TROPHY[k]), DISC_LIGHT, 3.0);
}

// ------------------------------------------------- coming-soon panel + modal
// The panel and the dialog reuse the site tokens on the site surfaces, so only
// the pieces with new colours are measured here.
check("dark: modal panel text on #10131c", "#f3f4f8", "#10131c", 4.5);
check("dark: modal muted text on #10131c", "#a6acc2", "#10131c", 4.5);
check("dark: modal error text on #10131c", "#fca5a5", "#10131c", 4.5);
check("dark: modal success text on #10131c", "#6ee7a8", "#10131c", 4.5);
check("dark: early-bird pill text on tint", "#f6dda2", over("#10131c", "#e0a83e", 0.14), 4.5);
check("light: modal panel text on #ffffff", "#101627", "#ffffff", 4.5);
check("light: modal muted text on #ffffff", "#4a5570", "#ffffff", 4.5);
check("light: modal error text on #ffffff", "#b91c1c", "#ffffff", 4.5);
check("light: modal success text on #ffffff", "#166534", "#ffffff", 4.5);
check("light: early-bird pill text on tint", "#6d4708", over("#ffffff", "#e0a83e", 0.20), 4.5);

// ============================================================
// The sections added after the owner's review: the rebuilt coming-soon
// panel, the history, the coaches, the round disclosure bar and the closing
// CTA. Everything here is composited from the site's own tokens rather than
// eyeballed against "roughly the card colour" — most of these sit three
// layers deep (a tinted chip, on a glass card, on the page).
//
// Tokens, from :root and html.light-mode in styles.css:
//   dark   bg #05070d  text #f3f4f8  secondary #a6acc2  cyan #22d3ee
//   light  bg #f4f7fc  text #101627  secondary #4a5570  cyan #0e7490
//   glass  white @ 0.045 (dark) / #101627 @ 0.035 (light)
// ============================================================
const D = { bg: "#05070d", text: "#f3f4f8", sub: "#a6acc2", cyan: "#22d3ee" };
const Lt = { bg: "#f4f7fc", text: "#101627", sub: "#4a5570", cyan: "#0e7490" };

const D_GLASS = ["#ffffff", 0.045];
const L_GLASS = ["#101627", 0.035];

// Cards: one glass layer on the page.
const D_CARD = stack(D.bg, [D_GLASS]);
const L_CARD = stack(Lt.bg, [L_GLASS]);

// Chips inside those cards (venue pills, coach round pills).
const D_CHIP = stack(D_CARD, [["#ffffff", 0.05]]);
const L_CHIP = stack(L_CARD, [["#000000", 0.04]]);

// The coming-soon panel and the closing CTA carry violet/cyan radials over a
// base layer. Composited in PAINT order — bottom layer first, and in CSS the
// FIRST background listed is the topmost — at each radial's peak alpha, which
// is the worst point for the text either way round: in dark the washes
// lighten the panel under light text, and in light they darken it under dark
// text. Measuring the light panel against its flat rgba(255,255,255,0.7)
// alone would have been the best case, not the worst.
const D_SOON = stack(D.bg, [D_GLASS, ["#22d3ee", 0.12], ["#8b5cf6", 0.16]]);
const L_SOON = stack(Lt.bg, [["#ffffff", 0.7], ["#0e7490", 0.09], ["#6d28d9", 0.10]]);
const D_CTA = stack(D.bg, [D_GLASS, ["#8b5cf6", 0.16]]);
const L_CTA = stack(Lt.bg, [["#ffffff", 0.7], ["#6d28d9", 0.10]]);

// The coach monogram. Two gradient stops over the card; the worst case for
// the light text in dark mode is whichever stop composites brightest, and for
// the dark text in light mode whichever composites darkest.
const D_MONO = [stack(D_CARD, [["#8b5cf6", 0.38]]), stack(D_CARD, [["#22d3ee", 0.22]])];
const L_MONO = [stack(L_CARD, [["#8b5cf6", 0.30]]), stack(L_CARD, [["#22d3ee", 0.20]])];
const brightest = (a) => a.reduce((x, y) => (L(x) > L(y) ? x : y));
const dimmest = (a) => a.reduce((x, y) => (L(x) < L(y) ? x : y));

// ---- coming-soon panel ----
check("dark: coming-soon eyebrow on panel", D.cyan, D_SOON, 4.5);
check("dark: coming-soon round name on panel", D.text, D_SOON, 4.5);
check("dark: coming-soon note on panel", D.sub, D_SOON, 4.5);
// Not Lt.cyan: --cyan measured 3.99:1 here, so .hk-soon-flag carries its own
// darker teal in light mode. The token is fine on the flat page and only
// fails on this panel's wash, which is why it needed measuring rather than
// assuming.
check("light: coming-soon eyebrow on panel", "#0b5c73", L_SOON, 4.5);
check("light: round number on the page", Lt.cyan, Lt.bg, 4.5);
check("dark: round number on the page", D.cyan, D.bg, 4.5);
check("light: coming-soon round name on panel", Lt.text, L_SOON, 4.5);
check("light: coming-soon note on panel", Lt.sub, L_SOON, 4.5);

// ---- "Coming Soon", set in the EduHackAI mark's own gradient ----
//
// The mark is a horizontal blue-to-magenta ramp. Its colours were SAMPLED out
// of assets/eduhack/eduhackai-dark.png — the PNG was decoded and its saturated
// pixels averaged in twelve vertical bands — rather than guessed, so the ramp
// below is the artwork's and not an impression of it. The run is #0017ff at
// the left through #f200c3 at the right, with a #00acff cyan accent.
//
// A gradient text fill has no single colour, so measuring its endpoints is not
// enough on its own — a linear-gradient interpolates channel-wise in sRGB and
// the luminance along it is not guaranteed to be monotone between two stops.
// A ramp is therefore SAMPLED at 21 evenly spaced points and the WORST of the
// 21 is what is reported. The endpoints are then reported separately, because
// the solid fallback in styles.css is the worse endpoint and it has to be the
// same number.
const mix = (a, b, t) => {
  const x = rgb(a), y = rgb(b);
  return [0, 1, 2].map((i) => Math.round(x[i] + (y[i] - x[i]) * t));
};
function worstOfRamp(a, b, bg) {
  let worst = Infinity, at = 0;
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const r = ratio(mix(a, b, t), bg);
    if (r < worst) { worst = r; at = t; }
  }
  return { worst, at };
}
function ramp(label, a, b, bg, need) {
  const { worst, at } = worstOfRamp(a, b, bg);
  rows.push({
    label: `${label} (worst of 21 samples, at ${Math.round(at * 100)}% along)`,
    fg: `${a}->${b}`, bg: toHex(rgb(bg)),
    r: worst.toFixed(2), need, pass: worst >= need,
  });
}
// The inverse assertion: this ramp MUST NOT clear the bar. It is the reason the
// mark's own colours were not simply used, and asserting it keeps that reason
// true rather than remembered — if the panel's wash is ever retuned so that the
// raw brand ramp does clear AA, this row turns red and says "go back to it".
function rampMustFail(label, a, b, bg, bar) {
  const { worst } = worstOfRamp(a, b, bg);
  rows.push({
    label: `${label} — must NOT reach ${bar}`,
    fg: `${a}->${b}`, bg: toHex(rgb(bg)),
    r: worst.toFixed(2), need: `<${bar}`, pass: worst < bar,
  });
}

// THE MARK'S OWN RAMP IS NOT USABLE AS TEXT on this panel, which is the whole
// reason it is re-voiced per theme. Measured, not asserted in prose: in dark
// the blue end is 1.57:1 and the magenta 3.40:1; in light the blue is fine at
// 6.09:1 but the magenta is 2.81:1. Either way an end of the ramp fails, and a
// gradient is only as legible as its worst point.
const BRAND = ["#0017ff", "#f200c3"];
rampMustFail("dark: the mark's raw blue->magenta as text", BRAND[0], BRAND[1], D_SOON, 4.5);
rampMustFail("light: the mark's raw blue->magenta as text", BRAND[0], BRAND[1], L_SOON, 4.5);

// So: the same blue-to-magenta journey, lifted for the dark surface and
// deepened for the light one. The ramps as declared in styles.css.
const D_VERB = ["#9aa5ff", "#ff9ae8"];
const L_VERB = ["#1a1fd6", "#9c0080"];

ramp("dark: 'Coming Soon' gradient on the panel", D_VERB[0], D_VERB[1], D_SOON, 4.5);
ramp("light: 'Coming Soon' gradient on the panel", L_VERB[0], L_VERB[1], L_SOON, 4.5);

// Each end on its own, so the fallback below can be checked against the number
// the gradient actually reaches at that end.
check("dark: 'Coming Soon' blue end on panel", D_VERB[0], D_SOON, 4.5);
check("dark: 'Coming Soon' magenta end on panel", D_VERB[1], D_SOON, 4.5);
check("light: 'Coming Soon' blue end on panel", L_VERB[0], L_SOON, 4.5);
check("light: 'Coming Soon' magenta end on panel", L_VERB[1], L_SOON, 4.5);

// The solid fallback, for anything that cannot paint background-clip: text.
// styles.css sets `color` unconditionally to the WORSE end of that theme's
// ramp, so a browser that falls back lands on a colour already measured at the
// gradient's own worst number — and on a brand colour rather than a neutral.
check("dark: 'Coming Soon' solid fallback on panel", "#9aa5ff", D_SOON, 4.5);
check("light: 'Coming Soon' solid fallback on panel", "#9c0080", L_SOON, 4.5);

// ============================================================
// THE SAME RAMP, ON EVERY SURFACE IT ACTUALLY LANDS ON
// ------------------------------------------------------------
// .hk-mark-text is one class carrying six section titles, and those six titles
// do NOT all sit on the same background. A ramp measured once, on the panel it
// was designed for, is a ramp measured on one sixth of its job — a gradient
// that clears 5.6:1 on the coming-soon panel says nothing about the same
// gradient on the flat page or on the closing CTA's violet wash.
//
// So every surface is enumerated and the ramp is sampled at 21 points against
// each, in both themes. The worst of the 21 is what is reported per surface.
//
// WHAT WAS FOUND WHILE ENUMERATING THEM, and it is worth writing down because
// the brief assumed otherwise: the coaches section and the story heading are
// NOT on cards. `.hk-thanks` has a border-top and no background, and
// `.hk-story-h` renders into #hack-story-head, which is a bare div in .hk-wrap
// above the stat tiles. Both are therefore on the PAGE. The story CARD is a
// real and different surface, but it sits below the heading rather than behind
// it; it is measured anyway, because it is the surface that heading would land
// on the day anybody moves it back inside, and because the number should be
// known before that happens rather than after.
const SURFACES = [
  // [what it is, which titles land on it, dark surface, light surface]
  ["the page", "EduHackAI Story / EduHackAI History / Project Showcase / Thank You to Our EduHackAI Coaches", D.bg, Lt.bg],
  ["the coming-soon panel", "Coming Soon", D_SOON, L_SOON],
  ["the closing CTA panel", "Your AI Journey Starts with EduHackAI-5", D_CTA, L_CTA],
  ["the story card", "(the surface under the story heading, not behind it)", D_CARD, L_CARD],
];
for (const [where, who, dbg, lbg] of SURFACES) {
  ramp(`dark: section-title gradient on ${where}`, D_VERB[0], D_VERB[1], dbg, 4.5);
  ramp(`light: section-title gradient on ${where}`, L_VERB[0], L_VERB[1], lbg, 4.5);
  // Each end on its own, because the solid fallback IS one of these ends and a
  // browser without background-clip:text gets exactly this number.
  check(`dark: section-title solid fallback (#9aa5ff) on ${where}`, D_VERB[0], dbg, 4.5);
  check(`light: section-title solid fallback (#9c0080) on ${where}`, L_VERB[1], lbg, 4.5);
  void who;
}
// And the inverse assertion, on the page as well as the panel: the mark's own
// blue-to-magenta still must not be usable as text anywhere these titles sit.
// If it ever becomes usable, the re-voiced ramp stops being necessary and this
// row says so instead of the reason being remembered.
rampMustFail("dark: the mark's raw blue->magenta as text, on the page", BRAND[0], BRAND[1], D.bg, 4.5);
rampMustFail("light: the mark's raw blue->magenta as text, on the page", BRAND[0], BRAND[1], Lt.bg, 4.5);

// ---- the history ----
check("dark: story heading on card", D.text, D_CARD, 4.5);
check("dark: story prose on card", D.sub, D_CARD, 4.5);
check("dark: story computed figure on card", D.text, D_CARD, 4.5);
// The venue pills are gone; the country pills that replace them reuse the same
// surface, so the number carries over. The row renders nothing today — the
// config behind it is empty and no table records a participant's country — but
// the colours have to be right for the day somebody fills it in.
check("dark: country pill text on pill", D.sub, D_CHIP, 4.5);
check("light: story heading on card", Lt.text, L_CARD, 4.5);
check("light: story prose on card", Lt.sub, L_CARD, 4.5);
check("light: story computed figure on card", Lt.text, L_CARD, 4.5);
check("light: country pill text on pill", Lt.sub, L_CHIP, 4.5);

// ---- coaches ----
check("dark: coach name on card", D.text, D_CARD, 4.5);
check("dark: coach round pill on pill", D.sub, D_CHIP, 4.5);
check("dark: coach monogram initials on wash", D.text, brightest(D_MONO), 4.5);
check("light: coach name on card", Lt.text, L_CARD, 4.5);
check("light: coach round pill on pill", Lt.sub, L_CHIP, 4.5);
check("light: coach monogram initials on wash", Lt.text, dimmest(L_MONO), 4.5);

// ---- the coach card as a LinkedIn link ----
// A card with a profile is an <a>. Three surfaces have to be measured that did
// not exist before: the "LinkedIn" cue at rest, the same cue and the name over
// the hovered violet tint, and the focus ring — which is the affordance a
// keyboard user has instead of hover, so it is held to 1.4.11's 3:1 as a
// non-text indicator, against BOTH what it is drawn on (the card) and what
// surrounds it (the page), because a 3px outline offset sits across the join.
const D_COACH_HOVER = stack(D_CARD, [["#8b5cf6", 0.08]]);
const L_COACH_HOVER = stack(L_CARD, [["#8b5cf6", 0.08]]);
const D_VIOLET = "#8b5cf6";
const L_VIOLET = "#6d28d9";
check("dark: coach LinkedIn cue on card", D.sub, D_CARD, 4.5);
check("dark: coach LinkedIn cue, hovered", D.text, D_COACH_HOVER, 4.5);
check("dark: coach name on hovered card", D.text, D_COACH_HOVER, 4.5);
check("dark: coach focus ring vs card (graphic)", D_VIOLET, D_CARD, 3.0);
check("dark: coach focus ring vs page (graphic)", D_VIOLET, D.bg, 3.0);
check("light: coach LinkedIn cue on card", Lt.sub, L_CARD, 4.5);
check("light: coach LinkedIn cue, hovered", Lt.text, L_COACH_HOVER, 4.5);
check("light: coach name on hovered card", Lt.text, L_COACH_HOVER, 4.5);
check("light: coach focus ring vs card (graphic)", L_VIOLET, L_CARD, 3.0);
check("light: coach focus ring vs page (graphic)", L_VIOLET, Lt.bg, 3.0);

// ---- the round's key figures ----
// These chips sit on the PAGE, not on a glass card: a round card has no
// background of its own, only a top border. So the surface is one chip tint
// over the page background, which is a lower-contrast base than the coach and
// story chips and therefore has to be measured separately rather than reusing
// D_CHIP. The number is --text and the noun is --text-secondary; the noun is
// the one that has to work, at 11.5px.
const D_ROUND_CHIP = stack(D.bg, [["#ffffff", 0.05]]);
const L_ROUND_CHIP = stack(Lt.bg, [["#000000", 0.04]]);
check("dark: round figure number on chip", D.text, D_ROUND_CHIP, 4.5);
check("dark: round figure noun on chip", D.sub, D_ROUND_CHIP, 4.5);
check("light: round figure number on chip", Lt.text, L_ROUND_CHIP, 4.5);
check("light: round figure noun on chip", Lt.sub, L_ROUND_CHIP, 4.5);

// ---- the round disclosure bar ----
// Collapsed it is --text-secondary on glass; hovered and expanded it is
// --text, which is lighter in dark and darker in light, so the collapsed
// state is the one that has to clear the bar.
check("dark: disclosure bar label on glass", D.sub, D_CARD, 4.5);
check("dark: disclosure bar label, hovered", D.text, stack(D_CARD, [["#8b5cf6", 0.08]]), 4.5);
check("light: disclosure bar label on glass", Lt.sub, L_CARD, 4.5);
check("light: disclosure bar label, hovered", Lt.text, stack(L_CARD, [["#8b5cf6", 0.08]]), 4.5);

// ---- closing CTA ----
check("dark: CTA heading on panel", D.text, D_CTA, 4.5);
check("dark: CTA text on panel", D.sub, D_CTA, 4.5);
check("light: CTA heading on panel", Lt.text, L_CTA, 4.5);
check("light: CTA text on panel", Lt.sub, L_CTA, 4.5);

// ---- "Details of previous rounds:" ----
// A heading straight on the page, above the filter chips.
check("dark: rounds heading on the page", D.text, D.bg, 4.5);
check("light: rounds heading on the page", Lt.text, Lt.bg, 4.5);

// ---- the demo videos ----
// The section has no card of its own, so its text sits on the page. The
// playlist link is --cyan, which is the token this page already uses for
// links, and it is underlined as well as coloured — so colour is not the only
// thing carrying it — but it still has to clear AA on its own.
check("dark: video heading on the page", D.text, D.bg, 4.5);
check("dark: video intro on the page", D.sub, D.bg, 4.5);
check("dark: video title on the page", D.text, D.bg, 4.5);
check("dark: video description on the page", D.sub, D.bg, 4.5);
check("dark: playlist link on the page", D.cyan, D.bg, 4.5);
check("light: video heading on the page", Lt.text, Lt.bg, 4.5);
check("light: video intro on the page", Lt.sub, Lt.bg, 4.5);
check("light: video title on the page", Lt.text, Lt.bg, 4.5);
check("light: video description on the page", Lt.sub, Lt.bg, 4.5);
check("light: playlist link on the page", Lt.cyan, Lt.bg, 4.5);

// The play cue sits on a YouTube poster frame, and a poster can be ANY colour —
// this page does not choose it and cannot measure it. So the cue carries its
// own opaque-enough disc and is measured against the WORST backing a poster
// could give it: pure white behind the disc in the resting state (which is the
// darkest the disc can be relative to a light poster's surroundings is not the
// question — the question is the icon against the disc, and the disc is what
// changes when the poster behind it is white).
//
// The triangle is a non-text graphic, so 3:1 under WCAG 1.4.11. Both states are
// measured: at rest the disc is near-black at 0.72, and on hover it becomes
// violet at 0.92, which is the lighter of the two and therefore the one that
// has to be checked with a white glyph on it.
const CUE_REST_ON_WHITE = over("#ffffff", "#0a0c14", 0.72);
const CUE_REST_ON_BLACK = over("#000000", "#0a0c14", 0.72);
const CUE_HOVER_ON_WHITE = over("#ffffff", "#8b5cf6", 0.92);
check("play cue: triangle on the resting disc over a white poster", "#ffffff", CUE_REST_ON_WHITE, 3.0);
check("play cue: triangle on the resting disc over a black poster", "#ffffff", CUE_REST_ON_BLACK, 3.0);
check("play cue: triangle on the hovered violet disc", "#ffffff", CUE_HOVER_ON_WHITE, 3.0);

// ---- the showcase rail's two buttons ----
// The chevrons are non-text graphics, so 3:1 under WCAG 1.4.11, measured on the
// glass disc they sit on — which is the same card surface the coach pills use.
// The DISABLED state is not measured and is not required to be: WCAG 1.4.3 and
// 1.4.11 both exempt inactive user-interface components, and the whole point of
// the 0.38 opacity is to look unavailable.
check("dark: rail button chevron at rest (graphic)", D.sub, D_CARD, 3.0);
check("dark: rail button chevron, hovered (graphic)", D.text, D_CARD, 3.0);
check("light: rail button chevron at rest (graphic)", Lt.sub, L_CARD, 3.0);
check("light: rail button chevron, hovered (graphic)", Lt.text, L_CARD, 3.0);

// ---- the player dialog ----
//
// This dialog has NO PANEL. Its title and its close button sit directly on the
// backdrop, so the backdrop is the background those two are measured against —
// which is the whole reason .hk-vmodal re-tints it.
//
// The shared backdrop in LIGHT mode is rgba(16,22,39,0.55). Over this page that
// composites to about #777b87, and white 16px text on it measures 4.21:1 — a
// miss, and 16px bold is not WCAG "large" (that starts at 18.66px bold), so 4.5
// is the bar it has to clear rather than 3. Measured below as the row that must
// FAIL, so the reason for the override is kept true rather than remembered.
const SHARED_BACKDROP_LIGHT = over(Lt.bg, "#101627", 0.55);
{
  const r = ratio("#ffffff", SHARED_BACKDROP_LIGHT);
  rows.push({
    label: "light: player title on the SHARED backdrop — must NOT reach 4.5, which is why it is re-tinted",
    fg: "#ffffff", bg: toHex(SHARED_BACKDROP_LIGHT),
    r: r.toFixed(2), need: "<4.5", pass: r < 4.5,
  });
}

// The player's own backdrop: one value for both themes, because a video is
// watched dark either way.
const PLAYER_BACKDROP_DARK = over(D.bg, "#03060e", 0.88);
const PLAYER_BACKDROP_LIGHT = over(Lt.bg, "#03060e", 0.88);
check("dark: player dialog title on its backdrop", "#ffffff", PLAYER_BACKDROP_DARK, 4.5);
check("light: player dialog title on its backdrop", "#ffffff", PLAYER_BACKDROP_LIGHT, 4.5);
// The close button carries its own disc, so it is measured on the disc and the
// disc on the backdrop behind it — the × is text, the disc's edge is a graphic.
const CLOSE_DISC_DARK = over(PLAYER_BACKDROP_DARK, "#121622", 0.92);
const CLOSE_DISC_LIGHT = over(PLAYER_BACKDROP_LIGHT, "#121622", 0.92);
const CLOSE_HOVER_DARK = over(PLAYER_BACKDROP_DARK, "#8b5cf6", 0.92);
const CLOSE_HOVER_LIGHT = over(PLAYER_BACKDROP_LIGHT, "#8b5cf6", 0.92);
check("dark: player close × on its disc", "#ffffff", CLOSE_DISC_DARK, 4.5);
check("light: player close × on its disc", "#ffffff", CLOSE_DISC_LIGHT, 4.5);
check("dark: player close × on the hovered violet disc", "#ffffff", CLOSE_HOVER_DARK, 4.5);
check("light: player close × on the hovered violet disc", "#ffffff", CLOSE_HOVER_LIGHT, 4.5);
// The close button's rim is what separates it from the backdrop — the only
// boundary a low-vision reader has for finding the way out.
check("dark: player close rim vs backdrop (graphic)",
  over(CLOSE_DISC_DARK, "#ffffff", 0.38), CLOSE_DISC_DARK, 3.0);
check("light: player close rim vs backdrop (graphic)",
  over(CLOSE_DISC_LIGHT, "#ffffff", 0.38), CLOSE_DISC_LIGHT, 3.0);

let bad = 0;   // measured, not eyeballed
for (const r of rows) {
  if (!r.pass) bad++;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${String(r.r).padStart(6)}:1 (need ${r.need})  ${r.label} — ${r.fg} on ${r.bg}`);
}
console.log(`\n${rows.length} measurements, ${bad} failing.`);
process.exit(bad ? 1 : 0);
