// talk.js — the language switcher under "We Talk What You Talk".
//
// Seven buttons, one <iframe>. Clicking a language swaps the video.
//
// ⚠ AUTOPLAY IS ADDED ON CLICK AND NEVER ON LOAD. The markup ships a src with
// no autoplay, so a visitor who scrolls past hears nothing. A click is a real
// user gesture, which is both the polite moment to start playing and the only
// case a browser will actually honour autoplay with sound.
//
// ⚠ MANUAL ACTIVATION for the keyboard, not the automatic kind. The ARIA tabs
// pattern usually selects a tab as soon as focus reaches it, which here would
// start playing a video on every arrow key press on the way past. Arrows move
// focus; Enter or Space commits.
(function () {
  "use strict";

  var langs = document.querySelector(".talk-langs");
  var frame = document.getElementById("talk-frame");
  var panel = document.getElementById("talk-panel");
  if (!langs || !frame || !panel) return;

  var tabs = Array.prototype.slice.call(langs.querySelectorAll(".lang"));
  if (!tabs.length) return;

  function select(tab) {
    if (!tab || tab.getAttribute("aria-selected") === "true") {
      if (tab) tab.focus();
      return;
    }

    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      // Roving tabindex: exactly one tab is in the tab order, so Tab moves
      // past the whole group rather than through seven buttons.
      t.setAttribute("tabindex", on ? "0" : "-1");
    });

    var id = tab.getAttribute("data-video");
    var label = tab.getAttribute("data-label") || tab.textContent.trim();

    // Rebuilt rather than string-patched, so a second click cannot end up with
    // autoplay=1 twice or two video ids in one URL.
    frame.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(id) +
      "?rel=0&playsinline=1&modestbranding=1&autoplay=1";
    frame.title = "Sahaba Club introduction in " + label;
    panel.setAttribute("aria-labelledby", tab.id);

    tab.focus();
  }

  langs.addEventListener("click", function (ev) {
    var tab = ev.target.closest ? ev.target.closest(".lang") : null;
    if (tab) select(tab);
  });

  langs.addEventListener("keydown", function (ev) {
    var i = tabs.indexOf(document.activeElement);
    if (i === -1) return;
    var next = null;

    if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = tabs[(i + 1) % tabs.length];
    else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (ev.key === "Home") next = tabs[0];
    else if (ev.key === "End") next = tabs[tabs.length - 1];
    else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(tabs[i]); return; }
    else return;

    ev.preventDefault();
    next.focus(); // focus only — see the header: activation is deliberate.
  });
})();
