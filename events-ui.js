// ============================================================
// Sahaba Club — Events page UI
// ------------------------------------------------------------
// Renders the upcoming-events grid and powers the search and
// filter bar. Loaded only by events.html, after events-data.js.
// ============================================================

// ---- Featured mega-events banner --------------------------------------
// Builds the scrolling strip at the top of the events page from
// FEATURED_EVENTS (featured-events.js). The track holds two copies of
// the card list so the CSS marquee can loop without a visible seam.
(function () {
  var track = document.getElementById("featured-track");
  var strip = document.getElementById("featured-strip");
  if (!track || typeof FEATURED_EVENTS === "undefined") return;

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

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    return Math.round((new Date(dateStr + "T00:00:00") - now) / 86400000);
  }

  function buildFeatured(f) {
    var a = document.createElement("a");
    a.className = "featured-card accent-" + (f.accent || "violet");
    a.href = f.link;
    a.target = "_blank";
    a.rel = "noopener";

    var head = document.createElement("div");
    head.className = "featured-card-head";

    var date = document.createElement("span");
    date.className = "featured-date";
    date.textContent = f.dateLabel;
    head.appendChild(date);

    var d = daysUntil(f.sortDate);
    if (d !== null && d >= 0 && d <= 60) {
      var soon = document.createElement("span");
      soon.className = "featured-soon";
      soon.textContent = d === 0 ? "Today" : d === 1 ? "Tomorrow" : "In " + d + " days";
      head.appendChild(soon);
    }
    a.appendChild(head);

    var name = document.createElement("h3");
    name.className = "featured-name";
    name.textContent = f.name;
    a.appendChild(name);

    if (f.note) {
      var note = document.createElement("p");
      note.className = "featured-note";
      note.textContent = f.note;
      a.appendChild(note);
    }

    var place = document.createElement("p");
    place.className = "featured-place";
    place.innerHTML = pin + " <span></span>";
    place.querySelector("span").textContent =
      f.venue ? f.venue + " · " + f.city : f.city;
    a.appendChild(place);

    var cta = document.createElement("span");
    cta.className = "featured-cta";
    cta.innerHTML = "Event details " + arrow;
    a.appendChild(cta);

    return a;
  }

  // Two passes: the second is a visual duplicate, hidden from assistive
  // tech and keyboard focus so the list is only announced once.
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

  // Longer lists need proportionally longer to travel the same distance,
  // otherwise the strip speeds up every time an event is added.
  track.style.setProperty("--featured-duration", (live.length * 8) + "s");
})();

// Upcoming events grid — reads from the EVENTS array defined in
// events-data.js (only present on events.html). Automatically hides
// past events, sorts what's left by date, and loads results in
// batches of 9 as the user scrolls.
(function () {
  var grid = document.getElementById("events-grid");
  if (!grid || typeof EVENTS === "undefined") return;
  var emptyMsg = document.getElementById("events-empty");

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

  var upcoming = EVENTS.filter(function (e) {
    var d = new Date(e.date + "T23:59:59");
    return d >= today;
  }).sort(function (a, b) {
    return new Date(a.date) - new Date(b.date);
  });

  if (upcoming.length === 0) {
    if (emptyMsg) emptyMsg.classList.remove("hidden");
    return;
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
    var card = document.createElement("div");
    card.className = "event-card";

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

    if (evt.registerLink) {
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
  // upcoming events carry each tag.
  if (tagsWrap) {
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

  applyFilters();
})();
