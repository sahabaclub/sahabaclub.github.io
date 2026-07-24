// Drifting starfield behind the whole page â the "AI universe" backdrop.
(function () {
  var canvas = document.getElementById("stars");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var w, h, stars;
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = document.documentElement.scrollHeight;
    var count = Math.floor((window.innerWidth * window.innerHeight) / 9000);
    stars = [];
    for (var i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.3 + 0.2,
        s: Math.random() * 0.4 + 0.05,
        o: Math.random() * 0.6 + 0.2,
      });
    }
  }

  function frame() {
    ctx.clearRect(0, 0, w, h);
    for (var i = 0; i < stars.length; i++) {
      var st = stars[i];
      if (!reduceMotion) {
        st.y += st.s;
        if (st.y > h) st.y = 0;
      }
      ctx.globalAlpha = st.o;
      ctx.fillStyle = "#cdd3ff";
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }

  var resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 200);
  });

  resize();
  frame();
})();

// The AI universe orbit visual â a glowing core with the Sahaba Club
// activities orbiting around it on tilted, depth-shaded rings.
(function () {
  var canvas = document.getElementById("universe-canvas");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var RINGS = [
    { radiusRatio: 0.24, tilt: 0.42, speed: 0.00028, color: "34, 211, 238", items: [
      { label: "Coaching", slug: "coaching" },
      { label: "Hackathons", slug: "hackathons" },
    ] },
    { radiusRatio: 0.37, tilt: 0.42, speed: -0.00019, color: "139, 92, 246", items: [
      { label: "PromptArena", slug: "promptarena" },
      { label: "ZuZu-AI", slug: "zuzu-ai" },
      { label: "PodCast", slug: "podcast" },
    ] },
    { radiusRatio: 0.49, tilt: 0.42, speed: 0.00013, color: "224, 168, 62", items: [
      { label: "Low-Code", slug: "low-code" },
      { label: "Vibe-Code", slug: "vibe-code" },
    ] },
  ];

  var w, h, cx, cy, dpr;
  var lastNodes = [];

  function resize() {
    var rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = rect.width;
    h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = w / 2;
    cy = h / 2;
  }

  function drawRingPath(radius, tilt) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, radius, radius * tilt, 0, 0, Math.PI * 2);
  }

  function drawCore(t, scale) {
    var pulse = 1 + Math.sin(t * 0.0016) * 0.06;
    var r = Math.max(24, Math.min(w, h) * 0.075) * pulse;
    var grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(0.35, "#8be9fd");
    grad.addColorStop(1, "#8b5cf6");
    ctx.save();
    ctx.shadowColor = "rgba(139, 92, 246, 0.9)";
    ctx.shadowBlur = r * 1.8;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = "#05070d";
    ctx.font = "800 " + Math.round(r * 0.62) + "px -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("AI", cx, cy + r * 0.04);
    ctx.restore();
  }

  function drawNode(x, y, depth, color, label, alignRight, scale) {
    var baseR = 5.5 * scale;
    var r = baseR * (0.65 + depth * 0.7);
    var alpha = 0.45 + depth * 0.55;

    ctx.save();
    ctx.globalAlpha = alpha * 0.9;
    ctx.strokeStyle = "rgba(" + color + ", 0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = "rgba(" + color + ", 0.9)";
    ctx.shadowBlur = 14 * scale * (0.5 + depth);
    ctx.fillStyle = "rgba(" + color + ", 0.95)";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.55 + depth * 0.45;
    ctx.fillStyle = "#f3f4f8";
    ctx.font = "600 " + Math.round(12 * scale) + "px -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textBaseline = "middle";
    var pad = r + 8 * scale;
    if (alignRight) {
      ctx.textAlign = "left";
      ctx.fillText(label, x + pad, y);
    } else {
      ctx.textAlign = "right";
      ctx.fillText(label, x - pad, y);
    }
    ctx.restore();
  }

  function frame(t) {
    if (!w || !h) { resize(); }
    ctx.clearRect(0, 0, w, h);

    var minDim = Math.min(w, h);
    var scale = Math.max(0.7, Math.min(1.6, minDim / 560));
    var nodes = [];

    RINGS.forEach(function (ring) {
      var radius = minDim * ring.radiusRatio;
      drawRingPath(radius, ring.tilt);
      ctx.save();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      var count = ring.items.length;
      var angleOffset = reduceMotion ? 0 : t * ring.speed;
      ring.items.forEach(function (item, i) {
        var angle = (Math.PI * 2 * i) / count + angleOffset;
        var x = cx + radius * Math.cos(angle);
        var y = cy + radius * ring.tilt * Math.sin(angle);
        var depth = (Math.sin(angle) + 1) / 2;
        nodes.push({ x: x, y: y, depth: depth, color: ring.color, label: item.label, slug: item.slug, alignRight: Math.cos(angle) >= 0 });
      });
    });

    ctx.font = "600 " + Math.round(12 * scale) + "px -apple-system, Segoe UI, Roboto, sans-serif";
    nodes.forEach(function (n) {
      var r = 5.5 * scale * (0.65 + n.depth * 0.7);
      var pad = r + 8 * scale;
      var textW = ctx.measureText(n.label).width;
      var textH = 16 * scale;
      var half = Math.max(r * 1.6, textH / 2);
      if (n.alignRight) {
        n.hit = { x0: n.x - r * 1.6, y0: n.y - half, x1: n.x + pad + textW, y1: n.y + half };
      } else {
        n.hit = { x0: n.x - pad - textW, y0: n.y - half, x1: n.x + r * 1.6, y1: n.y + half };
      }
    });
    lastNodes = nodes;

    nodes.sort(function (a, b) { return a.depth - b.depth; });
    var backNodes = nodes.filter(function (n) { return n.depth < 0.5; });
    var frontNodes = nodes.filter(function (n) { return n.depth >= 0.5; });

    backNodes.forEach(function (n) { drawNode(n.x, n.y, n.depth, n.color, n.label, n.alignRight, scale); });
    drawCore(t, scale);
    frontNodes.forEach(function (n) { drawNode(n.x, n.y, n.depth, n.color, n.label, n.alignRight, scale); });

    if (!reduceMotion) requestAnimationFrame(frame);
  }

  function nodeAt(mx, my) {
    for (var i = 0; i < lastNodes.length; i++) {
      var n = lastNodes[i];
      if (n.hit && mx >= n.hit.x0 && mx <= n.hit.x1 && my >= n.hit.y0 && my <= n.hit.y1) {
        return n;
      }
    }
    return null;
  }

  canvas.addEventListener("click", function (e) {
    var rect = canvas.getBoundingClientRect();
    var n = nodeAt(e.clientX - rect.left, e.clientY - rect.top);
    if (n) {
      var target = document.getElementById(n.slug);
      if (target) target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    }
  });

  canvas.addEventListener("mousemove", function (e) {
    var rect = canvas.getBoundingClientRect();
    var n = nodeAt(e.clientX - rect.left, e.clientY - rect.top);
    canvas.style.cursor = n ? "pointer" : "default";
  });

  var resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resize();
      if (reduceMotion) frame(0);
    }, 200);
  });

  resize();
  if (reduceMotion) {
    frame(0);
  } else {
    requestAnimationFrame(frame);
  }
})();

(function () {
  var tabButtons = document.querySelectorAll(".tab-btn");
  var indivEls = document.querySelectorAll(".indiv-only");
  var corpEls = document.querySelectorAll(".corp-only");

  function setTab(tab) {
    var isIndividual = tab === "individual";

    tabButtons.forEach(function (btn) {
      var match = btn.getAttribute("data-tab") === tab;
      btn.classList.toggle("active", match);
      btn.setAttribute("aria-selected", match ? "true" : "false");
    });

    indivEls.forEach(function (el) {
      el.classList.toggle("hidden", !isIndividual);
    });
    corpEls.forEach(function (el) {
      el.classList.toggle("hidden", isIndividual);
    });
  }

  tabButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      setTab(btn.getAttribute("data-tab"));
    });
  });

  // Start on the Individuals view.
  setTab("individual");
})();

// Sign-up / consultation forms â post to the Sahaba Club Power Automate
// flow, which emails the team for every submission.
(function () {
  var FLOW_URL = "https://default23e9f3d3e0d04d38b8cf44b82c7fab.db.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/15/workflows/b950546181014f17b4fec3b3cfe6c139/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=xD3SzgK_AVwsu89BqjT2I3vIcwojfFKT5yiZqvupEvk";

  function wireForm(formId, formType, thanksId) {
    var form = document.getElementById(formId);
    var thanks = document.getElementById(thanksId);
    if (!form) return;

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      var data = {};
      new FormData(form).forEach(function (value, key) {
        data[key] = value;
      });
      data.form_type = formType;

      // mode: "no-cors" + a text/plain body avoids a CORS preflight, so the
      // request reaches the flow reliably from a static site with no backend.
      // We can't read the response in this mode, so we show the thank-you
      // message optimistically as soon as the request is sent.
      fetch(FLOW_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(data),
      }).catch(function () {
        // Network failure: still show the thank-you message so the visitor
        // isn't left staring at a form that appears to do nothing.
      });

      form.classList.add("hidden");
      if (thanks) thanks.classList.remove("hidden");
    });
  }

  wireForm("individual-form", "individual", "individual-thanks");
  wireForm("corporate-form", "corporate", "corporate-thanks");
})();

// Upcoming events grid â reads from the EVENTS array defined in
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
    title.textContent = evt.title;
    card.appendChild(title);

    var loc = document.createElement("p");
    loc.className = "event-meta";
    loc.innerHTML = pinIcon + " <span></span>";
    loc.querySelector("span").textContent = evt.location + ", " + evt.country;
    card.appendChild(loc);

    var when = document.createElement("p");
    when.className = "event-meta";
    when.innerHTML = calIcon + " <span></span>";
    when.querySelector("span").textContent = formatDate(evt.date) + " Â· " + evt.time;
    card.appendChild(when);

    if (evt.description) {
      var wrap = document.createElement("div");
      wrap.className = "event-desc-wrap";

      var desc = document.createElement("p");
      desc.className = "event-desc";
      desc.textContent = evt.description;
      wrap.appendChild(desc);

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

  var PAGE_SIZE = 9;
  var renderedCount = 0;

  var sentinel = document.createElement("div");
  sentinel.className = "events-sentinel";

  var statusEl = document.createElement("p");
  statusEl.className = "events-load-more-status";
  statusEl.textContent = "Loading more eventsâ¦";
  statusEl.style.display = "none";

  function renderNextBatch() {
    var next = upcoming.slice(renderedCount, renderedCount + PAGE_SIZE);
    next.forEach(function (evt) {
      grid.insertBefore(buildCard(evt), sentinel);
    });
    renderedCount += next.length;

    if (renderedCount >= upcoming.length) {
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
        if (entry.isIntersecting && renderedCount < upcoming.length) {
          statusEl.style.display = "block";
          renderNextBatch();
          window.setTimeout(function () {
            statusEl.style.display = "none";
          }, 200);
        }
      });
    }, { rootMargin: "300px" });
    observer.observe(sentinel);
  }

  renderNextBatch();
})();


// Admin nav link — shown only when this browser is connected to the
// Events Admin panel with a GitHub token that still has access. This is
// an interim stand-in for real sign-in/sign-up (coming later): for now,
// "logged in" means "holds a valid, working admin token in this browser."
(function () {
  var link = document.getElementById("nav-admin-link");
  if (!link) return;

  var TOKEN_KEY = "sc_admin_gh_token";
  var token = localStorage.getItem(TOKEN_KEY);
  if (!token) return;

  // Note: this repo is public, so a plain "can I read it" check would pass
  // for anyone, token or not. We specifically check the authenticated
  // user's push (write) permission on the repo, which GitHub only returns
  // when the request carries a valid token belonging to someone with real
  // access — that's the actual admin signal.
  fetch("https://api.github.com/repos/sahabaclub/sahabaclub.github.io", {
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
    },
  }).then(function (resp) {
    if (resp.status === 401 || resp.status === 403) {
      localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return resp.ok ? resp.json() : null;
  }).then(function (data) {
    if (data && data.permissions && data.permissions.push) {
      link.classList.remove("admin-hidden");
    } else if (data) {
      // Valid token, but this account has no write access to the repo.
      localStorage.removeItem(TOKEN_KEY);
    }
  }).catch(function () {
    // Network hiccup — leave the link hidden rather than guess.
  });
})();
