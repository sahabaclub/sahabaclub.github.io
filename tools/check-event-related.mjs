// Test lib/event-related.js.
//
// This exists because it CAN. Almost nothing else on the event page can be
// verified without a browser, but the "what else is like this" scorer is a
// pure function — no DOM, no Supabase, no clock of its own — so its behaviour
// is checkable here, offline, in a second.
//
// ⚠ Controls at both ends, as everything in this repo now does: a check that
// can only say yes has not been tested. See tools/check-badge-contrast.mjs for
// the run where a broken calculation passed its own negative control.
//
// Run: node tools/check-event-related.mjs

import { relatedEvents } from "../lib/event-related.js";

const TODAY = "2026-08-06";

const ev = (id, over) => Object.assign({
  id, title: id, eventDate: "2026-09-01", mode: "In-Person", country: "UAE",
  tags: [], organizerIds: [], presenter: null, isPublished: true,
}, over || {});

const subject = ev("subject", {
  tags: ["AI", "Cloud"], organizerIds: ["org-sahaba"], country: "UAE",
  mode: "In-Person", presenter: "Ahmed Abdel Razek",
});

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const ids = (list) => list.map((e) => e.id);

// ---- The subject is never its own recommendation ------------------------
check("excludes itself",
  ids(relatedEvents(subject, [subject], TODAY, 3)), []);

// ---- A shared organizer outranks a shared tag ---------------------------
// The rule the file argues for: two events tagged "AI" have almost nothing in
// common; two run by the same people do.
const sameOrg = ev("same-org", { organizerIds: ["org-sahaba"], tags: [] });
const sameTag = ev("same-tag", { organizerIds: ["org-other"], tags: ["AI"] });
check("organizer beats tag",
  ids(relatedEvents(subject, [sameOrg, sameTag], TODAY, 2)), ["same-org", "same-tag"]);

// ---- Weak matches are dropped rather than padded ------------------------
// Same mode only (+1) plus upcoming (+4) = 5... which passes MIN_SCORE. Use a
// PAST event with only a mode match: +1, under the floor.
const barelyRelated = ev("barely", {
  organizerIds: [], tags: [], country: "Egypt", mode: "In-Person", eventDate: "2024-01-01",
});
check("drops a match below the floor",
  ids(relatedEvents(subject, [barelyRelated], TODAY, 3)), []);

// ---- Upcoming is preferred, past is still allowed -----------------------
const pastStrong = ev("past-strong", {
  organizerIds: ["org-sahaba"], tags: ["AI", "Cloud"], eventDate: "2024-01-01",
});
const futureWeak = ev("future-weak", {
  organizerIds: [], tags: ["Cloud"], eventDate: "2026-12-01", country: "Egypt", mode: "Online",
});
const both = relatedEvents(subject, [pastStrong, futureWeak], TODAY, 2);
check("a strongly-related PAST event still appears", both.length, 2);
check("the stronger match leads even though it is past", both[0].id, "past-strong");

// ---- Drafts never leak into a public list -------------------------------
const draft = ev("draft", { organizerIds: ["org-sahaba"], tags: ["AI"], isPublished: false });
check("never surfaces an unpublished event",
  ids(relatedEvents(subject, [draft], TODAY, 3)), []);

// ---- Same presenter counts ----------------------------------------------
const samePresenter = ev("same-presenter", {
  organizerIds: [], tags: [], country: "Egypt", mode: "Online",
  presenter: "Ahmed Abdel Razek", eventDate: "2024-02-02",
});
check("a shared presenter is enough on its own",
  ids(relatedEvents(subject, [samePresenter], TODAY, 3)), ["same-presenter"]);

// ---- Limit is respected --------------------------------------------------
const many = Array.from({ length: 10 }, (_, i) =>
  ev("m" + i, { organizerIds: ["org-sahaba"], tags: ["AI"] }));
check("respects the limit", relatedEvents(subject, many, TODAY, 3).length, 3);

// ---- Bad input does not throw -------------------------------------------
check("null subject returns empty", relatedEvents(null, many, TODAY, 3), []);
check("non-array events returns empty", relatedEvents(subject, null, TODAY, 3), []);
check("event with no tags/organizers is handled",
  Array.isArray(relatedEvents(ev("bare"), many, TODAY, 3)), true);

console.log(failures === 0 ? "\nall event-related checks pass" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
