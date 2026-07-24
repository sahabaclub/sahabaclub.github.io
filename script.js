// Drifting starfield behind the whole page — the "AI universe" backdrop.
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

// The AI universe orbit visual — a glowing core with the Sahaba Club
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

// Sign-up / consultation forms — post to the Sahaba Club Power Automate
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

// Upcoming events grid — reads from the EVENTS array defined in
// events-data.js (only present on events.html). Automatically hides
// past events and sorts what's left by date.
(function () {
  var grid = document.getElementById("events-grid");
  if (!grid || typeof EVENTS === "undefined") return;
  var emptyMsg = document.getElementById("events-empty");

  var pinIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.4"/></svg>';
  var calIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg>';

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

  upcoming.forEach(function (evt) {
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
    }

    var badges = document.createElement("div");
    badges.className = "event-badges";

    var badge = document.createElement("span");
    badge.className = "event-price-badge " + (isPaid ? "is-paid" : "is-free");
    badge.textContent = evt.price;
    badges.appendChild(badge);

    if (evt.mode) {
      var modeBadge = document.createElement("span");
      modeBadge.className = "event-mode-badge";
      modeBadge.textContent = evt.mode;
      badges.appendChild(modeBadge);
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
    when.querySelector("span").textContent = formatDate(evt.date) + " · " + evt.time;
    card.appendChild(when);

    if (evt.description) {
      var desc = document.createElement("p");
      desc.className = "event-desc";
      desc.textContent = evt.description;
      card.appendChild(desc);
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

    if (evt.mapsLink) {
      var mapsBtn = document.createElement("a");
      mapsBtn.className = "btn btn-outline";
      mapsBtn.href = evt.mapsLink;
      mapsBtn.target = "_blank";
      mapsBtn.rel = "noopener";
      mapsBtn.textContent = "Find Location";
      actions.appendChild(mapsBtn);
    }

    card.appendChild(actions);

    grid.appendChild(card);
  });
})();
