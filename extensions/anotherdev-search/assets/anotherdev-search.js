/* AnotherDev Search & Filters — storefront runtime.
   Zero dependencies. Two behaviours, auto-detected from the DOM:
     [data-adsf-searchbar]    -> instant autocomplete dropdown
     [data-adsf-results-app]  -> faceted results grid with URL-synced state
*/
(function () {
  "use strict";

  // --- tiny helpers -------------------------------------------------------
  var money = function (n, cur) {
    if (n == null) return "";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: cur || "USD",
      }).format(n);
    } catch (e) {
      return (cur ? cur + " " : "") + Number(n).toFixed(2);
    }
  };
  var el = function (tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var debounce = function (fn, ms) {
    var t;
    return function () {
      var a = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, a); }, ms);
    };
  };
  var sessionToken = (function () {
    try {
      var k = "adsf_st";
      var v = localStorage.getItem(k);
      if (!v) {
        v = Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(k, v);
      }
      return v;
    } catch (e) {
      return "";
    }
  })();

  function priceRange(p) {
    if (p.priceMin === p.priceMax) return money(p.priceMin, p.currencyCode);
    return money(p.priceMin, p.currencyCode) + " – " + money(p.priceMax, p.currencyCode);
  }

  function track(proxy, type, query, productId) {
    try {
      var body = JSON.stringify({ type: type, query: query, productId: productId, st: sessionToken });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(proxy + "/track", new Blob([body], { type: "application/json" }));
      } else {
        fetch(proxy + "/track", { method: "POST", body: body, headers: { "Content-Type": "application/json" }, keepalive: true });
      }
    } catch (e) {}
  }

  function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  // Bold the matched query words inside a label (like the reference apps).
  function highlight(text, term) {
    var safe = esc(text);
    var words = String(term || "").trim().split(/\s+/).filter(Boolean).map(escapeRegex);
    if (!words.length) return safe;
    try {
      return safe.replace(new RegExp("(" + words.join("|") + ")", "gi"), '<mark class="adsf-hl">$1</mark>');
    } catch (e) { return safe; }
  }

  // Shared dropdown renderer used by BOTH the search-bar block and the app-embed
  // auto-attach. Builds Suggestions / Products / Collections / Pages sections +
  // a "See all results" button, matching the reference-app layout.
  // Returns the list of focusable <a> items (for keyboard nav).
  function populateDropdown(dropdown, data, term, cfg) {
    dropdown.innerHTML = "";
    var items = [];
    var isEmpty = !term; // empty query → recommendation mode
    var hasProducts = data.products && data.products.length;
    var hasColl = data.collections && data.collections.length;
    var hasPages = data.pages && data.pages.length;
    var hasSugg = data.suggestions && data.suggestions.length;

    if (!hasProducts && !hasColl && !hasPages && !hasSugg) {
      dropdown.classList.remove("adsf-dropdown--rich");
      dropdown.appendChild(el("div", "adsf-dropdown__empty",
        isEmpty ? "Start typing to search" : "No matches for “" + esc(term) + "”"));
      return items;
    }

    // Two-pane layout (hover-preview + list) unless the merchant chose "list".
    var useRich = (cfg.layout || "rich") !== "list";
    dropdown.classList.toggle("adsf-dropdown--rich", useRich);
    dropdown.classList.toggle("adsf-dropdown--preview-right", useRich && cfg.previewSide === "right");
    var preview = useRich ? el("div", "adsf-dropdown__preview") : null;
    var list = useRich ? el("div", "adsf-dropdown__list") : dropdown;

    function setPreview(p) {
      if (!preview) return;
      if (!p) { preview.innerHTML = ""; return; }
      preview.innerHTML =
        (p.imageUrl
          ? '<img class="adsf-preview__img" src="' + esc(p.imageUrl) + '" alt="">'
          : '<div class="adsf-preview__noimg"></div>') +
        '<div class="adsf-preview__title">' + esc(p.title) + "</div>" +
        '<div class="adsf-preview__price">' + esc(priceRange(p)) + "</div>" +
        (p.description ? '<div class="adsf-preview__desc">' + esc(p.description) + "</div>" : "") +
        '<a class="adsf-preview__link" href="/products/' + esc(p.handle) + '">See details →</a>';
    }

    function section(label) {
      var wrap = el("div", "adsf-dropdown__section");
      wrap.appendChild(el("div", "adsf-dropdown__label", esc(label)));
      list.appendChild(wrap);
      return wrap;
    }

    // Suggestions / Trending searches when empty
    if (hasSugg) {
      var sg = section(isEmpty ? "Trending searches" : "Suggestions");
      data.suggestions.forEach(function (s) {
        var a = el("a", "adsf-dropdown__suggestion");
        a.href = cfg.resultsUrl + "?q=" + encodeURIComponent(s);
        a.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none"><circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="2"/><path d="m14 14 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>' + highlight(s, term) + "</span>";
        sg.appendChild(a); items.push(a);
      });
    }

    // Products / Popular products when empty — each row updates the preview on hover
    if (hasProducts) {
      var pg = section(isEmpty ? "Popular products" : "Products");
      data.products.forEach(function (p) {
        var a = el("a", "adsf-dropdown__product");
        a.href = "/products/" + encodeURIComponent(p.handle);
        a.addEventListener("mousedown", function () { track(cfg.proxy, "click", term, p.productId); });
        a.addEventListener("mouseenter", function () {
          setPreview(p);
          Array.prototype.forEach.call(pg.querySelectorAll(".adsf-dropdown__product"), function (n) { n.classList.remove("is-preview"); });
          a.classList.add("is-preview");
        });
        a.innerHTML =
          (p.imageUrl ? '<img src="' + esc(p.imageUrl) + '" alt="" loading="lazy">' : '<span class="adsf-dropdown__noimg"></span>') +
          '<span class="adsf-dropdown__pinfo"><span class="adsf-dropdown__ptitle">' + highlight(p.title, term) + "</span>" +
          '<span class="adsf-dropdown__pprice">' + esc(priceRange(p)) + "</span></span>";
        pg.appendChild(a); items.push(a);
      });
    }

    // Collections / Popular choices when empty
    if (hasColl) {
      var cg = section(isEmpty ? "Popular choices" : "Collections");
      data.collections.forEach(function (c) {
        var a = el("a", "adsf-dropdown__collection");
        a.href = "/collections/" + encodeURIComponent(c.handle);
        a.innerHTML =
          (c.imageUrl ? '<img src="' + esc(c.imageUrl) + '" alt="" loading="lazy">' : '<span class="adsf-dropdown__noimg adsf-dropdown__noimg--sm"></span>') +
          '<span class="adsf-dropdown__ctitle">' + highlight(c.title, term) + "</span>" +
          (c.productCount ? '<span class="adsf-dropdown__count">' + c.productCount + "</span>" : "");
        cg.appendChild(a); items.push(a);
      });
    }

    // Pages
    if (hasPages) {
      var pgs = section("Pages");
      data.pages.forEach(function (pageItem) {
        var a = el("a", "adsf-dropdown__page");
        a.href = "/pages/" + encodeURIComponent(pageItem.handle);
        a.innerHTML = highlight(pageItem.title, term);
        pgs.appendChild(a); items.push(a);
      });
    }

    // See all results (only when there's a query)
    if (!isEmpty) {
      var all = el("a", "adsf-dropdown__all");
      all.href = cfg.resultsUrl + "?q=" + encodeURIComponent(term);
      all.textContent = "See all results";
      list.appendChild(all);
      items.push(all);
    }

    if (useRich) {
      // previewSide "right" is handled by CSS via the --preview-right class,
      // but we still append preview first then list for source order = left.
      dropdown.appendChild(preview);
      dropdown.appendChild(list);
      // Default the preview to the first product.
      if (hasProducts) {
        setPreview(data.products[0]);
        var firstRow = list.querySelector(".adsf-dropdown__product");
        if (firstRow) firstRow.classList.add("is-preview");
      }
    }

    return items;
  }

  // =======================================================================
  //  1. Autocomplete search bar
  // =======================================================================
  function initSearchBar(root) {
    var input = root.querySelector("[data-adsf-input]");
    var dropdown = root.querySelector("[data-adsf-dropdown]");
    var proxy = root.getAttribute("data-proxy");
    var resultsUrl = root.getAttribute("data-results-url");
    var minChars = parseInt(root.getAttribute("data-min-chars") || "2", 10);
    var limit = parseInt(root.getAttribute("data-max-suggestions") || "6", 10);
    var showRecs = root.getAttribute("data-recommendations") !== "false";
    if (!input || !dropdown) return;

    var activeIndex = -1;
    var items = [];

    function close() {
      dropdown.hidden = true;
      dropdown.innerHTML = "";
      activeIndex = -1;
      items = [];
    }

    function render(data, term) {
      items = populateDropdown(dropdown, data, term, { proxy: proxy, resultsUrl: resultsUrl });
      activeIndex = -1;
      dropdown.hidden = false;
    }

    var run = debounce(function () {
      var term = input.value.trim();
      if (term.length < minChars) { close(); return; }
      fetch(proxy + "/autocomplete?q=" + encodeURIComponent(term) + "&limit=" + limit, {
        headers: { Accept: "application/json" },
      })
        .then(function (r) { return r.json(); })
        .then(function (d) { render(d, term); })
        .catch(function () { close(); });
    }, 150);

    // Fetch recommendations (empty query) for the focus/empty state.
    function fetchRecs() {
      fetch(proxy + "/autocomplete?q=&limit=8", { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (d) { render(d, ""); })
        .catch(function () { close(); });
    }

    input.addEventListener("input", run);
    input.addEventListener("focus", function () {
      var term = input.value.trim();
      if (term.length >= minChars && items.length) dropdown.hidden = false;
      else if (!term && showRecs) fetchRecs();
    });
    input.addEventListener("keydown", function (e) {
      if (dropdown.hidden) return;
      if (e.key === "ArrowDown") { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, items.length - 1); markActive(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, -1); markActive(); }
      else if (e.key === "Enter") { if (activeIndex >= 0 && items[activeIndex]) { e.preventDefault(); items[activeIndex].click(); } }
      else if (e.key === "Escape") { close(); }
    });
    function markActive() {
      items.forEach(function (it, i) { it.classList.toggle("is-active", i === activeIndex); });
    }
    document.addEventListener("click", function (e) {
      if (!root.contains(e.target)) close();
    });
  }

  // =======================================================================
  //  2. Faceted results application
  // =======================================================================
  function initResultsApp(root) {
    var proxy = root.getAttribute("data-proxy");
    var perPage = parseInt(root.getAttribute("data-per-page") || "24", 10);
    var collection = root.getAttribute("data-collection") || "";
    var grid = root.querySelector("[data-adsf-grid]");
    var facetsInner = root.querySelector("[data-adsf-facets-inner]");
    var meta = root.querySelector("[data-adsf-meta]");
    var pagination = root.querySelector("[data-adsf-pagination]");
    var sortSel = root.querySelector("[data-adsf-sort]");
    var filterToggle = root.querySelector("[data-adsf-filter-toggle]");
    var facetsPanel = root.querySelector("[data-adsf-facets]");
    var backdrop = root.querySelector("[data-adsf-backdrop]");

    var state = readState();

    function readState() {
      var sp = new URLSearchParams(location.search);
      var filters = {};
      sp.forEach(function (v, k) {
        if (k.indexOf("f.") === 0) { (filters[k.slice(2)] = filters[k.slice(2)] || []).push(v); }
      });
      return {
        term: sp.get("q") || "",
        page: Math.max(1, parseInt(sp.get("page") || "1", 10)),
        sort: sp.get("sort") || "relevance",
        filters: filters,
        priceMin: sp.get("price.min"),
        priceMax: sp.get("price.max"),
      };
    }

    function toParams(s) {
      var sp = new URLSearchParams();
      if (s.term) sp.set("q", s.term);
      if (s.page > 1) sp.set("page", s.page);
      if (s.sort && s.sort !== "relevance") sp.set("sort", s.sort);
      if (s.priceMin) sp.set("price.min", s.priceMin);
      if (s.priceMax) sp.set("price.max", s.priceMax);
      Object.keys(s.filters).forEach(function (src) {
        s.filters[src].forEach(function (v) { sp.append("f." + src, v); });
      });
      return sp;
    }

    function syncUrl() {
      var sp = toParams(state);
      history.replaceState(null, "", location.pathname + (sp.toString() ? "?" + sp.toString() : ""));
    }

    function fetchResults() {
      grid.setAttribute("aria-busy", "true");
      var sp = toParams(state);
      sp.set("perPage", perPage);
      if (collection) sp.set("collection", collection);
      sp.set("st", sessionToken);
      fetch(proxy + "/search?" + sp.toString(), { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.redirect) { location.href = data.redirect; return; }
          render(data);
        })
        .catch(function () {
          grid.setAttribute("aria-busy", "false");
          grid.innerHTML = '<p class="adsf-error">Search is temporarily unavailable.</p>';
        });
    }

    function render(data) {
      grid.setAttribute("aria-busy", "false");
      // meta
      var m = data.total + " result" + (data.total === 1 ? "" : "s");
      if (state.term) m += ' for “' + esc(state.term) + '”';
      meta.innerHTML = m + (data.suggestion && data.total < 3
        ? ' — did you mean <a href="#" data-adsf-suggest="' + esc(data.suggestion) + '">' + esc(data.suggestion) + "</a>?"
        : "");
      var sug = meta.querySelector("[data-adsf-suggest]");
      if (sug) sug.addEventListener("click", function (e) { e.preventDefault(); state.term = sug.getAttribute("data-adsf-suggest"); state.page = 1; apply(); });

      // grid
      if (!data.hits.length) {
        grid.innerHTML = '<div class="adsf-empty"><p>No products found.</p>' +
          (Object.keys(state.filters).length ? '<button type="button" data-adsf-clear>Clear filters</button>' : "") + "</div>";
        var cl = grid.querySelector("[data-adsf-clear]");
        if (cl) cl.addEventListener("click", function () { state.filters = {}; state.priceMin = state.priceMax = null; state.page = 1; apply(); });
      } else {
        grid.innerHTML = data.hits.map(function (p) {
          return '<article class="adsf-card' + (p.pinned ? " adsf-card--pinned" : "") + '">' +
            '<a href="/products/' + esc(p.handle) + '" data-adsf-hit="' + esc(p.productId) + '">' +
            (p.imageUrl ? '<img class="adsf-card__img" src="' + esc(p.imageUrl) + '" alt="' + esc(p.imageAlt || p.title) + '" loading="lazy" width="300" height="300">' : '<span class="adsf-card__noimg"></span>') +
            '<h3 class="adsf-card__title">' + esc(p.title) + "</h3>" +
            '<div class="adsf-card__price">' + esc(priceRange(p)) + "</div>" +
            (p.available ? "" : '<span class="adsf-card__soldout">Sold out</span>') +
            "</a></article>";
        }).join("");
        Array.prototype.forEach.call(grid.querySelectorAll("[data-adsf-hit]"), function (a) {
          a.addEventListener("click", function () { track(proxy, "click", state.term, a.getAttribute("data-adsf-hit")); });
        });
      }

      renderFacets(data.facets || []);
      renderPagination(data.total);
      if (sortSel) sortSel.value = state.sort;
    }

    function renderFacets(facets) {
      facetsInner.innerHTML = "";
      facets.forEach(function (f) {
        var group = el("div", "adsf-facet");
        group.appendChild(el("h4", "adsf-facet__title", esc(f.label)));

        if (f.displayAs === "range") {
          var wrap = el("div", "adsf-facet__range");
          var min = el("input", "adsf-facet__num");
          min.type = "number"; min.placeholder = f.min != null ? Math.floor(f.min) : "Min";
          min.value = state.priceMin || "";
          var max = el("input", "adsf-facet__num");
          max.type = "number"; max.placeholder = f.max != null ? Math.ceil(f.max) : "Max";
          max.value = state.priceMax || "";
          var applyBtn = el("button", "adsf-facet__apply", "Go");
          applyBtn.type = "button";
          applyBtn.addEventListener("click", function () {
            state.priceMin = min.value || null; state.priceMax = max.value || null; state.page = 1; apply();
          });
          wrap.appendChild(min); wrap.appendChild(el("span", "adsf-facet__dash", "–")); wrap.appendChild(max); wrap.appendChild(applyBtn);
          group.appendChild(wrap);
        } else {
          var list = el("ul", "adsf-facet__list");
          var selected = state.filters[f.source] || [];
          f.values.forEach(function (v) {
            var li = el("li", "adsf-facet__item" + (f.displayAs === "swatch" ? " adsf-facet__item--swatch" : ""));
            var id = "adsf_" + f.source.replace(/[^a-z0-9]/gi, "") + "_" + v.value.replace(/[^a-z0-9]/gi, "");
            var checked = selected.indexOf(v.value) >= 0;
            var cb = el("input");
            cb.type = "checkbox"; cb.id = id; cb.checked = checked; cb.value = v.value;
            cb.addEventListener("change", function () { toggleFilter(f.source, v.value, cb.checked); });
            var lbl = el("label");
            lbl.setAttribute("for", id);
            if (f.displayAs === "swatch") {
              lbl.innerHTML = '<span class="adsf-swatch" style="background:' + swatchColor(v.value) + '" title="' + esc(v.label) + '"></span>';
            }
            lbl.insertAdjacentHTML("beforeend", '<span class="adsf-facet__label">' + esc(v.label) + '</span> <span class="adsf-facet__count">' + v.count + "</span>");
            li.appendChild(cb); li.appendChild(lbl);
            list.appendChild(li);
          });
          group.appendChild(list);
        }
        facetsInner.appendChild(group);
      });
    }

    function renderPagination(total) {
      var pages = Math.max(1, Math.ceil(total / perPage));
      if (pages <= 1) { pagination.innerHTML = ""; return; }
      var html = "";
      if (state.page > 1) html += '<button type="button" data-p="' + (state.page - 1) + '">‹ Prev</button>';
      for (var p = Math.max(1, state.page - 2); p <= Math.min(pages, state.page + 2); p++) {
        html += '<button type="button" data-p="' + p + '"' + (p === state.page ? ' aria-current="page"' : "") + ">" + p + "</button>";
      }
      if (state.page < pages) html += '<button type="button" data-p="' + (state.page + 1) + '">Next ›</button>';
      pagination.innerHTML = html;
      Array.prototype.forEach.call(pagination.querySelectorAll("[data-p]"), function (b) {
        b.addEventListener("click", function () {
          state.page = parseInt(b.getAttribute("data-p"), 10);
          apply();
          root.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });
    }

    function toggleFilter(source, value, on) {
      var arr = state.filters[source] || [];
      if (on) { if (arr.indexOf(value) < 0) arr.push(value); }
      else { arr = arr.filter(function (v) { return v !== value; }); }
      if (arr.length) state.filters[source] = arr; else delete state.filters[source];
      state.page = 1;
      apply();
    }

    function apply() { syncUrl(); fetchResults(); }

    // mobile drawer
    function openDrawer(open) {
      facetsPanel.classList.toggle("is-open", open);
      if (backdrop) backdrop.hidden = !open;
      filterToggle.setAttribute("aria-expanded", String(open));
      document.body.style.overflow = open ? "hidden" : "";
    }
    if (filterToggle) filterToggle.addEventListener("click", function () { openDrawer(!facetsPanel.classList.contains("is-open")); });
    if (backdrop) backdrop.addEventListener("click", function () { openDrawer(false); });

    if (sortSel) sortSel.addEventListener("change", function () { state.sort = sortSel.value; state.page = 1; apply(); });

    window.addEventListener("popstate", function () { state = readState(); if (sortSel) sortSel.value = state.sort; fetchResults(); });

    fetchResults();
  }

  function swatchColor(name) {
    var known = { red: "#d33", blue: "#26c", green: "#2a2", black: "#111", white: "#fff", yellow: "#ee0", pink: "#e79", purple: "#849", orange: "#e83", grey: "#999", gray: "#999", brown: "#853", navy: "#123", beige: "#e8dcc0", gold: "#ca0", silver: "#bbb" };
    return known[String(name).toLowerCase()] || "#ccc";
  }

  // =======================================================================
  //  3. Auto-attach to the theme's existing search box (used by the App Embed)
  // =======================================================================
  function attachAutocomplete(input, cfg) {
    if (input.getAttribute("data-adsf-attached")) return;
    input.setAttribute("data-adsf-attached", "1");
    input.setAttribute("autocomplete", "off");

    var spotlight = cfg.panelStyle === "spotlight";

    // Optional dimmed backdrop so the panel doesn't visually overlap the page.
    var backdrop = null;
    if (spotlight) {
      backdrop = el("div", "adsf-backdrop");
      backdrop.hidden = true;
      document.body.appendChild(backdrop);
      backdrop.addEventListener("click", close);
    }

    var dropdown = el("div", "adsf-dropdown" + (spotlight ? " adsf-dropdown--spotlight" : ""));
    dropdown.hidden = true;
    dropdown.style.position = "absolute";
    dropdown.style.zIndex = "100000";
    document.body.appendChild(dropdown);

    function place() {
      var r = input.getBoundingClientRect();
      var isRich = dropdown.classList.contains("adsf-dropdown--rich");
      var w = isRich ? Math.min(640, window.innerWidth * 0.92) : Math.max(300, r.width);
      dropdown.style.width = w + "px";
      var left = r.left + window.scrollX;
      var maxLeft = window.scrollX + window.innerWidth - w - 8;
      if (left > maxLeft) left = Math.max(window.scrollX + 8, maxLeft);
      dropdown.style.left = left + "px";
      dropdown.style.top = (r.bottom + window.scrollY + 6) + "px";
    }
    function open() {
      if (backdrop) backdrop.hidden = false;
      dropdown.hidden = false;
      // Hide the theme's OWN predictive-search results so the two panels don't
      // stack/overlap (CSS in the stylesheet targets common theme containers).
      document.body.classList.add("adsf-active");
    }
    function close() {
      dropdown.hidden = true;
      dropdown.innerHTML = "";
      if (backdrop) backdrop.hidden = true;
      document.body.classList.remove("adsf-active");
    }

    function render(data, term) {
      populateDropdown(dropdown, data, term, cfg);
      place();
      open();
    }

    function fetchTerm(term) {
      var q = term ? encodeURIComponent(term) : "";
      fetch(cfg.proxy + "/autocomplete?q=" + q + "&limit=" + (term ? cfg.maxSuggestions : 8), { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (d) { render(d, term); })
        .catch(function () { close(); });
    }

    var run = debounce(function () {
      var term = input.value.trim();
      if (term.length < cfg.minChars) {
        if (!term && cfg.showRecs) fetchTerm("");
        else close();
        return;
      }
      fetchTerm(term);
    }, 150);

    input.addEventListener("input", run);
    input.addEventListener("focus", function () {
      if (!input.value.trim() && cfg.showRecs) fetchTerm("");
    });
    input.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", function () { if (!dropdown.hidden) place(); }, true);
    document.addEventListener("click", function (e) {
      if (e.target !== input && !dropdown.contains(e.target)) close();
    });
  }

  var ADSF_SEARCH_SELECTOR =
    'input[type="search"], input[name="q"], form[action*="/search"] input[type="text"], form[action$="/search"] input, [role="search"] input, [class*="earch"] input[type="text"]';

  function scanAndAttach(cfg, rootEl) {
    var inputs = (rootEl || document).querySelectorAll(ADSF_SEARCH_SELECTOR);
    Array.prototype.forEach.call(inputs, function (input) {
      if (input.closest("[data-adsf-searchbar]")) return; // our own bar
      if (input.getAttribute("data-adsf-input") != null) return;
      if (input.getAttribute("data-adsf-attached")) return;
      attachAutocomplete(input, cfg);
    });
  }

  function autoAttachSearch(cfg) {
    scanAndAttach(cfg);

    // Many themes render the search input only when the header search ICON is
    // clicked (a drawer/modal opens). Watch the DOM and attach the moment a
    // search box appears, so instant search "just works" from the search icon.
    if (window.MutationObserver && !window.__adsfObserving) {
      window.__adsfObserving = true;
      var mo = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (node.nodeType !== 1) continue;
            if (node.matches && node.matches(ADSF_SEARCH_SELECTOR)) {
              scanAndAttach(cfg, node.parentNode || document);
            } else if (node.querySelector) {
              scanAndAttach(cfg, node);
            }
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }

    // Also catch inputs revealed by CSS (present but hidden until the icon opens
    // the drawer) — a focus anywhere in a search region triggers a rescan.
    document.addEventListener(
      "focusin",
      function (e) {
        if (e.target && e.target.matches && e.target.matches(ADSF_SEARCH_SELECTOR)) {
          scanAndAttach(cfg, document);
        }
      },
      true,
    );
  }

  function applySettings(cfg, s) {
    // Behaviour
    cfg.minChars = s.minChars || cfg.minChars;
    cfg.maxSuggestions = s.maxSuggestions || cfg.maxSuggestions;
    cfg.showRecs = s.showRecommendations !== false;
    cfg.panelStyle = s.panelStyle || cfg.panelStyle || "dropdown";
    cfg.layout = s.layout || "rich";
    cfg.previewSide = s.previewSide || "left";
    cfg.autoAttach = s.autoAttach !== false;
    // Appearance → CSS variables
    var rs = document.documentElement.style;
    if (s.accentColor) rs.setProperty("--adsf-accent", s.accentColor);
    if (s.backgroundColor) rs.setProperty("--adsf-dd-bg", s.backgroundColor);
    if (s.textColor) rs.setProperty("--adsf-dd-text", s.textColor);
    if (s.highlightColor) rs.setProperty("--adsf-hl-color", s.highlightColor);
    if (s.fontSize) rs.setProperty("--adsf-dd-font-size", s.fontSize + "px");
    if (s.fontWeight) rs.setProperty("--adsf-dd-font-weight", s.fontWeight);
    return cfg;
  }

  // --- boot ---------------------------------------------------------------
  function boot() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-adsf-searchbar]"), initSearchBar);
    Array.prototype.forEach.call(document.querySelectorAll("[data-adsf-results-app]"), initResultsApp);

    // App Embed path: config injected globally; APPEARANCE + BEHAVIOUR come from
    // the app admin (fetched via the proxy /config endpoint) so everything is
    // configured in one place.
    var g = window.ADSF_CONFIG;
    if (g) {
      var cfg = {
        proxy: g.proxy || "/apps/anotherdev-search",
        resultsUrl: g.resultsUrl || "/apps/anotherdev-search/results",
        minChars: g.minChars || 2,
        maxSuggestions: g.maxSuggestions || 8,
        showRecs: true,
        panelStyle: "spotlight",
        layout: "rich",
        previewSide: "left",
        autoAttach: g.autoAttach !== false,
      };

      function start() {
        if (cfg.autoAttach) {
          autoAttachSearch(cfg);
          setTimeout(function () { autoAttachSearch(cfg); }, 1200);
        }
      }

      // Fetch merchant settings from the app; fall back to defaults on error.
      fetch(cfg.proxy + "/config", { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (s) { applySettings(cfg, s || {}); })
        .catch(function () {})
        .then(function () { start(); });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
