// Measure the notification badge's contrast in both themes, from styles.css.
//
// Why this exists: the badge is 11px at weight 700. That is NOT WCAG "large
// text" — large needs 18.66px at bold or 24px at regular — so it must clear
// 4.5:1, not 3:1. Reaching for the theme's --violet looks like the obvious
// choice and quietly fails: white on the dark theme's #8b5cf6 measures 4.23:1.
//
// This project has a standing rule that contrast is measured and not asserted,
// after a sweep reported dark and light as identical because it set the wrong
// class (the real switch is `html.light-mode`, not `data-theme`) and both
// numbers were the dark one. So this reads the values OUT OF styles.css rather
// than being handed them, and fails if the file and this check disagree about
// which colours are in play.
//
// Run: node tools/check-badge-contrast.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "styles.css"), "utf8");

function channel(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// Pull the real values out of the stylesheet. If the selectors are renamed,
// this throws rather than silently measuring nothing — a check that examines
// nothing and prints a pass is worse than no check.
function extract(re, label) {
  const m = re.exec(css);
  if (!m) {
    console.error(`FAIL  could not find ${label} in styles.css — has it been renamed?`);
    process.exit(1);
  }
  return m[1];
}

const darkBg = extract(/\.nav-badge\s*\{[^}]*?--badge-bg:\s*(#[0-9a-fA-F]{6})/, ".nav-badge --badge-bg");
const lightBg = extract(/html\.light-mode\s+\.nav-badge\s*\{[^}]*?--badge-bg:\s*(#[0-9a-fA-F]{6})/, "light-mode --badge-bg");
const fg = extract(/\.nav-badge\s*\{[^}]*?color:\s*(#[0-9a-fA-F]{6})/, ".nav-badge color");
const sizeM = /\.nav-badge\s*\{[^}]*?font-size:\s*(\d+)px/.exec(css);
const weightM = /\.nav-badge\s*\{[^}]*?font-weight:\s*(\d+)/.exec(css);

const size = sizeM ? Number(sizeM[1]) : 0;
const weight = weightM ? Number(weightM[1]) : 400;

// WCAG large text: >=24px, or >=18.66px when bold (>=700).
const isLarge = size >= 24 || (size >= 18.66 && weight >= 700);
const required = isLarge ? 3.0 : 4.5;

console.log(`badge text: ${size}px / weight ${weight} → ${isLarge ? "large" : "normal"} text, needs ${required}:1\n`);

const results = [
  ["dark  ", fg, darkBg],
  ["light ", fg, lightBg],
];

let failed = 0;
for (const [label, text, bg] of results) {
  const ratio = contrast(text, bg);
  const ok = ratio >= required;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label} ${text} on ${bg} = ${ratio.toFixed(2)}:1`
  );
}

// ---- Controls, in BOTH directions ---------------------------------------
//
// ⚠ The negative control alone is not enough, and this is not hypothetical:
// the first version of this file dropped the blue channel out of the
// luminance sum (`0.0722 * (n & 255)` instead of `0.0722 * channel(n & 255)`).
// Every pair then measured near 1:1 — and the negative control still reported
// "correctly detected as failing", because a calculation that fails
// EVERYTHING also fails the thing that ought to fail. It took a known-GOOD
// pair to expose it. A check needs a control at each end or it only proves it
// can say no.
const controls = [
  ["black on white must pass", contrast("#000000", "#ffffff"), (r) => r > 20.9],
  ["white on white must fail", contrast("#ffffff", "#ffffff"), (r) => r < 1.05],
  ["white on the dark theme's --violet #8b5cf6 must fail", contrast("#ffffff", "#8b5cf6"), (r) => r >= 4.0 && r < 4.5],
];

console.log("");
let controlsOk = true;
for (const [label, ratio, predicate] of controls) {
  const ok = predicate(ratio);
  if (!ok) controlsOk = false;
  console.log(`${ok ? "ok  " : "BAD "} control: ${label} — measured ${ratio.toFixed(2)}:1`);
}

if (!controlsOk) {
  console.error("\nCONTROLS FAILED — the contrast maths is wrong; ignore the results above.");
  process.exit(1);
}
process.exit(failed === 0 ? 0 : 1);
