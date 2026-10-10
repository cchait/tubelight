/* tubelight — a small single-page library over catalog.json.
 * Plain JS, no build step. Routes live in the query string so GitHub Pages
 * needs no rewrites: index.html, ?s=<shelf>, ?c=<channelId>, ?q=<text>,
 * ?view=continue|watched, ?v=<videoId>.
 * The only YouTube hosts touched are www.youtube-nocookie.com (player),
 * i.ytimg.com (thumbnails) and yt3.ggpht.com (avatars). Search is local. */
(function () {
  "use strict";

  var EMBED = "https://www.youtube-nocookie.com/embed/";
  var EMBED_PARAMS = "rel=0&iv_load_policy=3&playsinline=1";
  var LS = { recent: "tubelight.recent", watched: "tubelight.watched", open: "tubelight.openShelves" };
  var RECENT_MAX = 24;
  var SEARCH_MAX = 200;

  // ---------- per-viewer state (localStorage may be missing, full or blocked) ----------
  function load(key, fallback) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ } }
  function recentList() { var l = load(LS.recent, []); return Array.isArray(l) ? l.filter(function (x) { return typeof x === "string"; }) : []; }
  function touchRecent(id) { var l = recentList().filter(function (x) { return x !== id; }); l.unshift(id); save(LS.recent, l.slice(0, RECENT_MAX)); }
  function watchedMap() { var m = load(LS.watched, {}); return m && typeof m === "object" && !Array.isArray(m) ? m : {}; }
  function isWatched(id) { return !!watchedMap()[id]; }
  function setWatched(id, on) { var m = watchedMap(); if (on) m[id] = Date.now(); else delete m[id]; save(LS.watched, m); }
  function openShelves() { var m = load(LS.open, {}); return m && typeof m === "object" ? m : {}; }

  // ---------- DOM helpers ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(name, cls) {
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("class", "icon" + (cls ? " " + cls : ""));
    s.setAttribute("aria-hidden", "true");
    var u = document.createElementNS("http://www.w3.org/2000/svg", "use");
    u.setAttribute("href", "#" + name);
    s.appendChild(u);
    return s;
  }
  function fmtDuration(s) {
    s = Math.max(0, s | 0);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
  }
  var compact = null;
  try { compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }); } catch (e) { /* old browser */ }
  function fmtViews(n) {
    if (typeof n !== "number" || !isFinite(n)) return "";
    return (compact ? compact.format(n) : String(n)) + (n === 1 ? " view" : " views");
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
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function isVideoId(id) { return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id); }

  // ---------- catalog model ----------
  var catalog = null;     // as loaded
  var byId = {};          // videoId -> { video, shelf }
  var channels = {};      // channelId -> { id, name, avatar, shelves: [si], videos: [] }

  function buildIndex(c) {
    byId = {}; channels = {};
    c.channels = c.channels || {};
    c.shelves.forEach(function (shelf, si) {
      // Older catalogs (v2) have no per-shelf channel list; derive one.
      if (!Array.isArray(shelf.channels)) {
        var seen = {}, list = [];
        shelf.videos.forEach(function (v) {
          if (!seen[v.channelId]) { seen[v.channelId] = { id: v.channelId, name: v.channel, avatar: (c.channels[v.channelId] || {}).avatar || "", count: 0 }; list.push(seen[v.channelId]); }
          seen[v.channelId].count++;
        });
        shelf.channels = list;
      }
      shelf.channels.forEach(function (ch) {
        if (!channels[ch.id]) channels[ch.id] = { id: ch.id, name: ch.name, avatar: ch.avatar, shelves: [], videos: [] };
        if (channels[ch.id].shelves.indexOf(si) === -1) channels[ch.id].shelves.push(si);
      });
      shelf.videos.forEach(function (v) {
        if (!byId[v.id]) byId[v.id] = { video: v, shelf: si };
        var ch = channels[v.channelId];
        if (ch && !ch.videos.some(function (x) { return x.id === v.id; })) ch.videos.push(v);
      });
    });
    Object.keys(channels).forEach(function (id) {
      channels[id].videos.sort(function (a, b) { return a.published < b.published ? 1 : -1; });
    });
  }

  function searchCatalog(query) {
    var words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return { videos: [], channels: [] };
    var videos = [], seen = {};
    catalog.shelves.forEach(function (shelf, si) {
      shelf.videos.forEach(function (v) {
        if (seen[v.id]) return;
        var hay = (v.title + " " + v.channel).toLowerCase();
        for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) === -1) return;
        seen[v.id] = true;
        videos.push({ video: v, shelf: si });
      });
    });
    videos.sort(function (a, b) { return a.video.published < b.video.published ? 1 : -1; });
    var chans = Object.keys(channels).map(function (k) { return channels[k]; }).filter(function (ch) {
      var hay = ch.name.toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) !== -1; });
    });
    return { videos: videos.slice(0, SEARCH_MAX), channels: chans };
  }

  // ---------- routing ----------
  function parseRoute() {
    var p;
    try { p = new URLSearchParams(location.search); } catch (e) { p = new URLSearchParams(""); }
    var s = parseInt(p.get("s"), 10); if (isNaN(s) || !catalog.shelves[s]) s = null;
    var c = p.get("c"); if (!c || !channels[c]) c = null;
    var q = (p.get("q") || "").trim();
    var v = p.get("v");
    var view = p.get("view");
    if (v) return { name: "watch", v: v, s: s, c: c };
    if (q) return { name: "search", q: q };
    if (c) return { name: "channel", c: c, s: s != null && channels[c].shelves.indexOf(s) !== -1 ? s : channels[c].shelves[0] };
    if (s != null) return { name: "shelf", s: s };
    if (view === "continue" || view === "watched") return { name: view };
    return { name: "home" };
  }
  function href(params) {
    var p = new URLSearchParams();
    Object.keys(params).forEach(function (k) { if (params[k] != null && params[k] !== "") p.set(k, params[k]); });
    var qs = p.toString();
    return "index.html" + (qs ? "?" + qs : "");
  }
  function go(params, replace) {
    var url = href(params);
    try { if (replace) history.replaceState(null, "", url); else history.pushState(null, "", url); } catch (e) { location.href = url; return; }
    render();
  }
  function link(node, params) {
    node.href = href(params);
    node.addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      go(params);
    });
    return node;
  }

  // ---------- components ----------
  function avatarEl(ch, name, cls) {
    var a = el("div", "avatar" + (cls ? " " + cls : ""));
    if (ch && ch.avatar) {
      var img = el("img"); img.src = ch.avatar; img.alt = ""; img.loading = "lazy"; img.width = 36; img.height = 36;
      a.appendChild(img);
    } else {
      a.textContent = (name || "?").charAt(0).toUpperCase();
    }
    return a;
  }

  function card(video, hints) {
    hints = hints || {};
    var a = link(el("a", "card"), { v: video.id, s: hints.s, c: hints.c });
    a.setAttribute("aria-label", video.title + ", " + video.channel);
    if (isWatched(video.id)) a.classList.add("watched");
    if (hints.now) a.classList.add("now");

    var th = el("div", "thumb");
    var img = el("img"); img.src = video.thumbnail; img.alt = ""; img.loading = "lazy"; img.width = 320; img.height = 180;
    th.appendChild(img);
    if (isWatched(video.id)) { var wb = el("span", "watched-badge"); wb.appendChild(icon("i-check")); wb.appendChild(document.createTextNode("Watched")); th.appendChild(wb); }
    if (video.duration) th.appendChild(el("span", "dur", fmtDuration(video.duration)));
    a.appendChild(th);

    var info = el("div", "info");
    info.appendChild(avatarEl(channels[video.channelId], video.channel));
    var text = el("div", "text");
    text.appendChild(el("div", "title", video.title));
    text.appendChild(el("div", "chan", video.channel));
    var bits = [];
    var vw = fmtViews(video.views); if (vw) bits.push(vw);
    var ta = timeAgo(video.published); if (ta) bits.push(ta);
    if (bits.length) text.appendChild(el("div", "stats", bits.join(" · ")));
    info.appendChild(text);
    a.appendChild(info);
    return a;
  }

  function sectionHead(title, sub, action) {
    var h = el("div", "section-head");
    var left = el("div");
    left.appendChild(el("h2", null, title));
    if (sub) left.appendChild(el("div", "sub", sub));
    h.appendChild(left);
    if (action) h.appendChild(action);
    return h;
  }
  function seeAll(params) {
    var b = link(el("a", "btn btn-tertiary"), params);
    b.appendChild(document.createTextNode("See all"));
    b.appendChild(icon("i-chevron-right"));
    return b;
  }
  function pageHead(title, sub, actions) {
    var h = el("div", "page-head");
    var t = el("div", "text");
    t.appendChild(el("h1", null, title));
    if (sub) t.appendChild(el("p", "sub", sub));
    h.appendChild(t);
    if (actions && actions.length) { var a = el("div", "actions"); actions.forEach(function (x) { a.appendChild(x); }); h.appendChild(a); }
    return h;
  }
  function crumbs(items) {
    var c = el("nav", "crumbs"); c.setAttribute("aria-label", "Breadcrumb");
    items.forEach(function (it, i) {
      if (i) c.appendChild(icon("i-chevron-right"));
      if (it.params) c.appendChild(link(el("a", null, it.label), it.params));
      else c.appendChild(el("span", "here", it.label));
    });
    return c;
  }
  function emptyState(iconName, title, lines, actions) {
    var box = el("div", "empty");
    var g = el("div", "glyph"); g.appendChild(icon(iconName)); box.appendChild(g);
    box.appendChild(el("h2", null, title));
    lines.forEach(function (l) {
      var p = el("p");
      if (typeof l === "string") p.textContent = l;
      else { p.appendChild(document.createTextNode(l[0])); p.appendChild(el("code", null, l[1])); p.appendChild(document.createTextNode(l[2] || "")); }
      box.appendChild(p);
    });
    if (actions && actions.length) { var a = el("div", "actions"); actions.forEach(function (x) { a.appendChild(x); }); box.appendChild(a); }
    return box;
  }
  function gridOf(list, hints) {
    var g = el("div", "grid");
    list.forEach(function (v) { g.appendChild(card(v, hints)); });
    return g;
  }
  function rowOf(list, hints) {
    var r = el("div", "row");
    list.forEach(function (v) { r.appendChild(card(v, hints)); });
    return r;
  }
  function channelChips(shelf, si, currentId) {
    var wrap = el("div", "chips");
    var all = link(el("a", "chip plain", "All"), { s: si });
    if (!currentId) all.setAttribute("aria-current", "true");
    wrap.appendChild(all);
    shelf.channels.forEach(function (ch) {
      var chip = link(el("a", "chip"), { c: ch.id, s: si });
      chip.appendChild(avatarEl(channels[ch.id], ch.name));
      chip.appendChild(document.createTextNode(ch.name));
      if (ch.id === currentId) chip.setAttribute("aria-current", "true");
      wrap.appendChild(chip);
    });
    return wrap;
  }

  // ---------- sidebar ----------
  function renderNav(route) {
    var nav = document.getElementById("nav");
    nav.innerHTML = "";
    var open = openShelves();

    function item(iconName, label, params, active, count) {
      var a = link(el("a", "nav-item"), params);
      a.appendChild(icon(iconName));
      a.appendChild(el("span", "grow", label));
      if (count) a.appendChild(el("span", "count", String(count)));
      if (active) a.setAttribute("aria-current", "page");
      return a;
    }

    var top = el("div", "nav-section");
    var recent = recentList().filter(function (id) { return byId[id] && !isWatched(id); });
    var watchedCount = Object.keys(watchedMap()).filter(function (id) { return byId[id]; }).length;
    top.appendChild(item("i-home", "Home", {}, route.name === "home"));
    top.appendChild(item("i-clock", "Continue watching", { view: "continue" }, route.name === "continue", recent.length));
    top.appendChild(item("i-check-circle", "Watched", { view: "watched" }, route.name === "watched", watchedCount));
    nav.appendChild(top);

    var sec = el("div", "nav-section");
    sec.appendChild(el("div", "nav-label", "Shelves"));
    catalog.shelves.forEach(function (shelf, si) {
      if (!shelf.videos.length) return;
      var activeShelf = (route.name === "shelf" && route.s === si) || (route.name === "channel" && route.s === si);
      var expanded = open[si] != null ? !!open[si] : activeShelf;
      var rowEl = el("div", "nav-shelf");
      var a = item("i-layers", shelf.name, { s: si }, route.name === "shelf" && route.s === si);
      rowEl.appendChild(a);
      var t = el("button", "nav-toggle"); t.type = "button";
      t.setAttribute("aria-expanded", expanded ? "true" : "false");
      t.setAttribute("aria-label", (expanded ? "Hide" : "Show") + " channels in " + shelf.name);
      t.appendChild(icon("i-chevron-down"));
      rowEl.appendChild(t);
      sec.appendChild(rowEl);

      var kids = el("div", "nav-children");
      shelf.channels.forEach(function (ch) {
        var c = link(el("a", "nav-item"), { c: ch.id, s: si });
        c.appendChild(avatarEl(channels[ch.id], ch.name, "avatar-sm"));
        c.appendChild(el("span", "grow", ch.name));
        if (route.name === "channel" && route.c === ch.id && route.s === si) c.setAttribute("aria-current", "page");
        kids.appendChild(c);
      });
      kids.hidden = !expanded;
      sec.appendChild(kids);
      t.addEventListener("click", function () {
        var now = kids.hidden; kids.hidden = !now;
        t.setAttribute("aria-expanded", now ? "true" : "false");
        var o = openShelves(); o[si] = now; save(LS.open, o);
      });
    });
    nav.appendChild(sec);

    var total = catalog.shelves.reduce(function (n, s) { return n + s.videos.length; }, 0);
    document.getElementById("sidebar-foot").textContent =
      plural(total, "video") + " · " + plural(Object.keys(channels).length, "channel") + " · refreshed daily";
  }

  // ---------- views ----------
  function viewHome(root) {
    var recent = recentList().filter(function (id) { return byId[id] && !isWatched(id); });
    if (recent.length) {
      var s = el("section", "section");
      s.appendChild(sectionHead("Continue watching", null, seeAll({ view: "continue" })));
      s.appendChild(rowOf(recent.slice(0, 12).map(function (id) { return byId[id].video; })));
      root.appendChild(s);
    }
    var any = false;
    catalog.shelves.forEach(function (shelf, si) {
      if (!shelf.videos.length) return;
      any = true;
      var s = el("section", "section");
      s.appendChild(sectionHead(shelf.name, plural(shelf.channels.length, "channel") + " · " + plural(shelf.videos.length, "video"), seeAll({ s: si })));
      s.appendChild(rowOf(shelf.videos.slice(0, 20), { s: si }));
      root.appendChild(s);
    });
    if (!any) root.appendChild(emptyState("i-layers", "The allowlist is empty", [["Add channels to ", "allowlist.yaml", " and run the refresh again."]]));
  }

  function viewShelf(root, si) {
    var shelf = catalog.shelves[si];
    root.appendChild(crumbs([{ label: "Home", params: {} }, { label: shelf.name }]));
    root.appendChild(pageHead(shelf.name, plural(shelf.channels.length, "channel") + " · " + plural(shelf.videos.length, "video") + ", newest first"));
    if (shelf.channels.length > 1) root.appendChild(channelChips(shelf, si, null));
    root.appendChild(gridOf(shelf.videos, { s: si }));
  }

  function viewChannel(root, cid, si) {
    var ch = channels[cid];
    var shelf = catalog.shelves[si];
    root.appendChild(crumbs([{ label: "Home", params: {} }, { label: shelf.name, params: { s: si } }, { label: ch.name }]));
    var head = el("div", "page-head");
    head.appendChild(avatarEl(ch, ch.name, "avatar-lg"));
    var t = el("div", "text");
    t.appendChild(el("h1", null, ch.name));
    var watched = ch.videos.filter(function (v) { return isWatched(v.id); }).length;
    t.appendChild(el("p", "sub", plural(ch.videos.length, "video") + (watched ? " · " + watched + " watched" : "")));
    head.appendChild(t);
    root.appendChild(head);
    if (shelf.channels.length > 1) root.appendChild(channelChips(shelf, si, cid));
    root.appendChild(gridOf(ch.videos, { s: si, c: cid }));
  }

  function viewSearch(root, q) {
    var r = searchCatalog(q);
    root.appendChild(pageHead("Search", r.videos.length
      ? r.videos.length + (r.videos.length === SEARCH_MAX ? "+" : "") + " " + (r.videos.length === 1 ? "video" : "videos") + " for “" + q + "”"
      : "Nothing on the shelves matches “" + q + "”"));
    if (r.channels.length) {
      var chips = el("div", "chips");
      r.channels.forEach(function (ch) {
        var chip = link(el("a", "chip"), { c: ch.id, s: ch.shelves[0] });
        chip.appendChild(avatarEl(ch, ch.name));
        chip.appendChild(document.createTextNode(ch.name));
        chips.appendChild(chip);
      });
      root.appendChild(chips);
    }
    if (r.videos.length) {
      var g = el("div", "grid");
      r.videos.forEach(function (h) { g.appendChild(card(h.video, { s: h.shelf })); });
      root.appendChild(g);
    } else {
      root.appendChild(emptyState("i-search", "No results", ["Search only covers videos already on the shelves. Try another word, or pick a shelf on the left."],
        [link(el("a", "btn btn-secondary", "Back to home"), {})]));
    }
  }

  function viewContinue(root) {
    var recent = recentList().filter(function (id) { return byId[id] && !isWatched(id); });
    root.appendChild(pageHead("Continue watching", recent.length ? plural(recent.length, "video") + " you opened but have not marked as watched" : null));
    if (!recent.length) {
      root.appendChild(emptyState("i-clock", "Nothing in progress", ["Videos you open show up here until you mark them as watched."], [link(el("a", "btn btn-primary", "Browse the shelves"), {})]));
      return;
    }
    root.appendChild(gridOf(recent.map(function (id) { return byId[id].video; })));
  }

  function viewWatched(root) {
    var m = watchedMap();
    var ids = Object.keys(m).filter(function (id) { return byId[id]; }).sort(function (a, b) { return m[b] - m[a]; });
    var clear = el("button", "btn btn-secondary"); clear.type = "button";
    clear.appendChild(icon("i-trash")); clear.appendChild(document.createTextNode("Clear watched"));
    clear.addEventListener("click", function () {
      if (confirm("Clear the watched list on this device?")) { save(LS.watched, {}); render(); }
    });
    root.appendChild(pageHead("Watched", ids.length ? plural(ids.length, "video") + " marked as watched on this device" : null, ids.length ? [clear] : []));
    if (!ids.length) {
      root.appendChild(emptyState("i-check-circle", "Nothing watched yet", ["Use “Mark as watched” under the player. Watched videos get a green badge on their thumbnail."], [link(el("a", "btn btn-primary", "Browse the shelves"), {})]));
      return;
    }
    root.appendChild(gridOf(ids.map(function (id) { return byId[id].video; })));
  }

  function viewWatch(root, route) {
    var entry = isVideoId(route.v) ? byId[route.v] : null;
    if (!entry) {
      root.appendChild(emptyState("i-play", "That video is not on the list",
        ["Only videos from the allowlist can play here."],
        [link(el("a", "btn btn-primary", "Back to home"), {})]));
      return;
    }
    var v = entry.video;
    var si = route.s != null && catalog.shelves[route.s].videos.some(function (x) { return x.id === v.id; }) ? route.s : entry.shelf;
    var shelf = catalog.shelves[si];
    var ch = channels[v.channelId];
    touchRecent(v.id);

    var wrap = el("div", "player-wrap");
    wrap.appendChild(crumbs([{ label: "Home", params: {} }, { label: shelf.name, params: { s: si } }].concat(ch ? [{ label: ch.name, params: { c: ch.id, s: si } }] : [])));

    // The player is YouTube's iframe, used exactly as served: no overlay, no cropping.
    var player = el("div", "player");
    var frame = document.createElement("iframe");
    frame.src = EMBED + encodeURIComponent(v.id) + "?" + EMBED_PARAMS + (route.autoplay ? "&autoplay=1" : "");
    frame.title = v.title;
    frame.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen");
    frame.setAttribute("allowfullscreen", "");
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    player.appendChild(frame);
    wrap.appendChild(player);

    wrap.appendChild(el("h1", "player-title", v.title));
    var meta = el("div", "player-meta");
    var chip = ch ? link(el("a", "channel-chip"), { c: ch.id, s: si }) : el("div", "channel-chip");
    chip.appendChild(avatarEl(ch, v.channel));
    var ct = el("div");
    ct.appendChild(el("div", "name", v.channel));
    var bits = []; var vw = fmtViews(v.views); if (vw) bits.push(vw); var ta = timeAgo(v.published); if (ta) bits.push(ta);
    if (bits.length) ct.appendChild(el("div", "meta", bits.join(" · ")));
    chip.appendChild(ct);
    meta.appendChild(chip);
    meta.appendChild(el("div", "spacer"));

    var btn = el("button", "btn btn-lg"); btn.type = "button";
    function paintBtn() {
      var on = isWatched(v.id);
      btn.className = "btn btn-lg " + (on ? "btn-success" : "btn-secondary");
      btn.innerHTML = "";
      btn.appendChild(icon(on ? "i-check-circle" : "i-check"));
      btn.appendChild(document.createTextNode(on ? "Watched" : "Mark as watched"));
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    paintBtn();
    btn.addEventListener("click", function () { setWatched(v.id, !isWatched(v.id)); paintBtn(); renderNav(route); });
    meta.appendChild(btn);
    wrap.appendChild(meta);
    root.appendChild(wrap);

    root.appendChild(el("hr", "divider"));
    if (ch && ch.videos.length > 1) {
      var s1 = el("section", "section");
      s1.appendChild(sectionHead("More from " + ch.name, null, seeAll({ c: ch.id, s: si })));
      s1.appendChild(rowOf(ch.videos.filter(function (x) { return x.id !== v.id; }).slice(0, 20), { c: ch.id, s: si }));
      root.appendChild(s1);
    }
    var others = shelf.videos.filter(function (x) { return x.id !== v.id && x.channelId !== v.channelId; });
    if (others.length) {
      var s2 = el("section", "section");
      s2.appendChild(sectionHead("More from " + shelf.name, null, seeAll({ s: si })));
      s2.appendChild(gridOf(others.slice(0, 24), { s: si }));
      root.appendChild(s2);
    }
    document.title = v.title + " · tubelight";
  }

  // ---------- render ----------
  var lastRouteKey = null;
  function render() {
    var route = parseRoute();
    var root = document.getElementById("view");
    root.innerHTML = "";
    document.title = "tubelight";
    var titles = { shelf: route.s != null ? catalog.shelves[route.s].name : "", channel: route.c ? channels[route.c].name : "", search: "Search", continue: "Continue watching", watched: "Watched" };
    if (titles[route.name]) document.title = titles[route.name] + " · tubelight";

    switch (route.name) {
      case "watch": viewWatch(root, route); break;
      case "search": viewSearch(root, route.q); break;
      case "channel": viewChannel(root, route.c, route.s); break;
      case "shelf": viewShelf(root, route.s); break;
      case "continue": viewContinue(root); break;
      case "watched": viewWatched(root); break;
      default: viewHome(root);
    }
    renderNav(route);
    var input = document.getElementById("q");
    if (input && document.activeElement !== input) input.value = route.name === "search" ? route.q : "";
    closeDrawer();
    var key = JSON.stringify(route);
    if (key !== lastRouteKey) window.scrollTo(0, 0);
    lastRouteKey = key;
  }

  // ---------- drawer (phone/tablet sidebar) ----------
  function openDrawer() {
    document.getElementById("app").classList.add("nav-open");
    document.getElementById("backdrop").hidden = false;
    document.getElementById("menu-btn").setAttribute("aria-expanded", "true");
  }
  function closeDrawer() {
    document.getElementById("app").classList.remove("nav-open");
    document.getElementById("backdrop").hidden = true;
    document.getElementById("menu-btn").setAttribute("aria-expanded", "false");
  }

  function wireChrome() {
    document.getElementById("menu-btn").addEventListener("click", openDrawer);
    document.getElementById("sidebar-close").addEventListener("click", closeDrawer);
    document.getElementById("backdrop").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });
    link(document.querySelector(".brand"), {});

    var form = document.getElementById("search-form");
    var input = document.getElementById("q");
    var timer = null;
    function applySearch(replace) {
      var q = input.value.trim();
      var route = parseRoute();
      if (!q) { if (route.name === "search") go({}, true); return; }
      if (route.name === "search" && route.q === q) return;
      go({ q: q }, replace || route.name === "search");
    }
    input.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { applySearch(false); }, 150); });
    input.addEventListener("search", function () { applySearch(false); });
    form.addEventListener("submit", function (e) { e.preventDefault(); clearTimeout(timer); applySearch(false); input.blur(); });
    window.addEventListener("popstate", render);
  }

  // ---------- boot ----------
  function loadCatalog() {
    return fetch("catalog.json", { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("catalog.json " + r.status);
      return r.json();
    }).then(function (c) {
      if (!c || !Array.isArray(c.shelves)) throw new Error("catalog.json has no shelves");
      return c;
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    wireChrome();
    loadCatalog().then(function (c) {
      catalog = c;
      buildIndex(c);
      render();
    }).catch(function (err) {
      var root = document.getElementById("view");
      root.innerHTML = "";
      root.appendChild(emptyState("i-layers", "No videos yet", [
        ["The site needs ", "docs/catalog.json", ", which is built from the allowlist."],
        ["Run ", "YT_API_KEY=... python refresh.py", " locally, or run the “Refresh catalog” workflow on GitHub."],
        "Details: " + (err && err.message ? err.message : String(err))
      ]));
      document.getElementById("sidebar-foot").textContent = "No catalog loaded";
    });
  });
})();
