/* Scaredy GmCat how-to page: just the Day/Night toggle (theme.js set it before the page drew). */
(function () {
  var b = document.getElementById("theme"); if (!b) return;
  b.addEventListener("click", function () {
    var dark = document.documentElement.getAttribute("data-theme") !== "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    try { localStorage.setItem("scaredy-theme", dark ? "dark" : "light"); } catch (e) { /* private mode */ }
  });
})();

/* Copies of files a closed Scaredy sender tab left in this browser (IndexedDB "scaredy-keep") are no longer reachable:
   wipe them here too, the same rule as scaredy.js Keep.sweep (sessions not seen for 30 minutes). Claude, v5 2026-11-20. */
(function () {
  if (!window.indexedDB || !indexedDB.databases) return;
  indexedDB.databases().then(function (list) {
    if (!list.some(function (d) { return d.name === "scaredy-keep"; })) return;      // never used here: don't create it
    var r = indexedDB.open("scaredy-keep", 1);
    r.onsuccess = function () {
      var db = r.result; if (!db.objectStoreNames.contains("sessions")) { db.close(); return; }
      var t = db.transaction(["files", "sessions"], "readwrite"), ss = t.objectStore("sessions"), fs = t.objectStore("files"), live = {};
      var g = ss.getAll(); g.onsuccess = function () {
        (g.result || []).forEach(function (s) { if (Date.now() - s.seen > 30 * 60 * 1000) ss.delete(s.sid); else live[s.sid] = 1; });
        var k = fs.getAllKeys(); k.onsuccess = function () { (k.result || []).forEach(function (key) { if (!live[key[0]]) fs.delete(key); }); };
      };
      t.oncomplete = t.onerror = function () { db.close(); };
    };
  }).catch(function () {});
})();
