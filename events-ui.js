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

// ---- Mega events also join the main list ------------------------------
// The featured strip and the grid below it are two views of the same
// events, so these are derived from FEATURED_EVENTS rather than typed out
// again — one place to edit, no chance of the two drifting apart. They
// carry a "Mega Event" tag so they can be filtered as a group.
(function () {
  if (typeof EVENTS === "undefined" || typeof FEATURED_EVENTS === "undefined") return;

  FEATURED_EVENTS.forEach(function (f) {
    // The grid sorts and filters on a real date, so an edition whose dates
    // haven't been announced can't be placed in it. It stays in the strip.
    if (!f.sortDate) return;
    // Guard against a double-add if this ever runs twice.
    if (EVENTS.some(function (e) { return e.title === f.name; })) return;

    EVENTS.push({
      title: f.name,
      country: f.city,
      location: f.venue,
      date: f.sortDate,
      time: f.dateLabel,
      price: "Paid",
      mode: "In-Person",
      tags: ["AI", "Mega Event"],
      registerLink: f.link,
      description: f.note + (f.scale ? " " + f.scale + "." : "")
    });
  });
})();

// Upcoming events grid — reads from the EVENTS array defined in
// events-data.js (only present on events.html). Automatically hides
// past events, sorts what's left by date, and loads results in
// batches of 9 as the user scrolls.
(function () {
  var grid = document.getElementById("events-grid");
  if (!grid || typeof EVENTS === "undefined") return;
  var emptyMsg = document.getElementById("events-empty");

  // Premium-only events render locked until we know better. "guest" is
  // the safe default — it's what an unauthenticated visitor actually is,
  // and it means nobody sees a Premium event unlocked for a flash before
  // we've confirmed their tier. refreshAccessThenRerender() (bottom of
  // this file) swaps in the real tier once lib/tier-gate.js resolves.
  var ACCESS = { tier: "guest", canSignIn: false };

  function refreshAccessThenRerender() {
    import("./lib/supabase-client.js").then(function (client) {
      // Before the Supabase project exists there is no sign-in page worth
      // sending anyone to, so locked events point at membership.html
      // instead. Same reasoning as the nav links in script.js.
      if (!client.isConfigured) return null;
      ACCESS.canSignIn = true;
      return import("./lib/tier-gate.js").then(function (mod) {
        return mod.getAccessLevel();
      });
    }).then(function (level) {
      if (!level) return;
      ACCESS.tier = level.tier;
      applyFilters();
    }).catch(function () {
      // Offline or CDN unreachable — stay on the safe "guest" default.
    });
  }

  var pinIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.4"/></svg>';
  var calIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg>';

  var KNOWN_TAG_CLASSES = ["ai", "agentic", "cloud", "media", "coding", "security", "business", "startups", "investors", "hackathon"];

  function tagSlug(tag) {
    return String(tag).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  // Deterministic fallback color for any tag not in the fixed palette above,
  // so new tags added later still get a consistent (if arbitrary) color.
  function hashHue(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    return hash % 360;
  }

  function formatDate(iso) {
    var parts = iso.split("-");
    var d = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear();
  }

  var today = new Date();
  today.setHours(0, 0, 0, 0);

  // Events come from the database now, not events-data.js. Staff add and edit
  // them in the admin dashboard and the change is live immediately — no code
  // commit, and no GitHub token handed to whoever manages the calendar.
  //
  // Filled in by loadEventsFromDatabase() before anything renders. Declared
  // here because every function below closes over it.
  var upcoming = [];

  // The database uses clearer column names than the old file did; the render
  // code below still speaks the original shape, so translate once here rather
  // than touching a dozen call sites.
  function fromRow(row) {
    return {
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
      tierRequired: row.tier_required,
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
      upcoming = (res.data || []).map(fromRow);
    });
  }

  // ---- search + filter state -------------------------------------------
  var noMatchMsg = document.getElementById("events-no-match");
  var qInput = document.getElementById("filter-q");
  var clearQBtn = document.getElementById("filter-clear-q");
  var tagsWrap = document.getElementById("filter-tags");
  var countEl = document.getElementById("filter-count");
  var resetBtn = document.getElementById("filter-reset");
  var resetSheetBtn = document.getElementById("filter-reset-sheet");
  var openBtn = document.getElementById("filter-open");
  var closeBtn = document.getElementById("filter-close");
  var applyBtn = document.getElementById("filter-apply");
  var applyCount = document.getElementById("filter-apply-count");
  var panel = document.getElementById("filter-panel");
  var backdrop = document.getElementById("filter-backdrop");
  var badge = document.getElementById("filter-badge");

  var state = { q: "", when: "all", mode: "all", price: "all", tags: [] };
  var filtered = upcoming.slice();

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Wraps the current search term where it appears, so people can see why
  // a card matched. Escaping happens first so event copy can't inject HTML.
  function highlight(text) {
    var safe = escapeHtml(text);
    if (!state.q) return safe;
    var re = new RegExp("(" + state.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
    return safe.replace(re, '<span class="hl">$1</span>');
  }

  function haystack(e) {
    return [e.title, e.description, e.location, e.country, e.mode, e.price, (e.tags || []).join(" ")]
      .join(" ").toLowerCase();
  }

  function daysFromToday(dateStr) {
    var d = new Date(dateStr + "T00:00:00");
    return Math.round((d - today) / 86400000);
  }

  function matches(e) {
    if (state.q && haystack(e).indexOf(state.q.toLowerCase()) === -1) return false;
    if (state.mode !== "all" && e.mode !== state.mode) return false;
    if (state.price !== "all") {
      var paid = /paid/i.test(e.price || "");
      if (state.price === "paid" && !paid) return false;
      if (state.price === "free" && paid) return false;
    }
    if (state.when !== "all") {
      var diff = daysFromToday(e.date);
      if (state.when === "today" && diff !== 0) return false;
      if (state.when === "7" && (diff < 0 || diff > 7)) return false;
      if (state.when === "30" && (diff < 0 || diff > 30)) return false;
    }
    // Tags are OR'd — picking AI and Cloud shows events tagged either.
    if (state.tags.length) {
      var evTags = (e.tags || []).map(function (t) { return t.toLowerCase(); });
      var hit = state.tags.some(function (t) { return evTags.indexOf(t) !== -1; });
      if (!hit) return false;
    }
    return true;
  }

  function buildCard(evt) {
    var isPaid = /paid/i.test(evt.price);
    var isPremiumLocked = evt.tierRequired === "premium" && ACCESS.tier !== "premium";
    var card = document.createElement("div");
    card.className = "event-card" + (isPremiumLocked ? " event-card-locked" : "");

    if (evt.image) {
      var img = document.createElement("img");
      img.className = "event-card-image";
      img.src = evt.image;
      img.alt = evt.title;
      img.loading = "lazy";
      card.appendChild(img);
    } else if (evt.brand === "microsoft") {
      var placeholder = document.createElement("div");
      placeholder.className = "event-card-image event-ms-placeholder";

      var msLogo = document.createElement("span");
      msLogo.className = "ms-logo";
      ["ms-logo-sq1", "ms-logo-sq2", "ms-logo-sq3", "ms-logo-sq4"].forEach(function (cls) {
        var sq = document.createElement("span");
        sq.className = "ms-logo-sq " + cls;
        msLogo.appendChild(sq);
      });
      placeholder.appendChild(msLogo);

      var msTitle = document.createElement("span");
      msTitle.className = "ms-placeholder-title";
      msTitle.textContent = evt.title;
      placeholder.appendChild(msTitle);

      var msCaption = document.createElement("span");
      msCaption.className = "ms-placeholder-caption";
      msCaption.textContent = "Official Microsoft Training";
      placeholder.appendChild(msCaption);

      card.appendChild(placeholder);
    }

    var badges = document.createElement("div");
    badges.className = "event-badges";

    var badge = document.createElement("span");
    badge.className = "event-price-badge " + (isPaid ? "is-paid" : "is-free");
    badge.textContent = evt.price;
    badges.appendChild(badge);

    if (evt.mode) {
      var modeBadge = document.createElement("span");
      var modeSlug = evt.mode === "Online" ? "is-online" : "is-in-person";
      modeBadge.className = "event-mode-badge " + modeSlug;
      modeBadge.textContent = evt.mode;
      badges.appendChild(modeBadge);
    }

    if (evt.tierRequired === "premium") {
      var tierBadge = document.createElement("span");
      tierBadge.className = "event-tier-badge";
      tierBadge.textContent = "Premium";
      badges.appendChild(tierBadge);
    }

    if (evt.tags && evt.tags.length) {
      evt.tags.slice(0, 2).forEach(function (tag) {
        var tagBadge = document.createElement("span");
        var slug = tagSlug(tag);
        tagBadge.className = "event-tag-badge" + (KNOWN_TAG_CLASSES.indexOf(slug) !== -1 ? " tag-" + slug : "");
        if (KNOWN_TAG_CLASSES.indexOf(slug) === -1) {
          var hue = hashHue(slug);
          tagBadge.style.setProperty("--tag-color", "hsl(" + hue + ", 85%, 78%)");
          tagBadge.style.setProperty("--tag-bg", "hsla(" + hue + ", 85%, 55%, 0.14)");
          tagBadge.style.setProperty("--tag-border", "hsla(" + hue + ", 85%, 55%, 0.4)");
        }
        tagBadge.textContent = tag;
        badges.appendChild(tagBadge);
      });
    }

    card.appendChild(badges);

    var title = document.createElement("h3");
    title.className = "event-title";
    title.innerHTML = highlight(evt.title);
    card.appendChild(title);

    var loc = document.createElement("p");
    loc.className = "event-meta";
    loc.innerHTML = pinIcon + " <span></span>";
    loc.querySelector("span").textContent = evt.location + ", " + evt.country;
    card.appendChild(loc);

    var when = document.createElement("p");
    when.className = "event-meta";
    when.innerHTML = calIcon + " <span></span>";
    when.querySelector("span").textContent = formatDate(evt.date) + " · " + evt.time;
    card.appendChild(when);

    if (evt.description) {
      var wrap = document.createElement("div");
      wrap.className = "event-desc-wrap";

      var desc = document.createElement("p");
      desc.className = "event-desc";
      desc.innerHTML = highlight(evt.description);
      wrap.appendChild(desc);

      // The toggle lives OUTSIDE the clamped <p> on purpose: text clipped by
      // -webkit-line-clamp can't be clicked, so a toggle appended inside the
      // clamped paragraph would sometimes get hidden by the ellipsis itself.
      var toggle = document.createElement("span");
      toggle.className = "event-desc-toggle";
      toggle.textContent = "more details";
      toggle.setAttribute("role", "button");
      toggle.setAttribute("tabindex", "0");
      wrap.appendChild(toggle);

      var expandCard = function () {
        var wasExpanded = card.classList.contains("is-expanded");
        Array.prototype.forEach.call(grid.querySelectorAll(".event-card.is-expanded"), function (openCard) {
          openCard.classList.remove("is-expanded");
          var t = openCard.querySelector(".event-desc-toggle");
          if (t) t.textContent = "more details";
        });
        if (!wasExpanded) {
          card.classList.add("is-expanded");
          toggle.textContent = "show less";
        }
      };

      toggle.addEventListener("click", expandCard);
      toggle.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          expandCard();
        }
      });

      card.appendChild(wrap);
    }

    var actions = document.createElement("div");
    actions.className = "event-actions";

    if (isPremiumLocked) {
      var lockBtn = document.createElement("a");
      lockBtn.className = "btn btn-outline";
      if (ACCESS.tier === "guest" && ACCESS.canSignIn) {
        lockBtn.href = "login.html";
        lockBtn.textContent = "Sign in to see if you can attend";
      } else {
        lockBtn.href = "membership.html";
        lockBtn.textContent = "Premium members only";
      }
      actions.appendChild(lockBtn);
    } else if (evt.registerLink) {
      var registerBtn = document.createElement("a");
      registerBtn.className = "btn btn-glow";
      registerBtn.href = evt.registerLink;
      registerBtn.target = "_blank";
      registerBtn.rel = "noopener";
      registerBtn.textContent = "Register";
      actions.appendChild(registerBtn);
    }

    if (evt.mapsLink && evt.mode !== "Online") {
      var mapsBtn = document.createElement("a");
      mapsBtn.className = "btn btn-outline";
      mapsBtn.href = evt.mapsLink;
      mapsBtn.target = "_blank";
      mapsBtn.rel = "noopener";
      mapsBtn.textContent = "Find Location";
      actions.appendChild(mapsBtn);
    }

    card.appendChild(actions);
    return card;
  }

  // Paginate: show 9 (three rows of three on desktop) at a time, loading
  // the next batch automatically once the user scrolls near the bottom.
  var PAGE_SIZE = 9;
  var renderedCount = 0;

  var sentinel = document.createElement("div");
  sentinel.className = "events-sentinel";

  var statusEl = document.createElement("p");
  statusEl.className = "events-load-more-status";
  statusEl.textContent = "Loading more events…";
  statusEl.style.display = "none";

  function renderNextBatch() {
    var next = filtered.slice(renderedCount, renderedCount + PAGE_SIZE);
    next.forEach(function (evt) {
      grid.insertBefore(buildCard(evt), sentinel);
    });
    renderedCount += next.length;

    if (renderedCount >= filtered.length) {
      statusEl.style.display = "none";
      if (observer) observer.disconnect();
      if (sentinel.parentNode) sentinel.parentNode.removeChild(sentinel);
    }
  }

  grid.appendChild(sentinel);
  grid.insertAdjacentElement("afterend", statusEl);

  var observer = null;
  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && renderedCount < filtered.length) {
          statusEl.style.display = "block";
          renderNextBatch();
          window.setTimeout(function () {
            statusEl.style.display = "none";
          }, 200);
        }
      });
    }, { rootMargin: "300px" });
  }

  // Rebuild the grid from scratch whenever the filters change, restarting
  // the 9-at-a-time pagination against the new result set.
  function rerender() {
    Array.prototype.forEach.call(grid.querySelectorAll(".event-card"), function (c) {
      c.parentNode.removeChild(c);
    });
    renderedCount = 0;
    if (observer) observer.disconnect();
    if (!sentinel.parentNode) grid.appendChild(sentinel);

    renderNextBatch();
    if (observer && renderedCount < filtered.length) observer.observe(sentinel);

    if (noMatchMsg) noMatchMsg.classList.toggle("hidden", filtered.length !== 0);
  }

  function isFiltering() {
    return state.q || state.when !== "all" || state.mode !== "all" ||
           state.price !== "all" || state.tags.length > 0;
  }

  // Counts only the panel controls, not the search box — the search term is
  // already visible in its own field, so counting it would look like a bug.
  function activeFilterCount() {
    var n = state.tags.length;
    if (state.when !== "all") n++;
    if (state.mode !== "all") n++;
    if (state.price !== "all") n++;
    return n;
  }

  function updateSummary() {
    if (countEl) {
      countEl.textContent = filtered.length === upcoming.length
        ? "Showing all " + upcoming.length + " events"
        : "Showing " + filtered.length + " of " + upcoming.length + " events";
    }
    if (resetBtn) resetBtn.classList.toggle("hidden", !isFiltering());
    if (clearQBtn) clearQBtn.classList.toggle("hidden", !state.q);

    var n = activeFilterCount();
    if (badge) {
      badge.textContent = n;
      badge.classList.toggle("hidden", n === 0);
    }
    if (openBtn) openBtn.classList.toggle("has-filters", n > 0);
    if (applyCount) {
      applyCount.textContent = filtered.length === 1
        ? "1 event" : filtered.length + " events";
    }
  }

  function applyFilters() {
    filtered = upcoming.filter(matches);
    rerender();
    updateSummary();
  }

  // ---- wire up the controls --------------------------------------------
  function wireChipGroup(containerId, attr, key) {
    var box = document.getElementById(containerId);
    if (!box) return;
    box.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".filter-chip") : null;
      if (!btn || !box.contains(btn)) return;
      state[key] = btn.getAttribute(attr);
      Array.prototype.forEach.call(box.querySelectorAll(".filter-chip"), function (b) {
        b.classList.toggle("is-active", b === btn);
      });
      applyFilters();
    });
  }
  wireChipGroup("filter-when", "data-when", "when");
  wireChipGroup("filter-mode", "data-mode", "mode");
  wireChipGroup("filter-price", "data-price", "price");

  // Topic chips are generated from the data, with a count of how many
  // upcoming events carry each tag. Now that events arrive from the database
  // this has to run *after* they load, so it's a function rather than inline.
  function buildTagChips() {
    if (!tagsWrap) return;
    tagsWrap.innerHTML = "";
    var counts = {};
    upcoming.forEach(function (e) {
      (e.tags || []).forEach(function (t) {
        var k = t.toLowerCase();
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
        b.innerHTML = escapeHtml(counts[k].label) + '<span class="chip-count">' + counts[k].n + "</span>";
        tagsWrap.appendChild(b);
      });
  }

  // The click handler doesn't depend on the data, so it can be wired once.
  if (tagsWrap) {
    tagsWrap.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".filter-chip") : null;
      if (!btn || !tagsWrap.contains(btn)) return;
      var tag = btn.getAttribute("data-tag");
      var i = state.tags.indexOf(tag);
      if (i === -1) state.tags.push(tag); else state.tags.splice(i, 1);
      btn.classList.toggle("is-active", i === -1);
      btn.setAttribute("aria-pressed", i === -1 ? "true" : "false");
      applyFilters();
    });
  }

  if (qInput) {
    var debounce;
    qInput.addEventListener("input", function () {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(function () {
        state.q = qInput.value.trim();
        applyFilters();
      }, 160);
    });
  }
  if (clearQBtn) {
    clearQBtn.addEventListener("click", function () {
      qInput.value = "";
      state.q = "";
      applyFilters();
      qInput.focus();
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
    applyFilters();
  }
  if (resetBtn) resetBtn.addEventListener("click", resetAll);
  if (resetSheetBtn) resetSheetBtn.addEventListener("click", resetAll);

  // ---- mobile filter sheet ---------------------------------------------
  // Above 820px the panel is just part of the page, so these handlers sit
  // idle; the sheet chrome is hidden by CSS at that width.
  var lastFocus = null;

  function openSheet() {
    if (!panel) return;
    lastFocus = document.activeElement;
    panel.classList.add("is-open");
    if (backdrop) backdrop.hidden = false;
    document.body.classList.add("filters-open");
    if (openBtn) openBtn.setAttribute("aria-expanded", "true");
    if (closeBtn) closeBtn.focus();
  }

  function closeSheet() {
    if (!panel) return;
    panel.classList.remove("is-open");
    if (backdrop) backdrop.hidden = true;
    document.body.classList.remove("filters-open");
    if (openBtn) openBtn.setAttribute("aria-expanded", "false");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  if (openBtn) openBtn.addEventListener("click", openSheet);
  if (closeBtn) closeBtn.addEventListener("click", closeSheet);
  if (applyBtn) applyBtn.addEventListener("click", closeSheet);
  if (backdrop) backdrop.addEventListener("click", closeSheet);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && panel && panel.classList.contains("is-open")) closeSheet();
  });
  // Leaving phone width with the sheet open would strand body scroll-lock on.
  window.addEventListener("resize", function () {
    if (window.innerWidth > 820 && panel && panel.classList.contains("is-open")) closeSheet();
  });

  // Nothing can render until the events arrive, so this is the one entry
  // point. On failure the page says so rather than sitting on a spinner or
  // pretending there are simply no events on.
  loadEventsFromDatabase().then(function () {
    if (upcoming.length === 0) {
      if (emptyMsg) emptyMsg.classList.remove("hidden");
      return;
    }
    buildTagChips();
    applyFilters();
    refreshAccessThenRerender();
  }).catch(function (err) {
    console.error("Could not load events:", err);
    if (emptyMsg) {
      emptyMsg.textContent =
        "We couldn't load the events just now. Please refresh, or try again shortly.";
      emptyMsg.classList.remove("hidden");
    }
  });
})();
