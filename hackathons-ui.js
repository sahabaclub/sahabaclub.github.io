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

  var ROUNDS = [];          // every round, newest first
  var PAST = [];            // rounds with at least one date
  var SOON = [];            // rounds with no dates at all
  var TEAMS_BY_ROUND = {};
  var ROSTER_BY_ROUND = {};
  var query = "";
  var OPEN = {};            // slug -> true once the reader has opened it

  var interestRound = null; // the round the dialog is currently about
  var lastFocus = null;     // the button that opened the dialog
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
  var sparkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>';
  var chevron = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

  // ------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------

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

  function summarise(rounds, teamsBy, rosterBy) {
    var teams = 0, builders = 0, medals = 0;
    (rounds || []).forEach(function (r) {
      var t = (teamsBy && teamsBy[r.id]) || [];
      teams += t.length;
      builders += ((rosterBy && rosterBy[r.id]) || []).length;
      medals += t.filter(function (x) { return medalTier(x); }).length;
    });
    return { rounds: (rounds || []).length, teams: teams, builders: builders, medals: medals };
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
    return import("./lib/supabase-client.js").then(function (mod) {
      var sb = mod.supabase;
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
          .select("hackathon_id,team_id,full_name,role_in_team,is_mentor,is_judge,profile_user_id,avatar_url,headline")
      ]);
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
    var name = escapeHtml(p.full_name || "Unnamed participant");
    var avatar = p.avatar_url
      ? '<img class="hk-face" src="' + escapeHtml(p.avatar_url) + '" alt="" loading="lazy" width="34" height="34">'
      : '<span class="hk-face hk-face-initials" aria-hidden="true">' + escapeHtml(initials(p.full_name)) + "</span>";

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
    // A search opens every round that has something to show, so results are
    // never hidden behind a closed tab.
    var open = OPEN[round.slug] === true || (!!query && visibleTeams.length > 0);

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

    return '' +
      '<section class="hk-round" id="' + escapeHtml(round.slug) + '">' +
        '<div class="hk-round-head">' +
          '<h3 class="hk-round-h">' +
            '<button class="hk-round-toggle" type="button" id="' + tabId + '"' +
              ' aria-expanded="' + (open ? "true" : "false") + '"' +
              ' aria-controls="' + panelId + '" data-hk-toggle="' + escapeHtml(round.slug) + '">' +
              '<span class="hk-round-label">' +
                '<span class="hk-round-num">Round ' + escapeHtml(round.round_number) + "</span>" +
                '<span class="hk-round-name glow-text">' + escapeHtml(round.name) + "</span>" +
              "</span>" +
              // aria-hidden: aria-expanded already announces collapsed or
              // expanded, so this is a visual cue only and would otherwise
              // land in the button's accessible name twice over.
              '<span class="hk-round-cue" aria-hidden="true">' +
                (open ? "Hide details" : "Show details") + "</span>" +
              '<span class="hk-round-caret">' + chevron + "</span>" +
            "</button>" +
          "</h3>" +
          (round.tagline ? '<p class="hk-round-tagline">' + escapeHtml(round.tagline) + "</p>" : "") +
          (when ? '<p class="hk-round-when">' + escapeHtml(when) + whenNote + "</p>" : "") +
          chipsHtml(round) +
        "</div>" +
        medalsHtml(teams) +
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

  // The next round, before it has dates. Everything shown here is whatever
  // the row actually carries; the only thing this markup asserts on its own
  // is that the dates are not set, which is exactly why it is in this list.
  function soonHtml(round) {
    var desc = round.description
      ? '<p class="hk-soon-desc">' + escapeHtml(round.description) + "</p>"
      : "";
    return '' +
      '<section class="hk-soon" id="' + escapeHtml(round.slug) + '">' +
        '<span class="hk-soon-flag">' + sparkIcon + "Coming soon</span>" +
        '<h2 class="hk-soon-name glow-text">' + escapeHtml(round.name) + "</h2>" +
        (round.tagline ? '<p class="hk-soon-tagline">' + escapeHtml(round.tagline) + "</p>" : "") +
        desc +
        chipsHtml(round) +
        '<span class="hk-earlybird">' + sparkIcon + "Early bird discount</span>" +
        '<div class="hk-soon-actions">' +
          '<button type="button" class="btn btn-glow btn-lg" data-hk-open="' + escapeHtml(round.slug) + '">' +
            "Register your interest</button>" +
          '<p class="hk-soon-note">The dates aren’t set yet. If you are interested to be with us, ' +
            "leave your details and we’ll let you know as soon as it’s scheduled.</p>" +
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
    // waiting for its dates has no teams and no builders, and folding a
    // zero into these tiles would only make them read as a shrinking
    // programme.
    var t = summarise(PAST, TEAMS_BY_ROUND, ROSTER_BY_ROUND);
    if (statsEl) {
      statsEl.innerHTML = PAST.length
        ? statHtml(t.rounds, t.rounds === 1 ? "round so far" : "rounds so far") +
          statHtml(t.teams, "teams") +
          statHtml(t.builders, "builders") +
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
  }

  function render() {
    mount.innerHTML = PAST.map(roundHtml).join("");

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

  // Toggling in place rather than re-rendering: a re-render would replace
  // the button the reader just pressed, and focus would fall back to
  // <body> mid-interaction.
  function setOpen(btn, willOpen) {
    var panel = document.getElementById(btn.getAttribute("aria-controls"));
    btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
    if (panel) panel.hidden = !willOpen;
    var cue = btn.querySelector(".hk-round-cue");
    if (cue) cue.textContent = willOpen ? "Hide details" : "Show details";
    OPEN[btn.getAttribute("data-hk-toggle")] = willOpen;
  }

  mount.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest) return;
    var btn = e.target.closest("[data-hk-toggle]");
    if (!btn) return;
    setOpen(btn, btn.getAttribute("aria-expanded") !== "true");
  });

  // A link to #eduhackai-2 should land on an open round, not a closed one.
  function openFromHash() {
    var hash = String(window.location.hash || "").slice(1);
    if (!hash) return;
    var section = document.getElementById(hash);
    if (!section) return;
    var btn = section.querySelector ? section.querySelector("[data-hk-toggle]") : null;
    if (btn && btn.getAttribute("aria-expanded") !== "true") setOpen(btn, true);
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

  function focusableInBox() {
    if (!modalBox) return [];
    var nodes = modalBox.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    return Array.prototype.filter.call(nodes, function (el) {
      return el.getClientRects().length > 0;
    });
  }

  function openInterest(round, opener) {
    if (!modal) return;
    interestRound = round;
    lastFocus = opener || document.activeElement;

    if (modalIntro) {
      modalIntro.textContent = round.name + " does not have its dates yet. Leave your details and we " +
        "will let you know the moment it is scheduled — and you will get the early bird discount " +
        "when registration opens.";
    }
    // A reopen after a success starts clean; a reopen after a failure keeps
    // whatever the visitor had already typed.
    resetDialog(STATE.name === "done");

    modal.hidden = false;
    document.body.classList.add("hk-modal-open");

    var first = fieldInput("full_name");
    if (first && first.focus) first.focus();
    else if (modalTitle && modalTitle.focus) modalTitle.focus();
  }

  function closeInterest() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove("hk-modal-open");
    if (STATE.name === "done") resetDialog(true);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
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
    return import("./lib/supabase-client.js").then(function (mod) {
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

    if (modal && !modal.hidden && e.target.closest("[data-hk-dismiss]")) closeInterest();
  });

  // Escape and the focus trap are bound at the document, not the dialog, so
  // they still work if focus ever ends up outside the box.
  document.addEventListener("keydown", function (e) {
    if (!modal || modal.hidden) return;

    if (e.key === "Escape") {
      e.preventDefault();
      closeInterest();
      return;
    }
    if (e.key !== "Tab") return;

    var list = focusableInBox();
    if (!list.length) { e.preventDefault(); return; }
    var first = list[0];
    var last = list[list.length - 1];
    var active = document.activeElement;
    var inside = modalBox && modalBox.contains(active);

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
    safeId: safeId
  };

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
