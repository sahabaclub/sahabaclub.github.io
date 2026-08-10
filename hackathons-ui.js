// ============================================================
// Sahaba Club — Hackathons page UI
// ------------------------------------------------------------
// Renders the EduHackAI programme: every round, its teams, and the
// people who built them. Loaded only by hackathons.html.
//
// Data comes from three public objects created in migration 0020:
//   hackathons        — the rounds
//   hackathon_teams   — the teams, with placings where they were recorded
//   hackathon_roster  — a VIEW, names without contact details
//
// It reads `hackathon_roster` and never `hackathon_participants`. That is
// not a style preference: the participants table holds personal email
// addresses and tenant mailboxes for real people, `anon` and
// `authenticated` hold no SELECT on it, and the view's column list IS the
// privacy boundary. Querying the table here would fail, and if it ever
// stopped failing that would be the bug. Contact details are never
// published, and a name becomes a link only once that person has joined
// and chosen to be discoverable — see personHtml().
//
// Nothing about any particular round is written into this file or into
// hackathons.html. Which round is "coming soon", who placed where, who
// coached, where it ran — all of it comes back from the database, and the
// page shapes itself around what is actually there:
//
//   * a round with neither a start nor an end date renders as coming soon,
//     at the top, with the register-interest dialog attached to it;
//   * a round with recorded placings gets gold / silver / bronze medal
//     cards, and one without simply shows its teams with no medals rather
//     than inventing any;
//   * anything the source never recorded — a description, an end date, a
//     project title — is left out or named as missing, never guessed.
// ============================================================

(function () {
  "use strict";

  // ============================================================
  // CONFIG — the things on this page that the database cannot answer
  // ------------------------------------------------------------
  // Everything else rendered here is computed from the rows that come back.
  // These four objects are the exceptions, and they are at the top of the file
  // rather than buried next to the code that reads them precisely so that
  // "what on this page is not derived from data" is one place a person can
  // look at, in full, without reading any logic.
  // ============================================================

  // ---- 1. "No of Apps", per round ----
  //
  // There is no column anywhere in `hackathons`, `hackathon_teams` or
  // `hackathon_roster` that counts the applications a round shipped, and it is
  // NOT the team count: round 1 had 8 teams and 6 apps. So it cannot be
  // derived, and this is the only honest way to show it.
  //
  // null means "not known yet", and a null round renders NO Apps chip at all —
  // not 0, not "—", not "TBC". A zero here would be a claim that a round
  // shipped nothing, which is false for every round that has run.
  //
  // All four figures are now Ahmed's own. A round that is not in this object —
  // a round 6 nobody has been asked about — is still null and still renders no
  // chip; the mechanism has not changed, only the answers have arrived.
  var APPS_BY_ROUND = { 1: 6, 2: 12, 3: 6, 4: 6 };

  // ---- 2. Where the EduHackers came from, per round ----
  //
  // ⚠ EMPTY ON PURPOSE. THIS IS NOT AN OVERSIGHT AND MUST NOT BE FILLED IN BY
  // ⚠ ANYONE WHO IS NOT READING IT OFF A RECORD.
  //
  // Ahmed asked for a row of country tags — "Egypt · UAE · India · KSA" — in
  // place of the Demo Day venue tags. THAT DATA DOES NOT EXIST. The only table
  // that holds a person is `hackathon_participants`, whose columns are email,
  // full_name and university_or_company; there is no country, no nationality
  // and no address, and `hackathon_roster` — the view this page is allowed to
  // read — exposes none of the three anyway.
  //
  // So the row is built from THIS object and nothing else, and it renders
  // nothing at all while this object is empty. It is deliberately NOT inferred:
  //
  //   * a name does not carry a nationality. Guessing one from "Mahmoud" or
  //     "Gangothri" would be both wrong and offensive, and it would be
  //     published, under the club's name, about real people.
  //   * `university_or_company` does not either — people study and work abroad,
  //     and the roster view does not expose that column to this page in any case.
  //   * the Demo Day venue is where the presentation was held, not where the
  //     people who presented are from.
  //
  // ⚠ PROGRAMME-WIDE, NOT PER ROUND — and that is the shape of the source, not
  // a simplification. Ahmed supplied one flat list of 95 participants' countries
  // with no round column, so there is no honest way to say which round any of
  // these belongs to. Splitting them across rounds would mean inventing exactly
  // the fact the file does not contain, and repeating all thirteen against every
  // round would claim each round drew from all thirteen, which nobody knows.
  //
  // It renders in the history section, which is itself programme-wide, so a flat
  // list is what that section can honestly say: these are the countries
  // EduHackAI has drawn from, across four rounds.
  //
  // Ordered by how many people came from each, commonest first — 55 Egypt, 16
  // India, 8 Bangladesh, 5 Pakistan, then a tail of one or two. The counts are
  // deliberately NOT printed: the file covers 95 people and the rounds recorded
  // 139, so a per-country number would be a share of an incomplete sample
  // presented as a total. The list of countries is what Ahmed vouched for.
  var EDUHACKER_COUNTRIES = [
    "Egypt", "India", "Bangladesh", "Pakistan", "Jordan", "Palestine",
    "Albania", "Argentina", "Ethiopia", "Qatar", "Saudi Arabia",
    "Sudan", "United Arab Emirates",
  ];

  // ---- 3. The teams' demo videos ----
  //
  // Ahmed's YouTube playlist, "EduHackAI — Participant App Demos". Nothing in
  // the database records a video against a team, so the list is here — ids and
  // titles exactly as the playlist carries them, in playlist order.
  //
  // `blurb` is written FROM THE TITLE and from nothing else. No team name,
  // placing, technology or date appears in a blurb unless the title above it
  // says so, because the only thing this file knows about these videos is what
  // is written on them. Twenty words is the cap.
  //
  // These are NOT nine embedded players. Each one renders as a poster image and
  // a play button, and the iframe is created only when somebody presses it —
  // see videoHtml() and the click handler at the bottom of this file.
  var PLAYLIST_URL =
    "https://www.youtube.com/playlist?list=PLHKe9OmckbU1C43jfevO26JLkmFcOW4JX";
  var DEMO_VIDEOS = [
    {
      id: "psV1lJXPA_o",
      title: "EduHackAI-3 Winner Solution (Meya Sports) Demo Video",
      blurb: "The winning solution from EduHackAI-3, Meya Sports, walked through in its own demo video."
    },
    {
      id: "qTiGdyTIeZU",
      title: "AI App That Detects Cheating During Online Exams 😱 | Built in 10 Days!",
      blurb: "An AI app that detects cheating during online exams, built in ten days."
    },
    {
      id: "Unm3CjFqmrY",
      title: "Built in 10 Days: AI App That Simplifies Smartphone Choices 💡",
      blurb: "An AI app that simplifies choosing a smartphone, built in ten days."
    },
    {
      id: "Osr5mmMdHaw",
      title: "A 19-Year-Old Built AI Glasses in Just 10 Days! 🤖👓",
      blurb: "AI glasses built in just ten days by a nineteen-year-old."
    },
    {
      id: "U4Cq-w3LIUk",
      title: "SkillSync AI – The 10-Day Hackathon App That Matches Skills to Projects 💡",
      blurb: "SkillSync AI, a ten-day hackathon app that matches skills to projects."
    },
    {
      id: "jX90VIemkiM",
      title: "Our 10-Day Hackathon Project That Solves a Problem Using Microsoft Power Platform (Low-Code AI App)",
      blurb: "A ten-day hackathon project solving a problem with a low-code AI app on Microsoft Power Platform."
    },
    {
      id: "HDUVb9o_v8s",
      title: "EduHackAI-2 (Suzy)",
      blurb: "Suzy — a participant app demo from EduHackAI-2."
    },
    {
      id: "cfznj3X_ais",
      title: "EduHackAI-2 Winner Solution (Clever Mart)",
      blurb: "The winning solution from EduHackAI-2, Clever Mart."
    },
    {
      id: "zmPVq2zzJrQ",
      title: "EduHackAI-1 Winner Solution (EduPulse AI)",
      blurb: "The winning solution from EduHackAI-1, EduPulse AI."
    }
  ];

  // ---- 4. Coach display names and LinkedIn profiles ----
  //
  // Keyed by the coach photo slug — i.e. by coachPhotoSlug(full_name) — so one
  // entry supplies both the LinkedIn URL and, where present, a display name.
  //
  // ⚠ WHY A NAME OVERRIDE EXISTS HERE AT ALL. It is not that this page prefers
  // ⚠ its own spelling of anybody's name — it does not, and every other name on
  // ⚠ this page is printed exactly as the database spells it. It is that the
  // ⚠ DATA HAS NOT CAUGHT UP. Ahmed asked for "Mahmoud" to be listed as
  // ⚠ "Mahmoud ATALLAH"; that is a migration against
  // ⚠ hackathon_participants.full_name, and it has not been applied yet. Until
  // ⚠ it is, `hackathon_roster` still returns the bare "Mahmoud" that migration
  // ⚠ 0036 §3d created from a first name.
  // ⚠
  // ⚠ So his entry is registered under BOTH slugs — `mahmoud` (what the
  // ⚠ database says today) and `mahmoud-atallah` (what it will say once the
  // ⚠ rename lands) — and they are the SAME object, not two copies. The page is
  // ⚠ therefore correct on both sides of that migration, and his photo resolves
  // ⚠ either way: the photo slug is taken from the DISPLAY name, which is
  // ⚠ "Mahmoud ATALLAH" -> mahmoud-atallah.jpg no matter which spelling the
  // ⚠ roster hands over.
  // ⚠
  // ⚠ When the rename is applied, the `mahmoud` key becomes dead and can be
  // ⚠ deleted. Nothing else in this object should ever grow a `name`.
  //
  // A coach with no entry here is not a bug and not a dead link: they render as
  // a plain, non-interactive card with their stored name. See coachCardHtml().
  //
  // These URLs are public professional profiles that the people concerned
  // publish themselves, and Ahmed asked for them to be linked. No email
  // address, mailbox or phone number belongs in this file — this repository is
  // public.
  var MAHMOUD_ATALLAH = {
    name: "Mahmoud ATALLAH",
    linkedin: "https://www.linkedin.com/in/mahmoudatallah/"
  };
  var COACH_PROFILES = {
    "zoka":                 { linkedin: "https://www.linkedin.com/in/izoka/" },
    "mahmoud":              MAHMOUD_ATALLAH,   // what the database says today
    "mahmoud-atallah":      MAHMOUD_ATALLAH,   // what it will say after the rename
    "ahmed-badawy":         { linkedin: "https://www.linkedin.com/in/ahmedfbadawy/" },
    "emad-adel":            { linkedin: "https://www.linkedin.com/in/emadadel/" },
    "gangothri-rajaram":    { linkedin: "https://www.linkedin.com/in/gangothrirajaram/" },
    "esraa-ahmed":          { linkedin: "https://www.linkedin.com/in/esraa-ahmed-2b5321220/" },
    "ansari":               { linkedin: "https://www.linkedin.com/in/dataileader/" },
    "mohamed-mohi-el-dien": { linkedin: "https://www.linkedin.com/in/mohi12/" }
  };

  // ------------------------------------------------------------
  // Module bindings. Every const/var this file uses at load is declared
  // here, above anything that runs — see tools/check-dead-zone.mjs for the
  // afternoon that rule cost.
  // ------------------------------------------------------------

  var mount = document.getElementById("hack-rounds");
  if (!mount) return;

  var soonEl = document.getElementById("hack-soon");
  var statusEl = document.getElementById("hack-status");
  var statsEl = document.getElementById("hack-stats");
  var jumpEl = document.getElementById("hack-jump");
  var searchInput = document.getElementById("hack-q");
  var clearBtn = document.getElementById("hack-clear-q");
  var countEl = document.getElementById("hack-count");
  // The story's heading and the story's card are two mounts, not one, because
  // Ahmed asked for the heading to sit ABOVE the four stat tiles while the
  // prose stays below them. They are still one section to a screen reader: the
  // card carries aria-labelledby pointing at the heading's id, which resolves
  // across the document rather than only inside an ancestor.
  var storyHeadEl = document.getElementById("hack-story-head");
  var storyEl = document.getElementById("hack-story");
  var videosEl = document.getElementById("hack-videos");
  var coachesEl = document.getElementById("hack-coaches");
  var ctaEl = document.getElementById("hack-cta");

  // Register-interest dialog (static markup in hackathons.html).
  var modal = document.getElementById("hk-interest");
  var modalBox = modal ? modal.querySelector(".hk-modal-box") : null;
  var modalTitle = document.getElementById("hk-interest-title");
  var modalIntro = document.getElementById("hk-interest-intro");
  var interestForm = document.getElementById("hk-interest-form");
  var interestSubmit = document.getElementById("hk-interest-submit");
  var interestDone = document.getElementById("hk-interest-done");
  var doneText = document.getElementById("hk-done-text");
  var formError = document.getElementById("hk-form-error");

  // The showcase player dialog (static markup in hackathons.html, same as the
  // interest dialog). Separate MARKUP — a player and a four-field form have
  // nothing structural in common, and there is still exactly one <form> on this
  // page — but the two share every behaviour, through makeModal() below.
  var videoModal = document.getElementById("hk-video-modal");
  var videoModalBox = videoModal ? videoModal.querySelector(".hk-vmodal-box") : null;
  var videoModalTitle = document.getElementById("hk-video-modal-title");
  var videoModalMedia = document.getElementById("hk-video-modal-media");
  var videoModalClose = document.getElementById("hk-video-modal-close");

  var ROUNDS = [];          // every round, newest first
  var PAST = [];            // rounds with at least one date
  var SOON = [];            // rounds with no dates at all
  var TEAMS_BY_ROUND = {};
  var ROSTER_BY_ROUND = {};
  var query = "";
  // At most one round is open at a time — the accordion the owner asked for.
  // A single slug, not a map: the map made "more than one open" representable,
  // and a state you cannot represent is a state you cannot ship by accident.
  var openSlug = null;

  var interestRound = null; // the round the dialog is currently about
  // The element that opened a dialog is no longer tracked here. It lives on the
  // controller makeModal() returns, one per dialog, because a single
  // module-level `lastFocus` shared by two dialogs is a bug waiting for the day
  // somebody opens the second one.
  var STATE = { name: "idle", already: false, message: "", fields: {} };

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var ORDINAL = { 1: "1st", 2: "2nd", 3: "3rd" };
  var TIER_BY_RANK = { 1: "gold", 2: "silver", 3: "bronze" };
  var TIER_ORDER = ["gold", "silver", "bronze"];
  var FIELDS = ["full_name", "email", "mobile", "current_job"];
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  var medalIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="15" r="6"/><path d="M8.2 9.5 5.5 3h5l2 4M15.8 9.5 18.5 3h-5"/></svg>';
  var peopleIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19"/><circle cx="10" cy="7.5" r="3.5"/><path d="M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.2a3.5 3.5 0 0 1 0 6.6"/></svg>';
  var pinIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.4"/></svg>';
  // The starburst that used to sit on both the "Coming soon" eyebrow and the
  // early-bird pill is gone. At 12px, two of them stacked read as a spinner,
  // and the top of the page looked stuck loading. Neither is replaced with a
  // different glyph: the fix for too much ornament is less of it.
  var chevron = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  // LinkedIn's "in" mark, filled rather than stroked so it stays legible at the
  // 13px it renders at. aria-hidden: the link's accessible name already says
  // whose profile it is and where it goes, so the glyph is decoration.
  var linkedinIcon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9h4v12H3zM9 9h3.8v1.7h.05c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.78 2.65 4.78 6.1V21h-4v-5.4c0-1.29-.02-2.95-1.8-2.95-1.8 0-2.07 1.4-2.07 2.85V21H9z"/></svg>';
  // The play triangle drawn over a demo video's poster. Decoration: the button
  // it sits in already says "Play the demo video: <title>".
  var playIcon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8.5 5.6v12.8a1 1 0 0 0 1.53.85l10.1-6.4a1 1 0 0 0 0-1.7L10.03 4.75a1 1 0 0 0-1.53.85z"/></svg>';
  // The showcase scroller's two buttons. Decoration again — each button carries
  // its own aria-label, so a screen reader hears "Previous demo videos" and
  // never "left chevron".
  var chevronLeft = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m15 5-7 7 7 7"/></svg>';
  var chevronRight = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 5 7 7-7 7"/></svg>';

  // ------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------

  // Every section title on this page is set in the EduHackAI mark's colours,
  // and every one of them does it the same way: the WORDS go in a
  // <span class="hk-mark-text">, and styles.css paints that one class.
  //
  // Why a span rather than the heading itself. background-clip: text clips a
  // gradient to the glyphs of the box it is set on — including the glyphs of
  // any child. Anything inside the heading that must NOT be painted (the
  // showcase medal, which renders as a flat magenta silhouette when it is
  // clipped — see markHeadingHtml's caller) simply stays outside this span.
  // A heading-level rule would have had no way to opt anything out.
  //
  // Six headings use this. Six copies of the ramp, the solid fallback, the
  // @supports gate and the forced-colors reset would have been six chances for
  // one of them to drift; this is the one place any of it is written.
  function markText(text) {
    return '<span class="hk-mark-text">' + escapeHtml(text) + "</span>";
  }

  // "EduHackAI-5" must not break across lines at its hyphen. A hyphen is a
  // line-break opportunity in CSS, so a narrow column is free to leave
  // "EduHackAI-" on one line and "5" on the next; this keeps the token whole.
  // It sits INSIDE .hk-mark-text so the gradient still runs through it.
  function noWrap(text) {
    return '<span class="hk-nowrap">' + escapeHtml(text) + "</span>";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Slugs come from the database, and they end up in id= and in
  // aria-controls. Anything that is not id-safe is dropped rather than
  // escaped, so a surprising slug can never produce a broken reference.
  function safeId(s) {
    return String(s == null ? "" : s).replace(/[^A-Za-z0-9_-]/g, "");
  }

  function parseDay(iso) {
    if (!iso) return null;
    var p = String(iso).slice(0, 10).split("-");
    if (p.length !== 3) return null;
    return { y: +p[0], m: +p[1], d: +p[2] };
  }

  // "24 May – 28 Jun 2025", collapsing the year when both dates share one.
  // A round with a start and no end reads "From 6 Dec 2025" rather than
  // inventing a dash to nowhere.
  function formatRange(startIso, endIso) {
    var a = parseDay(startIso);
    var b = parseDay(endIso);
    if (!a && !b) return "";
    if (!a) return "Until " + b.d + " " + MONTHS[b.m - 1] + " " + b.y;
    if (!b) return "From " + a.d + " " + MONTHS[a.m - 1] + " " + a.y;
    var left = a.d + " " + MONTHS[a.m - 1] + (a.y === b.y ? "" : " " + a.y);
    return left + " – " + b.d + " " + MONTHS[b.m - 1] + " " + b.y;
  }

  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function placeLabel(rank) {
    return ORDINAL[rank] || (rank + "th");
  }

  // `role_in_team` is the participant's own multi-choice answer at
  // registration, stored verbatim in its comma-joined form. Splitting it
  // for display is presentation; it is never re-interpreted. In
  // particular "AI Coach" appearing here does NOT make someone a coach —
  // is_mentor is the only thing that does.
  function roleChips(role) {
    if (!role) return "";
    var chips = String(role).split(",").map(function (r) { return r.trim(); }).filter(Boolean);
    if (!chips.length) return "";
    return '<span class="hk-roles">' + chips.map(function (r) {
      return '<span class="hk-role">' + escapeHtml(r) + "</span>";
    }).join("") + "</span>";
  }

  // "a, b and c" — used for venue and round lists in the history prose, so a
  // sentence reads the same whether the database returns one of something or
  // four of it.
  function listSentence(items) {
    var a = (items || []).slice();
    if (!a.length) return "";
    if (a.length === 1) return a[0];
    return a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
  }

  function plural(n, one, many) {
    return n === 1 ? one : many;
  }

  // ------------------------------------------------------------
  // Logo slots
  // ------------------------------------------------------------
  //
  // Two files per mark, one per theme, swapped on html.light-mode — the same
  // mechanism .logo-img-dark / .logo-img-light already uses in styles.css for
  // the club wordmark. There is no second mechanism on this page.
  //
  // Both images start hidden in CSS and are revealed by wireLogos() only after
  // the browser has actually decoded them. That ordering is the whole design:
  //
  //   * a file that is not there never paints a broken-image icon, because the
  //     image is never displayed in the first place;
  //   * what renders instead is the text inside .hk-logo-text — the heading
  //     the page had before any of this existed, so the fallback is a design
  //     rather than a hole;
  //   * .hk-logo reserves the slot's height in CSS whether it ends up holding
  //     an image or the text, so the swap costs no reflow either way.
  //
  // This is not hypothetical. assets/eduhack/round-2-light.png does not exist,
  // so round 2 in light mode renders its text heading on the live site while
  // rounds 1, 3, 4 and 5 render their logo. The dark file is deliberately NOT
  // used as a stand-in: its lettering is white and would be invisible on a
  // light page, which reads as a broken image rather than as a wrong colour.
  //
  // `alt` is the mark's own words, so the accessible name is identical whether
  // the image or the text is what the reader ends up with.
  function logoHtml(base, alt, textHtml, boxClass, w, h) {
    var src = "assets/eduhack/" + escapeHtml(base);
    var a = escapeHtml(alt);
    var dims = ' width="' + w + '" height="' + h + '"';
    return '<span class="hk-logo ' + boxClass + '">' +
      '<img class="hk-logo-img hk-logo-dark" data-hk-logo="dark" src="' + src + '-dark.png"' +
        ' alt="' + a + '"' + dims + '>' +
      '<img class="hk-logo-img hk-logo-light" data-hk-logo="light" src="' + src + '-light.png"' +
        ' alt="' + a + '"' + dims + '>' +
      textHtml +
    "</span>";
  }

  // Reveal each logo image once it has decoded, and never otherwise. There is
  // deliberately no error handler: "did not load" is already the fallback, and
  // handling the error would only be a way to re-introduce a state where
  // something has to be un-drawn.
  function wireLogos(root) {
    var scope = root || document;
    if (!scope.querySelectorAll) return;
    var imgs = scope.querySelectorAll("img[data-hk-logo]");
    Array.prototype.forEach.call(imgs, function (img) {
      var box = img.parentNode;
      var flag = img.getAttribute("data-hk-logo") === "light" ? "is-light-ready" : "is-dark-ready";
      function ready() {
        // complete + naturalWidth 0 is a 404, not a decode.
        if (!img.naturalWidth) return;
        img.classList.add("is-ready");
        if (box && box.classList) box.classList.add(flag);
      }
      if (img.complete) ready();
      else img.addEventListener("load", ready);
    });
  }

  // ------------------------------------------------------------
  // Pure logic — no DOM, unit-testable
  // ------------------------------------------------------------

  // A round with neither a start nor an end date has not been scheduled
  // yet, so it renders as coming soon. A cancelled round is excluded: it
  // has no dates either, and inviting people to register for it would be
  // the one wrong answer.
  function isComingSoon(round) {
    if (!round) return false;
    if (round.status === "cancelled") return false;
    return !round.starts_on && !round.ends_on;
  }

  // Which medal card a team gets, or null for none.
  //
  // rank is the recorded placing. A team flagged is_winner with no rank
  // won something the source never numbered — it gets the gold card,
  // because the database says it won, but it is labelled "Winner" rather
  // than "1st place", because nothing recorded a position. A rank outside
  // 1–3 is a real placing off the podium: no medal card, and the small
  // place pill on the team card still shows it.
  function medalTier(team) {
    if (!team) return null;
    if (team.rank) return TIER_BY_RANK[team.rank] || null;
    return team.is_winner ? "gold" : null;
  }

  function medalLabel(team) {
    if (team && team.rank && TIER_BY_RANK[team.rank]) return placeLabel(team.rank) + " place";
    return "Winner";
  }

  // The (at most three) teams that earned a medal card, in podium order.
  function podiumTeams(teams) {
    var out = (teams || []).filter(function (t) { return medalTier(t); });
    out.sort(function (a, b) {
      var ra = a.rank || 0, rb = b.rank || 0;
      if (ra && rb) return ra - rb;
      if (ra) return -1;                       // a numbered placing leads
      if (rb) return 1;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
    return out.slice(0, 3);
  }

  // The programme-wide tiles. `eduhackers` counts roster rows WITHOUT
  // is_mentor, for the same reason the per-round chips do: the tile is labelled
  // "EduHackers", and a tile labelled EduHackers that quietly included the
  // coaches would be a wrong number under a right word. It is a sum of
  // per-round rows, not distinct people — somebody who came back for two rounds
  // is two EduHacker seats, which is what "how big were these rounds" means.
  function summarise(rounds, teamsBy, rosterBy) {
    var teams = 0, eduhackers = 0, coaches = 0, medals = 0;
    (rounds || []).forEach(function (r) {
      var t = (teamsBy && teamsBy[r.id]) || [];
      teams += t.length;
      ((rosterBy && rosterBy[r.id]) || []).forEach(function (p) {
        if (p && p.is_mentor) coaches++;
        else eduhackers++;
      });
      medals += t.filter(function (x) { return medalTier(x); }).length;
    });
    return {
      rounds: (rounds || []).length,
      teams: teams,
      eduhackers: eduhackers,
      coaches: coaches,
      medals: medals
    };
  }

  // ------------------------------------------------------------
  // Per-round key figures
  // ------------------------------------------------------------

  // Coaches, teams and EduHackers are COMPUTED, every time, from the rows this
  // page already loaded — never typed in. is_mentor is the whole rule: a
  // participant carrying it is a coach and everybody else in the round is an
  // EduHacker, which is the same split splitRoster() renders the round with, so
  // the chip and the list underneath it can never disagree.
  //
  // `apps` is the one figure that has no column to come from. It is looked up
  // in APPS_BY_ROUND at the top of this file and is null for any round whose
  // count nobody has given us — see figureChipsHtml(), which omits the chip
  // entirely rather than printing a zero.
  function roundFigures(round, teams, roster) {
    var coaches = 0, eduhackers = 0;
    (roster || []).forEach(function (p) {
      if (p && p.is_mentor) coaches++;
      else eduhackers++;
    });
    return {
      coaches: coaches,
      teams: (teams || []).length,
      eduhackers: eduhackers,
      apps: appsForRound(round && round.round_number)
    };
  }

  // null for anything not answered yet, and for any round number that is not in
  // the config at all — a round 6 nobody has been asked about is exactly as
  // unknown as a round 2 nobody has answered.
  function appsForRound(roundNumber) {
    if (roundNumber === null || roundNumber === undefined || roundNumber === "") return null;
    var key = String(roundNumber);
    if (!Object.prototype.hasOwnProperty.call(APPS_BY_ROUND, key)) return null;
    var v = APPS_BY_ROUND[key];
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  // The accordion rule, on its own so it can be reasoned about without a DOM:
  // pressing the round that is already open closes it, pressing any other one
  // makes that the open one. There is no state in which two are open.
  function nextOpenRound(current, slug) {
    if (!slug) return current || null;
    return current === slug ? null : slug;
  }

  // assets/eduhack/coaches/<slug>.jpg — the name lowercased with every run of
  // non-alphanumerics collapsed to a single hyphen. Kept pure because it is
  // the one place a person's name turns into a URL, and a wrong answer here is
  // a 404 on somebody's face.
  function coachPhotoSlug(name) {
    return String(name == null ? "" : name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  // The COACH_PROFILES entry for a stored name, or null. Looked up by slug
  // rather than by the raw string so that a change of spacing or case in the
  // database cannot silently drop somebody's link.
  function coachProfile(name) {
    var slug = coachPhotoSlug(name);
    if (!slug) return null;
    return Object.prototype.hasOwnProperty.call(COACH_PROFILES, slug)
      ? COACH_PROFILES[slug]
      : null;
  }

  // What the page calls a coach. The stored name unless COACH_PROFILES supplies
  // an override, which today exactly one person has and only because the rename
  // he asked for has not been migrated yet — see the config block at the top.
  function coachDisplayName(name) {
    var entry = coachProfile(name);
    var stored = String(name == null ? "" : name).trim();
    return (entry && entry.name) ? entry.name : stored;
  }

  // assets/eduhack/coaches/<slug>.jpg, slugified from the DISPLAY name.
  //
  // That indirection is the whole reason the override and the photo agree: the
  // file on disk is mahmoud-atallah.jpg, the database says "Mahmoud" today and
  // will say "Mahmoud ATALLAH" after the rename, and both resolve through the
  // display name to the same file. Everybody without an override slugifies
  // their own stored name exactly as before.
  function coachPhotoSrc(name) {
    return "assets/eduhack/coaches/" + coachPhotoSlug(coachDisplayName(name)) + ".jpg";
  }

  // "" for anybody with no profile recorded, which is what stops a coach
  // without a LinkedIn becoming a link to nowhere.
  function coachLinkUrl(name) {
    var entry = coachProfile(name);
    return (entry && entry.linkedin) ? String(entry.linkedin) : "";
  }

  // One coach per person, across every round, in the order the view handed
  // them over — which is is_mentor first, then display_order, then name, and
  // is where the lead coach's first place is decided. Nothing is re-sorted
  // here, so a change to display_order in the database moves the row on the
  // page and nothing in this file has to know about it.
  //
  // Matching is on the DISPLAY name casefolded and space-collapsed, because the
  // same person is a row per round and those rows are what has to fold into one
  // card. Every round they appear in is collected on the way through.
  //
  // Display name rather than stored name for one reason: while the rename in
  // COACH_PROFILES is outstanding, the database could hold "Mahmoud" against one
  // round and "Mahmoud ATALLAH" against another — mid-migration, or if the rows
  // are corrected one at a time. Both resolve to the same display name, so they
  // fold into one card instead of appearing twice. For everybody without an
  // override this is character-for-character the old behaviour.
  function dedupeCoaches(rounds, rosterBy) {
    var seen = {};
    var out = [];
    (rounds || []).forEach(function (r) {
      ((rosterBy && rosterBy[r.id]) || []).forEach(function (p) {
        if (!p.is_mentor) return;
        var key = coachDisplayName(p.full_name).toLowerCase().replace(/\s+/g, " ");
        if (!key) return;
        if (!seen[key]) {
          seen[key] = { person: p, rounds: [] };
          out.push(seen[key]);
        }
        if (seen[key].rounds.indexOf(r.round_number) === -1) {
          seen[key].rounds.push(r.round_number);
        }
      });
    });
    out.forEach(function (c) { c.rounds.sort(function (a, b) { return a - b; }); });
    return out;
  }

  // The country tags, read out of EDUHACKER_COUNTRIES and out of NOTHING else.
  //
  // The union across the rounds that are actually on the page, in first-seen
  // order, deduplicated. It returns [] while the config is empty — which is
  // today, and which is why the tag row does not render at all. There is no
  // fallback branch that fills the gap from names, universities or venues: see
  // the ⚠ block on EDUHACKER_COUNTRIES for why inventing one would be worse
  // than showing nothing.
  //
  // ⚠ The `rounds` argument is accepted and deliberately IGNORED. It used to
  // narrow a per-round config to the rounds on the page; the source turned out
  // to carry no round column, so there is nothing to narrow by and pretending
  // otherwise would be the invention this whole block exists to avoid. The
  // parameter stays because the caller passes it and because a per-round source
  // may yet arrive — at which point this is where the narrowing goes back.
  function countriesForRounds(rounds) {         // eslint-disable-line no-unused-vars
    var out = [];
    Array.prototype.forEach.call(EDUHACKER_COUNTRIES || [], function (name) {
      var c = String(name == null ? "" : name).trim();
      if (!c) return;
      if (out.indexOf(c) === -1) out.push(c);
    });
    return out;
  }

  // Everything the history section says. Every figure here is computed from the
  // rows the page has already loaded, which is the point: when the database
  // changes, the prose changes with it, and there is no sentence sitting in the
  // markup quietly going out of date.
  //
  // `countries` is the ONE field that is not derived from the rows — it is
  // EDUHACKER_COUNTRIES, narrowed to the rounds on the page. It is in here
  // rather than reached for inside storyHtml() so that the whole of what the
  // history section says still arrives through one value that can be inspected
  // in a test. It is [] today.
  //
  // What is deliberately NOT here any more: the Demo Day venues and the count
  // of them, and which round ran in Arabic. Ahmed asked for all three to come
  // out of the prose. Nothing computes them now, rather than something
  // computing them and the renderer quietly dropping them on the floor — the
  // per-round `location` chip still shows each round's own Demo Day venue,
  // which is where that fact now lives.
  function storyFacts(rounds, teamsBy, rosterBy) {
    var list = rounds || [];
    var starts = [], ends = [];
    var teams = 0, people = 0;
    var seenPerson = {};

    list.forEach(function (r) {
      if (r.starts_on) starts.push(String(r.starts_on).slice(0, 10));
      if (r.ends_on) ends.push(String(r.ends_on).slice(0, 10));

      teams += ((teamsBy && teamsBy[r.id]) || []).length;

      ((rosterBy && rosterBy[r.id]) || []).forEach(function (p) {
        var key = String(p.full_name || "").trim().toLowerCase().replace(/\s+/g, " ");
        if (!key || seenPerson[key]) return;
        seenPerson[key] = true;
        people++;
      });
    });

    starts.sort();
    ends.sort();

    return {
      rounds: list.length,
      firstStart: starts.length ? starts[0] : null,
      lastEnd: ends.length ? ends[ends.length - 1] : null,
      teams: teams,
      people: people,
      countries: countriesForRounds(list)
    };
  }

  function validateInterest(values) {
    var v = values || {};
    var errors = {};

    if (!String(v.full_name || "").trim()) {
      errors.full_name = "Please tell us your name.";
    }

    var email = String(v.email || "").trim();
    if (!email) errors.email = "We need an email address to reach you on.";
    else if (!EMAIL_RE.test(email)) errors.email = "That doesn’t look like an email address.";

    var mobile = String(v.mobile || "").trim();
    if (!mobile) errors.mobile = "We need a mobile number.";
    else if (mobile.replace(/[^0-9]/g, "").length < 7) errors.mobile = "That number looks too short.";

    if (!String(v.current_job || "").trim()) {
      errors.current_job = "Please tell us what you do at the moment.";
    }

    return { ok: !Object.keys(errors).length, errors: errors };
  }

  // The contract fixes { error, code } and says nothing about which field a
  // code refers to, so the field is read out of the code — and an explicit
  // `field` is honoured if the function ever starts sending one.
  function fieldForCode(code, explicit) {
    if (explicit && FIELDS.indexOf(explicit) !== -1) return explicit;
    var c = String(code == null ? "" : code).toLowerCase();
    if (!c) return null;
    if (c.indexOf("full_name") !== -1 || /(^|_)name(_|$)/.test(c)) return "full_name";
    if (c.indexOf("email") !== -1) return "email";
    if (c.indexOf("mobile") !== -1 || c.indexOf("phone") !== -1) return "mobile";
    if (c.indexOf("current_job") !== -1 || /(^|_)job(_|$)/.test(c)) return "current_job";
    return null;
  }

  // The dialog's state machine, kept separate from the DOM so it can be
  // reasoned about and tested on its own.
  //
  //   idle  --submit--> sending --ok---> done      (terminal until reset)
  //                            \--fail-> error
  //   error --submit--> sending
  //   idle/error --invalid--> error                (client-side check)
  //
  // A second submit while a request is in flight is ignored rather than
  // queued, which is what stops a double-click posting twice.
  function nextInterestState(state, event) {
    var s = state || { name: "idle", already: false, message: "", fields: {} };
    var type = event && event.type;

    if (type === "reset") return { name: "idle", already: false, message: "", fields: {} };

    if (s.name === "idle" || s.name === "error") {
      if (type === "submit") return { name: "sending", already: false, message: "", fields: {} };
      if (type === "invalid") {
        return { name: "error", already: false, message: event.message || "", fields: event.fields || {} };
      }
      return s;
    }
    if (s.name === "sending") {
      if (type === "ok") return { name: "done", already: !!event.already, message: "", fields: {} };
      if (type === "fail") {
        return { name: "error", already: false, message: event.message || "", fields: event.fields || {} };
      }
      return s;
    }
    return s;   // done
  }

  // ------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------

  // Migration 0020 may not have been applied to the live database yet, so
  // the three objects below can genuinely not exist. That is a "not
  // published yet" state, not a crash — the page says so plainly instead
  // of showing a broken shell. Any other error is reported as an error.
  function isMissingSchema(err) {
    if (!err) return false;
    var code = String(err.code || "");
    // 42P01 = undefined_table (Postgres). PGRST20x = PostgREST could not
    // find the relation in its schema cache, which is what actually comes
    // back over the wire when a table has never been created.
    return code === "42P01" || code.indexOf("PGRST20") === 0 ||
      /schema cache|does not exist/i.test(String(err.message || ""));
  }

  function load() {
    return import("./lib/supabase-client.js?v=aba5b41535").then(function (mod) {
      var sb = mod.supabase;
      // Is anybody signed in? It decides ONE thing: whether the roster query
      // may ask for profile_user_id. 0041 took that column off the anon grant,
      // and PostgREST refuses the WHOLE query when any requested column is
      // ungranted — so asking for it while signed out would empty the roster
      // rather than merely omitting a field.
      return sb.auth.getSession()
        .then(function (r) { return !!(r && r.data && r.data.session); })
        .catch(function () { return false; })
        .then(function (hasSession) {
      return Promise.all([
        sb.from("hackathons")
          .select("id,slug,round_number,name,tagline,description,status,starts_on,ends_on,location,mode,partner")
          .order("round_number", { ascending: false }),
        sb.from("hackathon_teams")
          .select("id,hackathon_id,name,tagline,project_title,project_summary,project_url,demo_url,repo_url,rank,award,is_winner,is_recruiting,looking_for")
          .order("rank", { ascending: true, nullsFirst: false }),
        // No .order() on the roster, deliberately. The view already sorts
        // itself — is_mentor first, then display_order, then full_name —
        // and a PostgREST .order() here would REPLACE that ordering rather
        // than refine it, silently, which is how the coach row would stop
        // leading with the person it is meant to lead with.
        sb.from("hackathon_roster")
          .select(
            "hackathon_id,team_id,full_name,role_in_team,is_mentor,is_judge,avatar_url,headline" +
            (hasSession ? ",profile_user_id" : "")
          )
      ]);
      });
    }).then(function (res) {
      var rounds = res[0], teams = res[1], roster = res[2];
      if (rounds.error) throw rounds.error;
      // Teams and roster failing on their own is survivable — the rounds
      // still tell the story — so they degrade to empty rather than
      // taking the page down.
      ROUNDS = rounds.data || [];
      SOON = ROUNDS.filter(isComingSoon);
      PAST = ROUNDS.filter(function (r) { return !isComingSoon(r); });
      groupTeams(teams.error ? [] : (teams.data || []));
      groupRoster(roster.error ? [] : (roster.data || []));
    });
  }

  function groupTeams(rows) {
    TEAMS_BY_ROUND = {};
    rows.forEach(function (t) {
      (TEAMS_BY_ROUND[t.hackathon_id] = TEAMS_BY_ROUND[t.hackathon_id] || []).push(t);
    });
    Object.keys(TEAMS_BY_ROUND).forEach(function (k) {
      // Ranked teams lead, in placing order; everything else follows
      // alphabetically. An unranked team is "not recorded", so it is not
      // sorted as though it placed last.
      TEAMS_BY_ROUND[k].sort(function (a, b) {
        if (a.rank && b.rank) return a.rank - b.rank;
        if (a.rank) return -1;
        if (b.rank) return 1;
        return String(a.name || "").localeCompare(String(b.name || ""));
      });
    });
  }

  function groupRoster(rows) {
    ROSTER_BY_ROUND = {};
    rows.forEach(function (p) {
      (ROSTER_BY_ROUND[p.hackathon_id] = ROSTER_BY_ROUND[p.hackathon_id] || []).push(p);
    });
  }

  // ------------------------------------------------------------
  // People
  // ------------------------------------------------------------

  // A person renders as a link only once they have signed up AND made
  // themselves discoverable — that is exactly when the view hands back a
  // profile_user_id. For everyone else it is a plain name, which is the
  // whole point of the roster view.
  function personHtml(p, opts) {
    opts = opts || {};
    // The display-name override applies to COACHES ONLY, and it exists because
    // the rename it carries has not been migrated yet (see COACH_PROFILES).
    // Restricting it to is_mentor is not tidiness: 'ansari' is a bare surname,
    // and a competitor who happened to slug-match a coach key would otherwise
    // be renamed on a public page. Nobody who is not a coach is ever touched.
    var shown = p.is_mentor ? coachDisplayName(p.full_name) : (p.full_name || "");
    var name = escapeHtml(shown || "Unnamed participant");
    var avatar = p.avatar_url
      ? '<img class="hk-face" src="' + escapeHtml(p.avatar_url) + '" alt="" loading="lazy" width="34" height="34">'
      : '<span class="hk-face hk-face-initials" aria-hidden="true">' + escapeHtml(initials(shown)) + "</span>";

    var badges = "";
    if (p.is_mentor) badges += '<span class="hk-badge is-coach">Coach</span>';
    if (p.is_judge) badges += '<span class="hk-badge is-judge">Judge</span>';

    var meta = "";
    if (p.headline) meta = '<span class="hk-person-headline">' + escapeHtml(p.headline) + "</span>";
    else if (!opts.hideRoles) meta = roleChips(p.role_in_team);

    var inner =
      avatar +
      '<span class="hk-person-main">' +
        '<span class="hk-person-name">' + name + badges + "</span>" +
        meta +
      "</span>";

    if (p.profile_user_id) {
      return '<a class="hk-person is-linked" href="app/member.html?u=' +
        encodeURIComponent(p.profile_user_id) + '">' + inner + "</a>";
    }
    return '<span class="hk-person">' + inner + "</span>";
  }

  // ------------------------------------------------------------
  // Teams
  // ------------------------------------------------------------

  function teamHtml(team, members) {
    var rankClass = team.rank ? " is-rank-" + team.rank : "";
    var head = "";
    if (team.rank) {
      head = '<span class="hk-place' + rankClass + '">' + medalIcon +
        "<span>" + placeLabel(team.rank) + "</span></span>";
    }
    if (team.award) {
      head += '<span class="hk-award">' + escapeHtml(team.award) + "</span>";
    }
    if (team.is_recruiting) {
      head += '<span class="hk-badge is-recruiting">Looking for members</span>';
    }

    // Where a round recorded no project title, the team name IS the
    // heading and the summary sits underneath as prose. Rendering an empty
    // "Project:" line would be noise.
    var title = team.project_title
      ? '<p class="hk-team-project">' + escapeHtml(team.project_title) + "</p>"
      : "";

    var summary = team.project_summary
      ? '<p class="hk-team-summary">' + escapeHtml(team.project_summary) + "</p>"
      : '<p class="hk-team-summary is-empty">No project description was recorded for this team.</p>';

    // The row is built from whatever links are actually present and
    // omitted entirely when there are none, so a card never shows a dead
    // "Demo" affordance.
    var links = [];
    if (team.demo_url) links.push(linkHtml(team.demo_url, "Demo"));
    if (team.repo_url) links.push(linkHtml(team.repo_url, "Code"));
    if (team.project_url) links.push(linkHtml(team.project_url, "Project"));
    var linkRow = links.length ? '<p class="hk-team-links">' + links.join("") + "</p>" : "";

    var roster = members.length
      ? '<div class="hk-roster">' + members.map(function (m) { return personHtml(m); }).join("") + "</div>"
      : '<p class="hk-team-summary is-empty">No members are recorded against this team.</p>';

    var count = members.length;
    var countLabel = count === 1 ? "1 member" : count + " members";

    return '' +
      '<article class="hk-team' + rankClass + '">' +
        '<div class="hk-team-head">' +
          '<h5 class="hk-team-name">' + escapeHtml(team.name) + "</h5>" +
          (head ? '<div class="hk-team-flags">' + head + "</div>" : "") +
        "</div>" +
        title +
        summary +
        linkRow +
        '<details class="hk-team-people">' +
          '<summary><span class="hk-team-count">' + peopleIcon + countLabel + "</span>" + chevron + "</summary>" +
          roster +
        "</details>" +
      "</article>";
  }

  function linkHtml(url, label) {
    return '<a class="hk-team-link" href="' + escapeHtml(url) +
      '" target="_blank" rel="noopener">' + escapeHtml(label) + "</a>";
  }

  // ------------------------------------------------------------
  // Medals
  // ------------------------------------------------------------

  // Gold, silver and bronze cards, one trophy each, referencing the sprite
  // in hackathons.html. A round whose placings were never recorded returns
  // "" here, and its teams simply render without medals — the page does
  // not manufacture a podium out of an absence.
  function medalsHtml(teams) {
    var podium = podiumTeams(teams);
    if (!podium.length) return "";
    return '<div class="hk-medals' + (podium.length < 3 ? " is-" + podium.length : "") + '">' +
      podium.map(function (t) {
        var tier = medalTier(t);
        return '<article class="hk-medal is-' + tier + '">' +
            '<span class="hk-medal-badge">' +
              '<svg class="hk-medal-trophy" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
                '<use href="#hk-trophy-' + tier + '"></use>' +
              "</svg>" +
            "</span>" +
            '<span class="hk-medal-place">' + escapeHtml(medalLabel(t)) + "</span>" +
            '<h4 class="hk-medal-team">' + escapeHtml(t.name) + "</h4>" +
            (t.award ? '<span class="hk-medal-sub">' + escapeHtml(t.award) + "</span>" : "") +
          "</article>";
      }).join("") +
    "</div>";
  }

  // ------------------------------------------------------------
  // Rounds
  // ------------------------------------------------------------

  function chipsHtml(round) {
    var chips = [];
    if (round.mode) chips.push('<span class="hk-chip is-mode">' + escapeHtml(round.mode) + "</span>");
    if (round.location) chips.push('<span class="hk-chip">' + pinIcon + escapeHtml(round.location) + "</span>");
    if (round.partner) chips.push('<span class="hk-chip">' + escapeHtml(round.partner) + "</span>");
    if (round.status && round.status !== "completed") {
      chips.push('<span class="hk-chip is-live">' + escapeHtml(round.status.replace(/_/g, " ")) + "</span>");
    }
    return chips.length ? '<div class="hk-chips">' + chips.join("") + "</div>" : "";
  }

  // The round's key figures, as chips.
  //
  // The wording is "5 Coaches", not "No of Coaches: 5 Coaches". The noun
  // appears once instead of twice: the figures are the same figures, and at
  // 375px the doubled noun was what pushed each chip onto its own line. The
  // number is set in the page's tabular figures at full text colour with the
  // noun beside it muted, so a run of them still reads as a set of counts
  // rather than as prose.
  function figureChipHtml(value, noun) {
    return '<span class="hk-chip is-figure">' +
      '<span class="hk-chip-n">' + escapeHtml(value) + "</span>" +
      '<span class="hk-chip-noun">' + escapeHtml(noun) + "</span>" +
    "</span>";
  }

  function figureChipsHtml(f) {
    if (!f) return "";
    var chips = [
      figureChipHtml(f.coaches, plural(f.coaches, "Coach", "Coaches")),
      figureChipHtml(f.teams, plural(f.teams, "Team", "Teams")),
      figureChipHtml(f.eduhackers, plural(f.eduhackers, "EduHacker", "EduHackers"))
    ];
    // No count, no chip. Not a zero and not a placeholder: nobody has told us
    // how many apps rounds 2–4 shipped, and "0 AI-Apps" on a round that shipped
    // some would be worse than saying nothing at all.
    if (f.apps !== null) {
      chips.push(figureChipHtml(f.apps, plural(f.apps, "AI-App", "AI-Apps")));
    }
    return '<div class="hk-chips hk-figures">' + chips.join("") + "</div>";
  }

  // The round's whole chip line: what kind of round it was, then how big it
  // was, in ONE row on a wide screen.
  //
  // They used to be two rows by design — a phone-first decision, because seven
  // chips wrapping freely at 375px produced a four-line block in which "Online"
  // and "40 EduHackers" were the same object at the same weight. Ahmed has
  // looked at the live page on a wide screen and asked for one row, so this is
  // the compromise that gives him one without giving the phone the wall back:
  //
  //   * the two groups stay as two elements, so they can still separate from
  //     each other cleanly rather than interleaving;
  //   * .hk-meta is a wrapping flex row holding both, so on a desktop width
  //     they sit side by side and the six chips read as one line;
  //   * when they do not fit — a narrow viewport, or a round whose Demo Day
  //     venue string is long — the groups wrap as units first and the chips
  //     inside them wrap second, so the fallback is two tidy rows rather than
  //     a ragged one. The column gap between the groups is wider than the gap
  //     inside them, which is what keeps them legible as two things while they
  //     are on one line.
  //
  // No chip is dropped at any width. Every one of these is a figure Ahmed asked
  // to be readable at a glance, and hiding one on a small screen would be
  // choosing which of his figures does not matter.
  function metaHtml(round, figures) {
    var inner = chipsHtml(round) + figureChipsHtml(figures);
    return inner ? '<div class="hk-meta">' + inner + "</div>" : "";
  }

  // Splits a round's roster into coaches (is_mentor) and everyone else,
  // and buckets the competitors by team. Coaches are lifted out of the
  // team rosters and shown once per round: a coach attached to a team in
  // the source is a data-entry artefact rather than a claim that they
  // competed, and the round-level coach row keeps that link visible
  // without publishing the implication.
  //
  // Nothing here reorders anybody. `hackathon_roster` carries its own
  // ORDER BY (is_mentor first, then display_order, then full_name), the
  // roster query above deliberately adds no .order() of its own — one
  // would silently replace the view's ordering rather than refine it — and
  // filter() preserves array order. So the coach row, the team rosters and
  // the unaffiliated list all come out in the order the database chose,
  // which is where the lead coach's first place is decided. Names are
  // rendered exactly as the database spells them.
  function splitRoster(roster) {
    var coaches = roster.filter(function (p) { return p.is_mentor; });
    var competitors = roster.filter(function (p) { return !p.is_mentor; });
    var byTeam = {};
    var unaffiliated = [];
    competitors.forEach(function (p) {
      if (p.team_id) (byTeam[p.team_id] = byTeam[p.team_id] || []).push(p);
      else unaffiliated.push(p);
    });
    return { coaches: coaches, byTeam: byTeam, unaffiliated: unaffiliated };
  }

  // One past round: a header that is always visible with its medal cards,
  // and everything else behind a disclosure.
  //
  // What stays visible when collapsed is the round's identity — number,
  // name, tagline, dates, mode/location chips — and the winners. That is
  // the answer to the two questions somebody scanning this page actually
  // has: when was this one, and who won it. The 40-odd team cards and 150
  // names are what they came for only after they have picked a round, so
  // those are what the click is for.
  function roundHtml(round) {
    var teams = TEAMS_BY_ROUND[round.id] || [];
    var roster = ROSTER_BY_ROUND[round.id] || [];
    var split = splitRoster(roster);

    var visibleTeams = teams.filter(function (t) {
      return matches(round, t, split.byTeam[t.id] || []);
    });
    var showUnaffiliated = !query || matches(round, null, split.unaffiliated);

    var id = safeId(round.slug) || ("round-" + safeId(String(round.round_number)));
    var tabId = "hk-tab-" + id;
    var panelId = "hk-panel-" + id;
    // Which rounds start open.
    //
    // With no search, exactly one: the accordion's. With a search running the
    // accordion is suspended and every round holding a match opens, because a
    // result the reader cannot see is not a result. Clearing the search puts
    // the page straight back to at most one open — `openSlug` is never touched
    // by searching, so whatever was open before the query is what comes back.
    var open = query ? visibleTeams.length > 0 : openSlug === round.slug;

    var when = formatRange(round.starts_on, round.ends_on);
    // A completed round with a start and no end has an unrecorded end date;
    // saying so stops a reader assuming it is still running.
    var whenNote = (round.starts_on && !round.ends_on && round.status === "completed")
      ? '<span class="hk-when-note">end date not recorded</span>'
      : "";

    var coachRow = split.coaches.length
      ? '<div class="hk-coaches">' +
          '<h4 class="hk-sub">Coaches</h4>' +
          '<div class="hk-roster">' + split.coaches.map(function (c) {
            return personHtml(c, { hideRoles: true });
          }).join("") + "</div>" +
        "</div>"
      : "";

    var teamsHtml = visibleTeams.length
      ? '<div class="hk-team-grid">' + visibleTeams.map(function (t) {
          return teamHtml(t, split.byTeam[t.id] || []);
        }).join("") + "</div>"
      : '<p class="hk-empty">No teams in this round match your search.</p>';

    // Participants the source records with no team took part and are named
    // here rather than dropped, but nobody is assigned a team by inference.
    var unaffiliatedHtml = (split.unaffiliated.length && showUnaffiliated)
      ? '<details class="hk-unaffiliated">' +
          "<summary><span>" + peopleIcon + split.unaffiliated.length +
          " more took part with no team recorded</span>" + chevron + "</summary>" +
          '<div class="hk-roster">' + split.unaffiliated.map(function (p) {
            return personHtml(p);
          }).join("") + "</div>" +
        "</details>"
      : "";

    var desc = round.description
      ? '<p class="hk-round-desc">' + escapeHtml(round.description) + "</p>"
      : '<p class="hk-round-desc is-empty">No description was recorded for this round.</p>';

    // The round's own mark, with the name as its fallback text. The heading is
    // a plain <h3> again rather than a button: the disclosure moved to the
    // bottom of the card, so the title is a title.
    var logo = logoHtml(
      "round-" + safeId(String(round.round_number)),
      round.name,
      '<span class="hk-logo-text hk-round-name glow-text">' + escapeHtml(round.name) + "</span>",
      "hk-round-logo", 300, 80
    );

    var cue = open ? "Hide details" : "Show details";

    return '' +
      '<section class="hk-round" id="' + escapeHtml(round.slug) + '">' +
        '<div class="hk-round-head">' +
          '<h3 class="hk-round-h">' +
            '<span class="hk-round-num">Round ' + escapeHtml(round.round_number) + "</span>" +
            logo +
          "</h3>" +
          (round.tagline ? '<p class="hk-round-tagline">' + escapeHtml(round.tagline) + "</p>" : "") +
          (when ? '<p class="hk-round-when">' + escapeHtml(when) + whenNote + "</p>" : "") +
          // Inside .hk-round-head, so the figures are visible while the round
          // is collapsed — which is how at least three of the four always are,
          // and the whole point of asking for them.
          metaHtml(round, roundFigures(round, teams, roster)) +
        "</div>" +
        medalsHtml(teams) +
        // The control sits at the bottom of the card and spans its full width,
        // and it stays BEFORE the panel in the DOM: pressing it and then
        // tabbing should land in what it just opened, not skip past it. When
        // the round is collapsed — which is how at least three of the four
        // always are — the bar is the last thing in the card, which is where
        // the owner asked for it.
        //
        // aria-label rather than a bare "Show details": four identical buttons
        // on one page are four identical announcements. It opens with the
        // visible text so the visible label is still a prefix of the
        // accessible name, and setOpen() rewrites both together.
        '<button class="hk-round-toggle" type="button" id="' + tabId + '"' +
          ' aria-expanded="' + (open ? "true" : "false") + '"' +
          ' aria-controls="' + panelId + '"' +
          ' data-hk-toggle="' + escapeHtml(round.slug) + '"' +
          ' data-hk-name="' + escapeHtml(round.name) + '"' +
          ' aria-label="' + escapeHtml(cue + " for " + round.name) + '">' +
          '<span class="hk-round-cue" aria-hidden="true">' + cue + "</span>" +
          '<span class="hk-round-caret">' + chevron + "</span>" +
        "</button>" +
        '<div class="hk-round-panel" id="' + panelId + '" role="region" aria-labelledby="' + tabId + '"' +
          (open ? "" : " hidden") + ">" +
          desc +
          coachRow +
          '<h4 class="hk-sub">Teams <span class="hk-sub-count">' + teams.length + "</span></h4>" +
          teamsHtml +
          unaffiliatedHtml +
        "</div>" +
      "</section>";
  }

  // The next round, before it has dates.
  //
  // Rebuilt after the owner's "not looks good at all". The panel used to open
  // with a starburst on the eyebrow and the same starburst on the early-bird
  // pill; at that size the pair read as a loading spinner and the top of the
  // page looked stuck. Both glyphs are gone and neither is replaced.
  //
  // What is left is one statement — <round mark> Coming Soon — the benefit in
  // plain words, the honest line that the dates are not set, and the button.
  // Everything shown is whatever the row actually carries; the only thing this
  // markup asserts on its own is that the dates are not set, which is exactly
  // why the round is in this list.
  //
  // The mark and the words are ONE lockup, not a mark with text hanging off it:
  // .hk-soon-lockup is the flex row and it centres its two children on each
  // other, so "Coming Soon" sits on the vertical centre line of the logo's
  // height whatever height that logo ends up being. See styles.css.
  function soonHtml(round) {
    var desc = round.description
      ? '<p class="hk-soon-desc">' + escapeHtml(round.description) + "</p>"
      : "";
    var logo = logoHtml(
      "round-" + safeId(String(round.round_number)),
      round.name,
      '<span class="hk-logo-text hk-soon-name glow-text">' + escapeHtml(round.name) + "</span>",
      "hk-soon-logo", 300, 80
    );
    return '' +
      '<section class="hk-soon" id="' + escapeHtml(round.slug) + '">' +
        '<p class="hk-soon-flag">The next round</p>' +
        '<h2 class="hk-soon-h"><span class="hk-soon-lockup">' + logo +
          // hk-mark-text is the shared class the other five section titles
          // carry; hk-soon-verb keeps only this one's size, weight and tight
          // line box. Two classes, two jobs, no colour written twice.
          '<span class="hk-soon-verb hk-mark-text">Coming Soon</span></span></h2>' +
        (round.tagline ? '<p class="hk-soon-tagline">' + escapeHtml(round.tagline) + "</p>" : "") +
        desc +
        '<p class="hk-soon-note">The dates aren’t set yet. If you are interested to be with us, ' +
          "leave your details and we’ll let you know as soon as it’s scheduled.</p>" +
        chipsHtml(round) +
        '<div class="hk-soon-actions">' +
          '<button type="button" class="btn btn-glow btn-lg" data-hk-open="' + escapeHtml(round.slug) + '">' +
            "Register your interest</button>" +
          // No icon, by name: this is the pill the owner asked to strip.
          '<span class="hk-earlybird">Early bird discount</span>' +
        "</div>" +
      "</section>";
  }

  // ------------------------------------------------------------
  // The history of EduHackAI
  // ------------------------------------------------------------

  // The heading, on its own, because it renders into its own mount ABOVE the
  // four stat tiles — Ahmed marked the gap between the coming-soon panel and
  // the tiles as where it belongs, so the page now reads: coming soon →
  // heading → tiles → prose. It keeps its id, and the story card below the
  // tiles keeps aria-labelledby pointing at it, so moving it apart on screen
  // did not split the section apart in the accessibility tree.
  //
  // It is guarded by the same `facts.rounds` test as the prose, so a page with
  // no rounds does not render a heading over nothing.
  function storyHeadingHtml(facts) {
    if (!facts || !facts.rounds) return "";
    return '<h2 class="hk-story-h" id="hk-story-h">' + markText("EduHackAI Story") + "</h2>";
  }

  // Every number in this section comes out of storyFacts(), which computes it
  // from the rows already on the page. The prose is written AROUND those
  // values rather than alongside them, so there is no sentence here that can
  // quietly stop being true when the data moves. Anything storyFacts() cannot
  // derive is left unsaid rather than estimated.
  //
  // The country tags are the live example of that rule: the row below is driven
  // by facts.countries, facts.countries is EDUHACKER_COUNTRIES, and
  // EDUHACKER_COUNTRIES is empty — so the label, the count and every tag are
  // absent from the DOM entirely rather than rendering an empty strip or a
  // guessed list.
  function storyHtml(facts) {
    if (!facts || !facts.rounds) return "";

    // Blocks rather than a flat list of sentences, because the country tags are
    // a <ul> that has to land after the paragraphs.
    var blocks = [];
    var range = formatRange(facts.firstStart, facts.lastEnd);
    function para(html) { blocks.push('<p class="hk-story-p">' + html + "</p>"); }

    para(
      "EduHackAI has run <strong>" + facts.rounds + "</strong> " +
      plural(facts.rounds, "round", "rounds") + " so far" +
      (range ? ", between <strong>" + escapeHtml(range) + "</strong>" : "") +
      ". Every round is the same ten days: you join a team, take the daily " +
      "challenges, and finish with an AI application you built yourself."
    );

    if (facts.teams || facts.people) {
      var bits = [];
      if (facts.teams) {
        bits.push("<strong>" + facts.teams + "</strong> " + plural(facts.teams, "team", "teams"));
      }
      if (facts.people) {
        bits.push("<strong>" + facts.people + "</strong> " + plural(facts.people, "person", "people"));
      }
      para(
        listSentence(bits) + " " + (bits.length > 1 ? "are named" : "is named") +
        " in the records of those rounds — people counted once each, however " +
        "many rounds they came back for."
      );
    }

    // Tags rather than a clause, the same way the venues were: a country list
    // reads as a set, and a set reads as a row of tags. The whole block —
    // sentence and tags together — is inside this one guard, so there is no
    // state in which a lead-in introduces a row that is not there.
    var countries = (facts.countries || []).filter(Boolean);
    if (countries.length) {
      para(
        "The EduHackers came from <strong>" + countries.length + "</strong> " +
        plural(countries.length, "country", "countries") + ":"
      );
      blocks.push('<ul class="hk-countries">' + countries.map(function (name) {
        return '<li class="hk-country">' + escapeHtml(name) + "</li>";
      }).join("") + "</ul>");
    }

    return '<section class="hk-story" id="hk-story" aria-labelledby="hk-story-h">' +
      blocks.join("") +
    "</section>";
  }

  // ------------------------------------------------------------
  // Coaches, across the whole programme
  // ------------------------------------------------------------

  // One card per coach, however many rounds they taught, with the rounds they
  // taught named on the card.
  //
  // The photo is assets/eduhack/coaches/<slug>.jpg, slugified from the coach's
  // DISPLAY name — see coachPhotoSrc(). Those files now exist for the eight
  // people who coached these rounds. The monogram stays underneath as the
  // fallback for anybody who has no file: it is built to be a finished state
  // rather than a placeholder — the same circle, the same size, the club's own
  // violet-to-cyan wash, initials set in the page's own type — so a coach
  // without a photo does not look like a coach with a broken one.
  //
  // Two coaches are recorded under a single name because that is all the
  // database holds for them. They render like everybody else.
  //
  // ---- Linked or not ----
  //
  // A coach with a LinkedIn in COACH_PROFILES renders as an <a>: new tab,
  // rel="noopener noreferrer", and an accessible name that says WHOSE profile
  // it is rather than the word "LinkedIn" eight times over — eight identical
  // announcements in a links list is the same fault four identical "Show
  // details" buttons were.
  //
  // A coach with no LinkedIn renders as the <article> it always was: not a link
  // with a dead href, not an <a> with href="#", not a link that goes nowhere on
  // click. There is no state in which a card looks pressable and is not,
  // because the element itself is different.
  function coachCardHtml(entry) {
    var p = entry.person;
    var stored = String(p.full_name || "").trim();
    var name = coachDisplayName(stored);
    var href = coachLinkUrl(stored);
    var src = p.avatar_url || coachPhotoSrc(stored);

    var rounds = entry.rounds.length
      ? '<span class="hk-coach-rounds">' + entry.rounds.map(function (n) {
          return '<span class="hk-coach-round">Round ' + escapeHtml(n) + "</span>";
        }).join("") + "</span>"
      : "";

    var inner =
      '<span class="hk-coach-face">' +
        '<span class="hk-coach-mono" aria-hidden="true">' + escapeHtml(initials(name)) + "</span>" +
        '<img class="hk-coach-photo" data-hk-face src="' + escapeHtml(src) + '"' +
          ' alt="" loading="lazy" width="112" height="112">' +
      "</span>" +
      '<h3 class="hk-coach-name">' + escapeHtml(name) + "</h3>" +
      rounds;

    if (!href) return '<article class="hk-coach">' + inner + "</article>";

    // The visible cue carries the mark and the word, so the affordance is
    // legible without hovering; aria-hidden on the pair because the link's own
    // accessible name already says all of it.
    var cue = '<span class="hk-coach-link-cue" aria-hidden="true">' + linkedinIcon + "LinkedIn</span>";
    return '<a class="hk-coach is-linked" href="' + escapeHtml(href) + '"' +
        ' target="_blank" rel="noopener noreferrer"' +
        ' aria-label="' + escapeHtml(name + " on LinkedIn (opens in a new tab)") + '">' +
        inner + cue +
      "</a>";
  }

  function coachesHtml(entries) {
    if (!entries || !entries.length) return "";
    return '<section class="hk-thanks" aria-labelledby="hk-thanks-h">' +
      '<h2 class="hk-thanks-h" id="hk-thanks-h">' +
        markText("Thank You to Our EduHackAI Coaches") + "</h2>" +
      '<div class="hk-coach-grid">' + entries.map(coachCardHtml).join("") + "</div>" +
    "</section>";
  }

  // The same reveal-on-decode rule the logos use. The monogram is underneath
  // in the same box, so a photo that never arrives costs nothing and a photo
  // that does arrive covers it without moving anything.
  function wireFaces(root) {
    var scope = root || document;
    if (!scope.querySelectorAll) return;
    Array.prototype.forEach.call(scope.querySelectorAll("img[data-hk-face]"), function (img) {
      function ready() {
        if (!img.naturalWidth) return;
        img.classList.add("is-ready");
      }
      if (img.complete) ready();
      else img.addEventListener("load", ready);
    });
  }

  // ------------------------------------------------------------
  // 🥇 Project Showcase — the demo videos
  // ------------------------------------------------------------
  //
  // WHY THERE ARE NO IFRAMES IN THIS MARKUP.
  //
  // Nine YouTube embeds is nine third-party players. Each one pulls a player
  // bundle, a set of fonts and its own tracking state before anybody has
  // pressed anything, on a page that already loads a starfield canvas, the
  // Supabase client, twelve logo files and nine coach photographs. So each
  // video renders as a FAÇADE: the poster image, a play button, and nothing
  // else. The <iframe> is created when somebody presses one, and never before —
  // and, since the player moved into a dialog, it is DESTROYED again the moment
  // that dialog closes. See videoDialog below.
  //
  // Two consequences worth being explicit about:
  //
  //   * The frame is built against youtube-nocookie.com, so the player that
  //     does eventually load is the one that does not write a tracking cookie
  //     for a visitor who has not signed in to Google.
  //   * The poster itself is still a request to i.ytimg.com. That is one image
  //     per card against nine players plus their payloads, and it carries no
  //     player and no cookie — but it is a third-party request and this comment
  //     is not going to pretend otherwise.
  //
  // The poster is hqdefault.jpg, which YouTube serves at a real 480x360. Those
  // are the width/height on the <img>, so the box is the right shape before the
  // file arrives and nothing on the page moves when it does. CSS crops it to
  // 16:9 inside a fixed-ratio frame.
  //
  // The cards are laid out as a horizontal scroll-snap RAIL rather than a grid:
  // three visible at a time on a desktop, two on a tablet and one on a phone,
  // with the next card peeking at the narrower two so it is visible that there
  // is more. See wireRail() and .hk-video-rail in styles.css.

  // Ids go into a URL and into an id-ish attribute, so anything that is not a
  // YouTube id character is dropped rather than escaped. A surprising id can
  // then only ever produce a 404, never a broken or hostile URL.
  function safeVideoId(s) {
    return String(s == null ? "" : s).replace(/[^A-Za-z0-9_-]/g, "");
  }

  function videoHtml(v) {
    var id = safeVideoId(v && v.id);
    if (!id) return "";
    var title = String((v && v.title) || "").trim();
    var t = escapeHtml(title);
    var blurb = String((v && v.blurb) || "").trim();

    return '<li class="hk-video">' +
      '<span class="hk-video-media">' +
        // The accessible name says what pressing it does AND which video it is:
        // nine buttons reading "Play" would be nine identical announcements.
        // The <img> carries the title as its alt as well, so the thumbnail is
        // named in its own right wherever it is read outside the button.
        //
        // aria-haspopup="dialog" is the honest description of what happens now:
        // the card no longer swaps itself for a player, it opens the dialog at
        // the bottom of hackathons.html. Somebody who cannot see the overlay
        // appear is told before they press it.
        '<button type="button" class="hk-video-play"' +
          ' data-hk-video="' + id + '"' +
          ' data-hk-title="' + t + '"' +
          ' aria-haspopup="dialog"' +
          ' aria-label="' + escapeHtml("Play the demo video: " + title) + '">' +
          '<img class="hk-video-thumb" src="https://i.ytimg.com/vi/' + id + '/hqdefault.jpg"' +
            ' alt="' + t + '" loading="lazy" width="480" height="360">' +
          '<span class="hk-video-cue" aria-hidden="true">' + playIcon + "</span>" +
        "</button>" +
      "</span>" +
      '<h3 class="hk-video-title">' + t + "</h3>" +
      (blurb ? '<p class="hk-video-desc">' + escapeHtml(blurb) + "</p>" : "") +
    "</li>";
  }

  // THE HEADING'S MEDAL IS OUTSIDE THE GRADIENT, DELIBERATELY.
  //
  // 🥇 is a colour glyph: the font supplies its own gold, red and white. A
  // background-clip: text fill does not tint text, it MASKS a gradient with the
  // glyph coverage — so an emoji inside .hk-mark-text stops being a medal and
  // becomes a flat magenta silhouette of one, in every engine that supports the
  // property. (This is stated from how the property is specified to composite,
  // not from having watched it here; see the report — it wants one look in a
  // browser to confirm the shape of the failure, not whether to avoid it.)
  //
  // So the medal is its own sibling span and never enters the clipped box. It
  // keeps its own colours, and the gradient runs across "Project Showcase".
  //
  // It is also aria-hidden. A heading whose accessible name is "1st place medal
  // Project Showcase" reads the ornament out as a word; the name is left as
  // "Project Showcase", which is what the section is called. The medal is still
  // in the visible heading text, exactly as asked — it is hidden from the
  // accessibility tree, not from the page.
  function showcaseHeadingHtml() {
    return '<h2 class="hk-videos-h" id="hk-videos-h">' +
      '<span class="hk-h-emoji" aria-hidden="true">🥇</span>' +
      markText("Project Showcase") +
    "</h2>";
  }

  function videosHtml(list) {
    var videos = list || [];
    var items = videos.map(videoHtml).join("");
    if (!items) return "";
    // The label says what the region is and how to move through it, because a
    // horizontal scroller is the one control on this page whose affordance is
    // invisible to somebody who cannot see the card peeking off the right edge.
    var railLabel = videos.length + " demo videos — scroll sideways, " +
      "or use the previous and next buttons";
    return '<section class="hk-videos" aria-labelledby="hk-videos-h">' +
      showcaseHeadingHtml() +
      '<p class="hk-videos-intro">What the teams built, shown by the people who built it. ' +
        "Pressing a thumbnail opens that video in a player; nothing loads until you do.</p>" +
      // Real buttons, not divs with click handlers: they are in the tab order,
      // they take Enter and Space for free, and `disabled` is a state a screen
      // reader already knows how to announce. wireRail() keeps that state
      // truthful as the rail is scrolled by ANY means — button, wheel, touch,
      // arrow key or scrollbar.
      '<div class="hk-rail-nav">' +
        '<button type="button" class="hk-rail-btn" data-hk-rail="prev"' +
          ' aria-controls="hk-video-rail" aria-label="Previous demo videos" disabled>' +
          chevronLeft + "</button>" +
        '<button type="button" class="hk-rail-btn" data-hk-rail="next"' +
          ' aria-controls="hk-video-rail" aria-label="Next demo videos">' +
          chevronRight + "</button>" +
      "</div>" +
      // tabindex="0" makes the scroller itself reachable, and a focused scroll
      // container is scrolled by the arrow keys by the browser — no key handler
      // of ours, and therefore nothing of ours that can swallow a key somebody
      // meant for the page. It stays a <ul>: the list semantics are worth more
      // than a role="region" would be, and a <ul> takes aria-label as it is.
      '<ul class="hk-video-rail" id="hk-video-rail" tabindex="0"' +
        ' aria-label="' + escapeHtml(railLabel) + '">' + items + "</ul>" +
      '<p class="hk-videos-more">' +
        '<a class="hk-videos-link" href="' + escapeHtml(PLAYLIST_URL) + '"' +
          ' target="_blank" rel="noopener noreferrer">' +
          "Watch the full playlist on YouTube (opens in a new tab)</a>" +
      "</p>" +
    "</section>";
  }

  // ------------------------------------------------------------
  // The showcase scroller
  // ------------------------------------------------------------
  //
  // CSS scroll-snap does the scrolling. There is no timer, no transform, no
  // wheel listener and no touch listener anywhere in here — the rail is an
  // ordinary overflow-x container, so the wheel, a trackpad swipe, a touch
  // drag, the scrollbar and the arrow keys all keep working exactly as the
  // browser implements them. This code only does the two things CSS cannot:
  // move the rail by one card when a button is pressed, and keep the two
  // buttons' disabled state honest.

  // Which edge the rail is against. A pure function of three numbers, so the
  // button state is decided by something the harness can test without a
  // browser — and so the 1px of slack below is one number in one place.
  //
  // The slack is not cosmetic. Card widths are fractional (a third of the rail,
  // less two gaps), scrollWidth and clientWidth are rounded integers, and on a
  // display whose device-pixel-ratio is not 1 a rail scrolled fully right can
  // sit a fraction of a pixel short of its own maximum. Without the slack the
  // Next button never disables — which is worse than no button, because it is a
  // control that says there is more when there is not.
  function railEdges(scrollLeft, scrollWidth, clientWidth) {
    var max = Math.max(0, scrollWidth - clientWidth);
    var x = Math.min(Math.max(scrollLeft, 0), max);
    return { atStart: x <= 1, atEnd: x >= max - 1 };
  }

  // Reduced motion, from both places this site records it: the checkbox in the
  // site's own settings (html.reduce-motion) and the OS setting. Either one is
  // enough. CSS handles the scrollbar-dragged and keyboard cases via
  // scroll-behavior; this is the button case, where the behaviour is an
  // argument to scrollBy() and CSS does not get a say.
  function railBehavior() {
    var root = document.documentElement;
    if (root && root.classList && root.classList.contains("reduce-motion")) return "auto";
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      if (mq && mq.matches) return "auto";
    }
    return "smooth";
  }

  // One card plus one gap, MEASURED off the laid-out rail rather than restated
  // from the stylesheet. The gap and the cards-per-view both change at
  // breakpoints, and a number copied out of styles.css into here would be a
  // number that silently stops matching.
  function railStep(rail) {
    var cards = rail.querySelectorAll ? rail.querySelectorAll(".hk-video") : [];
    if (cards.length > 1) return cards[1].offsetLeft - cards[0].offsetLeft;
    if (cards.length === 1) return cards[0].offsetWidth;
    return Math.round((rail.clientWidth || 0) * 0.9);
  }

  function railParts(root) {
    var scope = root || document;
    if (!scope.querySelector) return null;
    var rail = scope.querySelector(".hk-video-rail");
    if (!rail) return null;
    return {
      rail: rail,
      prev: scope.querySelector('[data-hk-rail="prev"]'),
      next: scope.querySelector('[data-hk-rail="next"]')
    };
  }

  function paintRail(parts) {
    if (!parts || !parts.rail) return;
    var e = railEdges(parts.rail.scrollLeft || 0, parts.rail.scrollWidth || 0, parts.rail.clientWidth || 0);
    if (parts.prev) parts.prev.disabled = e.atStart;
    if (parts.next) parts.next.disabled = e.atEnd;
  }

  function wireRail(root) {
    var parts = railParts(root);
    if (!parts || !parts.rail.addEventListener) return;
    paintRail(parts);
    // Repainted from the SCROLL event rather than from the click, so the state
    // is right however the rail moved — a touch drag and a wheel flick change
    // the same two buttons a press does.
    parts.rail.addEventListener("scroll", function () { paintRail(parts); });
    if (window.addEventListener) {
      window.addEventListener("resize", function () { paintRail(parts); });
    }
    [["prev", -1], ["next", 1]].forEach(function (pair) {
      var btn = parts[pair[0]];
      if (!btn || !btn.addEventListener) return;
      btn.addEventListener("click", function () {
        if (btn.disabled) return;
        if (!parts.rail.scrollBy) return;
        parts.rail.scrollBy({ left: pair[1] * railStep(parts.rail), behavior: railBehavior() });
      });
    });
  }

  // The player's markup, built at the moment the dialog opens.
  //
  // autoplay=1 is honest here for the same reason it always was: this is only
  // ever reached from the reader's own click, so the thing that starts playing
  // is the thing they just pressed. youtube-nocookie.com for the same reason it
  // always was too — the player that loads is the one that does not write a
  // tracking cookie for a visitor who has not signed in to Google.
  //
  // No loading="lazy": this frame is created in order to be watched immediately,
  // and a lazy frame inside a dialog that has just been revealed is a frame that
  // may not have started fetching when the visitor expects sound.
  function videoFrameHtml(id, title) {
    return '<iframe class="hk-video-frame"' +
      ' src="https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&amp;rel=0"' +
      ' title="' + escapeHtml(title) + '"' +
      ' width="960" height="540"' +
      ' allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"' +
      " allowfullscreen></iframe>";
  }

  // ------------------------------------------------------------
  // Closing call to action
  // ------------------------------------------------------------

  // The second way into the SAME dialog. It carries data-hk-open, which is the
  // one thing that opens it, so there is no second form and no second dialog —
  // and openInterest() records whichever button was pressed, so Escape or
  // Close returns focus to this one when this one is what opened it.
  // The round's NAME is still the database's, not a string typed in here — the
  // heading reads "Your AI Journey Starts with EduHackAI-5" because the row
  // that has no dates is called EduHackAI-5, and it will read whatever that row
  // is called next time. Only the sentence around it is written here.
  //
  // The name is wrapped in .hk-nowrap so "EduHackAI-5" cannot be split at its
  // hyphen; the whole line is inside .hk-mark-text so the gradient runs across
  // the sentence and the name together rather than restarting at the name.
  function ctaHtml(round) {
    if (!round) return "";
    return '<section class="hk-cta" aria-labelledby="hk-cta-h">' +
      '<h2 class="hk-cta-h" id="hk-cta-h">' +
        '<span class="hk-mark-text">Your AI Journey Starts with ' +
          noWrap(round.name) + "</span></h2>" +
      '<p class="hk-cta-text">The dates aren’t set yet. Leave your details and we’ll let you know ' +
        "the moment it’s scheduled — and you’ll get the early bird discount when registration opens.</p>" +
      '<div class="hk-cta-actions">' +
        '<button type="button" class="btn btn-glow btn-lg" data-hk-open="' + escapeHtml(round.slug) + '">' +
          "Register your interest</button>" +
      "</div>" +
    "</section>";
  }

  // Search spans the things a person would actually look for: their own
  // name, a team name, and what a team built.
  function matches(round, team, members) {
    if (!query) return true;
    var hay = [];
    if (team) hay.push(team.name, team.project_title, team.project_summary, team.tagline);
    if (round) hay.push(round.name, round.tagline);
    members.forEach(function (m) { hay.push(m.full_name, m.role_in_team); });
    return hay.join("   ").toLowerCase().indexOf(query) !== -1;
  }

  // ------------------------------------------------------------
  // Render
  // ------------------------------------------------------------

  function statHtml(value, label) {
    return '<div class="hk-stat"><span class="hk-stat-num">' + value +
      '</span><span class="hk-stat-label">' + escapeHtml(label) + "</span></div>";
  }

  function renderChrome() {
    // The summary counts the rounds that have actually run. A round still
    // waiting for its dates has no teams and no EduHackers, and folding a
    // zero into these tiles would only make them read as a shrinking
    // programme.
    //
    // The third tile said "builders" and counted every roster row. It says
    // "EduHackers" now, which is the word Ahmed uses, and the number moved with
    // the word rather than staying put underneath it: coaches are no longer in
    // it. A tile reading "150 EduHackers" while the round it sits above says
    // "40 EduHackers" and "5 Coaches" would be the page disagreeing with
    // itself in public.
    var t = summarise(PAST, TEAMS_BY_ROUND, ROSTER_BY_ROUND);
    if (statsEl) {
      statsEl.innerHTML = PAST.length
        ? statHtml(t.rounds, t.rounds === 1 ? "round so far" : "rounds so far") +
          statHtml(t.teams, "teams") +
          statHtml(t.eduhackers, t.eduhackers === 1 ? "EduHacker" : "EduHackers") +
          statHtml(t.medals, t.medals === 1 ? "medal awarded" : "medals awarded")
        : "";
    }
    if (jumpEl) {
      jumpEl.innerHTML = ROUNDS.map(function (r) {
        return '<a class="hk-jump-link" href="#' + escapeHtml(r.slug) + '">Round ' +
          escapeHtml(r.round_number) + "</a>";
      }).join("");
    }
    if (soonEl) soonEl.innerHTML = SOON.map(soonHtml).join("");

    // The history is about the rounds that have actually run, so it is
    // computed over PAST — a round with no dates has no teams and no people,
    // and folding it in would only pull every number down.
    //
    // One set of facts, two mounts: the heading renders above the stat tiles
    // and the prose below them. Computed once so the two can never be guarded
    // by different answers to the same question.
    var facts = storyFacts(PAST, TEAMS_BY_ROUND, ROSTER_BY_ROUND);
    if (storyHeadEl) storyHeadEl.innerHTML = storyHeadingHtml(facts);
    if (storyEl) storyEl.innerHTML = storyHtml(facts);
    if (coachesEl) coachesEl.innerHTML = coachesHtml(dedupeCoaches(PAST, ROSTER_BY_ROUND));
    // Only offered when there is genuinely a round to register interest in.
    if (ctaEl) ctaEl.innerHTML = ctaHtml(SOON[0] || null);

    wireLogos(soonEl);
    wireFaces(coachesEl);
  }

  function render() {
    mount.innerHTML = PAST.map(roundHtml).join("");
    wireLogos(mount);

    if (countEl) {
      if (!query) {
        countEl.textContent = "";
      } else {
        var n = mount.querySelectorAll(".hk-team").length;
        countEl.textContent = n === 1 ? "1 team matches" : n + " teams match";
      }
    }
    if (clearBtn) clearBtn.classList.toggle("hidden", !query);
  }

  // ------------------------------------------------------------
  // Disclosure behaviour
  // ------------------------------------------------------------

  // Paint one button and its panel. No bookkeeping and no re-render: a
  // re-render would replace the button the reader just pressed and focus would
  // fall back to <body> mid-interaction.
  //
  // aria-expanded is set here on EVERY button this touches, which is the point
  // of routing the close through the same function as the open — the round
  // being closed has to announce that it closed, not just look closed.
  function paintOpen(btn, willOpen) {
    if (!btn) return;
    var panel = document.getElementById(btn.getAttribute("aria-controls"));
    btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
    if (panel) panel.hidden = !willOpen;
    var cueText = willOpen ? "Hide details" : "Show details";
    var cue = btn.querySelector(".hk-round-cue");
    if (cue) cue.textContent = cueText;
    var name = btn.getAttribute("data-hk-name");
    if (name) btn.setAttribute("aria-label", cueText + " for " + name);
  }

  // Open one round and close whichever was open. At most one, always.
  function setOpen(btn, willOpen) {
    if (!btn) return;
    var slug = btn.getAttribute("data-hk-toggle");
    if (willOpen && mount.querySelectorAll) {
      Array.prototype.forEach.call(mount.querySelectorAll("[data-hk-toggle]"), function (other) {
        if (other !== btn && other.getAttribute("aria-expanded") === "true") paintOpen(other, false);
      });
    }
    paintOpen(btn, willOpen);
    openSlug = willOpen ? slug : null;
  }

  mount.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest) return;
    var btn = e.target.closest("[data-hk-toggle]");
    if (!btn) return;
    var slug = btn.getAttribute("data-hk-toggle");
    // The rule lives in nextOpenRound(), so what the page does on a click is
    // decided by something that can be tested without a browser.
    setOpen(btn, nextOpenRound(openSlug, slug) === slug);
  });

  // A link to #eduhackai-2 should land on an open round, not a closed one —
  // and, now that only one round can be open, it closes whatever else was.
  // A deep link is a request for one specific round, so it wins outright.
  function openFromHash() {
    var hash = String(window.location.hash || "").slice(1);
    if (!hash) return;
    var section = document.getElementById(hash);
    if (!section) return;
    var btn = section.querySelector ? section.querySelector("[data-hk-toggle]") : null;
    if (btn) setOpen(btn, true);
    section.scrollIntoView({ block: "start" });
  }

  window.addEventListener("hashchange", openFromHash);

  // ------------------------------------------------------------
  // Register-interest dialog
  // ------------------------------------------------------------

  function fieldInput(name) {
    return interestForm ? interestForm.querySelector('[name="' + name + '"]') : null;
  }

  function fieldErrorEl(name) {
    var input = fieldInput(name);
    if (!input) return null;
    return document.getElementById(input.getAttribute("aria-describedby"));
  }

  function readValues() {
    var out = {};
    FIELDS.forEach(function (name) {
      var input = fieldInput(name);
      out[name] = input ? String(input.value || "").trim() : "";
    });
    return out;
  }

  function clearFieldErrors() {
    FIELDS.forEach(function (name) {
      var input = fieldInput(name);
      var err = fieldErrorEl(name);
      if (input) input.removeAttribute("aria-invalid");
      if (err) { err.textContent = ""; err.hidden = true; }
    });
  }

  function showFieldErrors(fields) {
    clearFieldErrors();
    Object.keys(fields || {}).forEach(function (name) {
      var input = fieldInput(name);
      var err = fieldErrorEl(name);
      if (input) input.setAttribute("aria-invalid", "true");
      if (err) { err.textContent = fields[name]; err.hidden = false; }
    });
  }

  function firstErrorField(fields) {
    for (var i = 0; i < FIELDS.length; i++) {
      if (fields && fields[FIELDS[i]]) return FIELDS[i];
    }
    return null;
  }

  // Every visible change the dialog makes goes through here, so the DOM can
  // only ever show a state the machine actually produced.
  function applyState(next) {
    STATE = next;
    if (!interestForm) return;

    var sending = STATE.name === "sending";
    var done = STATE.name === "done";

    interestForm.hidden = done;
    if (modalIntro) modalIntro.hidden = done;
    if (interestDone) interestDone.hidden = !done;
    interestForm.setAttribute("aria-busy", sending ? "true" : "false");

    if (interestSubmit) {
      interestSubmit.disabled = sending;
      interestSubmit.innerHTML = sending
        ? '<span class="hk-spin" aria-hidden="true"></span>Sending…'
        : "Tell me when it’s scheduled";
    }

    if (formError) {
      formError.textContent = STATE.message || "";
      formError.hidden = !STATE.message;
    }
    showFieldErrors(STATE.fields);

    if (done) {
      var roundName = interestRound ? interestRound.name : "the next round";
      if (STATE.already) {
        if (modalTitle) modalTitle.textContent = "You’re already on the list";
        if (doneText) {
          doneText.textContent = "Good news — this email is already down for " + roundName +
            ", so there is nothing more to do. We will be in touch the moment it is scheduled, " +
            "and your early bird discount still stands.";
        }
      } else {
        if (modalTitle) modalTitle.textContent = "You’re on the list";
        if (doneText) {
          doneText.textContent = "Thank you. We have your details, and we will let you know as soon as " +
            roundName + " has its dates — with your early bird discount waiting when registration opens.";
        }
      }
      if (modalTitle && modalTitle.focus) modalTitle.focus();
    }
  }

  function resetDialog(clearValues) {
    if (clearValues && interestForm && interestForm.reset) interestForm.reset();
    applyState(nextInterestState(STATE, { type: "reset" }));
    if (modalTitle && interestRound) {
      modalTitle.textContent = "Be with us in " + interestRound.name;
    }
  }

  // ============================================================
  // Modal behaviour, once, for both dialogs
  // ------------------------------------------------------------
  // There are two dialogs on this page — the interest form and the showcase
  // player — and they share every behaviour that is easy to get subtly wrong:
  // the focus trap, Escape, the background scroll lock, and returning focus to
  // whatever opened it. All of that is HERE, once. The two dialogs differ only
  // in their markup and in what they put inside themselves when they open,
  // which is what makeModal()'s three hooks are for.
  //
  // Writing the player a second focus trap of its own was the obvious cheap
  // option and is the reason this comment exists: two implementations of the
  // same rule drift, and the half that drifts is usually the one nobody opens
  // in a screen reader.
  //
  // The open dialogs are a STACK rather than a flag. Nothing on this page opens
  // one dialog from inside another today, but "which dialog does Escape close"
  // and "when is the scroll lock released" both need an answer that survives
  // it: Escape closes the topmost, and the lock lifts when the last one closes.
  // ============================================================

  var openModals = [];

  function topModal() {
    return openModals.length ? openModals[openModals.length - 1] : null;
  }

  // `iframe` is in this list and was not in the one this replaced, because the
  // player is the first thing in either dialog that HAS an iframe. An iframe is
  // in the browser's own tab order — Tab moves into it and then through the
  // YouTube player's controls — so leaving it out of the trap would have wrapped
  // focus from the close button straight back to the close button and locked a
  // keyboard user out of the play, seek and fullscreen controls of the video
  // they just opened. A focus trap that traps somebody away from the content is
  // worse than none.
  function focusableIn(box) {
    if (!box || !box.querySelectorAll) return [];
    var nodes = box.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])'
    );
    return Array.prototype.filter.call(nodes, function (el) {
      return el.getClientRects().length > 0;
    });
  }

  // opts.onOpen   — fill the dialog in. Runs BEFORE it is revealed, so nothing
  //                 half-built is ever on screen.
  // opts.onClose  — tear it down. Runs AFTER it is hidden and BEFORE focus is
  //                 restored, which is what lets the player destroy its iframe
  //                 without the focus move landing inside a dying frame.
  // opts.focusOn  — what to focus once it is open.
  function makeModal(root, box, opts) {
    if (!root) return null;
    opts = opts || {};
    var api = {
      root: root,
      box: box,
      lastFocus: null,
      isOpen: function () { return root.hidden === false; },
      open: function (opener) {
        // Opening one that is ALREADY open refills it rather than doing
        // nothing: the interest dialog can be asked for a different round and
        // the player for a different video, and "refuse, and leave the old
        // contents up" would be the wrong answer to both. Only the stack entry
        // is guarded, because pushing twice would need closing twice.
        var already = api.isOpen();
        // Recorded BEFORE anything is focused, so it is the element the visitor
        // actually pressed and not something this function moved focus to.
        api.lastFocus = opener || document.activeElement;
        if (opts.onOpen) opts.onOpen();
        root.hidden = false;
        if (!already) openModals.push(api);
        document.body.classList.add("hk-modal-open");
        var target = opts.focusOn ? opts.focusOn() : null;
        if (target && target.focus) target.focus();
      },
      close: function () {
        if (!api.isOpen()) return;
        root.hidden = true;
        openModals = openModals.filter(function (m) { return m !== api; });
        // Only when the LAST one closes: releasing it per-dialog would unlock
        // the page behind a dialog that is still open.
        if (!openModals.length) document.body.classList.remove("hk-modal-open");
        if (opts.onClose) opts.onClose();
        var back = api.lastFocus;
        api.lastFocus = null;
        if (back && back.focus) back.focus();
      }
    };
    return api;
  }

  var interestDialog = makeModal(modal, modalBox, {
    onOpen: function () {
      if (modalIntro && interestRound) {
        modalIntro.textContent = interestRound.name + " does not have its dates yet. Leave your " +
          "details and we will let you know the moment it is scheduled — and you will get the " +
          "early bird discount when registration opens.";
      }
      // A reopen after a success starts clean; a reopen after a failure keeps
      // whatever the visitor had already typed.
      resetDialog(STATE.name === "done");
    },
    onClose: function () {
      if (STATE.name === "done") resetDialog(true);
    },
    focusOn: function () {
      return fieldInput("full_name") || modalTitle;
    }
  });

  function openInterest(round, opener) {
    if (!interestDialog) return;
    interestRound = round;
    interestDialog.open(opener);
  }

  function closeInterest() {
    if (interestDialog) interestDialog.close();
  }

  // ---- the showcase player ----
  //
  // WHAT THE DIALOG HOLDS BETWEEN OPENINGS: nothing. The <iframe> is built by
  // onOpen and the host is EMPTIED by onClose, so a closed dialog contains no
  // player at all.
  //
  // That is the whole point rather than tidiness. Hiding a dialog that still
  // contains a YouTube frame leaves the video playing — audible, from nowhere
  // the visitor can see — and leaves the player's connection open behind a
  // dialog they believe they closed. `hidden` stops neither. Removing the
  // element does both, and it is what tools/hackathons-checks/check.mjs
  // asserts after every close.
  var pendingVideo = null;

  var videoDialog = makeModal(videoModal, videoModalBox, {
    onOpen: function () {
      // The dialog's accessible name IS the video's title: aria-labelledby
      // points at this heading and this heading is rewritten per video, so the
      // dialog announces "EduHackAI-2 Winner Solution (Clever Mart), dialog"
      // rather than "Video player, dialog" nine times.
      if (videoModalTitle) videoModalTitle.textContent = pendingVideo ? pendingVideo.title : "";
      if (videoModalMedia) {
        videoModalMedia.innerHTML = pendingVideo
          ? videoFrameHtml(pendingVideo.id, pendingVideo.title)
          : "";
      }
    },
    onClose: function () {
      if (videoModalMedia) videoModalMedia.innerHTML = "";
      pendingVideo = null;
    },
    // The close button rather than the frame. Focus inside a cross-origin
    // iframe is focus this page can no longer see or move, and a visitor who
    // opened a dialog needs the way out to be the first thing under their
    // hands. The trap keeps them in the dialog; the frame is one Tab away.
    focusOn: function () { return videoModalClose; }
  });

  function openVideo(btn) {
    if (!btn || !videoDialog) return;
    var id = safeVideoId(btn.getAttribute("data-hk-video"));
    if (!id) return;
    pendingVideo = { id: id, title: btn.getAttribute("data-hk-title") || "" };
    videoDialog.open(btn);
  }

  if (videosEl && videosEl.addEventListener) {
    videosEl.addEventListener("click", function (e) {
      if (!e.target || !e.target.closest) return;
      var btn = e.target.closest("[data-hk-video]");
      if (btn) openVideo(btn);
    });
  }

  // supabase-js turns any non-2xx into a FunctionsHttpError and keeps the
  // response on err.context — the { error, code } body is only reachable by
  // reading it back. Anything with no body at all (function not deployed,
  // network down) degrades to a generic message rather than a blank one.
  function readFunctionError(err) {
    var ctx = err && err.context;
    if (!ctx || typeof ctx.json !== "function") {
      return Promise.resolve({ error: "", code: "", field: "" });
    }
    return ctx.json().then(function (body) {
      body = body || {};
      return { error: body.error || "", code: body.code || "", field: body.field || "" };
    }, function () {
      return { error: "", code: "", field: "" };
    });
  }

  // No auth on this call, by design: the person filling it in has almost
  // certainly never signed in. The client is imported lazily, the same way
  // the rest of this page does it, so a signed-out visitor is never waiting
  // on a module they do not need until they press the button.
  function submitInterest(values) {
    return import("./lib/supabase-client.js?v=aba5b41535").then(function (mod) {
      return mod.supabase.functions.invoke("register-interest", {
        body: {
          full_name: values.full_name,
          email: values.email,
          mobile: values.mobile,
          current_job: values.current_job,
          round_slug: interestRound ? interestRound.slug : ""
        }
      });
    }).then(function (res) {
      if (res && res.error) {
        return readFunctionError(res.error).then(function (payload) { throw payload; });
      }
      var data = (res && res.data) || {};
      if (data.ok !== true) throw { error: data.error || "", code: data.code || "", field: data.field || "" };
      return { already: !!data.already };
    });
  }

  if (interestForm) {
    interestForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (STATE.name === "sending") return;

      var values = readValues();
      var check = validateInterest(values);
      if (!check.ok) {
        applyState(nextInterestState(STATE, {
          type: "invalid",
          message: "Please check the highlighted fields.",
          fields: check.errors
        }));
        var bad = firstErrorField(check.errors);
        var input = bad && fieldInput(bad);
        if (input && input.focus) input.focus();
        return;
      }

      applyState(nextInterestState(STATE, { type: "submit" }));

      submitInterest(values).then(function (result) {
        applyState(nextInterestState(STATE, { type: "ok", already: result.already }));
      }, function (payload) {
        payload = payload || {};
        var field = fieldForCode(payload.code, payload.field);
        var message = payload.error ||
          "We couldn’t save that just now. Please try again in a moment.";
        var fields = {};
        // Nothing here touches the inputs' values: a failure must not cost
        // somebody what they typed.
        if (field) fields[field] = payload.error || "Please check this field.";
        applyState(nextInterestState(STATE, { type: "fail", message: message, fields: fields }));
        var input = field && fieldInput(field);
        if (input && input.focus) input.focus();
        else if (formError && formError.focus) formError.focus();
      });
    });
  }

  document.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest) return;

    var opener = e.target.closest("[data-hk-open]");
    if (opener) {
      var slug = opener.getAttribute("data-hk-open");
      var round = ROUNDS.filter(function (r) { return r.slug === slug; })[0];
      if (round) openInterest(round, opener);
      return;
    }

    // One rule for both dialogs: the backdrop, the round × and the Cancel and
    // Close buttons all carry data-hk-dismiss, and it closes whichever dialog
    // is on top.
    var open = topModal();
    if (open && e.target.closest("[data-hk-dismiss]")) open.close();
  });

  // Escape and the focus trap are bound at the document, not at either dialog,
  // so they still work if focus ever ends up outside the box — and so there is
  // one implementation of them rather than one per dialog.
  document.addEventListener("keydown", function (e) {
    var top = topModal();
    if (!top) return;

    if (e.key === "Escape") {
      e.preventDefault();
      top.close();
      return;
    }
    if (e.key !== "Tab") return;

    var list = focusableIn(top.box);
    if (!list.length) { e.preventDefault(); return; }
    var first = list[0];
    var last = list[list.length - 1];
    var active = document.activeElement;
    var inside = top.box && top.box.contains(active);

    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  });

  // ------------------------------------------------------------
  // Search
  // ------------------------------------------------------------

  if (searchInput) {
    searchInput.addEventListener("input", function () {
      query = searchInput.value.trim().toLowerCase();
      if (ROUNDS.length) render();
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      searchInput.value = "";
      query = "";
      render();
      searchInput.focus();
    });
  }

  // ------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------

  function setStatus(html, isError) {
    if (!statusEl) return;
    statusEl.innerHTML = html;
    statusEl.classList.toggle("is-error", !!isError);
    statusEl.hidden = !html;
  }

  // Exposed only so tools/ and a Node harness can exercise the pure logic
  // without a browser. Nothing on the page reads this.
  window.HK_TESTABLE = {
    isComingSoon: isComingSoon,
    medalTier: medalTier,
    medalLabel: medalLabel,
    podiumTeams: podiumTeams,
    summarise: summarise,
    validateInterest: validateInterest,
    fieldForCode: fieldForCode,
    nextInterestState: nextInterestState,
    formatRange: formatRange,
    safeId: safeId,
    nextOpenRound: nextOpenRound,
    coachPhotoSlug: coachPhotoSlug,
    coachProfile: coachProfile,
    coachDisplayName: coachDisplayName,
    coachPhotoSrc: coachPhotoSrc,
    coachLinkUrl: coachLinkUrl,
    coachProfiles: COACH_PROFILES,
    appsByRound: APPS_BY_ROUND,
    appsForRound: appsForRound,
    roundFigures: roundFigures,
    // A renderer rather than a rule, exposed for one reason: every round on the
    // page now HAS an app count, so "a round without one renders no chip"
    // cannot be asserted off a rendered card any more. It is asserted on this
    // function instead, which is the function the card is built by.
    figureChipsHtml: figureChipsHtml,
    dedupeCoaches: dedupeCoaches,
    storyFacts: storyFacts,
    listSentence: listSentence,
    eduhackerCountries: EDUHACKER_COUNTRIES,
    countriesForRounds: countriesForRounds,
    demoVideos: DEMO_VIDEOS,
    playlistUrl: PLAYLIST_URL,
    safeVideoId: safeVideoId,
    // The scroller's one rule, and the player's one string. Both are exposed
    // for the same reason: they are the parts of a browser feature that can be
    // decided without a browser, so they are the parts the harness can hold.
    railEdges: railEdges,
    railBehavior: railBehavior,
    videoFrameHtml: videoFrameHtml,
    markText: markText,
    noWrap: noWrap
  };

  // The hero's brand mark is static markup, so it is wired straight away
  // rather than waiting on the database — there is nothing about it that
  // depends on what comes back.
  wireLogos(document);

  // Same reasoning for the demo videos: the playlist is a fixed list in this
  // file, not a query, so it is rendered at boot rather than inside
  // renderChrome(). Putting it there would have made nine videos that have
  // nothing to do with the archive disappear whenever the archive failed to
  // load — and the posters are lazy, so rendering them early costs nothing
  // until they scroll into view.
  if (videosEl) {
    videosEl.innerHTML = videosHtml(DEMO_VIDEOS);
    // Wired straight after the markup exists, for the same reason: the rail
    // does not wait on the archive either. paintRail() runs inside this, so the
    // Previous button is already correctly disabled before the first frame.
    wireRail(videosEl);
  }

  setStatus("Loading the EduHackAI archive…", false);

  load().then(function () {
    if (!ROUNDS.length) {
      setStatus("No rounds have been published yet.", false);
      return;
    }
    setStatus("", false);
    renderChrome();
    render();

    // Deep link straight to a round, e.g. hackathons.html#eduhackai-2.
    // Rendering happens after load, so the browser's own jump has already
    // missed; this repeats it — and opens the round — once the sections
    // exist.
    openFromHash();
  }).catch(function (err) {
    if (isMissingSchema(err)) {
      setStatus(
        "The EduHackAI archive isn’t published yet. The completed rounds are harvested " +
        "and ready to load — this page fills in as soon as they are.",
        false
      );
    } else {
      setStatus("Couldn’t load the hackathon archive just now. Please try again later.", true);
      if (window.console && console.error) console.error("hackathons:", err);
    }
  });
})();
