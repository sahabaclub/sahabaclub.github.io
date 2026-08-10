// check-recording-gate.mjs
// ------------------------------------------------------------
//   node tools/check-recording-gate.mjs
//
// A past event's recording is members-only as a COURTESY: the video is public
// on YouTube and Ahmed has accepted that anyone can find it by title. What this
// guards is the one thing the courtesy actually consists of — that the club's
// own page does not hand a signed-out visitor the URL, and does not load a
// Google player for somebody who has not asked to watch.
//
// Both are one-line regressions. "Just show the link" and "why is this a button
// instead of an iframe" are exactly the simplifications a later reader makes
// when the comment above it is the only thing saying no.
//
// Static: it reads event.html and runs the page's own string builders. No
// database, no key, no session, no browser — so it runs in CI.
//
// ⚠ The URL table is MEASURED, not imagined: it is every recording_url in the
// events table on 10 Aug 2026, read from the live database. If the archive
// grows a shape that is not here, this file is where to add it.
//
// ⚠ Self-tests in both directions at the end, per this project's rule that a
// checker never seen to fail is a checker nobody should trust.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The real functions out of the real page, rather than a copy of them: a copy
// would keep passing long after event.html stopped agreeing with it. Everything
// from the loader down is cut away — it awaits Supabase, and none of these
// checks reach it.
function loadPage(sabotage) {
  const html = readFileSync(join(root, "event.html"), "utf8");
  let mod = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/^\s*import .*$/gm, "")
    .split("// ---- Load")[0];
  if (sabotage) mod = sabotage(mod);
  const build = new Function("document", "window", "navigator",
    mod + "\n return { youtubeId, signInHref, recordingHtml, videoFrameHtml };");
  return build({ getElementById: () => null }, { location: { search: "" } }, {});
}

// Every recording in the archive, measured 10 Aug 2026.
const ARCHIVE = [
  ["https://youtu.be/1hrx5LH7m0s?si=1bKvOW5enJh6RQvY", "1hrx5LH7m0s"],
  ["https://youtu.be/XYbtH5H5NDo?si=9fYk1gcTM4Pt2bcY", "XYbtH5H5NDo"],
  ["https://youtu.be/L12hVXbvUtQ?si=nHTRlPUYZtOw-mE0", "L12hVXbvUtQ"],
  ["https://youtu.be/2Bscm8-PBf8?si=KqYakNU7HI5FBwz0", "2Bscm8-PBf8"],
  ["https://youtu.be/ahwa7TvfOm4?si=VCN93qSgd8Zjs-q9", "ahwa7TvfOm4"],
  ["https://youtu.be/WyZUdxEunj8", "WyZUdxEunj8"],
  ["https://youtu.be/L12hVXbvUtQ", "L12hVXbvUtQ"],
  ["https://www.youtube.com/watch?v=wk_bRmIJ5Wk&t=3s", "wk_bRmIJ5Wk"],
  ["https://www.youtube.com/watch?v=dQliQ0TZWkg", "dQliQ0TZWkg"],
  ["https://youtu.be/64O5Sp05C3Q?si=ungBfZDBYBIlrPWU", "64O5Sp05C3Q"],
  ["https://www.youtube.com/watch?v=66FWNjLcj4w", "66FWNjLcj4w"],
  ["https://youtu.be/HDUVb9o_v8s?si=ozUHxLmCfQA8tbNo", "HDUVb9o_v8s"],
  ["https://youtu.be/HM4HM95N7QU", "HM4HM95N7QU"],
  ["https://youtu.be/e3J3z4u7zl0?si=n5vqeXq6aN1TPi4x", "e3J3z4u7zl0"],
  ["https://youtu.be/FZ6B--Vm7BQ?si=gqRPjy9zkZsDkTRa", "FZ6B--Vm7BQ"],
  ["https://youtu.be/ntx9qAbYiYI?si=7S59xTxnRvoWHY2C", "ntx9qAbYiYI"],
];

// Shapes nobody has pasted yet but somebody will.
const FUTURE = [
  ["https://www.youtube.com/embed/dQliQ0TZWkg", "dQliQ0TZWkg"],
  ["https://www.youtube.com/live/dQliQ0TZWkg?feature=share", "dQliQ0TZWkg"],
  ["https://www.youtube.com/shorts/dQliQ0TZWkg", "dQliQ0TZWkg"],
  ["https://m.youtube.com/watch?v=dQliQ0TZWkg", "dQliQ0TZWkg"],
  ["https://youtube.com/watch?app=desktop&v=dQliQ0TZWkg", "dQliQ0TZWkg"],
  ["http://youtu.be/dQliQ0TZWkg", "dQliQ0TZWkg"],
];

// ⚠ These must NOT parse. The column only checks `^https?://`, so a Vimeo or
// Teams link is a legal value; the page falls back to a plain gated link for
// them. A parser that guessed an id here would build a player around a URL it
// did not understand. The last two are the ones that matter: a host that merely
// CONTAINS youtu.be is not youtu.be.
const NOT_YOUTUBE = [
  "https://vimeo.com/76979871",
  "https://sahabaclub-my.sharepoint.com/x/recording.mp4",
  "https://www.youtube.com/",
  "https://www.youtube.com/@sahabaclub",
  "https://www.youtube.com/watch?list=PL123",
  "https://notyoutu.be/dQliQ0TZWkg",
  "https://youtu.be.evil.example/dQliQ0TZWkg",
  "",
  null,
];

const EVENT = {
  slug: "ai-on-cloud-2023",
  title: 'AI on "Cloud" & <friends>',
  recording_url: "https://www.youtube.com/watch?v=wk_bRmIJ5Wk&t=3s",
};

// The checks themselves, as data, so the self-test can run the same list
// against a deliberately broken page and confirm they notice.
function run(api, report) {
  ARCHIVE.concat(FUTURE).forEach(([url, id]) => {
    report("youtubeId " + url, api.youtubeId(url) === id, "got " + JSON.stringify(api.youtubeId(url)));
  });
  NOT_YOUTUBE.forEach((url) => {
    report("not a YouTube link: " + JSON.stringify(url), api.youtubeId(url) === "",
      "got " + JSON.stringify(api.youtubeId(url)) + " — the page would build a player around it");
  });

  const guest = api.recordingHtml(EVENT, "wk_bRmIJ5Wk", "guest");
  report("a guest is offered sign-in, with the way back",
    guest.includes('href="login.html?next=event.html%3Fe%3Dai-on-cloud-2023"'));
  report("THE GATE: a guest is never handed the video's URL",
    !/youtu\.?be/.test(guest.replace(/i\.ytimg\.com\/vi\/[A-Za-z0-9_-]+\/hqdefault\.jpg/g, "")),
    "a youtube link reached the signed-out page");
  report("the control says what it does",
    guest.includes('aria-label="Sign in to watch the recording"'));
  report("nothing on the page claims the video is locked",
    !/lock|members only|restricted/i.test(guest));

  const member = api.recordingHtml(EVENT, "wk_bRmIJ5Wk", "");
  report("a member gets a real button",
    member.includes('<button type="button" class="hk-video-play" data-evp-play="wk_bRmIJ5Wk"'));
  report("the title is escaped into the button's name",
    member.includes("Play the recording: AI on &quot;Cloud&quot; &amp; &lt;friends&gt;"));
  report("a member has a way out if the uploader refuses embedding",
    member.includes('rel="noopener">Open it on YouTube</a>'));

  report("THE FAÇADE: no player exists before somebody presses play",
    !guest.includes("<iframe") && !member.includes("<iframe"),
    "an iframe is in the markup, so Google loads for a reader who never asked");
  report("the frame, when it is built, is the no-cookie one",
    api.videoFrameHtml("wk_bRmIJ5Wk", "x").includes("https://www.youtube-nocookie.com/embed/wk_bRmIJ5Wk?autoplay=1&amp;rel=0"));

  report("Register and the recording share ONE sign-in round trip",
    api.signInHref(EVENT) === "login.html?next=" + encodeURIComponent("event.html?e=" + EVENT.slug));
}

let failed = 0;
console.log("\nevent.html — the members-only recording\n");
run(loadPage(null), (label, ok, detail) => {
  if (ok) { console.log("  ok    " + label); return; }
  failed++;
  console.log("  FAIL  " + label + (detail ? "\n        " + detail : ""));
});

// ---- Self-test -----------------------------------------------------------
//
// Two sabotages, each the regression this file exists to catch, and each one
// must be NOTICED. Without this, a check that silently stopped inspecting
// anything would report a clean run for ever.
console.log("\nself-test — the checks must fail when the page is broken\n");

function mustCatch(name, sabotage, expectHit) {
  let hits = [];
  try {
    run(loadPage(sabotage), (label, ok) => { if (!ok) hits.push(label); });
  } catch (e) {
    hits.push("threw: " + e.message);
  }
  const caught = hits.some((h) => h.includes(expectHit));
  if (caught) console.log("  ok    " + name + " → caught by \"" + expectHit + "\"");
  else { failed++; console.log("  FAIL  " + name + " went UNNOTICED — this checker cannot be trusted"); }
}

// The pre-10-Aug behaviour: the guest's control points straight at YouTube.
// ⚠ The call site, not the declaration — `signInHref(e)` matches the text of
// `function signInHref(e) {` first, and renaming THAT only produces a syntax
// error. The first run of this self-test did exactly that and reported the
// sabotage as unnoticed, which is the check working: a broken page must fail a
// named check, not merely fail to load.
mustCatch("guest handed the video URL",
  (m) => m.replace('href="\' + signInHref(e)', 'href="\' + e.recording_url'), "THE GATE");

// "Why not just embed it" — the façade removed, so Google loads on page view.
mustCatch("player embedded before any press",
  (m) => m.replace("'<span class=\"hk-video-media\">' + control",
                   "'<span class=\"hk-video-media\">' + videoFrameHtml(id, e.title) + control"), "THE FAÇADE");

console.log("\n" + (failed ? failed + " FAILED" : "all checks passed") + "\n");
process.exit(failed ? 1 : 0);
