// ============================================================
// Sahaba Club — Events page UI
// ------------------------------------------------------------
// Renders the upcoming-events grid and powers the search and
// filter bar. Loaded only by events.html, after events-data.js.
// ============================================================

// ---- Featured mega-events banner --------------------------------------
// A hand-controllable carousel of the region's landmark AI conferences,
// built from FEATURED_EVENTS (featured-events.js). The track holds two
// copies of the list and the scroll position wraps at the halfway mark,
// so it loops seamlessly in either direction. Auto-advance is a scroll
// nudge per frame rather than a CSS animation, which is what lets the
// arrows, swipe and pause button all share one source of truth.
(function () {
  var track = document.getElementById("featured-track");
  var viewport = document.getElementById("featured-viewport");
  var strip = document.getElementById("featured-strip");
  if (!track || !viewport || typeof FEATURED_EVENTS === "undefined") return;

  var prevBtn = document.getElementById("featured-prev");
  var nextBtn = document.getElementById("featured-next");
  var playBtn = document.getElementById("featured-play");

  var now = new Date();
  now.setHours(0, 0, 0, 0);

  // Drop editions that have already finished, but keep entries whose dates
  // haven't been announced (empty sortDate) and park them at the end.
  var live = FEATURED_EVENTS.filter(function (f) {
    if (!f.sortDate) return true;
    return new Date(f.sortDate + "T23:59:59") >= now;
  }).sort(function (a, b) {
    if (!a.sortDate) return 1;
    if (!b.sortDate) return -1;
    return new Date(a.sortDate) - new Date(b.sortDate);
  });

  if (!live.length) {
    if (strip) strip.parentNode.removeChild(strip);
    return;
  }

  var pin = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.4"/></svg>';
  var arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>';

  // The Machines Can Think mark: a chip with an eye, and a wordmark whose
  // last verb cycles. Drawn in markup so it stays crisp and recolourable
  // instead of being baked into a video.
  var MCT_CHIP = '<svg class="mct-chip" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" aria-hidden="true">' +
    '<rect x="14" y="14" width="36" height="36" rx="4.5"/>' +
    '<path d="M21 8v6M28 8v6M36 8v6M43 8v6M21 50v6M28 50v6M36 50v6M43 50v6M8 21h6M8 28h6M8 36h6M8 43h6M50 21h6M50 28h6M50 36h6M50 43h6"/>' +
    '<path d="M4.5 32h9.5M50 32h9.5"/>' +
    '<circle cx="3" cy="32" r="2.4"/><circle cx="61" cy="32" r="2.4"/>' +
    '<circle cx="21.5" cy="21.5" r="1.7" fill="currentColor" stroke="none"/>' +
    '<circle cx="42.5" cy="21.5" r="1.7" fill="currentColor" stroke="none"/>' +
    '<circle cx="21.5" cy="42.5" r="1.7" fill="currentColor" stroke="none"/>' +
    '<circle cx="42.5" cy="42.5" r="1.7" fill="currentColor" stroke="none"/>' +
    '<path class="mct-eye" d="M22 32q10-8.5 20 0-10 8.5-20 0z"/>' +
    '<circle cx="32" cy="32" r="3.4"/>' +
    '</svg>';

  var MCT_VERBS = ["SEE", "THINK", "LEARN", "CREATE"];
  // Must match the mct-verb animation duration in styles.css: each verb
  // holds the slot for CYCLE / verbs.length seconds.
  var MCT_CYCLE = 8;

  function buildMctLogo() {
    var wrap = document.createElement("div");
    wrap.className = "mct";
    var slot = MCT_CYCLE / MCT_VERBS.length;
    var cycle = MCT_VERBS.map(function (w, i) {
      return '<span class="mct-verb" style="animation-delay:' +
        (i * slot).toFixed(2) + 's">' + w + '</span>';
    }).join("");
    wrap.innerHTML = MCT_CHIP +
      '<span class="mct-words">' +
        '<span class="mct-l1">MACHINES</span>' +
        '<span class="mct-l2">CAN <span class="mct-cycle">' + cycle +
          '<span class="mct-ghost">' + MCT_VERBS.slice().sort(function (a, b) {
            return b.length - a.length;
          })[0] + '</span></span></span>' +
      '</span>';
    return wrap;
  }

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    return Math.round((new Date(dateStr + "T00:00:00") - now) / 86400000);
  }

  // First letter of each significant word, e.g. "GITEX GLOBAL" -> "GG".
  function initials(name) {
    return name.split(/\s+/)
      .filter(function (w) { return !/^(the|of|and|can|&)$/i.test(w); })
      .slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); })
      .join("");
  }

  function buildFeatured(f) {
    var a = document.createElement("a");
    a.className = "featured-card accent-" + (f.accent || "violet") +
      " tile-" + (f.tile === "light" ? "light" : "dark");
    a.href = f.link;
    a.target = "_blank";
    a.rel = "noopener";

    // --- logo panel: left side on desktop, a bar across the top on phones ---
    var media = document.createElement("div");
    media.className = "featured-media";

    function addInitials() {
      var fallback = document.createElement("span");
      fallback.className = "featured-initials";
      fallback.textContent = initials(f.name);
      media.appendChild(fallback);
    }

    if (f.live === "mct") {
      media.appendChild(buildMctLogo());
      media.classList.add("has-live");
    } else if (f.logo) {
      var img = document.createElement("img");
      img.className = "featured-logo";
      img.src = f.logo;
      img.alt = f.name + " logo";
      // Deliberately not lazy: the strip sits above the fold, and cards are
      // moved by scrolling their container rather than entering the page.
      img.decoding = "async";
      // The initials are only ever a stand-in for a missing logo. They must
      // not be rendered alongside one — logos have transparent backgrounds,
      // so the letters would show straight through the artwork.
      img.addEventListener("error", function () {
        img.parentNode && img.parentNode.removeChild(img);
        addInitials();
      });
      media.appendChild(img);
    } else {
      addInitials();
    }
    a.appendChild(media);

    // --- content panel ---
    var body = document.createElement("div");
    body.className = "featured-body";

    var head = document.createElement("div");
    head.className = "featured-card-head";

    var date = document.createElement("span");
    date.className = "featured-date";
    date.textContent = f.dateLabel;
    head.appendChild(date);

    var d = daysUntil(f.sortDate);
    if (d !== null && d >= 0 && d <= 120) {
      var soon = document.createElement("span");
      soon.className = "featured-soon";
      soon.textContent = d === 0 ? "Today" : d === 1 ? "Tomorrow" : d + " days to go";
      head.appendChild(soon);
    }
    body.appendChild(head);

    var name = document.createElement("h3");
    name.className = "featured-name";
    name.textContent = f.name;
    body.appendChild(name);

    if (f.note) {
      var note = document.createElement("p");
      note.className = "featured-note";
      note.textContent = f.note;
      body.appendChild(note);
    }

    var meta = document.createElement("div");
    meta.className = "featured-meta";

    var place = document.createElement("span");
    place.className = "featured-place";
    place.innerHTML = pin + " <span></span>";
    place.querySelector("span").textContent =
      f.venue ? f.venue + " · " + f.city : f.city;
    meta.appendChild(place);

    if (f.scale) {
      var scale = document.createElement("span");
      scale.className = "featured-scale";
      scale.textContent = f.scale;
      meta.appendChild(scale);
    }
    body.appendChild(meta);

    var cta = document.createElement("span");
    cta.className = "featured-cta";
    cta.innerHTML = "Event details " + arrow;
    body.appendChild(cta);

    a.appendChild(body);
    return a;
  }

  // Two passes: the second is a visual duplicate that makes the wrap
  // invisible. It's hidden from assistive tech and taken out of the tab
  // order so the list is only announced once.
  [0, 1].forEach(function (pass) {
    live.forEach(function (f) {
      var card = buildFeatured(f);
      if (pass === 1) {
        card.setAttribute("aria-hidden", "true");
        card.setAttribute("tabindex", "-1");
      }
      track.appendChild(card);
    });
  });

  // ---- carousel motion + controls ---------------------------------------
  var SPEED = 0.55;            // px per frame at 60fps — a readable drift
  var playing = true;
  var pausedByUser = false;
  var hovering = false;
  var dragging = false;
  var raf = null;
  // Auto-advance writes scrollLeft every frame, which cancels an in-flight
  // smooth scroll. Holding it off briefly lets an arrow press complete.
  var holdUntil = 0;

  function half() { return track.scrollWidth / 2; }

  function step(px) {
    var h = half();
    if (!h) return;
    var x = viewport.scrollLeft + px;
    if (x >= h) x -= h;
    if (x < 0) x += h;
    viewport.scrollLeft = x;
  }

  function frame() {
    if (playing && !hovering && !dragging && Date.now() > holdUntil) step(SPEED);
    raf = window.requestAnimationFrame(frame);
  }

  function cardStride() {
    var card = track.querySelector(".featured-card");
    if (!card) return 320;
    var style = window.getComputedStyle(card);
    return card.getBoundingClientRect().width + parseFloat(style.marginRight || 0);
  }

  // Arrow presses jump a whole card. The position is always assigned
  // directly so the button can never appear dead — the easing comes from
  // temporarily switching the container to smooth scrolling, which degrades
  // to an instant jump wherever that isn't honoured. scrollTo({behavior})
  // was unreliable here because the per-frame auto-advance cancels it.
  function nudge(dir) {
    var h = half();
    if (!h) return;
    holdUntil = Date.now() + 700;
    var target = viewport.scrollLeft + dir * cardStride();
    var wraps = target < 0 || target >= h;
    if (wraps) {
      // Jumping across the seam must not be animated, or the strip visibly
      // rewinds through every card.
      viewport.style.scrollBehavior = "auto";
      step(dir * cardStride());
    } else {
      viewport.style.scrollBehavior = "smooth";
      viewport.scrollLeft = target;
    }
    window.setTimeout(function () { viewport.style.scrollBehavior = "auto"; }, 700);
  }

  function setPlaying(on) {
    playing = on;
    pausedByUser = !on;
    if (!playBtn) return;
    playBtn.setAttribute("aria-pressed", on ? "false" : "true");
    playBtn.setAttribute("aria-label", on ? "Pause the events carousel" : "Play the events carousel");
    playBtn.title = on ? "Pause" : "Play";
    playBtn.classList.toggle("is-paused", !on);
  }

  if (prevBtn) prevBtn.addEventListener("click", function () { nudge(-1); });
  if (nextBtn) nextBtn.addEventListener("click", function () { nudge(1); });
  if (playBtn) playBtn.addEventListener("click", function () { setPlaying(!playing); });

  // Hovering or focusing a card holds the strip still so it can be read
  // and clicked; leaving resumes unless the user pressed pause.
  viewport.addEventListener("mouseenter", function () { hovering = true; });
  viewport.addEventListener("mouseleave", function () { hovering = false; });
  viewport.addEventListener("focusin", function () { hovering = true; });
  viewport.addEventListener("focusout", function () { hovering = false; });

  // Touch and mouse dragging: the browser scrolls the container natively,
  // we just stop auto-advance while a finger is down and wrap afterwards.
  viewport.addEventListener("pointerdown", function () { dragging = true; });
  window.addEventListener("pointerup", function () {
    if (!dragging) return;
    dragging = false;
    var h = half();
    if (h && viewport.scrollLeft >= h) viewport.scrollLeft -= h;
  });
  viewport.addEventListener("scroll", function () {
    if (dragging) return;
    var h = half();
    if (h && viewport.scrollLeft >= h) viewport.scrollLeft -= h;
  }, { passive: true });

  // Keyboard control when the strip itself has focus.
  viewport.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight") { e.preventDefault(); nudge(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); nudge(-1); }
  });

  // Don't burn frames while the page is in a background tab.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (raf) { window.cancelAnimationFrame(raf); raf = null; }
    } else if (!raf) {
      raf = window.requestAnimationFrame(frame);
    }
  });

  // Respect a stated preference for less motion: the strip still scrolls by
  // hand, it just doesn't drift on its own.
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || document.documentElement.classList.contains("reduce-motion")) {
    setPlaying(false);
  } else {
    setPlaying(true);
    raf = window.requestAnimationFrame(frame);
  }
})();

// The mega events used to be copied out of FEATURED_EVENTS into the grid at
// runtime, because they only existed in featured-events.js. They now live in
// the database like every other event — carrying the same "Mega Event" tag —
// so that merge step is gone. Re-adding it would double them up.
//
// featured-events.js still drives the carousel at the top of the page; only
// the grid's copy of them moved.

// ---- Upcoming events, as a date-grouped agenda -------------------------
// Events arrive from the database, get grouped by day, and hang off a
// timeline. Layered on top: each member's own favourites, whether they're
// going, who else from the club is going, and a recommended strip.
//
// Everything personal is additive. Signed out, this is exactly the public
// events list it always was — no errors, no empty widgets.
(function () {
  var grid = document.getElementById("events-grid");
  if (!grid) return;

  var emptyMsg = document.getElementById("events-empty");
  var noMatchMsg = document.getElementById("events-no-match");

  var EVENTS_ALL = [];
  var social = null;
  var favourites = new Set();
  var myRegistrations = {};
  var attendees = {};
  var viewCounts = {};
  var signedIn = false;

  function fromRow(row) {
    return {
      id: row.id,
      title: row.title,
      country: row.country,
      location: row.location,
      date: row.event_date,
      time: row.time_label,
      price: row.price_label,
      mode: row.mode,
      tags: row.tags || [],
      registerLink: row.register_link,
      mapsLink: row.maps_link,
      image: row.image_url,
      brand: row.brand,
      description: row.description,
      tierRequired: row.tier_required
    };
  }

  function loadEventsFromDatabase() {
    return import("./lib/supabase-client.js").then(function (mod) {
      var todayIso = new Date().toISOString().slice(0, 10);
      return mod.supabase
        .from("events")
        .select("*")
        .eq("is_published", true)
        .gte("event_date", todayIso)
        .order("event_date", { ascending: true });
    }).then(function (res) {
      if (res.error) throw res.error;
      EVENTS_ALL = (res.data || []).map(fromRow);
    });
  }

  // Personal layer. Any failure here leaves the public list intact rather
  // than taking the page down with it.
  function loadSocial() {
    return import("./lib/event-social.js").then(function (mod) {
      social = mod;
      return mod.currentUserId();
    }).then(function (uid) {
      signedIn = !!uid;
      if (!signedIn) return null;
      return Promise.all([
        social.loadFavourites(),
        social.loadMyRegistrations(),
        social.loadViewCounts(),
        social.loadAttendees(EVENTS_ALL.map(function (e) { return e.id; }))
      ]).then(function (r) {
        favourites = r[0];
        myRegistrations = r[1];
        viewCounts = r[2];
        attendees = r[3];
      });
    }).catch(function () {
      signedIn = false;
    });
  }

  var ACCESS = { tier: "guest", canSignIn: false };

  function refreshAccess() {
    return import("./lib/supabase-client.js").then(function (client) {
      if (!client.isConfigured) return null;
      ACCESS.canSignIn = true;
      return import("./lib/tier-gate.js").then(function (m) { return m.getAccessLevel(); });
    }).then(function (level) {
      if (level) ACCESS.tier = level.tier;
    }).catch(function () {});
  }

  var pinIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.4"/></svg>';
  var heartIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 22l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>';
  var heartFilled = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 22l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>';
  var sparkIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 6.1L20 10l-5.8 1.9L12 18l-2.2-6.1L4 10l5.8-1.9z"/></svg>';

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function dayParts(iso) {
    var p = iso.split("-");
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    var today = new Date();
    var todayIso = today.toISOString().slice(0, 10);
    var tomorrowIso = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
    var label = d.getUTCDate() + " " + MONTHS[d.getUTCMonth()];
    if (iso === todayIso) label = "Today";
    else if (iso === tomorrowIso) label = "Tomorrow";
    return { label: label, weekday: WEEKDAYS[d.getUTCDay()], isToday: iso === todayIso };
  }

  function facesHtml(list) {
    if (!list || !list.length) return "";
    var shown = list.slice(0, 4);
    var rest = list.length - shown.length;
    var html = '<span class="ev-faces">';
    shown.forEach(function (p) {
      if (p.avatar) {
        html += '<img class="ev-face" src="' + escapeHtml(p.avatar) + '" alt="' + escapeHtml(p.name) + '" loading="lazy">';
      } else {
        html += '<span class="ev-face ev-face-initial" title="' + escapeHtml(p.name) + '">' +
          escapeHtml(String(p.name || "?").trim().charAt(0).toUpperCase()) + '</span>';
      }
    });
    html += '</span><span class="ev-face-more">' +
      (rest > 0 ? "+" + rest + " going" : (list.length === 1 ? "1 going" : list.length + " going")) +
      '</span>';
    return html;
  }

  function buildCard(e, reason) {
    var locked = e.tierRequired === "premium" && ACCESS.tier !== "premium";
    var status = myRegistrations[e.id];
    var isFav = favourites.has(e.id);

    var card = document.createElement("article");
    card.className = "ev-card" + (locked ? " is-locked" : "");
    card.setAttribute("data-event", e.id);

    var thumbHtml = e.image
      ? '<img class="ev-thumb" src="' + escapeHtml(e.image) + '" alt="" loading="lazy">'
      : '<div class="ev-thumb-fallback">&#128197;</div>';

    var where = e.mode === "Online" ? "Online" : (e.location || e.country || "");

    var foot = [];
    if (e.tierRequired === "premium") foot.push('<span class="ev-status is-premium">Premium</span>');
    if (status === "registered") foot.push('<span class="ev-status is-going">Going</span>');
    else if (status === "interested") foot.push('<span class="ev-status is-interested">Interested</span>');

    if (locked) {
      var lockHref = (ACCESS.tier === "guest" && ACCESS.canSignIn) ? "login.html" : "membership.html";
      var lockText = (ACCESS.tier === "guest" && ACCESS.canSignIn) ? "Sign in" : "Premium only";
      foot.push('<a class="ev-register" href="' + lockHref + '">' + lockText + '</a>');
    } else if (e.registerLink && status !== "registered") {
      foot.push('<button type="button" class="ev-register" data-register="' + e.id + '">Register</button>');
    }

    var att = attendees[e.id];
    if (att && att.length) foot.push(facesHtml(att));

    var favBtn = signedIn
      ? '<button type="button" class="ev-fav' + (isFav ? " is-on" : "") + '" data-fav="' + e.id +
        '" aria-pressed="' + (isFav ? "true" : "false") +
        '" aria-label="' + (isFav ? "Remove from favourites" : "Save to favourites") + '">' +
        (isFav ? heartFilled : heartIcon) + '</button>'
      : "";

    card.innerHTML =
      '<div>' +
        (e.time ? '<div class="ev-time">' + escapeHtml(e.time) + '</div>' : "") +
        '<h3 class="ev-title">' + escapeHtml(e.title) + '</h3>' +
        (where ? '<div class="ev-meta">' + pinIcon + '<span>' + escapeHtml(where) + '</span></div>' : "") +
        (reason ? '<div class="ev-rec-reason">' + sparkIcon + '<span>Because you like ' + escapeHtml(reason) + '</span></div>' : "") +
        '<div class="ev-foot">' + foot.join("") + '</div>' +
      '</div>' +
      '<div>' + thumbHtml + '</div>' +
      favBtn;

    // A broken image URL should leave a placeholder, not a torn card.
    var img = card.querySelector(".ev-thumb");
    if (img) {
      img.addEventListener("error", function () {
        var ph = document.createElement("div");
        ph.className = "ev-thumb-fallback";
        ph.innerHTML = "&#128197;";
        img.replaceWith(ph);
      });
    }

    return card;
  }

  var state = { q: "", when: "all", mode: "all", price: "all", tags: [] };
  var filtered = [];

  function matches(e) {
    if (state.mode !== "all" && e.mode !== state.mode) return false;
    if (state.price === "free" && /paid/i.test(e.price)) return false;
    if (state.price === "paid" && !/paid/i.test(e.price)) return false;

    if (state.when !== "all") {
      var d = new Date(e.date + "T00:00:00");
      var now = new Date();
      now.setHours(0, 0, 0, 0);
      if (state.when === "today") {
        if (d.getTime() !== now.getTime()) return false;
      } else {
        var limit = new Date(now.getTime() + parseInt(state.when, 10) * 86400000);
        if (d > limit) return false;
      }
    }

    if (state.tags.length) {
      var slugs = (e.tags || []).map(function (t) { return String(t).toLowerCase(); });
      if (!state.tags.some(function (t) { return slugs.indexOf(t) !== -1; })) return false;
    }

    if (state.q) {
      var hay = [e.title, e.location, e.country, e.description, (e.tags || []).join(" ")]
        .filter(Boolean).join(" ").toLowerCase();
      if (hay.indexOf(state.q.toLowerCase()) === -1) return false;
    }
    return true;
  }

  function renderList() {
    grid.innerHTML = "";
    filtered = EVENTS_ALL.filter(matches);

    // How many filters are actually narrowing things down. Drives the badge
    // on the Filters button and whether "Reset filters" is worth offering.
    var activeCount =
      (state.when !== "all" ? 1 : 0) +
      (state.mode !== "all" ? 1 : 0) +
      (state.price !== "all" ? 1 : 0) +
      state.tags.length +
      (state.q ? 1 : 0);

    var countEl = document.getElementById("filter-count");
    if (countEl) {
      countEl.textContent = filtered.length === EVENTS_ALL.length
        ? filtered.length + " upcoming events"
        : filtered.length + " of " + EVENTS_ALL.length + " events";
    }
    var badge = document.getElementById("filter-badge");
    if (badge) {
      badge.textContent = activeCount;
      badge.classList.toggle("hidden", activeCount === 0);
    }
    var applyCount = document.getElementById("filter-apply-count");
    if (applyCount) {
      applyCount.textContent = filtered.length === 1 ? "1 event" : filtered.length + " events";
    }
    var resetBtn = document.getElementById("filter-reset");
    if (resetBtn) resetBtn.classList.toggle("hidden", activeCount === 0);

    if (noMatchMsg) noMatchMsg.classList.toggle("hidden", filtered.length > 0);

    var byDay = [];
    var index = {};
    filtered.forEach(function (e) {
      if (!(e.date in index)) {
        index[e.date] = byDay.length;
        byDay.push({ date: e.date, items: [] });
      }
      byDay[index[e.date]].items.push(e);
    });

    byDay.forEach(function (day) {
      var parts = dayParts(day.date);
      var section = document.createElement("section");
      section.className = "ev-day" + (parts.isToday ? " is-today" : "");
      section.innerHTML =
        '<span class="ev-day-dot"></span>' +
        '<div class="ev-day-head">' +
          '<span class="ev-day-date">' + escapeHtml(parts.label) + '</span>' +
          '<span class="ev-day-weekday">' + escapeHtml(parts.weekday) + '</span>' +
        '</div>' +
        '<div class="ev-cards"></div>';
      var holder = section.querySelector(".ev-cards");
      day.items.forEach(function (e) { holder.appendChild(buildCard(e)); });
      grid.appendChild(section);
    });
  }

  function renderRecommended() {
    var host = document.getElementById("events-recommended");
    if (!host) return;
    if (!signedIn || !social) { host.innerHTML = ""; return; }

    var rec = social.recommendEvents(EVENTS_ALL, favourites, myRegistrations, viewCounts, 4);

    if (rec.needsSignal) {
      host.innerHTML =
        '<div class="ev-recommend">' +
          '<div class="ev-recommend-head"><h2 class="glow-text">Recommended for you</h2></div>' +
          '<p class="section-sub" style="text-align:left;margin:0;">Save a few events you like and ' +
          'we&rsquo;ll start suggesting others that fit &mdash; based on the topics, cities and formats you go for.</p>' +
        '</div>';
      return;
    }
    if (!rec.items.length) { host.innerHTML = ""; return; }

    host.innerHTML =
      '<div class="ev-recommend">' +
        '<div class="ev-recommend-head">' +
          '<h2 class="glow-text">Recommended for you</h2>' +
          '<span class="ev-recommend-why">from what you save and attend</span>' +
        '</div>' +
        '<div class="ev-rec-grid" id="ev-rec-grid"></div>' +
      '</div>';

    var recGrid = document.getElementById("ev-rec-grid");
    rec.items.forEach(function (item) {
      recGrid.appendChild(buildCard(item.event, item.why));
    });
  }

  function renderAll() {
    renderList();
    renderRecommended();
  }

  // ---- favourites ----
  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest ? ev.target.closest("[data-fav]") : null;
    if (!btn || !social) return;
    var id = btn.getAttribute("data-fav");
    var wasOn = favourites.has(id);

    // Flip straight away and put it back if the write fails — waiting on a
    // round trip for a heart makes the whole page feel slow.
    if (wasOn) favourites.delete(id); else favourites.add(id);
    renderAll();

    var p = wasOn ? social.removeFavourite(id) : social.addFavourite(id);
    p.then(function (res) {
      if (res && res.error) {
        if (wasOn) favourites.add(id); else favourites.delete(id);
        renderAll();
      }
    });
  });

  // ---- register, then ask on the way back ----
  var PENDING_KEY = "sc_pending_registration";

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest ? ev.target.closest("[data-register]") : null;
    if (!btn) return;
    var id = btn.getAttribute("data-register");
    var e = EVENTS_ALL.find(function (x) { return x.id === id; });
    if (!e || !e.registerLink) return;

    // Nothing is claimed yet. The ticketing site belongs to someone else, so
    // the only honest way to know whether they signed up is to ask them.
    if (signedIn) {
      try {
        sessionStorage.setItem(PENDING_KEY, JSON.stringify({ id: id, title: e.title, at: Date.now() }));
      } catch (err) {}
      if (social) social.recordView(id);
    }
    window.open(e.registerLink, "_blank", "noopener");
  });

  function pendingRegistration() {
    try {
      var raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      // Older than a couple of hours isn't a return from the registration
      // page any more, it's a new visit.
      if (Date.now() - p.at > 2 * 60 * 60 * 1000) {
        sessionStorage.removeItem(PENDING_KEY);
        return null;
      }
      return p;
    } catch (err) { return null; }
  }

  function clearPending() {
    try { sessionStorage.removeItem(PENDING_KEY); } catch (err) {}
  }

  function askDialog(html) {
    var back = document.createElement("div");
    back.className = "ev-ask-back";
    back.innerHTML = '<div class="ev-ask" role="dialog" aria-modal="true">' + html + '</div>';
    document.body.appendChild(back);
    return back;
  }

  function askDidYouRegister(p) {
    var back = askDialog(
      "<h3>Did you register?</h3>" +
      '<p>You opened the registration page for <span class="ev-ask-event">' +
      escapeHtml(p.title) + '</span>.</p>' +
      '<div class="ev-ask-actions">' +
        '<button type="button" class="btn btn-glow" data-yes>Yes, I registered</button>' +
        '<button type="button" class="btn btn-outline" data-no>Not yet</button>' +
      '</div>'
    );

    back.querySelector("[data-yes]").addEventListener("click", function () {
      back.remove();
      clearPending();
      myRegistrations[p.id] = "registered";
      renderAll();
      if (!social) return;
      social.setMyRegistration(p.id, "registered").then(function () {
        // Refresh the attendee list so they see themselves appear.
        return social.loadAttendees(EVENTS_ALL.map(function (x) { return x.id; }));
      }).then(function (a) {
        if (a) { attendees = a; renderAll(); }
      });
    });

    back.querySelector("[data-no]").addEventListener("click", function () {
      back.remove();
      clearPending();
      askAddToFavourites(p);
    });
  }

  function askAddToFavourites(p) {
    if (favourites.has(p.id)) return;
    var back = askDialog(
      "<h3>Save it for later?</h3>" +
      '<p>We can keep <span class="ev-ask-event">' + escapeHtml(p.title) +
      '</span> in your favourites, and use it to suggest events like it.</p>' +
      '<div class="ev-ask-actions">' +
        '<button type="button" class="btn btn-glow" data-yes>Add to favourites</button>' +
        '<button type="button" class="btn btn-outline" data-no>No thanks</button>' +
      '</div>'
    );

    back.querySelector("[data-yes]").addEventListener("click", function () {
      back.remove();
      favourites.add(p.id);
      renderAll();
      if (social) social.addFavourite(p.id);
    });

    back.querySelector("[data-no]").addEventListener("click", function () {
      back.remove();
      // They looked but passed. Still worth knowing — a weaker signal than a
      // favourite, and the recommender weights it accordingly.
      myRegistrations[p.id] = "interested";
      renderAll();
      if (social) social.setMyRegistration(p.id, "interested");
    });
  }

  function checkPendingOnReturn() {
    if (document.visibilityState !== "visible") return;
    if (document.querySelector(".ev-ask-back")) return;
    var p = pendingRegistration();
    if (p) askDidYouRegister(p);
  }

  document.addEventListener("visibilitychange", checkPendingOnReturn);
  window.addEventListener("focus", checkPendingOnReturn);

  // ---- filters ----
  function wireChipGroup(id, attr, key) {
    var box = document.getElementById(id);
    if (!box) return;
    box.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".filter-chip") : null;
      if (!btn) return;
      state[key] = btn.getAttribute(attr);
      Array.prototype.forEach.call(box.querySelectorAll(".filter-chip"), function (b) {
        b.classList.toggle("is-active", b === btn);
      });
      renderList();
    });
  }
  wireChipGroup("filter-when", "data-when", "when");
  wireChipGroup("filter-mode", "data-mode", "mode");
  wireChipGroup("filter-price", "data-price", "price");

  var qInput = document.getElementById("filter-q");
  var clearQBtn = document.getElementById("filter-clear-q");
  if (qInput) {
    qInput.addEventListener("input", function () {
      state.q = qInput.value.trim();
      if (clearQBtn) clearQBtn.classList.toggle("hidden", !state.q);
      renderList();
    });
  }
  if (clearQBtn) {
    clearQBtn.addEventListener("click", function () {
      state.q = "";
      if (qInput) qInput.value = "";
      clearQBtn.classList.add("hidden");
      renderList();
    });
  }

  var tagsWrap = document.getElementById("filter-tags");
  function buildTagChips() {
    if (!tagsWrap) return;
    tagsWrap.innerHTML = "";
    var counts = {};
    EVENTS_ALL.forEach(function (e) {
      (e.tags || []).forEach(function (t) {
        var k = String(t).toLowerCase();
        counts[k] = counts[k] || { label: t, n: 0 };
        counts[k].n++;
      });
    });
    Object.keys(counts)
      .sort(function (a, b) { return counts[b].n - counts[a].n || a.localeCompare(b); })
      .forEach(function (k) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "filter-chip";
        b.setAttribute("data-tag", k);
        b.setAttribute("aria-pressed", "false");
        b.innerHTML = escapeHtml(counts[k].label) + '<span class="chip-count">' + counts[k].n + '</span>';
        tagsWrap.appendChild(b);
      });
  }
  if (tagsWrap) {
    tagsWrap.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".filter-chip") : null;
      if (!btn || !tagsWrap.contains(btn)) return;
      var tag = btn.getAttribute("data-tag");
      var i = state.tags.indexOf(tag);
      if (i === -1) state.tags.push(tag); else state.tags.splice(i, 1);
      btn.classList.toggle("is-active", i === -1);
      btn.setAttribute("aria-pressed", i === -1 ? "true" : "false");
      renderList();
    });
  }

  function resetAll() {
    state = { q: "", when: "all", mode: "all", price: "all", tags: [] };
    if (qInput) qInput.value = "";
    ["filter-when", "filter-mode", "filter-price"].forEach(function (id) {
      var box = document.getElementById(id);
      if (!box) return;
      Array.prototype.forEach.call(box.querySelectorAll(".filter-chip"), function (b, idx) {
        b.classList.toggle("is-active", idx === 0);
      });
    });
    if (tagsWrap) {
      Array.prototype.forEach.call(tagsWrap.querySelectorAll(".filter-chip"), function (b) {
        b.classList.remove("is-active");
        b.setAttribute("aria-pressed", "false");
      });
    }
    renderList();
  }
  ["filter-reset", "filter-reset-sheet"].forEach(function (id) {
    var b = document.getElementById(id);
    if (b) b.addEventListener("click", resetAll);
  });

  // ---- mobile filter sheet ----
  var panel = document.getElementById("filter-panel");
  var backdrop = document.getElementById("filter-backdrop");
  var openBtn = document.getElementById("filter-open");
  var closeBtn = document.getElementById("filter-close");
  var applyBtn = document.getElementById("filter-apply");

  function openSheet() {
    if (!panel) return;
    panel.classList.add("is-open");
    if (backdrop) backdrop.hidden = false;
    document.body.classList.add("filters-open");
    if (openBtn) openBtn.setAttribute("aria-expanded", "true");
  }
  function closeSheet() {
    if (!panel) return;
    panel.classList.remove("is-open");
    if (backdrop) backdrop.hidden = true;
    document.body.classList.remove("filters-open");
    if (openBtn) openBtn.setAttribute("aria-expanded", "false");
  }
  if (openBtn) openBtn.addEventListener("click", openSheet);
  if (closeBtn) closeBtn.addEventListener("click", closeSheet);
  if (applyBtn) applyBtn.addEventListener("click", closeSheet);
  if (backdrop) backdrop.addEventListener("click", closeSheet);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && panel && panel.classList.contains("is-open")) closeSheet();
  });
  window.addEventListener("resize", function () {
    if (window.innerWidth > 820 && panel && panel.classList.contains("is-open")) closeSheet();
  });

  // ---- go ----
  loadEventsFromDatabase().then(function () {
    if (EVENTS_ALL.length === 0) {
      if (emptyMsg) emptyMsg.classList.remove("hidden");
      return null;
    }
    buildTagChips();
    // Draw the public list immediately; the personal layer arrives after and
    // re-renders, so events appear without waiting on a signed-in check.
    renderList();
    return Promise.all([loadSocial(), refreshAccess()]).then(function () {
      renderAll();
      checkPendingOnReturn();
    });
  }).catch(function (err) {
    console.error("Could not load events:", err);
    if (emptyMsg) {
      emptyMsg.textContent = "We couldn't load the events just now. Please refresh, or try again shortly.";
      emptyMsg.classList.remove("hidden");
    }
  });
})();
