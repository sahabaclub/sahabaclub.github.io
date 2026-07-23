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
