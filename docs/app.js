/* tubelight front end. Plain JS, no build step.
 * Loads catalog.json, renders shelves (index) or the player (watch).
 * Nothing here talks to youtube.com: the only YouTube hosts are
 * www.youtube-nocookie.com (player), i.ytimg.com (thumbnails) and
 * yt3.ggpht.com (channel avatars). Search filters the local catalog only. */
(function () {
  "use strict";

  var EMBED = "https://www.youtube-nocookie.com/embed/";
  var EMBED_PARAMS = "rel=0&iv_load_policy=3&playsinline=1";
  var LS_KEY = "tubelight.recent";
  var RECENT_MAX = 12;
  var SEARCH_MAX = 200;

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
  var compact = null;
  try { compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }); } catch (e) { /* old browser */ }
  function fmtViews(n) {
    if (typeof n !== "number" || !isFinite(n)) return "";
    var s = compact ? compact.format(n) : String(n);
    return s + (n === 1 ? " view" : " views");
  }
  function timeAgo(iso) {
    var t = Date.parse(iso || "");
    if (isNaN(t)) return "";
    var d = Math.max(0, (Date.now() - t) / 1000);
    var units = [[31536000, "year"], [2592000, "month"], [604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"]];
    for (var i = 0; i < units.length; i++) {
      var n = Math.floor(d / units[i][0]);
      if (n >= 1) return n + " " + units[i][1] + (n === 1 ? "" : "s") + " ago";
    }
    return "just now";
  }
  function qs(name) {
    try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
  }
  function isVideoId(id) { return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id); }

  // ---- card: thumbnail, then avatar + title + channel + "views · time ago" ----
  function card(catalog, video, shelfIndex, onClick) {
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

    var info = el("div", "info");
    var chan = (catalog.channels || {})[video.channelId];
    var av = el("div", "avatar");
    if (chan && chan.avatar) {
      var ai = el("img");
      ai.src = chan.avatar; ai.alt = ""; ai.loading = "lazy"; ai.width = 36; ai.height = 36;
      av.appendChild(ai);
    } else {
      av.textContent = (video.channel || "?").charAt(0).toUpperCase();
    }
    info.appendChild(av);
    var text = el("div", "text");
    text.appendChild(el("div", "title", video.title));
    text.appendChild(el("div", "chan", video.channel));
    var bits = [];
    var v = fmtViews(video.views); if (v) bits.push(v);
    var t = timeAgo(video.published); if (t) bits.push(t);
    if (bits.length) text.appendChild(el("div", "stats", bits.join(" · ")));
    info.appendChild(text);
    a.appendChild(info);

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
      c.channels = c.channels || {};
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

  // ---- local search: every word must appear in title or channel name ----
  function searchCatalog(catalog, query) {
    var words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var out = [], seen = {};
    catalog.shelves.forEach(function (shelf, si) {
      shelf.videos.forEach(function (v) {
        if (seen[v.id]) return;
        var hay = (v.title + " " + v.channel).toLowerCase();
        for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) === -1) return;
        seen[v.id] = true;
        out.push({ video: v, shelf: si });
      });
    });
    out.sort(function (a, b) { return a.video.published < b.video.published ? 1 : -1; });
    return out.slice(0, SEARCH_MAX);
  }

  // ---- index page ----
  function renderIndex(root, catalog) {
    var byId = indexById(catalog);
    var input = document.getElementById("q");

    function shelvesView() {
      root.innerHTML = "";
      var recent = readRecent().filter(function (id) { return byId[id]; });
      if (recent.length) {
        var sec = el("section", "shelf");
        sec.appendChild(el("h2", null, "Continue watching"));
        var row = el("div", "row");
        recent.forEach(function (id) { row.appendChild(card(catalog, byId[id].video, byId[id].shelf)); });
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
        shelf.videos.forEach(function (v) { row.appendChild(card(catalog, v, si)); });
        sec.appendChild(row);
        root.appendChild(sec);
      });
      if (!any) notice(root, "The allowlist is empty", [
        ["Add channels to ", "allowlist.yaml", " and run the refresh again."]
      ]);
    }

    function searchView(q) {
      var hits = searchCatalog(catalog, q);
      root.innerHTML = "";
      var sec = el("section", "shelf results");
      sec.appendChild(el("h2", null, hits.length
        ? hits.length + (hits.length === SEARCH_MAX ? "+" : "") + " result" + (hits.length === 1 ? "" : "s") + " for “" + q + "”"
        : "Nothing on the list matches “" + q + "”"));
      if (hits.length) {
        var grid = el("div", "grid");
        hits.forEach(function (h) { grid.appendChild(card(catalog, h.video, h.shelf)); });
        sec.appendChild(grid);
      } else {
        sec.appendChild(el("p", "hint", "Search only covers videos already on the shelves."));
      }
      root.appendChild(sec);
    }

    var current = null;
    function apply(q, replaceUrl) {
      q = (q || "").trim();
      if (q === current) return;
      current = q;
      if (q) searchView(q); else shelvesView();
      if (replaceUrl) {
        try { history.replaceState(null, "", q ? "index.html?q=" + encodeURIComponent(q) : "index.html"); } catch (e) { /* ignore */ }
      }
    }

    var initial = qs("q") || "";
    if (input) {
      input.value = initial;
      var timer = null;
      input.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(function () { apply(input.value, true); }, 120);
      });
      input.form.addEventListener("submit", function (e) { e.preventDefault(); apply(input.value, true); input.blur(); });
      input.addEventListener("search", function () { apply(input.value, true); });
    }
    apply(initial, false);
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
          grid.appendChild(card(catalog, v, 0, function (vv) { show(vv.id, 0, true, true); }));
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
      var bits = [v.channel];
      var vw = fmtViews(v.views); if (vw) bits.push(vw);
      var ta = timeAgo(v.published); if (ta) bits.push(ta);
      chanEl.textContent = bits.join(" · ");
      document.title = v.title + " · tubelight";
      moreTitle.textContent = "More from " + shelf.name;
      grid.innerHTML = "";
      shelf.videos.forEach(function (other) {
        var c = card(catalog, other, si, function (vv) { show(vv.id, si, true, true); });
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
