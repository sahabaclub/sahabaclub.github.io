// Drifting starfield behind the whole page - the "AI universe" backdrop.
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

// Sign-up / consultation forms - post to the Sahaba Club Power Automate
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
