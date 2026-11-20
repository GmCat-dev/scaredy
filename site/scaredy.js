/* Scaredy GmCat (scaredy.gmcat.io; Claude, 2026-11-19, v2 2026-11-20). Send files without leaving them on anyone's server.
   Sender: picks files, gets a link, keeps this page open; can add or remove files while waiting (the list updates live).
   Receiver: opens the link; files come straight from the sender's page:
     - Direct: a browser-to-browser WebRTC data channel (our server only helps them find each other); link = /#room.key
     - Encrypted relay: locked pieces pass through our server, which hands each one over once and keeps nothing; /#room.key
     - Short link: like Direct, but the link is just /k7m2-x9pq; the key is handed over by our server (memory only) on join
   Files are encrypted here with AES-GCM. Frames: [type][payload] -> [12-byte IV][ciphertext].
     T_LIST: the file list {files:[{id,name,size,type}]}   T_DATA: [4-byte id][bytes]   T_DONE: [4-byte id]
   Server side: gmcat-scaredy/rooms.py. Look and words: blend of Pixel's and Claude's takes. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var ICE = [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }];
  var DC_CHUNK = 64 * 1024, RELAY_CHUNK = 1024 * 1024, CONNECT_TIMEOUT = 25000, STALL = 15000;
  var T_LIST = 1, T_DATA = 2, T_DONE = 3;
  var ART = { ghost: "/img/scaredy-ghost.png", peeking: "/img/scaredy-peeking.png", shy: "/img/scaredy-shy.png", sweat: "/img/scaredy-sweat.png",
              relieved: "/img/scaredy-relieved.png", thumbs: "/img/scaredy-thumbs.png", sad: "/img/scaredy-sad.png", eek: "/img/scaredy-eek.png" };
  var ALT = { ghost: "Ghost GmCat", peeking: "GmCat peeking", shy: "Shy GmCat", sweat: "GmCat shaking nervously", relieved: "Relieved GmCat",
              thumbs: "GmCat giving a thumbs up", sad: "Sad GmCat", eek: "GmCat with a paw over its mouth" };
  Object.keys(ART).forEach(function (k) { var i = new Image(); i.src = ART[k]; });
  var CODE_RE = /^\/([2-9a-hjkmnp-z]{4})-?([2-9a-hjkmnp-z]{4})\/?$/;

  $("theme").addEventListener("click", function () {
    var dark = document.documentElement.getAttribute("data-theme") !== "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    try { localStorage.setItem("scaredy-theme", dark ? "dark" : "light"); } catch (e) { /* private mode */ }
  });

  /* ---------- helpers ---------- */
  function size(n) { if (n < 1024) return n + " B"; if (n < 1048576) return (n / 1024).toFixed(0) + " KB"; if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB"; return (n / 1073741824).toFixed(2) + " GB"; }
  function b64u(bytes) { var s = ""; bytes.forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function unb64u(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function api(method, path, body, headers) {
    return fetch("/api/" + path, { method: method, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}), body: body == null ? undefined : JSON.stringify(body), cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || "Something went wrong (" + r.status + ")."); e.status = r.status; e.code = d.code; throw e; } return d; }); });
  }
  function ask(title, text, ok) {
    return new Promise(function (resolve) {
      var d = $("ask"), settled = false; $("ask-title").textContent = title; $("ask-text").textContent = text; $("ask-yes").textContent = ok;
      function done(v) { if (settled) return; settled = true; if (d.open) d.close(); resolve(v); }
      $("ask-yes").onclick = function () { done(true); }; $("ask-no").onclick = function () { done(false); };
      d.onclose = function () { done(false); }; d.onclick = function (e) { if (e.target === d) done(false); };
      d.showModal(); $("ask-no").focus();
    });
  }
  function mood(imgId, catId, name, extra) { var img = $(imgId), cat = $(catId); img.src = ART[name]; img.alt = ALT[name]; cat.classList.toggle("wobble", extra === "wobble"); }
  function icon(name) {
    var x = (String(name).split(".").pop() || "").toLowerCase();
    return /^(png|jpe?g|gif|webp|avif|heic)$/.test(x) ? "🖼️" : /^(mp4|mov|webm|m4v|mkv)$/.test(x) ? "🎬" : /^(mp3|wav|m4a|ogg|flac)$/.test(x) ? "🎵" : /^(zip|7z|rar|gz|tar)$/.test(x) ? "🗜️" : /^pdf$/.test(x) ? "📕" : "📄";
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function u32(n) { var a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n); return a; }
  function readU32(a) { return new DataView(a.buffer, a.byteOffset, 4).getUint32(0); }
  function cat2(a, b) { var o = new Uint8Array(a.byteLength + b.byteLength); o.set(new Uint8Array(a), 0); o.set(new Uint8Array(b), a.byteLength); return o.buffer; }

  /* ---------- the route strip doubles as progress (Pixel's idea) ---------- */
  function strip(id, frac, relay) {
    var el = $(id); if (!el) return; el.hidden = false;
    var st = el.querySelector(".strip"), f = Math.max(0, Math.min(1, frac || 0)), pct = Math.round(f * 100);
    st.classList.toggle("relay", !!relay); st.classList.toggle("idle", frac == null);
    st.querySelector(".sw-b").classList.remove("lit"); st.querySelector(".trail").classList.remove("fade");
    var mv = st.querySelector(".mover"); mv.textContent = "📄"; mv.style.left = pct + "%"; mv.classList.toggle("hop", !!relay && f > .42 && f < .58);
    st.querySelector(".trail").style.width = pct + "%";
  }
  function stripDone(id) {
    var el = $(id); if (!el) return; var st = el.querySelector(".strip");
    st.querySelector(".mover").style.left = "100%"; st.querySelector(".trail").style.width = "100%";
    st.querySelector(".sw-b").classList.add("lit"); st.querySelector(".mover").textContent = "✓";
    setTimeout(function () { st.querySelector(".trail").classList.add("fade"); }, 600);
    var bg = document.querySelector(".win-b"); if (bg) bg.classList.add("lit");
  }

  /* ---------- encryption ---------- */
  function importKey(raw) { return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]); }
  function seal(key, type, payload) {
    var plain = new Uint8Array(1 + payload.byteLength); plain[0] = type; plain.set(new Uint8Array(payload), 1);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, plain).then(function (ct) { var out = new Uint8Array(12 + ct.byteLength); out.set(iv, 0); out.set(new Uint8Array(ct), 12); return out.buffer; });
  }
  function unseal(key, buf) {
    var a = new Uint8Array(buf);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: a.slice(0, 12) }, key, a.slice(12)).then(function (p) { var b = new Uint8Array(p); return { type: b[0], data: b.slice(1) }; });
  }
  var enc = new TextEncoder(), dec = new TextDecoder();

  /* ---------- Keep: a copy of the sender's files in this browser (IndexedDB), so a refresh doesn't lose them (v3).
     Nothing leaves the device. Wiped on Stop sharing or ✕; copies left by a closed tab are wiped on the next visit. ---------- */
  var Keep = (function () {
    var dbp = null, STALE = 10 * 60 * 1000;
    function open() {
      if (!dbp) dbp = new Promise(function (res, rej) {
        if (!window.indexedDB) { rej(new Error("no storage")); return; }
        var r; try { r = indexedDB.open("scaredy-keep", 1); } catch (e) { rej(e); return; }
        r.onupgradeneeded = function () { var db = r.result; db.createObjectStore("files", { keyPath: ["sid", "id"] }).createIndex("sid", "sid"); db.createObjectStore("sessions", { keyPath: "sid" }); };
        r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error || new Error("storage")); };
      });
      return dbp;
    }
    function run(stores, mode, fn) {
      return open().then(function (db) { return new Promise(function (res, rej) {
        var t = db.transaction(stores, mode), out = {}; fn(t, out);
        t.oncomplete = function () { res(out.v); }; t.onerror = t.onabort = function () { rej(t.error || new Error("storage")); };
      }); });
    }
    return {
      ok: function () { return open().then(function () { return true; }, function () { return false; }); },
      put: function (sid, f) { return run(["files", "sessions"], "readwrite", function (t) {
        t.objectStore("files").put({ sid: sid, id: f.id, name: f.file.name, type: f.file.type, lastModified: f.file.lastModified, blob: f.file });
        t.objectStore("sessions").put({ sid: sid, seen: Date.now() }); }); },
      del: function (sid, id) { return run(["files"], "readwrite", function (t) { t.objectStore("files").delete([sid, id]); }).catch(function () {}); },
      load: function (sid) { return run(["files"], "readonly", function (t, out) { var r = t.objectStore("files").index("sid").getAll(sid); r.onsuccess = function () { out.v = r.result || []; }; })
        .then(function (rows) { return (rows || []).sort(function (a, b) { return a.id - b.id; }).map(function (x) { return { id: x.id, file: new File([x.blob], x.name, { type: x.type || "", lastModified: x.lastModified || Date.now() }) }; }); })
        .catch(function () { return []; }); },
      wipe: function (sid) { return run(["files", "sessions"], "readwrite", function (t) {
        var fs = t.objectStore("files"), r = fs.index("sid").getAllKeys(sid); r.onsuccess = function () { (r.result || []).forEach(function (k) { fs.delete(k); }); };
        t.objectStore("sessions").delete(sid); }).catch(function () {}); },
      touch: function (sid) { return run(["sessions"], "readwrite", function (t) { t.objectStore("sessions").put({ sid: sid, seen: Date.now() }); }).catch(function () {}); },
      sweep: function (mine) { return run(["files", "sessions"], "readwrite", function (t) {      // copies from tabs closed a while ago
        var ss = t.objectStore("sessions"), fs = t.objectStore("files"), live = {}; live[mine] = 1;
        var r = ss.getAll(); r.onsuccess = function () {
          (r.result || []).forEach(function (s) { if (s.sid !== mine && Date.now() - s.seen > STALE) ss.delete(s.sid); else live[s.sid] = 1; });
          var k = fs.getAllKeys(); k.onsuccess = function () { (k.result || []).forEach(function (key) { if (!live[key[0]]) fs.delete(key); }); };
        }; }).catch(function () {}); }
    };
  })();

  function poller(room, token, onMsgs, onGone) {
    var stopped = false;
    (function loop() {
      if (stopped) return;
      api("GET", room + "/poll?token=" + encodeURIComponent(token)).then(function (d) { if (!stopped) onMsgs(d); loop(); })
        .catch(function (e) { if (stopped) return; if (e.status === 404 || e.status === 403 || e.status === 409) { stopped = true; onGone(e); return; } setTimeout(loop, 2000); });
    })();
    return { stop: function () { stopped = true; } };
  }

  /* the ghost: tap three times for a "boo!" */
  var taps = [];
  $("hero-cat").addEventListener("click", function () {
    var t = Date.now(); taps = taps.filter(function (x) { return t - x < 1200; }); taps.push(t);
    if (taps.length >= 3) { taps = []; $("boo").hidden = false; setTimeout(function () { $("boo").hidden = true; }, 1400); }
  });

  /* dropping a file anywhere on the page: the sender's handler adds it; elsewhere the browser mustn't open it instead */
  var onPageDrop = null, dragDepth = 0;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1; }
  document.addEventListener("dragover", function (e) { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = onPageDrop ? "copy" : "none"; } });
  document.addEventListener("dragenter", function (e) { if (hasFiles(e) && onPageDrop) { dragDepth++; document.body.classList.add("dragging"); } });
  document.addEventListener("dragleave", function () { if (dragDepth > 0 && --dragDepth === 0) document.body.classList.remove("dragging"); });
  document.addEventListener("drop", function (e) {
    if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging");
    if (onPageDrop && e.dataTransfer.files.length) onPageDrop(e.dataTransfer.files);
  });

  var hash = location.hash.replace(/^#/, ""), code = location.pathname.match(CODE_RE);
  if (/^[2-9a-hjkmnp-z]{8}\.[A-Za-z0-9_-]{20,}$/.test(hash)) receiver(hash.split(".")[0], hash.split(".")[1]);
  else if (code) receiver(code[1] + code[2], null);
  else sender();

  /* =====================================================================  SENDER  */
  function sender() {
    var files = [], nextId = 1, key = null, keyB64 = "", room = null, token = null, mode = "direct", poll = null, people = {}, count = 0, wakeLock = null, sharing = false, hiddenAt = 0, over = false;
    var title = document.title, sess = null, keepable = true, lastTouch = 0, keeping = {}, notKept = {};
    var SS = "scaredy-share";
    function err(m) { $("err").textContent = m || ""; $("err").hidden = !m; }
    function total() { return files.reduce(function (n, f) { return n + f.file.size; }, 0); }
    function fileById(id) { return files.filter(function (f) { return f.id === id; })[0]; }

    /* this tab's session (sessionStorage survives a refresh, not a closed tab): files are kept under its sid */
    function saveSess() {
      if (!sess) return;
      sess.nextId = nextId;
      if (sharing) { sess.room = room; sess.token = token; sess.key = keyB64; sess.mode = mode; } else { delete sess.room; delete sess.token; delete sess.key; delete sess.mode; }
      try { sessionStorage.setItem(SS, JSON.stringify(sess)); } catch (e) { /* private mode: no refresh safety */ }
    }
    try { sess = JSON.parse(sessionStorage.getItem(SS) || "null"); } catch (e) { sess = null; }
    if (!sess || !/^[a-z0-9]{12,}$/.test(sess.sid || "")) sess = { sid: Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(9)), function (b) { return (b % 36).toString(36); }).join("") + Date.now().toString(36), nextId: 1 };
    nextId = sess.nextId || 1;

    function keptLine() {
      var ids = files.map(function (f) { return f.id; });
      var busy = ids.filter(function (id) { return keeping[id]; }).length, bad = ids.filter(function (id) { return notKept[id]; }).length, t = "";
      if (!files.length) t = "";
      else if (!keepable) t = "⚠ Don't refresh this page: this browser can't keep your files through a refresh.";
      else if (busy) t = "Keeping a copy in this browser so a refresh won't lose " + (files.length === 1 ? "it" : "them") + "…";
      else if (bad) t = "⚠ This browser didn't have room to keep " + plural(bad, "file", "files") + " through a refresh. If you refresh, add " + (bad === 1 ? "it" : "them") + " again.";
      else t = "↻ Safe to refresh. A copy stays in this browser (only on your device) until you stop sharing.";
      ["kept-pick", "kept-share"].forEach(function (id) { var el = $(id); if (el) { el.textContent = t; el.hidden = !t; } });
    }
    function keepFile(f) {
      if (!keepable) return;
      keeping[f.id] = 1; keptLine();
      Keep.put(sess.sid, f).then(function () { delete notKept[f.id]; }, function () { notKept[f.id] = 1; Keep.del(sess.sid, f.id); })
        .then(function () { delete keeping[f.id]; keptLine(); });
    }
    function listHtml(ul, removable) {
      ul.innerHTML = ""; ul.hidden = !files.length;
      files.forEach(function (f) {
        var li = document.createElement("li");
        li.innerHTML = '<span class="ico"></span><span class="fn"><b></b><small></small></span>' + (removable ? '<button type="button" class="x" aria-label="Remove">✕</button>' : "");
        li.querySelector(".ico").textContent = icon(f.file.name); li.querySelector("b").textContent = f.file.name; li.querySelector("small").textContent = size(f.file.size);
        if (removable) { li.querySelector(".x").setAttribute("aria-label", "Remove " + f.file.name); li.querySelector(".x").addEventListener("click", function () { removeFile(f.id); }); }
        ul.appendChild(li);
      });
    }
    function showPicked() {
      listHtml($("pick-list"), true);
      $("drop").classList.toggle("has", files.length > 0);
      $("drop-main").innerHTML = files.length ? "<b>Add more files</b> or drop them here" : "<b>Pick files</b> or drop them here";
      $("drop-sub").textContent = files.length ? plural(files.length, "file", "files") + " · " + size(total()) : "They stay right here until someone opens the link.";
      $("file").value = ""; keptLine();
    }
    function addFiles(list) {
      if (over) return;
      Array.prototype.forEach.call(list || [], function (file) {
        if (!files.some(function (f) { return f.file.name === file.name && f.file.size === file.size && f.file.lastModified === file.lastModified; })) { var f = { id: nextId++, file: file }; files.push(f); keepFile(f); }
      });
      saveSess(); err(""); if (sharing) shareChanged(); else showPicked();
    }
    function removeFile(id) {
      files = files.filter(function (f) { return f.id !== id; }); delete notKept[id]; delete keeping[id];
      Keep.del(sess.sid, id);
      if (sharing) shareChanged(); else showPicked();
    }
    $("file").addEventListener("change", function () { addFiles($("file").files); });
    $("add-file").addEventListener("change", function () { addFiles($("add-file").files); $("add-file").value = ""; });
    onPageDrop = addFiles;                           // drop files anywhere on the page, before or while sharing (v3)
    ["drop", "drop-add"].forEach(function (zone) {
      ["dragenter", "dragover"].forEach(function (t) { $(zone).addEventListener(t, function (e) { if (!over) $(zone).classList.add("over"); }); });
      ["dragleave", "drop"].forEach(function (t) { $(zone).addEventListener(t, function () { $(zone).classList.remove("over"); }); });
    });

    $("start").addEventListener("click", function () {
      if (!files.length) { err("Pick at least one file first."); return; }
      if (!window.crypto || !crypto.subtle || !window.RTCPeerConnection) { err("This browser can't do it. Try an up-to-date Chrome, Firefox, Edge or Safari."); return; }
      var v = (document.querySelector('input[name="mode"]:checked') || {}).value; mode = v === "relay" || v === "short" ? v : "direct";
      $("start").disabled = true; err("");
      var raw = crypto.getRandomValues(new Uint8Array(16));
      keyB64 = b64u(raw);
      importKey(raw).then(function (k) { key = k; return api("POST", "rooms", mode === "short" ? { mode: mode, key: keyB64 } : { mode: mode }); }).then(function (d) {
        room = d.room; token = d.token; openShare();
      }).catch(function (e) { $("start").disabled = false; err(e.message); });
    });
    function openShare() {
      sharing = true; saveSess();
      var link = mode === "short" ? location.origin + "/" + room.slice(0, 4) + "-" + room.slice(4) : location.origin + "/#" + room + "." + keyB64;
      $("link").value = link;
      $("mode-line").textContent = mode === "relay" ? "Encrypted relay: taking the encrypted shortcut. Still never stored." :
        mode === "short" ? "Short link: easy to type or say. The key passes through our server while you connect (never saved)." :
        "Direct: straight between your browsers. If their network blocks it, they'll be told.";
      try { dropQR.draw($("qr"), link); } catch (e) { /* QR is optional */ }
      strip("share-strip", null, mode === "relay");
      $("send").hidden = true; $("why").hidden = true; $("share").hidden = false; window.scrollTo(0, 0);
      shareChanged(); keepAwake();
      poll = poller(room, token, onSignal, function (e) {
        if (e && e.code === "moved") ended("This link is now being shared from another tab or window.", "moved");
        else ended("This link vanished while this page was away. Your files are still here.", "vanished");
      });
    }

    /* coming back after a refresh: bring the kept files back and, if a link was open, carry on with the same link */
    function restore() {
      var s = sess, tries = 0;
      Keep.ok().then(function (ok) { keepable = ok; if (ok) { Keep.touch(s.sid); Keep.sweep(s.sid); } });
      var filesBack = Keep.load(s.sid).then(function (list) {
        files = list.concat(files.filter(function (f) { return !list.some(function (k) { return k.id === f.id; }); }));   // keep anything added meanwhile
        files.forEach(function (f) { if (f.id >= nextId) nextId = f.id + 1; });
      });
      if (!s.room || !s.token || !s.key) { filesBack.then(function () { if (files.length) { showPicked(); } }); return; }
      $("start").disabled = true; $("drop-sub").textContent = "Coming back to your link…";
      (function resume() {
        api("POST", s.room + "/resume", { token: s.token }).then(function (d) {
          room = s.room; token = s.token; mode = d.mode || s.mode; keyB64 = s.key;
          return Promise.all([importKey(unb64u(keyB64)), filesBack]).then(function (r) { key = r[0]; $("start").disabled = false; openShare(); });
        }).catch(function (e) {
          if (!e.status && ++tries < 5) { setTimeout(resume, 2000); return; }       // offline for a moment: try again
          sharing = false; saveSess();
          filesBack.then(function () { $("start").disabled = false; showPicked(); if (files.length) err("Your link ended while this page was away, but your files are still here. Make a new link to share them again."); });
        });
      })();
    }
    restore();
    window.addEventListener("pageshow", function (e) { if (e.persisted && sharing) location.reload(); });   // back from the browser's page cache

    /* the list changed while sharing: redraw it and tell everyone connected */
    function shareChanged() {
      listHtml($("share-list"), true);
      $("what").textContent = files.length ? plural(files.length, "file", "files") + " · " + size(total()) : "No files right now. Add some, or anyone opening the link will see an empty list.";
      Object.keys(people).forEach(function (pid) { sendList(pid); });
    }
    function listPayload() { return enc.encode(JSON.stringify({ files: files.map(function (f) { return { id: f.id, name: f.file.name, size: f.file.size, type: f.file.type || "application/octet-stream" }; }) })); }
    function sendList(pid) {
      var p = people[pid]; if (!p || p.stopped) return;
      seal(key, T_LIST, listPayload()).then(function (b) { if (mode === "relay") return relayPut(pid, b); if (p.dc && p.dc.readyState === "open") p.dc.send(b); }).catch(function () {});
    }

    function keepAwake() {
      var plain = "The link only works while this page is open and online. On a phone, keep the screen on.";
      if (!navigator.wakeLock) { $("keep-msg").textContent = plain; return; }
      navigator.wakeLock.request("screen").then(function (l) { wakeLock = l; l.addEventListener("release", function () { wakeLock = null; }); $("keep-msg").textContent = "The link only works while this page is open and online. Your screen will stay on while you share."; })
        .catch(function () { $("keep-msg").textContent = plain; });
    }
    document.addEventListener("visibilitychange", function () {
      if (!sharing) return;
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); document.title = "Don't leave me! 👻"; $("share-cat").classList.add("faded"); }
      else {
        document.title = title; $("share-cat").classList.remove("faded"); if (!wakeLock) keepAwake();
        var busy = Object.keys(people).some(function (pid) { return people[pid].busy; });
        if (hiddenAt && Date.now() - hiddenAt > 4000 && busy) $("keep-msg").textContent = "Welcome back! If your phone paused this page, anyone mid-download may need to open the link again.";
      }
    });
    window.addEventListener("pagehide", function () {
      // "soon": a refresh comes back within a few seconds and keeps the link; a closed page doesn't, and the link vanishes
      if (room && token && sharing) fetch("/api/" + room + "/close", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token, soon: true }) }).catch(function () {});
    });
    $("copy").addEventListener("click", function () {
      var t = $("link").value;
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () {
        $("copy").textContent = "Got it. Don't get spooked."; $("share-cat").classList.add("rise");
        setTimeout(function () { $("copy").textContent = "Copy link"; $("share-cat").classList.remove("rise"); }, 2000);
      }).catch(function () { $("link").select(); });
    });
    $("stop").addEventListener("click", function () {
      ask("Stop sharing?", "The link vanishes straight away. Anyone still downloading will be cut off.", "Stop sharing").then(function (yes) {
        if (!yes) return; api("POST", room + "/close", { token: token }).catch(function () {}); ended("You stopped sharing. The link has vanished, and the copy kept in this browser is wiped.", "stopped");
      });
    });
    function ended(msg, how) {
      sharing = false; over = true; document.title = title; if (poll) poll.stop();
      if (how === "stopped") { Keep.wipe(sess.sid); try { sessionStorage.removeItem(SS); } catch (e) { /* ignore */ } }
      else if (how === "moved") { try { sessionStorage.removeItem(SS); } catch (e) { /* ignore */ } }   // the other page owns it now
      else saveSess();          // vanished: keep the files so "Share these files again" can use them
      $("drop-add").hidden = true; $("kept-share").hidden = true;
      Object.keys(people).forEach(function (pid) { var p = people[pid]; p.stopped = true; if (p.pc) try { p.pc.close(); } catch (e) { /* ignore */ } });
      if (wakeLock) wakeLock.release().catch(function () {});
      $("keep").innerHTML = "👻 <b>Not sharing.</b> "; $("keep").appendChild(document.createTextNode(msg));
      $("stop").hidden = true; $("copy").disabled = true; $("share-title").textContent = "This link is already a ghost."; $("share-tag").textContent = "Make a new one whenever you're ready.";
      listHtml($("share-list"), false);
      mood("share-img", "share-cat", Object.keys(people).some(function (pid) { return people[pid].got > 0; }) ? "thumbs" : "ghost");
      var again = document.createElement("a"); again.className = "btn go"; again.href = "/";
      again.textContent = how === "vanished" && files.length ? "Share these files again" : "Share more files"; $("stop").parentNode.appendChild(again);
    }

    /* the People list + GmCat's mood */
    function overallMood() {
      var list = Object.keys(people).map(function (k) { return people[k]; });
      if (list.some(function (p) { return p.busy; })) { mood("share-img", "share-cat", "sweat", "wobble"); $("share-title").textContent = "Tiptoeing across…"; $("share-tag").textContent = "Try not to blink. Keep this page open."; return; }
      if (list.some(function (p) { return p.got > 0; })) { mood("share-img", "share-cat", "relieved"); $("share-title").textContent = "Made it. Nothing left behind."; $("share-tag").textContent = "Keep the page open if anyone still needs something, or add more files."; setTimeout(function () { if (/Made it/.test($("share-title").textContent)) mood("share-img", "share-cat", "thumbs"); }, 2500); return; }
      if (list.length && list.every(function (p) { return /Couldn't/.test(p.status); })) { mood("share-img", "share-cat", "eek"); $("share-title").textContent = "Eek."; $("share-tag").textContent = "Their network wouldn't let us sneak through."; return; }
      if (list.length) { mood("share-img", "share-cat", "peeking"); $("share-title").textContent = "Oh! Someone's at the other end."; $("share-tag").textContent = "Keep this page open."; return; }
      mood("share-img", "share-cat", "shy");
    }
    function personRow(pid) {
      var p = people[pid];
      if (!p.el) { $("nobody").hidden = true; p.el = document.createElement("li"); $("people").appendChild(p.el); }
      p.el.innerHTML = "<b>Person " + p.n + '</b><span class="st"></span>' + (p.busy ? '<div class="pbar"><i></i></div>' : "");
      p.el.querySelector(".st").textContent = p.status;
      if (p.busy) p.el.querySelector(".pbar i").style.width = Math.round(p.frac * 100) + "%";   // set in script: the page's CSP allows no inline style attributes
    }
    function setStatus(pid, status) { var p = people[pid]; if (!p) return; p.status = status; personRow(pid); overallMood(); }
    function signal(pid, data) { return api("POST", room + "/send", { token: token, to: pid, data: data }); }
    function gotLine(p) { return p.got ? "✓ Has " + plural(p.got, "file", "files") + "." : ""; }

    function onSignal(d) {
      if (Date.now() - lastTouch > 30000) { lastTouch = Date.now(); Keep.touch(sess.sid); }   // "this tab is still here"
      (d.msgs || []).forEach(function (m) {
        if (m.type === "join") {
          count += 1; people[m.peer] = { n: count, n2: 0, epoch: m.epoch || 0, got: 0, queue: [], busy: false, frac: 0, status: "Connecting…" }; personRow(m.peer); overallMood();
          if (mode === "relay") { sendList(m.peer); setStatus(m.peer, "Connected through the relay. Looking at your files…"); } else directOffer(m.peer);
          return;
        }
        var p = people[m.from]; if (!p || !m.data) return;
        var x = m.data;
        if (x.type === "answer" && p.pc) p.pc.setRemoteDescription(x.sdp).then(function () { (p.ice || []).forEach(function (c) { p.pc.addIceCandidate(c).catch(function () {}); }); p.ice = []; }).catch(function () {});
        else if (x.type === "ice" && p.pc && x.c) { if (p.pc.remoteDescription) p.pc.addIceCandidate(x.c).catch(function () {}); else (p.ice = p.ice || []).push(x.c); }
        else if (x.type === "get" && mode === "relay") want(m.from, x.ids);
        else if (x.type === "got") gotOne(m.from);
        else if (x.type === "bye") { p.stopped = true; p.busy = false; setStatus(m.from, (gotLine(p) + " They left.").trim()); }
      });
      if (d.peers) Object.keys(people).forEach(function (pid) {
        var p = people[pid];
        if (d.peers.indexOf(pid) === -1 && !p.stopped) { p.stopped = true; p.busy = false; setStatus(pid, (gotLine(p) + " They left.").trim()); }
      });
    }
    function gotOne(pid) { var p = people[pid]; if (!p) return; p.got += 1; if (!p.queue.length && !p.sending) { p.busy = false; setStatus(pid, gotLine(p)); } stripDone("share-strip"); }

    /* each person asks for files (all, or one by one); they're sent one after another */
    function want(pid, ids) {
      var p = people[pid]; if (!p) return;
      (ids || []).forEach(function (id) { if (p.queue.indexOf(id) === -1) p.queue.push(id); });
      pump(pid);
    }
    function pump(pid) {
      var p = people[pid]; if (!p || p.sending || p.stopped) return;
      var id = p.queue.shift(); if (id == null) return;
      var f = fileById(id); if (!f) { pump(pid); return; }          // removed meanwhile: skip it
      p.sending = true; p.busy = true;
      var send = mode === "relay" ? relaySendFile : directSendFile;
      send(pid, f).then(function () { p.sending = false; pump(pid); }).catch(function (e) { p.sending = false; p.busy = false; if (!p.stopped) setStatus(pid, e.status === 410 ? "They left." : e.message || "Something went wrong."); });
    }
    function progress(pid, f, sent) {
      var p = people[pid]; p.frac = f.file.size ? sent / f.file.size : 1;
      if (!p.tick || Date.now() - p.tick > 250 || sent >= f.file.size) { p.tick = Date.now(); setStatus(pid, "Tiptoeing across… " + f.file.name + " · " + Math.round(p.frac * 100) + "%"); }
      strip("share-strip", p.frac, mode === "relay");
    }

    /* ---- direct (and short link): one WebRTC connection per person ---- */
    function directOffer(pid) {
      var p = people[pid], pc = new RTCPeerConnection({ iceServers: ICE }); p.pc = pc;
      var dc = pc.createDataChannel("files", { ordered: true }); dc.binaryType = "arraybuffer"; dc.bufferedAmountLowThreshold = 1024 * 1024; p.dc = dc;
      pc.onicecandidate = function (e) { if (e.candidate) signal(pid, { type: "ice", c: e.candidate.toJSON() }).catch(function () {}); };
      var timer = setTimeout(function () { if (dc.readyState !== "open") fail(); }, CONNECT_TIMEOUT);
      function fail() { if (p.stopped) return; p.stopped = true; setStatus(pid, "Couldn't sneak through their network. Make a new link with Encrypted relay."); try { pc.close(); } catch (e) { /* ignore */ } }
      pc.onconnectionstatechange = function () { if (pc.connectionState === "failed") fail(); };
      dc.onopen = function () { clearTimeout(timer); setStatus(pid, "Connected. Looking at your files…"); sendList(pid); };
      dc.onmessage = function (e) {
        if (typeof e.data !== "string") return;
        var m; try { m = JSON.parse(e.data); } catch (x) { return; }
        if (m.type === "get") want(pid, m.ids); else if (m.type === "got") gotOne(pid);
      };
      dc.onclose = function () { if (!p.stopped) { p.stopped = true; p.busy = false; setStatus(pid, (gotLine(p) + " The connection closed.").trim()); } };
      pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).then(function () { return signal(pid, { type: "offer", sdp: pc.localDescription.toJSON() }); }).catch(fail);
    }
    function directSendFile(pid, f) {
      var p = people[pid], dc = p.dc, off = 0, idb = u32(f.id);
      return new Promise(function (resolve, reject) {
        (function next() {
          if (p.stopped || dc.readyState !== "open") { reject(new Error("The connection closed.")); return; }
          if (dc.bufferedAmount > 4 * 1024 * 1024) { dc.onbufferedamountlow = function () { dc.onbufferedamountlow = null; next(); }; return; }
          if (off >= f.file.size) { seal(key, T_DONE, idb).then(function (b) { dc.send(b); resolve(); }, reject); return; }
          var end = Math.min(f.file.size, off + DC_CHUNK);
          f.file.slice(off, end).arrayBuffer().then(function (buf) { return seal(key, T_DATA, cat2(idb, buf)); }).then(function (b) {
            if (dc.readyState !== "open") { reject(new Error("The connection closed.")); return; }
            dc.send(b); off = end; progress(pid, f, off); next();
          }).catch(function () { reject(new Error("Couldn't read " + f.file.name + ". Try adding it again.")); });
        })();
      });
    }

    /* ---- relay: every piece for a person goes in order (n = 0, 1, 2…): lists, file pieces, "done" marks ---- */
    function relayPut(pid, body) {
      var p = people[pid]; if (!p) return Promise.reject(new Error("gone"));
      p.chain = (p.chain || Promise.resolve()).catch(function () {}).then(function () { var n = p.n2++; return put(n); });
      return p.chain;
      function put(n) {
        return fetch("/api/" + room + "/relay/" + pid + "/" + n, { method: "POST", headers: { "X-Scaredy-Token": token, "X-Scaredy-Epoch": String(p.epoch || 0), "Content-Type": "application/octet-stream" }, body: body })
          .then(function (r) {
            if (r.status === 429) return r.json().catch(function () { return {}; }).then(function (d) { if (d.code === "window") return wait(250).then(function () { return put(n); }); var e = new Error(d.error || "Too busy"); e.status = 429; throw e; });
            if (!r.ok) return r.json().catch(function () { return {}; }).then(function (d) { var e = new Error(d.error || "Relay error"); e.status = r.status; throw e; });
          });
      }
    }
    function relaySendFile(pid, f) {
      var off = 0, idb = u32(f.id);
      function next() {
        if (people[pid].stopped) return Promise.reject(new Error("They left."));
        if (off >= f.file.size) return seal(key, T_DONE, idb).then(function (b) { return relayPut(pid, b); });
        var end = Math.min(f.file.size, off + RELAY_CHUNK);
        return f.file.slice(off, end).arrayBuffer().then(function (buf) { return seal(key, T_DATA, cat2(idb, buf)); })
          .then(function (b) { return relayPut(pid, b); }).then(function () { off = end; progress(pid, f, off); return next(); });
      }
      return next();
    }
  }

  /* =====================================================================  RECEIVER  */
  function receiver(room, keyB64) {
    $("send").hidden = true; $("recv").hidden = false; $("why").hidden = true;
    var key = null, me = null, token = null, mode = null, poll = null, pc = null, dc = null, ended = false, pendingIce = [], lastGot = 0, stallTimer = null;
    var list = [], items = {}, current = null, wanted = [], saved = 0;   // items[id] = {meta, parts, got, state, url}
    var epoch = 0, relayGen = 0, resumeIds = [], everOpen = false;      // v3: the sender's page can reload and come back
    function status(t) { $("r-status").textContent = t; }
    function hint(t) { $("r-hint").textContent = t || ""; $("r-hint").hidden = !t; }
    function stopAll() { if (poll) poll.stop(); if (pc) try { pc.close(); } catch (e) { /* ignore */ } clearInterval(stallTimer); }
    function gone() {
      if (ended) return; ended = true; stopAll(); hint("");
      var mid = current != null || resumeIds.length > 0;
      mood("recv-img", "recv-cat", saved ? "thumbs" : "sad");
      $("r-go").hidden = true; drawList(true);
      if (mid) { $("recv-title").textContent = "The other page went dark."; status("The sender closed the page or went offline before it finished." + (saved ? " The files you already saved are safe." : "") + " Open the link again if they're back, or ask for a new one."); }
      else if (saved) { $("recv-title").textContent = "The sender has stopped sharing."; status("Your saved files are safe on your device. Nothing was left behind."); }
      else { $("r-file").hidden = true; $("recv-title").textContent = "This link is already a ghost."; status("The sender closed the page, so this link has vanished. Ask them for a new one."); }
    }
    function send(obj) {
      if (mode !== "relay" && dc && dc.readyState === "open") dc.send(JSON.stringify(obj));
      else api("POST", room + "/send", { token: token, to: "sender", data: obj }).catch(function () {});
    }
    function drawList(frozen) {
      var ul = $("r-list"); ul.innerHTML = "";
      list.forEach(function (m) {
        var it = items[m.id] || (items[m.id] = { meta: m, parts: [], got: 0, state: "new" });
        it.meta = m;
        var li = document.createElement("li");
        li.innerHTML = '<span class="ico"></span><span class="fn"><b></b><small></small></span><span class="act"></span>';
        li.querySelector(".ico").textContent = icon(m.name); li.querySelector("b").textContent = m.name;
        li.querySelector("small").textContent = size(m.size) + (it.state === "receiving" ? " · " + Math.round(it.got / Math.max(1, m.size) * 100) + "%" : it.state === "queued" ? " · waiting" : it.state === "done" ? " · saved" : "");
        var act = li.querySelector(".act");
        if (it.state === "done") { var a = document.createElement("a"); a.className = "btn small-btn"; a.href = it.url; a.download = m.name; a.textContent = "Save again"; act.appendChild(a); }
        else if (it.state === "new" && !frozen) { var b = document.createElement("button"); b.type = "button"; b.className = "btn small-btn"; b.textContent = "Receive"; b.addEventListener("click", function () { ask1([m.id]); }); act.appendChild(b); }
        else if (it.state === "receiving") act.textContent = "⏳";
        else if (it.state === "queued") act.textContent = "…";
        ul.appendChild(li);
      });
      Object.keys(items).forEach(function (k) {                       // saved files the sender later removed stay listed
        var id = +k; if (list.some(function (m) { return m.id === id; }) || items[id].state !== "done") return;
        var it = items[id], li = document.createElement("li");
        li.innerHTML = '<span class="ico"></span><span class="fn"><b></b><small>saved</small></span><span class="act"><a class="btn small-btn">Save again</a></span>';
        li.querySelector(".ico").textContent = icon(it.meta.name); li.querySelector("b").textContent = it.meta.name;
        var a = li.querySelector("a"); a.href = it.url; a.download = it.meta.name; ul.appendChild(li);
      });
      var fresh = list.filter(function (m) { return items[m.id].state === "new"; });
      $("r-go").hidden = frozen || fresh.length < 1; $("r-go").textContent = fresh.length === 1 ? "Receive file" : "Receive all (" + fresh.length + ")";
      $("r-multi").hidden = list.length < 2;
      if (!list.length && !frozen && !saved) status("The sender's list is empty right now. Keep this page open; it updates by itself.");
    }
    /* the sender's page went away (refresh?): half-received files start again when it's back */
    function resetPartial() {
      Object.keys(items).forEach(function (k) { var it = items[k]; if (it.state === "receiving" || it.state === "queued") { it.state = "new"; it.parts = []; it.got = 0; if (resumeIds.indexOf(+k) === -1) resumeIds.push(+k); } });
      wanted = []; current = null; $("r-pct").textContent = ""; if (list.length) drawList(false);
    }
    function senderAway() {
      resetPartial(); mood("recv-img", "recv-cat", "peeking");
      hint("The sender's page went away for a moment. Waiting a few seconds in case it comes back…");
    }
    function senderBack(e) {
      resetPartial();
      if (pc) { var old = pc; pc = null; dc = null; try { old.close(); } catch (x) { /* ignore */ } }
      if (mode === "relay") { epoch = e || 0; relayGen += 1; relayGet(0, relayGen); }
      hint(resumeIds.length ? "The sender's page reloaded. Picking up where you left off…" : "The sender's page reloaded. Reconnecting…");
    }
    function onList(obj) {
      var before = list.length, first = !$("r-file").getAttribute("data-seen");
      list = obj.files || [];
      if (resumeIds.length) {                                            // carry on with what was being received
        var again = resumeIds.filter(function (id) { return list.some(function (m) { return m.id === id; }); }); resumeIds = [];
        if (again.length) setTimeout(function () { ask1(again); }, 0);
        if (!again.length) hint("");
      } else if (/reloaded/.test($("r-hint").textContent)) hint("");
      Object.keys(items).forEach(function (k) { var id = +k; if (!list.some(function (m) { return m.id === id; }) && items[id].state === "queued") { items[id].state = "gone"; wanted = wanted.filter(function (x) { return x !== id; }); } });
      if (!first && list.length !== before) hint(list.length > before ? "The sender added a file." : "The sender changed the list.");
      $("r-file").hidden = false; $("r-file").setAttribute("data-seen", "1");
      if (current == null && !saved && !wanted.length) { mood("recv-img", "recv-cat", "shy"); $("recv-title").textContent = list.length === 1 ? "Your file is ready." : "Your files are ready."; status(list.length ? "Oh! Here " + (list.length === 1 ? "it is" : "they are") + ". Keep this page open while they come across." : ""); }
      drawList(false);
    }
    function ask1(ids) {
      ids = ids.filter(function (id) { return items[id] && items[id].state === "new"; }); if (!ids.length) return;
      ids.forEach(function (id) { items[id].state = "queued"; wanted.push(id); });
      send({ type: "get", ids: ids });
      mood("recv-img", "recv-cat", "sweat", "wobble"); $("recv-title").textContent = "Tiptoeing across…"; status("Receiving. Keep this page open.");
      if (!stallTimer) watchStall(); lastGot = Date.now(); drawList(false);
    }
    $("r-go").addEventListener("click", function () { ask1(list.map(function (m) { return m.id; })); });
    function handleFrame(f) {
      if (f.type === T_LIST) { onList(JSON.parse(dec.decode(f.data))); return; }
      var id = readU32(f.data), it = items[id]; if (!it) return;
      if (f.type === T_DATA) {
        current = id; it.state = "receiving"; it.parts.push(f.data.slice(4)); it.got += f.data.byteLength - 4; lastGot = Date.now(); hint("");
        $("r-pct").textContent = "Tiptoeing across… " + it.meta.name + " · " + Math.round(it.got / Math.max(1, it.meta.size) * 100) + "% (" + size(it.got) + " of " + size(it.meta.size) + ")";
        strip("recv-strip", it.got / Math.max(1, it.meta.size), mode === "relay");
        if (!it.tick || Date.now() - it.tick > 300) { it.tick = Date.now(); drawList(false); }
        return;
      }
      if (f.type === T_DONE) {
        var blob = new Blob(it.parts, { type: it.meta.type || "application/octet-stream" }); it.parts = [];
        it.url = URL.createObjectURL(blob); it.state = "done"; current = null; saved += 1;
        var a = document.createElement("a"); a.href = it.url; a.download = it.meta.name; document.body.appendChild(a); a.click(); a.remove();
        send({ type: "got", id: id }); stripDone("recv-strip");
        wanted = wanted.filter(function (x) { return x !== id; });
        drawList(false);
        if (!wanted.length) {
          $("r-pct").textContent = ""; mood("recv-img", "recv-cat", "relieved"); $("recv-title").textContent = "Phew. You've got " + (saved === 1 ? "it" : "them") + ".";
          status("✓ Made it. Nothing left behind. Check your downloads." + (list.some(function (m) { return items[m.id] && items[m.id].state === "new"; }) ? " There's more you can receive below." : ""));
          setTimeout(function () { if (!wanted.length && !ended) mood("recv-img", "recv-cat", "thumbs"); }, 2500);
        }
      }
    }
    window.addEventListener("pagehide", function () {
      if (token && !ended) fetch("/api/" + room + "/send", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token, to: "sender", data: { type: "bye" } }) }).catch(function () {});
    });
    function watchStall() {
      stallTimer = setInterval(function () { if (!ended && wanted.length && Date.now() - lastGot > STALL) hint("Waiting for the sender's page… If they're on a phone, it may have paused. Ask them to come back to the Scaredy GmCat page."); }, 3000);
    }
    function badKey() { ended = true; stopAll(); mood("recv-img", "recv-cat", "eek"); $("recv-title").textContent = "That key doesn't fit."; status("This link's key doesn't match. Check you copied the whole link, including the part after the #."); $("r-file").hidden = true; }

    api("POST", room + "/join", {}).then(function (d) {
      me = d.peer; token = d.token; mode = d.mode;
      var k = keyB64 || d.key; if (!k) throw Object.assign(new Error("This link is missing its key."), { code: "nokey" });
      return importKey(unb64u(k));
    }).then(function (k) {
      key = k;
      status(mode === "relay" ? "Taking the encrypted shortcut to the sender…" : "Tiptoeing over to the sender's browser…");
      poll = poller(room, token, onSignal, gone);
      if (mode === "relay") relayGet(0, relayGen);
      else setTimeout(function () {
        if ($("r-file").hidden && !ended && (!dc || dc.readyState !== "open")) { stopAll(); ended = true; mood("recv-img", "recv-cat", "eek"); $("recv-title").textContent = "Eek."; status("Couldn't sneak through. Your network or the sender's blocks direct connections. Ask them to make a new link with Encrypted relay."); }
      }, CONNECT_TIMEOUT);
    }).catch(function (e) { if (e.code === "gone" || e.status === 404) gone(); else if (e.code === "nokey") badKey(); else status(e.message); });

    function onSignal(d) {
      (d.msgs || []).forEach(function (m) {
        var x = m.data || {};
        if (x.type === "again") senderBack(x.epoch);
        else if (x.type === "offer") answer(x.sdp);
        else if (x.type === "ice" && x.c) { if (pc && pc.remoteDescription) pc.addIceCandidate(x.c).catch(function () {}); else pendingIce.push(x.c); }
      });
    }
    function answer(sdp) {
      if (pc) { var stale = pc; pc = null; try { stale.close(); } catch (x) { /* ignore */ } }
      var mine = pc = new RTCPeerConnection({ iceServers: ICE });
      pc.onicecandidate = function (e) { if (e.candidate) api("POST", room + "/send", { token: token, to: "sender", data: { type: "ice", c: e.candidate.toJSON() } }).catch(function () {}); };
      pc.onconnectionstatechange = function () { if (pc === mine && !everOpen && mine.connectionState === "failed" && !ended) { mood("recv-img", "recv-cat", "eek"); status("Couldn't sneak through. Ask the sender to make a new link with Encrypted relay."); } };
      pc.ondatachannel = function (e) {
        if (pc !== mine) return;
        var ch = dc = e.channel; dc.binaryType = "arraybuffer";
        var chain = Promise.resolve();
        ch.onopen = function () { everOpen = true; };
        if (ch.readyState === "open") everOpen = true;
        ch.onmessage = function (ev) { if (typeof ev.data === "string" || dc !== ch) return; var buf = ev.data; chain = chain.then(function () { return unseal(key, buf); }).then(function (f) { if (dc === ch) handleFrame(f); }).catch(badKey); };
        ch.onclose = function () { if (!ended && dc === ch) { dc = null; senderAway(); } };   // gone() comes from the poll if it never returns
      };
      pc.setRemoteDescription(sdp).then(function () { pendingIce.forEach(function (c) { pc.addIceCandidate(c).catch(function () {}); }); pendingIce = []; return pc.createAnswer(); })
        .then(function (a) { return pc.setLocalDescription(a); })
        .then(function () { return api("POST", room + "/send", { token: token, to: "sender", data: { type: "answer", sdp: pc.localDescription.toJSON() } }); })
        .catch(function () { status("Couldn't sneak through. Ask the sender to make a new link with Encrypted relay."); });
    }
    function relayGet(n, gen) {
      if (ended || gen !== relayGen) return;
      fetch("/api/" + room + "/relay/" + me + "/" + n + "?token=" + encodeURIComponent(token) + "&e=" + epoch, { cache: "no-store" }).then(function (r) {
        if (gen !== relayGen || r.status === 409) return;                // the sender's page reloaded: a new loop has started
        if (r.status === 204) return relayGet(n, gen);
        if (!r.ok) { gone(); return; }
        return r.arrayBuffer().then(function (buf) { return unseal(key, buf).catch(function () { badKey(); throw new Error("key"); }); }).then(function (f) { if (gen !== relayGen) return; handleFrame(f); relayGet(n + 1, gen); });
      }).catch(function (e) { if (!ended && e.message !== "key") setTimeout(function () { relayGet(n, gen); }, 1500); });
    }
  }
})();
