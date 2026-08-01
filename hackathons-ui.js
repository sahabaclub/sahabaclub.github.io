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
// addresses and tenant mailboxes for 150 real people, `anon` and
// `authenticated` hold no SELECT on it, and the view's column list IS the
// privacy boundary. Querying the table here would fail, and if it ever
// stopped failing that would be the bug.
//
// This page is honest about gaps by design. Rounds 3 and 4 have no
// recorded placings, no team has a project title or a demo link, and
// round 4 has no end date — every one of those is a real absence in the
// source, documented in supabase/seed/hackathons/README.md. The UI says
// "not recorded" where that is the truth and never renders an empty slot
// that reads as "nobody won".
// ============================================================

(function () {
  "use strict";

  var mount = document.getElementById("hack-rounds");
  if (!mount) return;

  var statusEl = document.getElementById("hack-status");
  var statsEl = document.getElementById("hack-stats");
  var jumpEl = document.getElementById("hack-jump");
  var searchInput = document.getElementById("hack-q");
  var clearBtn = document.getElementById("hack-clear-q");
  var countEl = document.getElementById("hack-count");

  var ROUNDS = [];        // rounds, newest first
  var TEAMS_BY_ROUND = {};
  var ROSTER_BY_ROUND = {};
  var query = "";

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function parseDay(iso) {
    if (!iso) return null;
    var p = String(iso).slice(0, 10).split("-");
    if (p.length !== 3) return null;
    return { y: +p[0], m: +p[1], d: +p[2] };
  }

  // "24 May – 28 Jun 2025", collapsing the year when both dates share one.
  // A missing end date is a real gap on round 4, so it reads "From 6 Dec
  // 2025" rather than inventing a dash to nowhere.
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

  var medalIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="15" r="6"/><path d="M8.2 9.5 5.5 3h5l2 4M15.8 9.5 18.5 3h-5"/></svg>';
  var peopleIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19"/><circle cx="10" cy="7.5" r="3.5"/><path d="M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.2a3.5 3.5 0 0 1 0 6.6"/></svg>';
  var pinIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.4"/></svg>';
  var chevron = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

  var ORDINAL = { 1: "1st", 2: "2nd", 3: "3rd" };

  function placeLabel(rank) {
    return ORDINAL[rank] || (rank + "th");
  }

  // ------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------

  // Migration 0020 has not been applied to the live database yet, so the
  // three objects below may genuinely not exist. That is a "not published
  // yet" state, not a crash — the page says so plainly instead of showing
  // a broken shell. Any other error is reported as an error.
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
        return a.name.localeCompare(b.name);
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
  // profile_user_id. For the other 150-odd it is a plain name, which is
  // the whole point of the roster view.
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
    // `award` is NULL on every seeded team — the winners file records a
    // position and no category — so this only ever renders if a later
    // round actually names its awards.
    if (team.award) {
      head += '<span class="hk-award">' + escapeHtml(team.award) + "</span>";
    }
    if (team.is_recruiting) {
      head += '<span class="hk-badge is-recruiting">Looking for members</span>';
    }

    // No team in the seed has a project title, so the team name IS the
    // heading and the summary sits underneath as prose. Rendering an
    // empty "Project:" line for all 43 would be noise.
    var title = team.project_title
      ? '<p class="hk-team-project">' + escapeHtml(team.project_title) + "</p>"
      : "";

    var summary = team.project_summary
      ? '<p class="hk-team-summary">' + escapeHtml(team.project_summary) + "</p>"
      : '<p class="hk-team-summary is-empty">No project description was recorded for this team.</p>';

    // project_url / demo_url / repo_url are NULL for all 43 seeded teams
    // because no such column exists in the source lists. The row is built
    // from whatever is actually present and omitted entirely when empty,
    // so the card never shows a dead "Demo" affordance.
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
          '<h4 class="hk-team-name">' + escapeHtml(team.name) + "</h4>" +
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
  // Rounds
  // ------------------------------------------------------------

  function roundHtml(round) {
    var teams = TEAMS_BY_ROUND[round.id] || [];
    var roster = ROSTER_BY_ROUND[round.id] || [];

    // Coaches are lifted out of the team rosters and shown once per round.
    // Round 2's Members list links two coaches to team "Reham", which the
    // seed README flags as a probable data-entry artefact rather than
    // those two competing. Showing them in the round's coach row instead
    // of inside that team's roster keeps the source link intact without
    // publishing the implication that they entered.
    var coaches = roster.filter(function (p) { return p.is_mentor; });
    var competitors = roster.filter(function (p) { return !p.is_mentor; });

    var byTeam = {};
    var unaffiliated = [];
    competitors.forEach(function (p) {
      if (p.team_id) (byTeam[p.team_id] = byTeam[p.team_id] || []).push(p);
      else unaffiliated.push(p);
    });
    Object.keys(byTeam).forEach(function (k) { byTeam[k].sort(byName); });
    unaffiliated.sort(byName);
    coaches.sort(byName);

    var visibleTeams = teams.filter(function (t) { return matches(round, t, byTeam[t.id] || []); });
    var showUnaffiliated = !query || matches(round, null, unaffiliated);

    // ---- header ----
    var chips = [];
    if (round.mode) chips.push('<span class="hk-chip is-mode">' + escapeHtml(round.mode) + "</span>");
    if (round.location) chips.push('<span class="hk-chip">' + pinIcon + escapeHtml(round.location) + "</span>");
    if (round.partner) chips.push('<span class="hk-chip">' + escapeHtml(round.partner) + "</span>");
    if (round.status && round.status !== "completed") {
      chips.push('<span class="hk-chip is-live">' + escapeHtml(round.status.replace(/_/g, " ")) + "</span>");
    }

    var when = formatRange(round.starts_on, round.ends_on);
    // Round 4's end date is genuinely unrecorded. formatRange already
    // renders "From 6 Dec 2025"; this adds the reason so a reader does
    // not assume the round is still running.
    var whenNote = (round.starts_on && !round.ends_on && round.status === "completed")
      ? '<span class="hk-when-note">end date not recorded</span>'
      : "";

    var ranked = teams.filter(function (t) { return t.rank; });
    var podium = ranked.length
      ? '<div class="hk-podium">' + ranked.slice(0, 3).map(function (t) {
          return '<div class="hk-podium-item is-rank-' + t.rank + '">' +
            '<span class="hk-podium-place">' + medalIcon + placeLabel(t.rank) + "</span>" +
            '<span class="hk-podium-team">' + escapeHtml(t.name) + "</span>" +
          "</div>";
        }).join("") + "</div>"
      // "rank IS NULL" means the placings were never written down, which
      // is not the same as nobody placing. The page says which one it is.
      : '<p class="hk-no-placings">Placings for this round were never recorded in the source, so none are shown here. That means <em>unknown</em>, not that no team placed.</p>';

    var coachRow = coaches.length
      ? '<div class="hk-coaches">' +
          '<h4 class="hk-sub">Coaches</h4>' +
          '<div class="hk-roster">' + coaches.map(function (c) {
            return personHtml(c, { hideRoles: true });
          }).join("") + "</div>" +
        "</div>"
      : "";

    var teamsHtml = visibleTeams.length
      ? '<div class="hk-team-grid">' + visibleTeams.map(function (t) {
          return teamHtml(t, byTeam[t.id] || []);
        }).join("") + "</div>"
      : '<p class="hk-empty">No teams in this round match your search.</p>';

    // 55 of 150 participants have no team, because the source records
    // none for them. They took part and are named here rather than
    // dropped, but nobody is assigned a team by inference.
    var unaffiliatedHtml = (unaffiliated.length && showUnaffiliated)
      ? '<details class="hk-unaffiliated">' +
          "<summary><span>" + peopleIcon + unaffiliated.length +
          " more took part with no team recorded</span>" + chevron + "</summary>" +
          '<div class="hk-roster">' + unaffiliated.map(function (p) {
            return personHtml(p);
          }).join("") + "</div>" +
        "</details>"
      : "";

    var desc = round.description
      ? '<p class="hk-round-desc">' + escapeHtml(round.description) + "</p>"
      // Round 1's SitePage was never edited off the Microsoft template,
      // so it has no description at all. Saying so beats a blank gap.
      : '<p class="hk-round-desc is-empty">No description was recorded for this round.</p>';

    return '' +
      '<section class="hk-round" id="' + escapeHtml(round.slug) + '">' +
        '<header class="hk-round-head">' +
          '<span class="hk-round-num">Round ' + escapeHtml(round.round_number) + "</span>" +
          '<h3 class="hk-round-name glow-text">' + escapeHtml(round.name) + "</h3>" +
          (round.tagline ? '<p class="hk-round-tagline">' + escapeHtml(round.tagline) + "</p>" : "") +
          (when ? '<p class="hk-round-when">' + escapeHtml(when) + whenNote + "</p>" : "") +
          (chips.length ? '<div class="hk-chips">' + chips.join("") + "</div>" : "") +
        "</header>" +
        desc +
        podium +
        coachRow +
        '<h4 class="hk-sub">Teams <span class="hk-sub-count">' + teams.length + "</span></h4>" +
        teamsHtml +
        unaffiliatedHtml +
      "</section>";
  }

  function byName(a, b) {
    return String(a.full_name || "").localeCompare(String(b.full_name || ""));
  }

  // Search spans the things a person would actually look for: their own
  // name, a team name, and what a team built.
  function matches(round, team, members) {
    if (!query) return true;
    var hay = [];
    if (team) hay.push(team.name, team.project_title, team.project_summary, team.tagline);
    if (round) hay.push(round.name, round.tagline);
    members.forEach(function (m) { hay.push(m.full_name, m.role_in_team); });
    return hay.join("   ").toLowerCase().indexOf(query) !== -1;
  }

  // ------------------------------------------------------------
  // Render
  // ------------------------------------------------------------

  function totals() {
    var teams = 0, people = 0, placings = 0;
    ROUNDS.forEach(function (r) {
      var t = TEAMS_BY_ROUND[r.id] || [];
      teams += t.length;
      people += (ROSTER_BY_ROUND[r.id] || []).length;
      placings += t.filter(function (x) { return x.rank; }).length;
    });
    return { rounds: ROUNDS.length, teams: teams, people: people, placings: placings };
  }

  function statHtml(value, label) {
    return '<div class="hk-stat"><span class="hk-stat-num">' + value +
      '</span><span class="hk-stat-label">' + escapeHtml(label) + "</span></div>";
  }

  function renderChrome() {
    var t = totals();
    if (statsEl) {
      statsEl.innerHTML =
        statHtml(t.rounds, t.rounds === 1 ? "round" : "rounds") +
        statHtml(t.teams, "teams") +
        statHtml(t.people, "builders") +
        statHtml(t.placings, "placings recorded");
    }
    if (jumpEl) {
      jumpEl.innerHTML = ROUNDS.map(function (r) {
        return '<a class="hk-jump-link" href="#' + escapeHtml(r.slug) + '">Round ' +
          escapeHtml(r.round_number) + "</a>";
      }).join("");
    }
  }

  function render() {
    mount.innerHTML = ROUNDS.map(roundHtml).join("");

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
  // Boot
  // ------------------------------------------------------------

  function setStatus(html, isError) {
    if (!statusEl) return;
    statusEl.innerHTML = html;
    statusEl.classList.toggle("is-error", !!isError);
    statusEl.hidden = !html;
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
    // missed; this repeats it once the sections exist.
    if (window.location.hash) {
      var target = document.getElementById(window.location.hash.slice(1));
      if (target) target.scrollIntoView({ block: "start" });
    }
  }).catch(function (err) {
    if (isMissingSchema(err)) {
      setStatus(
        "The EduHackAI archive isn’t published yet. The four completed rounds " +
        "are harvested and ready to load — this page fills in as soon as they are.",
        false
      );
    } else {
      setStatus("Couldn’t load the hackathon archive just now. Please try again later.", true);
      if (window.console && console.error) console.error("hackathons:", err);
    }
  });

  // ---- search ----
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
})();
