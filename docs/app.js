/* tubelight front end. Plain JS, no build step.
 * Loads catalog.json, renders shelves (index) or the player (watch).
 * Nothing here talks to youtube.com: the only YouTube host is
 * www.youtube-nocookie.com (player) and i.ytimg.com (thumbnails). */
(function () {
  "use strict";

  var EMBED = "https://www.youtube-nocookie.com/embed/";
  var EMBED_PARAMS = "rel=0&iv_load_policy=3&playsinline=1";
  var LS_KEY = "tubelight.recent";
  var RECENT_MAX = 12;

  // ---- storage (localStorage may be unavailable or full) ----
  function readRecent() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter(function (x) { return typeof x === "string"; }) : [];
    } catch (e) { return []; }
  }
  function pushRecent(id) {
    try {
      var list = readRecent().filter(function (x) { return x !== id; });
      list.unshift(id);
      localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
    } catch (e) { /* ignore */ }
  }

  // ---- helpers ----
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function fmtDuration(s) {
    s = Math.max(0, s | 0);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var mm = h ? String(m).padStart(2, "0") : String(m);
    return (h ? h + ":" : "") + mm + ":" + String(sec).padStart(2, "0");
  }
  function qs(name) {
    try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
  }
  function isVideoId(id) { return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id); }

  function card(video, shelfIndex, onClick) {
    var a = el("a", "card");
    a.href = "watch.html?v=" + encodeURIComponent(video.id) + "&s=" + shelfIndex;
    a.setAttribute("aria-label", video.title + ", " + video.channel);
    var th = el("div", "thumb");
    var img = el("img");
    img.src = video.thumbnail;
    img.alt = "";
    img.loading = "lazy";
    img.width = 320; img.height = 180;
    th.appendChild(img);
    if (video.duration) th.appendChild(el("span", "dur", fmtDuration(video.duration)));
    a.appendChild(th);
    a.appendChild(el("div", "title", video.title));
    a.appendChild(el("div", "chan", video.channel));
    if (onClick) a.addEventListener("click", function (e) { e.preventDefault(); onClick(video); });
    return a;
  }

  function notice(root, heading, lines) {
    var box = el("div", "notice");
    box.appendChild(el("h2", null, heading));
    lines.forEach(function (l) {
      var p = el("p");
      if (typeof l === "string") p.textContent = l;
      else { p.appendChild(document.createTextNode(l[0])); p.appendChild(el("code", null, l[1])); p.appendChild(document.createTextNode(l[2] || "")); }
      box.appendChild(p);
    });
    root.innerHTML = "";
    root.appendChild(box);
  }

  function loadCatalog() {
    return fetch("catalog.json", { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("catalog.json " + r.status);
      return r.json();
    }).then(function (c) {
      if (!c || !Array.isArray(c.shelves)) throw new Error("catalog.json has no shelves");
      return c;
    });
  }

  function missingCatalog(root, err) {
    notice(root, "No videos yet", [
      ["The site needs ", "docs/catalog.json", ", which is built from the allowlist."],
      ["Run ", "YT_API_KEY=... python refresh.py", " locally, or run the “Refresh catalog” workflow on GitHub."],
      "Details: " + (err && err.message ? err.message : String(err))
    ]);
  }

  function indexById(catalog) {
    var map = {};
    catalog.shelves.forEach(function (shelf, si) {
      shelf.videos.forEach(function (v) { if (!map[v.id]) map[v.id] = { video: v, shelf: si }; });
    });
    return map;
  }

  // ---- index page ----
  function renderIndex(root, catalog) {
    root.innerHTML = "";
    var byId = indexById(catalog);
    var recent = readRecent().filter(function (id) { return byId[id]; });
    if (recent.length) {
      var sec = el("section", "shelf");
      sec.appendChild(el("h2", null, "Continue watching"));
      var row = el("div", "row");
      recent.forEach(function (id) { row.appendChild(card(byId[id].video, byId[id].shelf)); });
      sec.appendChild(row);
      root.appendChild(sec);
    }
    var any = false;
    catalog.shelves.forEach(function (shelf, si) {
      if (!shelf.videos.length) return;
      any = true;
      var sec = el("section", "shelf");
      sec.appendChild(el("h2", null, shelf.name));
      var row = el("div", "row");
      shelf.videos.forEach(function (v) { row.appendChild(card(v, si)); });
      sec.appendChild(row);
      root.appendChild(sec);
    });
    if (!any) notice(root, "The allowlist is empty", [
      ["Add channels to ", "allowlist.yaml", " and run the refresh again."]
    ]);
  }

  // ---- watch page ----
  function renderWatch(root, catalog) {
    var byId = indexById(catalog);
    var player = document.getElementById("player");
    var titleEl = document.getElementById("title");
    var chanEl = document.getElementById("channel");
    var moreTitle = document.getElementById("more-title");
    var grid = document.getElementById("more");
    var frame = null;

    function show(id, shelfHint, push, autoplay) {
      var entry = isVideoId(id) ? byId[id] : null;
      if (!entry) {
        player.innerHTML = "";
        titleEl.textContent = "That video is not on the list";
        chanEl.textContent = "Only videos from the allowlist can play here.";
        document.title = "Not on the list · tubelight";
        moreTitle.textContent = "Pick something else";
        grid.innerHTML = "";
        (catalog.shelves[0] ? catalog.shelves[0].videos : []).forEach(function (v) {
          grid.appendChild(card(v, 0, function (vv) { show(vv.id, 0, true, true); }));
        });
        return;
      }
      var v = entry.video;
      var si = (shelfHint != null && catalog.shelves[shelfHint] &&
        catalog.shelves[shelfHint].videos.some(function (x) { return x.id === id; })) ? shelfHint : entry.shelf;
      var shelf = catalog.shelves[si];

      // Swap the player. The iframe is used exactly as YouTube serves it.
      var src = EMBED + encodeURIComponent(id) + "?" + EMBED_PARAMS + (autoplay ? "&autoplay=1" : "");
      if (!frame) {
        frame = document.createElement("iframe");
        frame.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen");
        frame.setAttribute("allowfullscreen", "");
        frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
        player.innerHTML = "";
        player.appendChild(frame);
      }
      frame.title = v.title;
      frame.src = src;

      titleEl.textContent = v.title;
      chanEl.textContent = v.channel + (v.duration ? " · " + fmtDuration(v.duration) : "");
      document.title = v.title + " · tubelight";
      moreTitle.textContent = "More from " + shelf.name;
      grid.innerHTML = "";
      shelf.videos.forEach(function (other) {
        var c = card(other, si, function (vv) { show(vv.id, si, true, true); });
        if (other.id === id) c.classList.add("now");
        grid.appendChild(c);
      });

      pushRecent(id);
      var url = "watch.html?v=" + encodeURIComponent(id) + "&s=" + si;
      try {
        if (push) history.pushState({ v: id, s: si }, "", url);
        else history.replaceState({ v: id, s: si }, "", url);
      } catch (e) { /* file:// or sandbox */ }
      if (push) window.scrollTo({ top: 0, behavior: "smooth" });
    }

    var sParam = parseInt(qs("s"), 10);
    show(qs("v"), isNaN(sParam) ? null : sParam, false, false);
    window.addEventListener("popstate", function (e) {
      var st = e.state || {};
      var sp = parseInt(qs("s"), 10);
      show(st.v || qs("v"), st.s != null ? st.s : (isNaN(sp) ? null : sp), false, false);
    });
  }

  // ---- boot ----
  document.addEventListener("DOMContentLoaded", function () {
    var root = document.getElementById("app");
    if (!root) return;
    var page = document.body.getAttribute("data-page");
    loadCatalog().then(function (catalog) {
      if (page === "watch") renderWatch(root, catalog);
      else renderIndex(root, catalog);
    }).catch(function (err) {
      missingCatalog(root, err);
    });
  });
})();
