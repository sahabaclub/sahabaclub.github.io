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
