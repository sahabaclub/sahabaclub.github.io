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
function over(base, ov, al) {
  const b = hex(base), o = hex(ov);
  return [0, 1, 2].map((i) => Math.round(b[i] * (1 - al) + o[i] * al));
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

let bad = 0;   // measured, not eyeballed
for (const r of rows) {
  if (!r.pass) bad++;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${String(r.r).padStart(6)}:1 (need ${r.need})  ${r.label} — ${r.fg} on ${r.bg}`);
}
console.log(`\n${rows.length} measurements, ${bad} failing.`);
process.exit(bad ? 1 : 0);
