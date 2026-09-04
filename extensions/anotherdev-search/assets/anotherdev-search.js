/* AnotherDev Search & Filters — storefront runtime.
   Zero dependencies. Behaviours auto-detected from the DOM:
     [data-adsf-searchbar]    -> instant autocomplete dropdown
     [data-adsf-results-app]  -> faceted results grid with URL-synced state
     [data-adsf-recommend]    -> recommendation rail
   Plus, from the app embed: auto-attach to the theme's own search box, takeover
   of the theme's /search page, and filters on collection pages.
*/
(function () {
  "use strict";

  // --- money -------------------------------------------------------------
  // Prices are indexed in the SHOP's currency. A shopper in another market sees
  // a converted, differently formatted price, so rendering the raw number with
  // the browser's locale showed the wrong amount in the wrong format. Shopify
  // publishes both pieces on the page; use them.
  function shopifyGlobal() {
    return (typeof window !== "undefined" && window.Shopify) || {};
  }
  function currencyRate() {
    var c = shopifyGlobal().currency || {};
    var r = parseFloat(c.rate);
    return isFinite(r) && r > 0 ? r : 1;
  }
  function activeCurrency(fallback) {
    var c = shopifyGlobal().currency || {};
    return c.active || fallback || "USD";
  }

  function withDelimiters(num, precision, thousands, decimal) {
    if (!isFinite(num)) num = 0;
    var fixed = Math.abs(num).toFixed(precision);
    var parts = fixed.split(".");
    var whole = parts[0].replace(/(\d)(?=(\d\d\d)+$)/g, "$1" + thousands);
    var frac = parts[1] ? decimal + parts[1] : "";
    return (num < 0 ? "-" : "") + whole + frac;
  }

  // Shopify money_format placeholders, e.g. "${{amount}}" or "{{amount_with_comma_separator}} €".
  var MONEY_PATTERNS = {
    amount: [2, ",", "."],
    amount_no_decimals: [0, ",", "."],
    amount_with_comma_separator: [2, ".", ","],
    amount_no_decimals_with_comma_separator: [0, ".", ","],
    amount_with_period_and_space_separator: [2, " ", "."],
    amount_with_space_separator: [2, " ", ","],
    amount_no_decimals_with_space_separator: [0, " ", ","],
    amount_with_apostrophe_separator: [2, "'", "."],
  };

  function formatMoney(amount, cfg, currencyCode) {
    var value = Number(amount) * currencyRate();
    var format = cfg && cfg.moneyFormat;
    if (format && /\{\{\s*\w+\s*\}\}/.test(format)) {
      return format.replace(/\{\{\s*(\w+)\s*\}\}/g, function (_, name) {
        var spec = MONEY_PATTERNS[name] || MONEY_PATTERNS.amount;
        return withDelimiters(value, spec[0], spec[1], spec[2]);
      });
    }
    // No money_format available (e.g. the results page rendered standalone):
    // fall back to Intl with the shopper's ACTIVE currency, not the shop's.
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: activeCurrency(currencyCode),
      }).format(value);
    } catch (e) {
      return (activeCurrency(currencyCode) || "") + " " + value.toFixed(2);
    }
  }

  // --- tiny helpers -------------------------------------------------------
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
  function rafThrottle(fn) {
    var queued = false;
    return function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; fn(); });
    };
  }

  /**
   * Anonymous shopper session id, used only to join a click or add-to-cart back
   * to the search that produced it. Kept in localStorage rather than a cookie so
   * it is never sent to the server on unrelated requests.
   */
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

  // Recent searches, per shopper, local only.
  var RECENT_KEY = "adsf_recent";
  function recentSearches() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); }
    catch (e) { return []; }
  }
  function rememberSearch(term) {
    if (!term) return;
    try {
      var list = recentSearches().filter(function (t) { return t !== term; });
      list.unshift(term);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
    } catch (e) {
      // Private browsing or storage disabled — recent searches are a convenience.
    }
  }

  function priceRange(p, cfg) {
    if (p.priceMin === p.priceMax) return formatMoney(p.priceMin, cfg, p.currencyCode);
    return (
      formatMoney(p.priceMin, cfg, p.currencyCode) +
      " – " +
      formatMoney(p.priceMax, cfg, p.currencyCode)
    );
  }

  function track(proxy, type, query, productId) {
    try {
      var body = JSON.stringify({ type: type, query: query, productId: productId, st: sessionToken });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(proxy + "/track", new Blob([body], { type: "application/json" }));
      } else {
        fetch(proxy + "/track", { method: "POST", body: body, headers: { "Content-Type": "application/json" }, keepalive: true });
      }
    } catch (e) {
      // Analytics must never break the storefront.
    }
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

  /**
   * A fetch wrapper that guarantees the LAST request wins.
   *
   * Type-ahead fires a request per keystroke; without this, a slow response for
   * "sh" could land after the fast one for "shirt" and repaint the panel with
   * results for a query the shopper has already moved past.
   */
  function makeSequencer() {
    var seq = 0;
    var controller = null;
    return function (url, options) {
      var mine = ++seq;
      if (controller) controller.abort();
      controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      var opts = Object.assign({ headers: { Accept: "application/json" } }, options || {});
      if (controller) opts.signal = controller.signal;
      return fetch(url, opts)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (mine !== seq) return null; // superseded
          return data;
        });
    };
  }

  var DEFAULT_SWATCHES = {
    red: "#d33", blue: "#26c", green: "#2a2", black: "#111", white: "#fff",
    yellow: "#ee0", pink: "#e79", purple: "#849", orange: "#e83", grey: "#999",
    gray: "#999", brown: "#853", navy: "#123", beige: "#e8dcc0", gold: "#ca0",
    silver: "#bbb", cream: "#fffdd0", tan: "#d2b48c", olive: "#808000",
    teal: "#008080", maroon: "#800000", charcoal: "#36454f", khaki: "#c3b091",
  };

  /**
   * Resolve a swatch for an option value. The merchant's own map wins, then a
   * built-in list of common colour names, then grey. Values can be a colour or
   * an image URL — real catalogs have "camo" and "floral" as well as "red".
   */
  function swatchStyle(value, facetValue, cfg) {
    var custom = facetValue && facetValue.swatch;
    var map = (cfg && cfg.swatches) || {};
    var resolved = custom || map[String(value).toLowerCase()] ||
      DEFAULT_SWATCHES[String(value).toLowerCase()] || "#ccc";
    if (/^https:\/\//i.test(resolved)) {
      return "background-image:url(" + esc(resolved) + ");background-size:cover";
    }
    return "background:" + esc(resolved);
  }

  // =======================================================================
  //  Shared dropdown renderer (search-bar block AND app-embed auto-attach)
  // =======================================================================
  function populateDropdown(dropdown, data, term, cfg) {
    dropdown.innerHTML = "";
    var items = [];
    var isEmpty = !term; // empty query → recommendation mode
    var hasProducts = data.products && data.products.length;
    var hasColl = data.collections && data.collections.length;
    var hasPages = data.pages && data.pages.length;
    var recent = isEmpty && cfg.recentSearches !== false ? recentSearches() : [];
    var suggestions = (data.suggestions || []).slice();
    var hasSugg = suggestions.length || recent.length;

    if (!hasProducts && !hasColl && !hasPages && !hasSugg) {
      dropdown.classList.remove("adsf-dropdown--rich");
      dropdown.appendChild(el("div", "adsf-dropdown__empty",
        isEmpty ? "Start typing to search" : "No matches for “" + esc(term) + "”"));
      return items;
    }

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
        '<div class="adsf-preview__price">' + esc(priceRange(p, cfg)) + "</div>" +
        (p.description ? '<div class="adsf-preview__desc">' + esc(p.description) + "</div>" : "") +
        '<a class="adsf-preview__link" href="/products/' + esc(p.handle) + '">See details</a>';
    }

    function section(label) {
      var wrap = el("div", "adsf-dropdown__section");
      wrap.appendChild(el("div", "adsf-dropdown__label", esc(label)));
      list.appendChild(wrap);
      return wrap;
    }

    // Each focusable row is an ARIA option so a screen reader announces it as
    // part of the combobox rather than as loose links after the input.
    function addOption(container, node) {
      node.setAttribute("role", "option");
      node.id = "adsf-opt-" + items.length;
      node.setAttribute("aria-selected", "false");
      container.appendChild(node);
      items.push(node);
      return node;
    }

    if (recent.length) {
      var rg = section("Recent searches");
      recent.forEach(function (s) {
        var a = el("a", "adsf-dropdown__suggestion");
        a.href = cfg.resultsUrl + "?q=" + encodeURIComponent(s);
        a.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="2"/><path d="M10 6v4l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>' + esc(s) + "</span>";
        addOption(rg, a);
      });
    }

    if (suggestions.length) {
      var sg = section(isEmpty ? "Trending searches" : "Suggestions");
      suggestions.forEach(function (s) {
        var a = el("a", "adsf-dropdown__suggestion");
        a.href = cfg.resultsUrl + "?q=" + encodeURIComponent(s);
        a.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="2"/><path d="m14 14 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>' + highlight(s, term) + "</span>";
        addOption(sg, a);
      });
    }

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
          (cfg.showVendor && p.vendor ? '<span class="adsf-dropdown__pvendor">' + esc(p.vendor) + "</span>" : "") +
          '<span class="adsf-dropdown__pprice">' + esc(priceRange(p, cfg)) + "</span></span>";
        addOption(pg, a);
      });
    }

    if (hasColl) {
      var cg = section(isEmpty ? "Popular choices" : "Collections");
      data.collections.forEach(function (c) {
        var a = el("a", "adsf-dropdown__collection");
        a.href = "/collections/" + encodeURIComponent(c.handle);
        a.innerHTML =
          (c.imageUrl ? '<img src="' + esc(c.imageUrl) + '" alt="" loading="lazy">' : '<span class="adsf-dropdown__noimg adsf-dropdown__noimg--sm"></span>') +
          '<span class="adsf-dropdown__ctitle">' + highlight(c.title, term) + "</span>" +
          (c.productCount ? '<span class="adsf-dropdown__count">' + c.productCount + "</span>" : "");
        addOption(cg, a);
      });
    }

    if (hasPages) {
      var pgs = section("Pages");
      data.pages.forEach(function (pageItem) {
        var a = el("a", "adsf-dropdown__page");
        a.href = "/pages/" + encodeURIComponent(pageItem.handle);
        a.innerHTML = highlight(pageItem.title, term);
        addOption(pgs, a);
      });
    }

    if (!isEmpty) {
      var all = el("a", "adsf-dropdown__all");
      all.href = cfg.resultsUrl + "?q=" + encodeURIComponent(term);
      all.textContent = "See all results";
      addOption(list, all);
    }

    if (useRich) {
      dropdown.appendChild(preview);
      dropdown.appendChild(list);
      if (hasProducts) {
        setPreview(data.products[0]);
        var firstRow = list.querySelector(".adsf-dropdown__product");
        if (firstRow) firstRow.classList.add("is-preview");
      }
    }

    return items;
  }

  /**
   * Keyboard + ARIA wiring shared by both autocomplete paths.
   *
   * The block-based search bar had arrow-key navigation and the auto-attached
   * theme input did not, so the same widget behaved differently depending on
   * which box the shopper used.
   */
  function bindCombobox(input, dropdown, ctx) {
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("autocomplete", "off");
    if (!dropdown.id) dropdown.id = "adsf-listbox-" + Math.random().toString(36).slice(2);
    input.setAttribute("aria-controls", dropdown.id);
    dropdown.setAttribute("role", "listbox");

    var status = el("div", "adsf-visually-hidden");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("role", "status");
    dropdown.parentNode.insertBefore(status, dropdown);

    ctx.activeIndex = -1;

    ctx.announce = function (n, term) {
      status.textContent = !term
        ? ""
        : n
          ? n + " suggestion" + (n === 1 ? "" : "s") + " for " + term
          : "No results for " + term;
    };

    ctx.markActive = function () {
      (ctx.items || []).forEach(function (it, i) {
        var on = i === ctx.activeIndex;
        it.classList.toggle("is-active", on);
        it.setAttribute("aria-selected", on ? "true" : "false");
      });
      var current = (ctx.items || [])[ctx.activeIndex];
      if (current) {
        input.setAttribute("aria-activedescendant", current.id);
        if (current.scrollIntoView) current.scrollIntoView({ block: "nearest" });
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    };

    input.addEventListener("keydown", function (e) {
      if (dropdown.hidden) return;
      var items = ctx.items || [];
      if (e.key === "ArrowDown") {
        e.preventDefault();
        ctx.activeIndex = Math.min(ctx.activeIndex + 1, items.length - 1);
        ctx.markActive();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        ctx.activeIndex = Math.max(ctx.activeIndex - 1, -1);
        ctx.markActive();
      } else if (e.key === "Home" && items.length) {
        e.preventDefault(); ctx.activeIndex = 0; ctx.markActive();
      } else if (e.key === "End" && items.length) {
        e.preventDefault(); ctx.activeIndex = items.length - 1; ctx.markActive();
      } else if (e.key === "Enter") {
        if (ctx.activeIndex >= 0 && items[ctx.activeIndex]) {
          e.preventDefault();
          items[ctx.activeIndex].click();
        } else {
          rememberSearch(input.value.trim());
        }
      } else if (e.key === "Escape") {
        ctx.close();
        input.focus();
      } else if (e.key === "Tab") {
        ctx.close();
      }
    });
  }

  // =======================================================================
  //  1. Autocomplete search bar (theme block)
  // =======================================================================
  function initSearchBar(root, globalCfg) {
    var input = root.querySelector("[data-adsf-input]");
    var dropdown = root.querySelector("[data-adsf-dropdown]");
    if (!input || !dropdown) return;

    var cfg = Object.assign({}, globalCfg || {}, {
      proxy: root.getAttribute("data-proxy") || (globalCfg && globalCfg.proxy) || "/apps/anotherdev-search",
      resultsUrl: root.getAttribute("data-results-url") || "/apps/anotherdev-search/results",
      moneyFormat: root.getAttribute("data-money-format") || (globalCfg && globalCfg.moneyFormat),
    });
    var minChars = parseInt(root.getAttribute("data-min-chars") || cfg.minChars || "2", 10);
    var limit = parseInt(root.getAttribute("data-max-suggestions") || cfg.maxSuggestions || "6", 10);
    var showRecs = root.getAttribute("data-recommendations") !== "false";

    var request = makeSequencer();
    var ctx = { items: [] };
    ctx.close = function () {
      dropdown.hidden = true;
      dropdown.innerHTML = "";
      ctx.activeIndex = -1;
      ctx.items = [];
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    };
    bindCombobox(input, dropdown, ctx);

    function render(data, term) {
      if (!data) return; // superseded by a newer keystroke
      ctx.items = populateDropdown(dropdown, data, term, cfg);
      ctx.activeIndex = -1;
      dropdown.hidden = false;
      input.setAttribute("aria-expanded", "true");
      ctx.announce(ctx.items.length, term);
    }

    var run = debounce(function () {
      var term = input.value.trim();
      if (term.length < minChars) {
        if (!term && showRecs) fetchRecs();
        else ctx.close();
        return;
      }
      request(cfg.proxy + "/autocomplete?q=" + encodeURIComponent(term) + "&limit=" + limit)
        .then(function (d) { render(d, term); })
        .catch(function () {});
    }, 150);

    function fetchRecs() {
      request(cfg.proxy + "/autocomplete?q=&limit=8")
        .then(function (d) { render(d, ""); })
        .catch(function () {});
    }

    input.addEventListener("input", run);
    input.addEventListener("focus", function () {
      var term = input.value.trim();
      if (term.length >= minChars && ctx.items.length) {
        dropdown.hidden = false;
        input.setAttribute("aria-expanded", "true");
      } else if (!term && showRecs) fetchRecs();
    });

    // Remember what was actually searched, for the "Recent searches" section.
    var form = root.querySelector("form");
    if (form) {
      form.addEventListener("submit", function () {
        rememberSearch(input.value.trim());
      });
    }

    document.addEventListener("click", function (e) {
      if (!root.contains(e.target)) ctx.close();
    });
  }

  // =======================================================================
  //  2. Faceted results application
  // =======================================================================
  function initResultsApp(root, globalCfg) {
    // The facet UI is presented four ways; the stylesheet does the work, so
    // switching layout is one class rather than four render paths.
    var layout = (globalCfg && globalCfg.filterLayout) || "sidebar";
    root.classList.add("adsf-app--filters-" + layout);
    var cfg = Object.assign({}, globalCfg || {}, {
      proxy: root.getAttribute("data-proxy") || (globalCfg && globalCfg.proxy) || "/apps/anotherdev-search",
      moneyFormat: root.getAttribute("data-money-format") || (globalCfg && globalCfg.moneyFormat),
    });
    var perPage = parseInt(root.getAttribute("data-per-page") || "24", 10);
    var collection = root.getAttribute("data-collection") || "";
    var grid = root.querySelector("[data-adsf-grid]");
    var facetsInner = root.querySelector("[data-adsf-facets-inner]");
    var meta = root.querySelector("[data-adsf-meta]");
    var chips = root.querySelector("[data-adsf-chips]");
    var pagination = root.querySelector("[data-adsf-pagination]");
    var sortSel = root.querySelector("[data-adsf-sort]");
    var filterToggle = root.querySelector("[data-adsf-filter-toggle]");
    var facetsPanel = root.querySelector("[data-adsf-facets]");
    var backdrop = root.querySelector("[data-adsf-backdrop]");

    var request = makeSequencer();
    var state = readState();
    var lastFacets = [];

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

    /**
     * Filter changes are navigation: each one becomes a history entry so Back
     * returns to the previous refinement. `replaceState` overwrote the single
     * entry instead, so Back left the results page entirely — losing everything
     * the shopper had narrowed down.
     */
    function syncUrl(push) {
      var sp = toParams(state);
      var url = location.pathname + (sp.toString() ? "?" + sp.toString() : "");
      if (push) history.pushState({ adsf: true }, "", url);
      else history.replaceState({ adsf: true }, "", url);
    }

    function skeleton() {
      var cells = "";
      for (var i = 0; i < Math.min(perPage, 8); i++) {
        cells += '<div class="adsf-card adsf-card--skeleton"><div class="adsf-skel adsf-skel--img"></div><div class="adsf-skel adsf-skel--line"></div><div class="adsf-skel adsf-skel--line adsf-skel--short"></div></div>';
      }
      grid.innerHTML = cells;
    }

    function fetchResults() {
      grid.setAttribute("aria-busy", "true");
      if (!grid.children.length) skeleton();
      var sp = toParams(state);
      sp.set("perPage", perPage);
      if (collection) sp.set("collection", collection);
      sp.set("st", sessionToken);
      request(cfg.proxy + "/search?" + sp.toString())
        .then(function (data) {
          if (!data) return;
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
      lastFacets = data.facets || [];

      var m = data.total + " result" + (data.total === 1 ? "" : "s");
      if (state.term) m += ' for “' + esc(state.term) + '”';
      meta.innerHTML = m + (data.suggestion && data.total < 3
        ? ' — did you mean <a href="#" data-adsf-suggest="' + esc(data.suggestion) + '">' + esc(data.suggestion) + "</a>?"
        : "");
      var sug = meta.querySelector("[data-adsf-suggest]");
      if (sug) sug.addEventListener("click", function (e) {
        e.preventDefault();
        state.term = sug.getAttribute("data-adsf-suggest");
        state.page = 1;
        apply(true);
      });

      if (!data.hits.length) {
        grid.innerHTML = '<div class="adsf-empty"><p>No products found.</p>' +
          (hasActiveFilters() ? '<button type="button" data-adsf-clear>Clear all filters</button>' : "") + "</div>";
        var cl = grid.querySelector("[data-adsf-clear]");
        if (cl) cl.addEventListener("click", clearAll);
      } else {
        grid.innerHTML = data.hits.map(function (p) { return card(p); }).join("");
        Array.prototype.forEach.call(grid.querySelectorAll("[data-adsf-hit]"), function (a) {
          a.addEventListener("click", function () { track(cfg.proxy, "click", state.term, a.getAttribute("data-adsf-hit")); });
        });
        if (cfg.quickAdd) bindQuickAdd();
      }

      renderChips();
      renderFacets(lastFacets);
      renderPagination(data.total);
      if (sortSel) sortSel.value = state.sort;
    }

    function card(p) {
      var canQuickAdd = cfg.quickAdd && p.available && p.variantCount === 1 && p.variantId;
      return '<article class="adsf-card' + (p.pinned ? " adsf-card--pinned" : "") + '">' +
        '<a href="/products/' + esc(p.handle) + '" data-adsf-hit="' + esc(p.productId) + '">' +
        (p.imageUrl
          ? '<img class="adsf-card__img" src="' + esc(p.imageUrl) + '" alt="' + esc(p.imageAlt || p.title) + '" loading="lazy" width="300" height="300">'
          : '<span class="adsf-card__noimg"></span>') +
        '<h3 class="adsf-card__title">' + esc(p.title) + "</h3>" +
        (cfg.showVendor && p.vendor ? '<div class="adsf-card__vendor">' + esc(p.vendor) + "</div>" : "") +
        '<div class="adsf-card__price">' + esc(priceRange(p, cfg)) + "</div>" +
        (p.available ? "" : '<span class="adsf-card__soldout">Sold out</span>') +
        "</a>" +
        (canQuickAdd
          ? '<button type="button" class="adsf-card__add" data-adsf-add="' + esc(p.variantId) + '" data-adsf-add-product="' + esc(p.productId) + '">Add to cart</button>'
          : "") +
        "</article>";
    }

    /**
     * Add to cart without leaving the results. Uses the theme-agnostic
     * /cart/add.js endpoint and then asks the theme to refresh its cart UI.
     */
    function bindQuickAdd() {
      Array.prototype.forEach.call(grid.querySelectorAll("[data-adsf-add]"), function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-adsf-add");
          btn.disabled = true;
          btn.textContent = "Adding…";
          fetch("/cart/add.js", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: [{ id: Number(id), quantity: 1 }] }),
          })
            .then(function (r) { if (!r.ok) throw new Error("add failed"); return r.json(); })
            .then(function () {
              btn.textContent = "Added";
              track(cfg.proxy, "add_to_cart", state.term, btn.getAttribute("data-adsf-add-product"));
              // Most themes listen for one of these to re-render the cart bubble.
              document.dispatchEvent(new CustomEvent("cart:refresh", { bubbles: true }));
              document.dispatchEvent(new CustomEvent("cart:build", { bubbles: true }));
              setTimeout(function () { btn.disabled = false; btn.textContent = "Add to cart"; }, 2500);
            })
            .catch(function () {
              btn.textContent = "Unavailable";
              setTimeout(function () { btn.disabled = false; btn.textContent = "Add to cart"; }, 2500);
            });
        });
      });
    }

    function hasActiveFilters() {
      return Object.keys(state.filters).length > 0 || !!state.priceMin || !!state.priceMax;
    }

    function clearAll() {
      state.filters = {};
      state.priceMin = state.priceMax = null;
      state.page = 1;
      apply(true);
    }

    /** Removable chips for everything currently applied. */
    function renderChips() {
      if (!chips) return;
      chips.innerHTML = "";
      if (!hasActiveFilters()) return;

      // Reads as words rather than symbols: an open-ended range rendered as
      // "10-∞", which means nothing to a shopper.
      function priceChipLabel(min, max) {
        if (min && max) return "Price " + min + " to " + max;
        if (min) return "Price " + min + " and up";
        if (max) return "Price up to " + max;
        return "Price";
      }

      function chip(label, onRemove) {
        var b = el("button", "adsf-chip");
        b.type = "button";
        b.innerHTML = esc(label) + ' <span aria-hidden="true">×</span>';
        b.setAttribute("aria-label", "Remove filter " + label);
        b.addEventListener("click", onRemove);
        chips.appendChild(b);
      }

      Object.keys(state.filters).forEach(function (source) {
        var facet = lastFacets.filter(function (f) { return f.source === source; })[0];
        state.filters[source].forEach(function (value) {
          var labelled = facet && facet.values.filter(function (v) { return v.value === value; })[0];
          chip((facet ? facet.label + ": " : "") + (labelled ? labelled.label : value), function () {
            toggleFilter(source, value, false);
          });
        });
      });

      if (state.priceMin || state.priceMax) {
        chip(priceChipLabel(state.priceMin, state.priceMax), function () {
          state.priceMin = state.priceMax = null;
          state.page = 1;
          apply(true);
        });
      }

      var clear = el("button", "adsf-chip adsf-chip--clear");
      clear.type = "button";
      clear.textContent = "Clear all";
      clear.addEventListener("click", clearAll);
      chips.appendChild(clear);
    }

    function renderFacets(facets) {
      facetsInner.innerHTML = "";
      facets.forEach(function (f) {
        var group = el("div", "adsf-facet");
        var heading = el("h4", "adsf-facet__title");
        var btn = el("button", "adsf-facet__toggle");
        btn.type = "button";
        btn.setAttribute("aria-expanded", "true");
        btn.textContent = f.label;
        heading.appendChild(btn);
        group.appendChild(heading);

        var bodyWrap = el("div", "adsf-facet__body");
        btn.addEventListener("click", function () {
          var open = btn.getAttribute("aria-expanded") === "true";
          btn.setAttribute("aria-expanded", String(!open));
          bodyWrap.hidden = open;
        });

        if (f.displayAs === "range") {
          bodyWrap.appendChild(rangeFacet(f));
        } else {
          bodyWrap.appendChild(listFacet(f));
        }
        group.appendChild(bodyWrap);
        facetsInner.appendChild(group);
      });
    }

    function rangeFacet(f) {
      var wrap = el("div", "adsf-facet__range");
      var lo = Math.floor(f.min != null ? f.min : 0);
      var hi = Math.ceil(f.max != null ? f.max : 0);

      var min = el("input", "adsf-facet__num");
      min.type = "number"; min.min = lo; min.max = hi;
      min.placeholder = String(lo);
      min.value = state.priceMin || "";
      min.setAttribute("aria-label", f.label + " minimum");

      var max = el("input", "adsf-facet__num");
      max.type = "number"; max.min = lo; max.max = hi;
      max.placeholder = String(hi);
      max.value = state.priceMax || "";
      max.setAttribute("aria-label", f.label + " maximum");

      // A slider for the upper bound: most price filtering is "under X", and
      // dragging beats typing on a phone.
      var slider = el("input", "adsf-facet__slider");
      slider.type = "range";
      slider.min = String(lo); slider.max = String(hi);
      slider.value = String(state.priceMax || hi);
      slider.setAttribute("aria-label", f.label + " maximum");
      slider.addEventListener("input", function () { max.value = slider.value; });
      slider.addEventListener("change", function () {
        state.priceMax = slider.value === String(hi) ? null : slider.value;
        state.page = 1;
        apply(true);
      });

      var applyBtn = el("button", "adsf-facet__apply", "Go");
      applyBtn.type = "button";
      applyBtn.addEventListener("click", function () {
        state.priceMin = min.value || null;
        state.priceMax = max.value || null;
        state.page = 1;
        apply(true);
      });

      var row = el("div", "adsf-facet__rangerow");
      row.appendChild(min);
      row.appendChild(el("span", "adsf-facet__dash", "–"));
      row.appendChild(max);
      row.appendChild(applyBtn);
      wrap.appendChild(row);
      if (hi > lo) wrap.appendChild(slider);
      return wrap;
    }

    function listFacet(f) {
      var list = el("ul", "adsf-facet__list");
      var selected = state.filters[f.source] || [];
      f.values.forEach(function (v) {
        var li = el("li", "adsf-facet__item" + (f.displayAs === "swatch" ? " adsf-facet__item--swatch" : ""));
        var id = "adsf_" + f.source.replace(/[^a-z0-9]/gi, "") + "_" + String(v.value).replace(/[^a-z0-9]/gi, "");
        var checked = selected.indexOf(v.value) >= 0;
        var cb = el("input");
        cb.type = "checkbox"; cb.id = id; cb.checked = checked; cb.value = v.value;
        cb.addEventListener("change", function () { toggleFilter(f.source, v.value, cb.checked); });
        var lbl = el("label");
        lbl.setAttribute("for", id);
        if (f.displayAs === "swatch") {
          lbl.innerHTML = '<span class="adsf-swatch" style="' + swatchStyle(v.value, v, cfg) + '" title="' + esc(v.label) + '"></span>';
        }
        lbl.insertAdjacentHTML("beforeend", '<span class="adsf-facet__label">' + esc(v.label) + '</span> <span class="adsf-facet__count">' + v.count + "</span>");
        li.appendChild(cb); li.appendChild(lbl);
        list.appendChild(li);
      });
      return list;
    }

    /**
     * Pagination as real links.
     *
     * Buttons cannot be crawled, opened in a new tab, or middle-clicked. The
     * click handler still keeps navigation in-page for anyone using a mouse.
     */
    function renderPagination(total) {
      var pages = Math.max(1, Math.ceil(total / perPage));
      if (pages <= 1) { pagination.innerHTML = ""; return; }

      function href(p) {
        var s = Object.assign({}, state, { page: p });
        var sp = toParams(s);
        return location.pathname + (sp.toString() ? "?" + sp.toString() : "");
      }

      var html = "";
      if (state.page > 1) html += '<a href="' + esc(href(state.page - 1)) + '" rel="prev" data-p="' + (state.page - 1) + '">‹ Prev</a>';
      for (var p = Math.max(1, state.page - 2); p <= Math.min(pages, state.page + 2); p++) {
        html += '<a href="' + esc(href(p)) + '" data-p="' + p + '"' + (p === state.page ? ' aria-current="page"' : "") + ">" + p + "</a>";
      }
      if (state.page < pages) html += '<a href="' + esc(href(state.page + 1)) + '" rel="next" data-p="' + (state.page + 1) + '">Next ›</a>';
      pagination.innerHTML = html;

      Array.prototype.forEach.call(pagination.querySelectorAll("[data-p]"), function (a) {
        a.addEventListener("click", function (e) {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser do it
          e.preventDefault();
          state.page = parseInt(a.getAttribute("data-p"), 10);
          apply(true);
          root.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });
    }

    function toggleFilter(source, value, on) {
      var arr = (state.filters[source] || []).slice();
      if (on) { if (arr.indexOf(value) < 0) arr.push(value); }
      else { arr = arr.filter(function (v) { return v !== value; }); }
      if (arr.length) state.filters[source] = arr; else delete state.filters[source];
      state.page = 1;
      apply(true);
    }

    function apply(push) { syncUrl(push); fetchResults(); }

    // --- mobile drawer, with a focus trap ---------------------------------
    var lastFocused = null;
    function focusables() {
      return facetsPanel.querySelectorAll(
        'button, input, select, a[href], [tabindex]:not([tabindex="-1"])',
      );
    }
    function openDrawer(open) {
      facetsPanel.classList.toggle("is-open", open);
      if (backdrop) backdrop.hidden = !open;
      if (filterToggle) filterToggle.setAttribute("aria-expanded", String(open));
      facetsPanel.setAttribute("aria-modal", String(open));
      document.body.style.overflow = open ? "hidden" : "";
      if (open) {
        lastFocused = document.activeElement;
        var f = focusables();
        if (f.length) f[0].focus();
      } else if (lastFocused && lastFocused.focus) {
        lastFocused.focus();
      }
    }
    if (filterToggle) filterToggle.addEventListener("click", function () { openDrawer(!facetsPanel.classList.contains("is-open")); });
    if (backdrop) backdrop.addEventListener("click", function () { openDrawer(false); });

    // Keyboard users must be able to leave the drawer, and must not tab out of
    // it into the page behind while it is covering the screen.
    facetsPanel.addEventListener("keydown", function (e) {
      if (!facetsPanel.classList.contains("is-open")) return;
      if (e.key === "Escape") { openDrawer(false); return; }
      if (e.key !== "Tab") return;
      var f = focusables();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    if (sortSel) sortSel.addEventListener("change", function () { state.sort = sortSel.value; state.page = 1; apply(true); });

    window.addEventListener("popstate", function () {
      state = readState();
      if (sortSel) sortSel.value = state.sort;
      fetchResults();
    });

    fetchResults();
  }

  // =======================================================================
  //  3. Recommendation rail
  // =======================================================================
  function initRecommendations(root, globalCfg) {
    var cfg = Object.assign({}, globalCfg || {}, {
      proxy: root.getAttribute("data-proxy") || (globalCfg && globalCfg.proxy) || "/apps/anotherdev-search",
      moneyFormat: root.getAttribute("data-money-format") || (globalCfg && globalCfg.moneyFormat),
    });
    var kind = root.getAttribute("data-kind") || "related";
    var productId = root.getAttribute("data-product-id") || "";
    var collection = root.getAttribute("data-collection") || "";
    var limit = parseInt(root.getAttribute("data-limit") || "8", 10);
    var track_ = root.querySelector("[data-adsf-rec-track]") || root;

    var qs = "kind=" + encodeURIComponent(kind) + "&limit=" + limit +
      (productId ? "&productId=" + encodeURIComponent(productId) : "") +
      (collection ? "&collection=" + encodeURIComponent(collection) : "");

    fetch(cfg.proxy + "/recommend?" + qs, { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var products = (data && data.products) || [];
        // An empty rail should collapse, not leave a titled empty box.
        if (!products.length) { root.hidden = true; return; }
        track_.innerHTML = products.map(function (p) {
          return '<a class="adsf-rec__card" href="/products/' + esc(p.handle) + '" data-adsf-rec-hit="' + esc(p.productId) + '">' +
            (p.imageUrl ? '<img src="' + esc(p.imageUrl) + '" alt="" loading="lazy">' : '<span class="adsf-card__noimg"></span>') +
            '<span class="adsf-rec__title">' + esc(p.title) + "</span>" +
            '<span class="adsf-rec__price">' + esc(priceRange(p, cfg)) + "</span>" +
            "</a>";
        }).join("");
        Array.prototype.forEach.call(track_.querySelectorAll("[data-adsf-rec-hit]"), function (a) {
          a.addEventListener("click", function () {
            track(cfg.proxy, "click", "", a.getAttribute("data-adsf-rec-hit"));
          });
        });
      })
      .catch(function () { root.hidden = true; });
  }

  // =======================================================================
  //  4. Auto-attach to the theme's existing search box
  // =======================================================================
  function attachAutocomplete(input, cfg) {
    if (input.getAttribute("data-adsf-attached")) return;
    input.setAttribute("data-adsf-attached", "1");

    var spotlight = cfg.panelStyle === "spotlight";
    var request = makeSequencer();

    var backdrop = null;
    if (spotlight) {
      backdrop = el("div", "adsf-backdrop");
      backdrop.hidden = true;
      document.body.appendChild(backdrop);
      // No click handler: the backdrop is pointer-events:none so the input
      // underneath stays usable. Clicking away is handled on document below.
    }

    var dropdown = el("div", "adsf-dropdown" + (spotlight ? " adsf-dropdown--spotlight" : ""));
    dropdown.hidden = true;
    dropdown.style.position = "fixed";
    dropdown.style.zIndex = "100000";
    document.body.appendChild(dropdown);

    var ctx = { items: [] };
    ctx.close = function () {
      dropdown.hidden = true;
      dropdown.innerHTML = "";
      ctx.items = [];
      ctx.activeIndex = -1;
      if (backdrop) backdrop.hidden = true;
      input.classList.remove("adsf-input-raised");
      document.body.classList.remove("adsf-active");
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    };
    bindCombobox(input, dropdown, ctx);

    // Viewport coordinates only. Adding scrollX/scrollY to a fixed-position
    // element would double-count the scroll offset and walk the panel off
    // screen; with position:fixed the rect alone is already correct, and the
    // scroll listener keeps it glued to a header that moves or reflows.
    function place() {
      var r = input.getBoundingClientRect();
      var isRich = dropdown.classList.contains("adsf-dropdown--rich");
      var w = isRich ? Math.min(640, window.innerWidth * 0.92) : Math.max(300, r.width);
      dropdown.style.width = w + "px";
      var left = Math.min(r.left, window.innerWidth - w - 8);
      dropdown.style.left = Math.max(8, left) + "px";
      dropdown.style.top = (r.bottom + 6) + "px";
      // Never run past the bottom of the window; the panel scrolls instead.
      dropdown.style.maxHeight = Math.max(220, window.innerHeight - r.bottom - 24) + "px";
    }

    function open() {
      if (backdrop) backdrop.hidden = false;
      dropdown.hidden = false;
      // Best effort at lifting the input above the dim layer so it reads as
      // focused. If an ancestor creates a stacking context this has no
      // effect, which is why the backdrop is also pointer-events:none.
      input.classList.add("adsf-input-raised");
      input.setAttribute("aria-expanded", "true");
      // Hide the theme's OWN predictive-search results so the two panels don't
      // stack/overlap (CSS in the stylesheet targets common theme containers).
      document.body.classList.add("adsf-active");
    }

    function render(data, term) {
      if (!data) return;
      ctx.items = populateDropdown(dropdown, data, term, cfg);
      ctx.activeIndex = -1;
      place();
      open();
      ctx.announce(ctx.items.length, term);
    }

    function fetchTerm(term) {
      var q = term ? encodeURIComponent(term) : "";
      request(cfg.proxy + "/autocomplete?q=" + q + "&limit=" + (term ? cfg.maxSuggestions : 8))
        .then(function (d) { render(d, term); })
        .catch(function () {});
    }

    var run = debounce(function () {
      var term = input.value.trim();
      if (term.length < cfg.minChars) {
        if (!term && cfg.showRecs) fetchTerm("");
        else ctx.close();
        return;
      }
      fetchTerm(term);
    }, 150);

    input.addEventListener("input", run);
    input.addEventListener("focus", function () {
      if (!input.value.trim() && cfg.showRecs) fetchTerm("");
    });

    /**
     * Send Enter to OUR results page.
     *
     * Without this, submitting the theme's search form went to the theme's own
     * /search — so a shopper who pressed Enter left the app's search entirely
     * and saw the basic results the app exists to replace.
     */
    var form = input.form || input.closest("form");
    if (form && cfg.searchTakeover !== false) {
      form.addEventListener("submit", function (e) {
        var term = input.value.trim();
        rememberSearch(term);
        if (!term) return;
        e.preventDefault();
        location.href = cfg.resultsUrl + "?q=" + encodeURIComponent(term);
      });
    } else if (form) {
      form.addEventListener("submit", function () { rememberSearch(input.value.trim()); });
    }

    var reposition = rafThrottle(function () { if (!dropdown.hidden) place(); });
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("click", function (e) {
      if (e.target !== input && !dropdown.contains(e.target)) ctx.close();
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
      var pending = false;
      var mo = new MutationObserver(function () {
        // Themes mutate constantly; coalesce into one scan per frame rather than
        // scanning per mutation record.
        if (pending) return;
        pending = true;
        requestAnimationFrame(function () {
          pending = false;
          scanAndAttach(cfg, document);
        });
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }

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

  // =======================================================================
  //  5. Page takeover — /search and collection pages
  // =======================================================================

  // Markets and locales prefix the path (/en-gb/search, /fr-ca/collections/x),
  // so an anchored "^/search" matched nothing on any internationalised store
  // and takeover silently never ran there.
  var LOCALE = "(?:/[a-z]{2}(?:-[a-z0-9]{2,})?)?";
  var SEARCH_PATH_RE = new RegExp("^" + LOCALE + "/search\\b", "i");
  var COLLECTION_PATH_RE = new RegExp("^" + LOCALE + "/collections/[^/]+/?$", "i");

  // Where themes put the product grid on search / collection templates, most
  // specific first. Dawn and the OS 2.0 family use the first few.
  var GRID_SELECTORS = [
    "[data-adsf-collection-mount]",
    "#ProductGridContainer",
    "#product-grid",
    "[id^='product-grid']",
    "#main-collection-product-grid",
    ".collection__products",
    ".collection-grid",
    "ul.product-grid",
    "#search-results",
    ".search__results",
  ];

  /**
   * The grid container, and nothing above it.
   *
   * Two earlier versions of this were too greedy. Emptying #MainContent took
   * the whole template; climbing to the enclosing .shopify-section took the
   * banner and description with it, because plenty of themes put those in the
   * same section as the grid. The grid element itself is the only node we can
   * replace and be certain we are not deleting the merchant’s content.
   *
   * The cost is that the theme's own facet UI survives; it is hidden by CSS
   * (body.adsf-collection-active) rather than removed, which is reversible.
   */
  function findGridHost() {
    for (var i = 0; i < GRID_SELECTORS.length; i++) {
      var node = document.querySelector(GRID_SELECTORS[i]);
      if (node) return node;
    }
    return null;
  }

  /**
   * Replace the theme's own search results with ours.
   *
   * The app previously only rendered results where a merchant had manually
   * placed the results block. Shoppers who used the theme's search form still
   * landed on the theme's basic results page — the exact page this app replaces.
   */
  function takeoverSearchPage(cfg) {
    if (!SEARCH_PATH_RE.test(location.pathname)) return false;
    if (document.querySelector("[data-adsf-results-app]")) return false; // block already present

    // Same rule as collection pages: replace the grid, never a container that
    // might hold anything else. The old #MainContent fallback was how the
    // whole template got wiped on themes we did not recognise, and no amount
    // of takeover is worth deleting a merchant's page.
    var host = findGridHost();
    if (!host) return false;

    var sp = new URLSearchParams(location.search);
    var mount = el("div", "adsf-app");
    mount.setAttribute("data-adsf-results-app", "");
    mount.setAttribute("data-proxy", cfg.proxy);
    mount.setAttribute("data-per-page", String(cfg.resultsPerPage || 24));
    if (cfg.moneyFormat) mount.setAttribute("data-money-format", cfg.moneyFormat);
    mount.style.setProperty("--adsf-cols", String(cfg.gridColumns || 4));
    mount.innerHTML = RESULTS_MARKUP;
    host.innerHTML = "";
    host.appendChild(mount);
    document.body.classList.add("adsf-collection-active");

    // The theme's URL uses ?q=, which our state reader already understands.
    if (!sp.get("q") && sp.get("query")) {
      history.replaceState(null, "", location.pathname + "?q=" + encodeURIComponent(sp.get("query")));
    }
    initResultsApp(mount, cfg);
    return true;
  }

  /**
   * Filters + instant results on collection pages.
   *
   * The collection handle is read from Shopify's own page globals, so one theme
   * block works on every collection. Previously the handle had to be typed into
   * the block's settings, which cannot work on a shared collection template.
   */
  function takeoverCollectionPage(cfg) {
    if (!COLLECTION_PATH_RE.test(location.pathname)) return false;
    if (document.querySelector("[data-adsf-results-app]")) return false;

    // Read the handle out of the path rather than by segment index, which was
    // off by one on any locale-prefixed URL (/en-gb/collections/summer).
    var fromPath = location.pathname.match(/\/collections\/([^/?#]+)/);
    var handle =
      (window.ShopifyAnalytics &&
        window.ShopifyAnalytics.meta &&
        window.ShopifyAnalytics.meta.page &&
        window.ShopifyAnalytics.meta.page.resourceType === "collection" &&
        window.ShopifyAnalytics.meta.page.handle) ||
      decodeURIComponent((fromPath && fromPath[1]) || "");
    if (!handle) return false;

    // Only ever replace the grid section. If this theme lays its collection out
    // in a way we do not recognise, leave the page completely alone — silently
    // rendering nothing beats deleting the merchant's content.
    var host = findGridHost();
    if (!host) return false;

    // Ask before replacing anything.
    //
    // If our index has no products for this collection, the theme is showing a
    // perfectly good grid and we would swap it for "No products found" — which
    // is exactly what happened when collection membership was missing from the
    // index. An unfiltered collection that we believe is empty means OUR data
    // is wrong, not the store, so we leave the page alone.
    var probe = cfg.proxy + "/search?perPage=1&collection=" + encodeURIComponent(handle);
    fetch(probe, { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.total) return;
        var mount = el("div", "adsf-app");
        mount.setAttribute("data-adsf-results-app", "");
        mount.setAttribute("data-proxy", cfg.proxy);
        mount.setAttribute("data-collection", handle);
        mount.setAttribute("data-per-page", String(cfg.resultsPerPage || 24));
        if (cfg.moneyFormat) mount.setAttribute("data-money-format", cfg.moneyFormat);
        mount.style.setProperty("--adsf-cols", String(cfg.gridColumns || 4));
        mount.innerHTML = RESULTS_MARKUP;
        host.innerHTML = "";
        host.appendChild(mount);
        // The theme's own facet form now drives a grid that is gone. Hide it
        // rather than delete it.
        document.body.classList.add("adsf-collection-active");
        initResultsApp(mount, cfg);
      })
      .catch(function () {
        // Proxy unreachable: the theme keeps its own grid. Nothing to undo.
      });
    return true;
  }

  // Kept in JS (not Liquid) because takeover mounts it into themes that never
  // included our block.
  var RESULTS_MARKUP = [
    '<div class="adsf-app__topbar">',
    '  <button type="button" class="adsf-app__filter-toggle" data-adsf-filter-toggle aria-expanded="false">Filters</button>',
    '  <div class="adsf-app__meta" data-adsf-meta aria-live="polite"></div>',
    '  <label class="adsf-app__sort"><span class="adsf-visually-hidden">Sort by</span>',
    '    <select data-adsf-sort>',
    '      <option value="relevance">Relevance</option>',
    '      <option value="price_asc">Price: Low to High</option>',
    '      <option value="price_desc">Price: High to Low</option>',
    '      <option value="newest">Newest</option>',
    '      <option value="bestselling">Best selling</option>',
    '      <option value="title_asc">Alphabetical</option>',
    '    </select>',
    '  </label>',
    "</div>",
    '<div class="adsf-app__chips" data-adsf-chips></div>',
    '<div class="adsf-app__body">',
    '  <aside class="adsf-facets" data-adsf-facets aria-label="Filters"><div class="adsf-facets__inner" data-adsf-facets-inner></div></aside>',
    '  <div class="adsf-app__main">',
    '    <div class="adsf-grid" data-adsf-grid aria-busy="true"></div>',
    '    <nav class="adsf-pagination" data-adsf-pagination aria-label="Search results pages"></nav>',
    "  </div>",
    "</div>",
    '<div class="adsf-drawer-backdrop" data-adsf-backdrop hidden></div>',
  ].join("");

  function applySettings(cfg, s) {
    // Behaviour
    cfg.minChars = s.minChars || cfg.minChars;
    cfg.maxSuggestions = s.maxSuggestions || cfg.maxSuggestions;
    cfg.showRecs = s.showRecommendations !== false;
    cfg.recentSearches = s.recentSearches !== false;
    cfg.panelStyle = s.panelStyle || cfg.panelStyle || "dropdown";
    cfg.layout = s.layout || "rich";
    cfg.previewSide = s.previewSide || "left";
    cfg.autoAttach = s.autoAttach !== false;
    cfg.searchTakeover = s.searchTakeover !== false;
    cfg.collectionFilters = s.collectionFilters !== false;
    cfg.filterLayout = s.filterLayout || "sidebar";
    cfg.resultsPerPage = s.resultsPerPage || 24;
    cfg.gridColumns = s.gridColumns || 4;
    cfg.showVendor = !!s.showVendor;
    cfg.quickAdd = !!s.quickAdd;
    cfg.swatches = s.swatches || {};
    if (s.proxy) {
      cfg.proxy = s.proxy;
      // resultsUrl is DERIVED from the proxy base. The app embed hardcodes the
      // default subpath, so a merchant who changed it got working autocomplete
      // and a 404 from both "See all results" and the Enter key.
      cfg.resultsUrl = s.proxy.replace(/\/+$/, "") + "/results";
    }
    // Appearance → CSS variables
    var rs = document.documentElement.style;
    if (s.accentColor) rs.setProperty("--adsf-accent", s.accentColor);
    if (s.backgroundColor) rs.setProperty("--adsf-dd-bg", s.backgroundColor);
    if (s.textColor) rs.setProperty("--adsf-dd-text", s.textColor);
    if (s.highlightColor) rs.setProperty("--adsf-hl-color", s.highlightColor);
    if (s.fontSize) rs.setProperty("--adsf-dd-font-size", s.fontSize + "px");
    if (s.fontWeight) rs.setProperty("--adsf-dd-font-weight", s.fontWeight);
    if (s.gridColumns) rs.setProperty("--adsf-cols", String(s.gridColumns));
    return cfg;
  }

  // --- boot ---------------------------------------------------------------
  function boot() {
    var g = window.ADSF_CONFIG || {};
    var cfg = {
      proxy: g.proxy || "/apps/anotherdev-search",
      resultsUrl: g.resultsUrl || "/apps/anotherdev-search/results",
      moneyFormat: g.moneyFormat || "",
      minChars: g.minChars || 2,
      maxSuggestions: g.maxSuggestions || 8,
      showRecs: true,
      recentSearches: true,
      panelStyle: "spotlight",
      layout: "rich",
      previewSide: "left",
      autoAttach: g.autoAttach !== false,
      searchTakeover: true,
      collectionFilters: true,
      filterLayout: "sidebar",
      resultsPerPage: 24,
      gridColumns: 4,
      showVendor: false,
      quickAdd: false,
      swatches: {},
    };

    function start() {
      // Blocks the merchant placed explicitly always win over takeover.
      Array.prototype.forEach.call(document.querySelectorAll("[data-adsf-searchbar]"), function (n) {
        initSearchBar(n, cfg);
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-adsf-results-app]"), function (n) {
        initResultsApp(n, cfg);
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-adsf-recommend]"), function (n) {
        initRecommendations(n, cfg);
      });

      if (window.ADSF_CONFIG) {
        if (cfg.searchTakeover) takeoverSearchPage(cfg);
        if (cfg.collectionFilters) takeoverCollectionPage(cfg);
        if (cfg.autoAttach) {
          autoAttachSearch(cfg);
          setTimeout(function () { autoAttachSearch(cfg); }, 1200);
        }
      }
    }

    // App Embed path: appearance + behaviour come from the app admin. Without
    // the embed there is no config endpoint to call, so start immediately.
    if (window.ADSF_CONFIG) {
      fetch(cfg.proxy + "/config", { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (s) { applySettings(cfg, s || {}); })
        .catch(function () {})
        .then(function () { start(); });
    } else {
      start();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
