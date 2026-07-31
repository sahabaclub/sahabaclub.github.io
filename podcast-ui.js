// ============================================================
// Sahaba Club — Podcast page
// ------------------------------------------------------------
// Builds the trailer player, the episode wall and the lightbox.
// YouTube iframes are only created on click: sixteen embedded
// players would cost several megabytes and a lot of scripting
// before anyone had pressed play.
// ============================================================

(function () {
  var stage = document.getElementById("pod-stage");
  var grid = document.getElementById("pod-grid");
  if (!stage || !grid || typeof PODCAST_EPISODES === "undefined") return;

  var countEl = document.getElementById("pod-count");
  var chipWrap = document.getElementById("pod-filters");
  var modal = document.getElementById("pod-modal");
  var modalFrame = document.getElementById("pod-modal-frame");
  var modalTitle = document.getElementById("pod-modal-title");
  var modalClose = document.getElementById("pod-modal-close");

  function thumb(id) {
    return "https://i.ytimg.com/vi/" + id + "/maxresdefault.jpg";
  }
  function embed(id) {
    return "https://www.youtube.com/embed/" + id + "?autoplay=1&rel=0&modestbranding=1";
  }
  function watchUrl(id) {
    return "https://www.youtube.com/watch?v=" + id;
  }

  var playIcon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6L19 12z"/></svg>';

  // ---- trailer -----------------------------------------------------------
  (function buildTrailer() {
    if (typeof PODCAST_TRAILER === "undefined") return;
    var t = PODCAST_TRAILER;

    var poster = document.createElement("img");
    poster.className = "pod-stage-img";
    poster.src = thumb(t.id);
    poster.alt = t.title;
    stage.appendChild(poster);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pod-play";
    btn.setAttribute("aria-label", "Play " + t.title);
    btn.innerHTML = '<span class="pod-play-ring"></span><span class="pod-play-ring pod-play-ring-2"></span>' +
      '<span class="pod-play-core">' + playIcon + "</span>";
    stage.appendChild(btn);

    var cap = document.createElement("span");
    cap.className = "pod-stage-cap";
    cap.textContent = t.title;
    stage.appendChild(cap);

    btn.addEventListener("click", function () {
      var f = document.createElement("iframe");
      f.className = "pod-stage-frame";
      f.src = embed(t.id);
      f.title = t.title;
      f.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      f.allowFullscreen = true;
      f.setAttribute("frameborder", "0");
      stage.classList.add("is-playing");
      stage.appendChild(f);
    });
  })();

  // ---- episode wall ------------------------------------------------------
  var state = { lang: "all" };

  function buildCard(ep, index) {
    var card = document.createElement("article");
    card.className = "pod-card lang-" + ep.lang;
    // Staggered so the wall assembles itself rather than snapping in at once.
    card.style.setProperty("--pod-delay", (index % 12) * 55 + "ms");

    var media = document.createElement("button");
    media.type = "button";
    media.className = "pod-card-media";
    media.setAttribute("aria-label", "Play episode " + ep.n + ": " + ep.topic);

    var img = document.createElement("img");
    img.src = thumb(ep.id);
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    media.appendChild(img);

    var num = document.createElement("span");
    num.className = "pod-num";
    num.innerHTML = '<span>EP</span>' + ep.n;
    media.appendChild(num);

    var lang = document.createElement("span");
    lang.className = "pod-lang";
    lang.textContent = ep.lang === "ar" ? "العربية" : "English";
    media.appendChild(lang);

    var play = document.createElement("span");
    play.className = "pod-card-play";
    play.innerHTML = playIcon;
    media.appendChild(play);

    card.appendChild(media);

    var body = document.createElement("div");
    body.className = "pod-card-body";

    var h = document.createElement("h3");
    h.className = "pod-card-title";
    h.textContent = ep.topic;
    body.appendChild(h);

    if (ep.ar) {
      var ar = document.createElement("p");
      ar.className = "pod-card-ar";
      ar.dir = "rtl";
      ar.lang = "ar";
      ar.textContent = ep.ar;
      body.appendChild(ar);
    }

    var links = document.createElement("div");
    links.className = "pod-card-links";
    var yt = document.createElement("a");
    yt.href = watchUrl(ep.id);
    yt.target = "_blank";
    yt.rel = "noopener";
    yt.className = "pod-card-yt";
    yt.textContent = "Watch on YouTube";
    links.appendChild(yt);
    body.appendChild(links);

    card.appendChild(body);

    media.addEventListener("click", function () {
      openModal(ep);
    });
    return card;
  }

  function render() {
    grid.innerHTML = "";
    var list = PODCAST_EPISODES.filter(function (e) {
      return state.lang === "all" || e.lang === state.lang;
    });
    list.forEach(function (ep, i) {
      grid.appendChild(buildCard(ep, i));
    });
    if (countEl) {
      countEl.textContent = list.length === PODCAST_EPISODES.length
        ? "All " + list.length + " episodes"
        : "Showing " + list.length + " of " + PODCAST_EPISODES.length + " episodes";
    }
    reveal();
  }

  // Cards fade up as they come into view; without an observer they're
  // simply visible from the start.
  var observer = null;
  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -40px 0px", threshold: 0.05 });
  }
  function reveal() {
    var cards = grid.querySelectorAll(".pod-card");
    if (!observer) {
      Array.prototype.forEach.call(cards, function (c) { c.classList.add("is-in"); });
      return;
    }
    Array.prototype.forEach.call(cards, function (c) { observer.observe(c); });
  }

  if (chipWrap) {
    chipWrap.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".pod-chip") : null;
      if (!btn || !chipWrap.contains(btn)) return;
      state.lang = btn.getAttribute("data-lang");
      Array.prototype.forEach.call(chipWrap.querySelectorAll(".pod-chip"), function (b) {
        var on = b === btn;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      render();
    });
  }

  // ---- lightbox ----------------------------------------------------------
  var lastFocus = null;

  function openModal(ep) {
    if (!modal) { window.open(watchUrl(ep.id), "_blank", "noopener"); return; }
    lastFocus = document.activeElement;
    modalTitle.textContent = "Episode " + ep.n + " — " + ep.topic;
    modalFrame.innerHTML = "";
    var f = document.createElement("iframe");
    f.src = embed(ep.id);
    f.title = "Episode " + ep.n + ": " + ep.topic;
    f.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    f.allowFullscreen = true;
    f.setAttribute("frameborder", "0");
    modalFrame.appendChild(f);
    modal.hidden = false;
    document.body.classList.add("pod-modal-open");
    if (modalClose) modalClose.focus();
  }

  function closeModal() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    // Emptying the container stops playback — pausing an embed from the
    // outside isn't possible without loading the whole YouTube API.
    modalFrame.innerHTML = "";
    document.body.classList.remove("pod-modal-open");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  if (modalClose) modalClose.addEventListener("click", closeModal);
  if (modal) {
    modal.addEventListener("click", function (e) {
      if (e.target === modal || e.target.classList.contains("pod-modal-backdrop")) closeModal();
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeModal();
  });

  render();
})();
