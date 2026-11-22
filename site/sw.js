/* Scaredy GmCat download pipe (Claude, 2026-11-21, v11). Big received files used to pile up in the page's memory until the
   last byte, so a phone's browser killed the tab partway through a large file ("Aw, Snap!"). Now the page hands each piece
   to this worker, which feeds it straight into an ordinary browser download: the file fills on disk as it arrives.
   Only /__dl/<one-time id>/<name> is answered here, and only for a download the page opened a moment ago; every other
   request goes to the network untouched. Nothing is cached or kept: pieces pass through once. */
"use strict";
var pending = {};          // id -> { meta, port } until the browser asks for the download (a minute at most)
var waiting = {};          // id -> callback: the download request arrived before the page's "open" message (v14)

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("message", function (e) {
  var d = e.data || {};
  if (d.t === "open" && e.ports && e.ports[0] && /^[0-9a-f]{32}$/.test(d.id || "")) {
    pending[d.id] = { meta: d, port: e.ports[0] };
    setTimeout(function () { delete pending[d.id]; }, 60000);
    e.ports[0].postMessage({ t: "ready" });                        // v14: the page opens the download only after this
    if (waiting[d.id]) waiting[d.id]();
  }
  // { t: "ping" } needs nothing: the message itself keeps this worker awake while a download is running
});

function cleanName(n) {
  n = String(n || "file").replace(/[\u0000-\u001f\u007f\/\\:*?"<>|]+/g, "_").replace(/^[.\s]+/, "").slice(0, 200);
  return n || "file";
}

self.addEventListener("fetch", function (e) {
  var u = new URL(e.request.url);
  if (u.origin !== self.location.origin || u.pathname.indexOf("/__dl/") !== 0) return;
  var id = u.pathname.split("/")[2];
  if (!/^[0-9a-f]{32}$/.test(id || "")) return;
  /* v14: messages and requests can arrive out of order, so wait up to 3 s for the page's "open" before saying no */
  e.respondWith(new Promise(function (resolve) {
    if (pending[id]) { resolve(serve(id)); return; }
    var t = setTimeout(function () { delete waiting[id]; resolve(new Response("This download has already finished or expired.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } })); }, 3000);
    waiting[id] = function () { clearTimeout(t); delete waiting[id]; resolve(serve(id)); };
  }));
});

function serve(id) {
  var p = pending[id];
  delete pending[id];                                              // one use only
  var port = p.port, done = false;
  var body = new ReadableStream({
    start: function (c) {
      port.onmessage = function (m) {
        if (done) return;
        var d = m.data;
        if (d === "end") { done = true; c.close(); port.close(); }
        else if (d === "abort") { done = true; c.error(new Error("stopped")); port.close(); }   // the browser marks it failed and drops the part file
        else if (d instanceof ArrayBuffer) c.enqueue(new Uint8Array(d));
      };
    },
    cancel: function () { if (!done) { done = true; try { port.postMessage({ t: "cancel" }); } catch (x) { /* page gone */ } } }   // cancelled in the downloads list
  }, { highWaterMark: 0 });
  var name = cleanName(p.meta.name), ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/[%;]/g, "_");
  var h = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(name),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  if (p.meta.size >= 0) h.set("Content-Length", String(p.meta.size));   // a short stream then counts as a failed download, never a finished one
  port.postMessage({ t: "started" });
  return new Response(body, { headers: h });
}
