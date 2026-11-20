/* Scaredy GmCat: pick Day or Night before the page draws (saved choice, else the device's). */
(function () {
  var t = null;
  try { t = localStorage.getItem("scaredy-theme"); } catch (e) { t = null; }
  if (t !== "dark" && t !== "light") t = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", t);
})();
