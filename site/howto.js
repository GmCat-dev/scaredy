/* Scaredy GmCat how-to page: just the Day/Night toggle (theme.js set it before the page drew). */
(function () {
  var b = document.getElementById("theme"); if (!b) return;
  b.addEventListener("click", function () {
    var dark = document.documentElement.getAttribute("data-theme") !== "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    try { localStorage.setItem("scaredy-theme", dark ? "dark" : "light"); } catch (e) { /* private mode */ }
  });
})();
