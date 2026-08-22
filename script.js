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

  // Labels and orbit rings need to flip with the theme, or they vanish.
  function isLight() {
    return document.documentElement.classList.contains("light-mode");
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
    ctx.fillStyle = isLight() ? "#101627" : "#f3f4f8";
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
      ctx.strokeStyle = isLight() ? "rgba(16, 22, 39, 0.14)" : "rgba(255, 255, 255, 0.08)";
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
  var FLOW_URL = "FLOW_ENDPOINT_URL_HERE";

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

// Dark / light theme. Drives the desktop nav button and the Dark/Light
// choice in the mobile Settings panel, keeping both in sync. The class
// itself is applied pre-paint by an inline snippet in <head>.
(function () {
  var KEY = "sc_light_mode";
  var root = document.documentElement;

  function isLight() { return root.classList.contains("light-mode"); }

  function syncControls() {
    var light = isLight();

    var btn = document.getElementById("theme-toggle");
    if (btn) {
      var label = light ? "Switch to dark mode" : "Switch to light mode";
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
    }

    Array.prototype.forEach.call(document.querySelectorAll("[data-theme]"), function (b) {
      var match = b.getAttribute("data-theme") === (light ? "light" : "dark");
      b.classList.toggle("is-active", match);
      b.setAttribute("aria-pressed", match ? "true" : "false");
    });
  }

  function setTheme(light) {
    root.classList.toggle("light-mode", light);
    try { localStorage.setItem(KEY, light ? "1" : "0"); } catch (e) {}
    syncControls();
  }

  var toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () { setTheme(!isLight()); });
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-theme]"), function (b) {
    b.addEventListener("click", function () {
      setTheme(b.getAttribute("data-theme") === "light");
    });
  });

  syncControls();
})();

// Mobile navigation drawer — hamburger opens a panel under the header
// with Sign in, Join the Club, Events, Language and Settings.
(function () {
  var toggle = document.getElementById("nav-toggle");
  var menu = document.getElementById("mobile-menu");
  var backdrop = document.getElementById("mobile-menu-backdrop");
  var header = document.querySelector(".nav");
  if (!toggle || !menu || !backdrop || !header) return;

  // Keep the panel pinned right below the header at any screen size.
  function syncHeaderHeight() {
    document.documentElement.style.setProperty("--nav-h", header.offsetHeight + "px");
  }
  syncHeaderHeight();
  window.addEventListener("resize", syncHeaderHeight);
  window.addEventListener("orientationchange", syncHeaderHeight);

  function openMenu() {
    syncHeaderHeight();
    menu.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add("menu-open");
    toggle.classList.add("is-open");
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", "Close menu");
    window.requestAnimationFrame(function () {
      menu.classList.add("is-open");
      backdrop.classList.add("is-open");
    });
  }

  function closeMenu() {
    menu.classList.remove("is-open");
    backdrop.classList.remove("is-open");
    document.body.classList.remove("menu-open");
    toggle.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Open menu");
    window.setTimeout(function () {
      menu.hidden = true;
      backdrop.hidden = true;
    }, 240);
  }

  function isOpen() { return !menu.hidden; }

  toggle.addEventListener("click", function () {
    if (isOpen()) closeMenu();
    else openMenu();
  });
  backdrop.addEventListener("click", closeMenu);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen()) closeMenu();
  });

  // Any real navigation closes the drawer. Expanders and the settings
  // switch stay put so the menu doesn't vanish mid-interaction.
  menu.addEventListener("click", function (e) {
    var link = e.target.closest ? e.target.closest("a") : null;
    if (link) closeMenu();
  });

  // Expandable sections (Language, Settings)
  Array.prototype.forEach.call(menu.querySelectorAll(".mobile-menu-expand"), function (btn) {
    btn.addEventListener("click", function () {
      var panel = document.getElementById(btn.getAttribute("aria-controls"));
      if (!panel) return;
      var willOpen = panel.hidden;
      // Only one section open at a time.
      Array.prototype.forEach.call(menu.querySelectorAll(".mobile-menu-expand"), function (other) {
        var otherPanel = document.getElementById(other.getAttribute("aria-controls"));
        if (otherPanel) otherPanel.hidden = true;
        other.setAttribute("aria-expanded", "false");
      });
      panel.hidden = !willOpen;
      btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
    });
  });

  // Language — English is live; Arabic isn't translated yet, so say so
  // rather than switching to a half-translated page.
  Array.prototype.forEach.call(menu.querySelectorAll("[data-lang]"), function (btn) {
    btn.addEventListener("click", function () {
      if (btn.getAttribute("data-lang") === "ar") {
        window.alert("An Arabic version of the site is on the way — it isn't ready yet.");
        return;
      }
      Array.prototype.forEach.call(menu.querySelectorAll("[data-lang]"), function (b) {
        b.classList.toggle("is-active", b === btn);
      });
    });
  });

  // Settings — reduce motion, remembered on this device.
  var motionBox = document.getElementById("setting-reduce-motion");
  if (motionBox) {
    var KEY = "sc_reduce_motion";
    var saved = localStorage.getItem(KEY) === "1";
    motionBox.checked = saved;
    document.documentElement.classList.toggle("reduce-motion", saved);
    motionBox.addEventListener("change", function () {
      document.documentElement.classList.toggle("reduce-motion", motionBox.checked);
      localStorage.setItem(KEY, motionBox.checked ? "1" : "0");
    });
  }

})();

// Gallery lightbox — click a past-event photo to view it full screen,
// click again (or press Escape) to shrink it back into the strip.
(function () {
  var box = document.getElementById("lightbox");
  var gallery = document.querySelector(".event-gallery");
  if (!box || !gallery) return;

  var boxImg = document.getElementById("lightbox-img");
  var closeBtn = document.getElementById("lightbox-close");
  var prevBtn = document.getElementById("lightbox-prev");
  var nextBtn = document.getElementById("lightbox-next");
  var counter = document.getElementById("lightbox-counter");

  // The strip duplicates every photo to loop seamlessly, so build the
  // list from the originals only (the clones are aria-hidden).
  function realPhotos() {
    return Array.prototype.filter.call(
      gallery.querySelectorAll(".event-photo.has-photo"),
      function (el) { return el.getAttribute("aria-hidden") !== "true"; }
    );
  }

  var index = 0;

  function srcList() {
    return realPhotos().map(function (el) {
      var img = el.querySelector("img");
      return img ? img.getAttribute("src") : null;
    }).filter(Boolean);
  }

  function show(i) {
    var list = srcList();
    if (!list.length) return;
    index = (i + list.length) % list.length;
    boxImg.src = list[index];
    boxImg.alt = "Sahaba Club event photo " + (index + 1) + " of " + list.length;
    counter.textContent = index + 1 + " / " + list.length;
    var multiple = list.length > 1;
    prevBtn.hidden = !multiple;
    nextBtn.hidden = !multiple;
  }

  function open(i) {
    show(i);
    box.hidden = false;
    document.body.classList.add("lightbox-open");
    // Next frame so the opacity/scale transition actually runs.
    window.requestAnimationFrame(function () {
      box.classList.add("is-open");
    });
    closeBtn.focus();
  }

  function close() {
    box.classList.remove("is-open");
    document.body.classList.remove("lightbox-open");
    window.setTimeout(function () {
      box.hidden = true;
      boxImg.src = "";
    }, 220);
  }

  gallery.addEventListener("click", function (e) {
    var photo = e.target.closest ? e.target.closest(".event-photo") : null;
    if (!photo || !photo.classList.contains("has-photo")) return;
    var clickedSrc = photo.querySelector("img").getAttribute("src");
    var list = srcList();
    var at = list.indexOf(clickedSrc);
    open(at === -1 ? 0 : at);
  });

  // Clicking the backdrop closes; clicking the photo or buttons does not.
  box.addEventListener("click", function (e) {
    if (e.target === boxImg) {
      close();
      return;
    }
    if (e.target === box) close();
  });

  closeBtn.addEventListener("click", close);
  prevBtn.addEventListener("click", function () { show(index - 1); });
  nextBtn.addEventListener("click", function () { show(index + 1); });

  document.addEventListener("keydown", function (e) {
    if (box.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") show(index - 1);
    else if (e.key === "ArrowRight") show(index + 1);
  });
})();

// Admin nav link — shown only to club staff and admins.
//
// This used to depend on a GitHub token stored in the browser, back when
// the only "admin panel" edited the repo directly. That's gone: staff now
// sign in with an ordinary account and their role decides what they see.
//
// Hiding the link is a courtesy, not a control. Someone who types the
// address anyway gets stopped by the dashboard's own check, and by the
// database policies underneath it.
(function () {
  var links = [
    document.getElementById("nav-admin-link"),
    document.getElementById("nav-admin-link-mobile"),
  ].filter(Boolean);
  if (!links.length) return;

  // ⚠ ASKS WHETHER YOU HAVE ANY ADMIN SECTION — it does NOT compare role names.
  //
  // This used to be a list of literals, and it was wrong twice in two days.
  // First it read `role === "admin"` alone, so 0054's rename hid the link from
  // Ahmed. That was fixed by adding `global_admin`… and the link then stayed
  // hidden from Ghadir, because `operations_manager` was not in the list
  // either. She could do nothing about it from her side; the menu simply never
  // showed her the door to a section she genuinely had.
  //
  // A hardcoded list has to be revisited every time a role is added or
  // renamed, and nothing makes anyone revisit it — the failure is silent and
  // looks like a permissions problem to the person affected.
  //
  // `my_admin_sections()` is the SAME source of truth lib/admin-guard.js uses
  // to build the admin menu, so the link and the page it opens can no longer
  // disagree. A new role that is granted a section gets the link with no change
  // here; a role granted nothing never sees it.
  import("./lib/supabase-client.js?v=a05d5717f7").then(function (mod) {
    if (!mod.isConfigured) return null;
    return mod.supabase.auth.getSession().then(function (res) {
      if (!res.data.session) return null;
      return mod.supabase.rpc("my_admin_sections");
    });
  }).then(function (res) {
    if (!res || res.error || !Array.isArray(res.data) || !res.data.length) return;
    links.forEach(function (l) { l.classList.remove("admin-hidden"); });
  }).catch(function () {
    // Offline, or Supabase not configured — leave the link hidden. Hiding is
    // the right way to fail HERE, unlike in the admin menu: this is a doorway
    // on a public page, and every page behind it guards itself anyway.
  });
})();

// One-time cleanup: the old root admin.html saved a GitHub personal access
// token — repository write scope — in this browser. That page has been
// deleted, but deleting it does not reach into the local storage of every
// machine that ever opened it, and the credential does not expire on its own.
//
// Kept deliberately as a one-release migration rather than removed with the
// page. It costs one localStorage call on pages that already run this file,
// it cannot break anything, and it is the only mechanism that clears the key
// from a browser that has it. Safe to delete after one release has been live
// long enough for the people who used that panel to have loaded the site once
// — and worth deleting then, because a key nothing writes any more is just
// noise. (The token should also be revoked on GitHub; clearing the copy in a
// browser is not the same as making it powerless.)
(function () {
  try { localStorage.removeItem("sc_admin_gh_token"); } catch (e) {}
})();

// Sign-in links on the public pages: the "Supabase isn't set up yet" fallback,
// and nothing else.
//
// This block used to do the whole job — rewrite the href to login.html, then
// wait on a network getSession() and relabel the link "Dashboard". Both halves
// ran at the end of the document, after the page had painted, which put the
// primary auth control in the wrong state for as long as the import and the
// round trip took: a signed-in member saw "Sign in", and a signed-out visitor
// saw a mailto: they could click before it was fixed, which opens a mail
// client rather than the login page.
//
// header-identity.js already answers "is anyone signed in?" synchronously,
// before first paint, and publishes it as html.sc-signed-in / .sc-signed-out.
// So the swap is now pure CSS (`[data-identity-join]`, styles.css) and the
// markup ships pointing at login.html — the true state in every case except
// one. That one is this: a clone of this repo published before its Supabase
// project exists, where login.html cannot work and "email us" is the only
// honest link. Marked with data-signin-link in the HTML.
(function () {
  var links = Array.prototype.slice.call(
    document.querySelectorAll("[data-signin-link]")
  );
  if (!links.length) return;

  import("./lib/supabase-client.js?v=a05d5717f7").then(function (mod) {
    if (mod.isConfigured) return;
    links.forEach(function (link) {
      link.href = "mailto:info@sahabaclub.com?subject=Sahaba%20Club%20sign%20in";
    });
  }).catch(function () {
    // Offline, or the module CDN is unreachable. Supabase being configured is
    // the overwhelmingly likely case, and login.html is where these already
    // point, so the markup's own state is the right one to leave standing.
  });
})();

// Unread counts on the menu.
// ------------------------------------------------------------
// The badge numbers for Dashboard, Messages, Connect, Events, EduHackAI and
// Podcast, painted from `my_notification_counts` and kept live over Realtime.
//
// This lives in script.js rather than in its own tag on every page for one
// reason: script.js is already loaded by all sixteen member-facing pages, and
// header-identity.js — the other obvious host — is loaded by only eleven,
// missing dashboard.html and inbox.html, which are the two that most need a
// badge. One hook here beats twenty-six edits and the drift that follows them.
//
// The admin pages and unsubscribe.html load neither file and get no badge.
// That is correct: neither carries the member menu.
//
// Dynamic import() in a classic external script resolves against THE SCRIPT'S
// OWN URL, not the document's — which is why "./lib/..." is right here even
// though app/dashboard.html loads this file as "../script.js". The block
// above has relied on that since it was written.
(function () {
  // Nothing to paint on a page with no menu — login.html, and any page whose
  // header is just the logo.
  if (!document.querySelector(".nav-link, .mobile-menu-item")) return;

  var notifications = null;

  import("./lib/supabase-client.js?v=a05d5717f7")
    .then(function (client) {
      // A repo published before its Supabase project exists has no counts to
      // read and no session to read them with.
      if (!client.isConfigured) return null;
      return import("./lib/auth.js?v=a05d5717f7").then(function (auth) {
        return auth.getSession();
      });
    })
    .then(function (session) {
      // Signed out is the common case on the public pages. No session, no
      // badges, no query — a visitor reading the events page should not be
      // made to wait on a request that can only ever return nothing.
      if (!session || !session.user) return null;

      return import("./lib/notifications.js?v=a05d5717f7").then(function (mod) {
        notifications = mod;
        return mod.refreshNavBadges().then(function () {
          // Opening a section reads it. Without this the count a member just
          // clicked on sits there permanently — they went to Events, read the
          // events, and the 2 never went away.
          mod.markCurrentSectionRead();

          // Realtime is the fast path; this is the one that catches a tab
          // which was already open when the notification was created, or came
          // back from bfcache, or whose socket never connected at all.
          mod.watchForRefocus();

          // Live from here: a message arriving while this page is open
          // increments the badge without a reload.
          mod.subscribeToCounts(session.user.id);

          // Repair any drift between what this browser's push subscription
          // holds and what the club knows — a rotated endpoint, an
          // interrupted turn-off, cleared site data. Runs on every page rather
          // than only on Settings, because the member most affected by a
          // silently dead subscription is the one who never visits Settings
          // again after switching it on. It is a no-op when push was never
          // enabled here, and it never prompts: reconcile() returns early
          // unless permission is already granted.
          return import("./lib/push.js?v=a05d5717f7").then(function (push) {
            push.reconcile();
            push.listenForResubscribe();
          }).catch(function () {
            // Push is strictly additive. A failure to load it must never
            // affect the badges, which have already been painted above.
          });
        });
      });
    })
    .catch(function () {
      // Offline, the CDN is unreachable, or the counts view is not there yet
      // because 0044 has not been applied. In every one of those cases the
      // right menu is the one already in the markup — a menu with no numbers
      // on it. Never let a badge failure break navigation.
    });

  // Close the socket on the way out rather than leaving the server to time it
  // out. `pagehide` fires where `unload` does not on mobile Safari.
  window.addEventListener("pagehide", function () {
    if (notifications) notifications.unsubscribe();
  });
})();
