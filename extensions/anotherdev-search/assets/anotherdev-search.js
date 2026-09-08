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

  // Load exactly once.
  //
  // Every block emits its own <script src> tag, so a merchant running the app
  // embed AND placing a search bar gets this file executed twice: two dropdowns
  // fighting over the same input, two `document` click handlers, two requests
  // per keystroke, and — worst — two `track` beacons per click, which silently
  // doubled every product's popularity score. The browser fetches the file once
  // and runs it per tag, so the guard has to be here rather than in the Liquid.
  if (window.__adsfLoaded) return;
  window.__adsfLoaded = true;

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
    var k = "adsf_st";
    var v = "";
    try {
      v = localStorage.getItem(k) || "";
    } catch (e) {
      // Private browsing or storage disabled.
    }
    if (!v) {
      // Fall back to the cookie, so a shopper who cleared localStorage but not
      // cookies keeps the same id — and so the two never disagree.
      v = readCookie(k);
    }
    if (!v) {
      v = Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    try {
      localStorage.setItem(k, v);
    } catch (e) {
      // Nothing to do; the cookie below still carries it.
    }
    // Also a first-party cookie, and this is not redundant.
    //
    // The Web Pixel that attributes completed orders runs in Shopify's sandbox
    // on a DIFFERENT origin, so it cannot see this page's localStorage at all.
    // A cookie on the shop's own domain is the only thing both halves can read,
    // which is what lets a purchase find the search that caused it.
    writeCookie(k, v);
    return v;
  })();

  function readCookie(name) {
    try {
      var m = new RegExp("(?:^|;\\s*)" + name + "=([^;]+)").exec(document.cookie || "");
      return m ? decodeURIComponent(m[1]) : "";
    } catch (e) {
      return "";
    }
  }

  function writeCookie(name, value) {
    try {
      // Lax, not None: this is only ever read first-party, and Lax survives the
      // top-level navigation into checkout, which is exactly when it is needed.
      document.cookie =
        name + "=" + encodeURIComponent(value) +
        ";path=/;max-age=31536000;SameSite=Lax" +
        (location.protocol === "https:" ? ";Secure" : "");
    } catch (e) {
      // Cookies blocked — attribution degrades, nothing else does.
    }
  }

  /**
   * Products this shopper has looked at, newest first.
   *
   * Local only, capped, and never sent anywhere except as the input to a
   * recommendation request — so there is no profile stored on the server and
   * nothing to reconcile when a shopper clears their browser.
   */
  var VIEWED_KEY = "adsf_viewed";
  function recentlyViewed() {
    try {
      var list = JSON.parse(localStorage.getItem(VIEWED_KEY) || "[]");
      return Array.isArray(list) ? list.filter(function (v) { return /^\d+$/.test(String(v)); }) : [];
    } catch (e) {
      return [];
    }
  }
  function rememberViewed(productId) {
    var id = String(productId || "").trim();
    if (!/^\d+$/.test(id)) return;
    try {
      var list = recentlyViewed().filter(function (v) { return String(v) !== id; });
      list.unshift(id);
      localStorage.setItem(VIEWED_KEY, JSON.stringify(list.slice(0, 20)));
    } catch (e) {
      // Storage disabled — the rail falls back to best sellers server-side.
    }
  }

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

  // Monotonic id source for facet checkboxes. Deriving an id from the value
  // collided whenever two values normalised the same ("Red" / "Red!"), which
  // pointed a <label> at the wrong box.
  var facetUid = 0;

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
    // Empty query -> recommendation mode. A photo search also carries no term,
    // but it is a RESULT, not an idle panel, so it must not be labelled
    // "Popular products" or padded with this shopper's recent searches.
    var isVisual = !!data.visual;
    var isEmpty = !term && !isVisual;
    var hasProducts = data.products && data.products.length;
    var hasColl = data.collections && data.collections.length;
    var hasPages = data.pages && data.pages.length;
    var recent = isEmpty && cfg.recentSearches !== false ? recentSearches() : [];
    var suggestions = (data.suggestions || []).slice();
    var hasSugg = suggestions.length || recent.length;

    if (!hasProducts && !hasColl && !hasPages && !hasSugg) {
      dropdown.classList.remove("adsf-dropdown--rich");
      dropdown.appendChild(el("div", "adsf-dropdown__empty",
        isVisual
          ? "Nothing in the catalog looks like that photo"
          : isEmpty
            ? "Start typing to search"
            : "No matches for “" + esc(term) + "”"));
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
      var pg = section(isVisual ? "Closest matches" : isEmpty ? "Popular products" : "Products");
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

    if (!isEmpty && !isVisual) {
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
  /**
   * Go to the results page for a term.
   *
   * Shared by the Enter key and the form submit so the two can never disagree
   * about where a search goes.
   */
  function goToResults(cfg, term) {
    var q = String(term || "").trim();
    if (!q) return false;
    rememberSearch(q);
    var base = (cfg && cfg.resultsUrl) || "/apps/anotherdev-search/results";
    location.assign(base + "?q=" + encodeURIComponent(q));
    return true;
  }

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
        } else if (ctx.cfg && ctx.cfg.searchTakeover !== false) {
          // Navigate from here rather than relying on the form submitting:
          // themes routinely intercept submit on their own search component,
          // which left the shopper sitting on the page they were already on.
          if (goToResults(ctx.cfg, input.value)) e.preventDefault();
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
  /** Has this element already been wired up? Guards every init entry point. */
  function claim(node) {
    if (node.getAttribute("data-adsf-init")) return false;
    node.setAttribute("data-adsf-init", "1");
    return true;
  }

  function initSearchBar(root, globalCfg) {
    if (!claim(root)) return;
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
    // From the merchant's setting, not from an attribute nothing ever writes.
    // `data-recommendations` is not rendered by search-bar.liquid, so this was
    // permanently true and "Show recommendations when the box is empty" did
    // nothing at all for the block — only for the auto-attached theme input.
    var showRecs = cfg.showRecs !== false;

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
    ctx.cfg = cfg;
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

    attachVoiceSearch(input, "inline", cfg, function () {
      run();
    });
    attachImageSearch(input, "inline", cfg, function (data) {
      render(data, "");
    });

    document.addEventListener("click", function (e) {
      if (!root.contains(e.target)) ctx.close();
    });
  }

  /**
   * Speak instead of type.
   *
   * More than half of storefront traffic is a phone, where typing "merino wool
   * crew neck" is the slowest part of the whole journey. The Web Speech API is
   * built into the browser, so this costs nothing and ships no dependency —
   * and when the browser does not have it, no button is rendered at all rather
   * than one that does nothing.
   */
  function attachVoiceSearch(input, mode, cfg, onResult) {
    var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition || input.getAttribute("data-adsf-voice")) return;
    if (cfg && cfg.voiceSearch === false) return;
    input.setAttribute("data-adsf-voice", "1");

    var btn = el("button", "adsf-voice");
    btn.type = "button";
    btn.setAttribute("aria-label", "Search by voice");
    btn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
      '<rect x="7" y="2" width="6" height="10" rx="3" stroke="currentColor" stroke-width="2"/>' +
      '<path d="M4 9a6 6 0 0 0 12 0M10 15v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

    if (mode === "inline") {
      // Our own block: the markup is ours, so the button can sit in the flow.
      var mount = input.parentNode;
      if (!mount) return;
      mount.insertBefore(btn, input.nextSibling);
    } else {
      // The theme's own search box. Injecting into a theme's markup is how you
      // break someone's header, so the button floats over the input instead:
      // fixed position, placed from the input's rect, kept there by the same
      // scroll/resize handling the dropdown already uses. Nothing in the
      // theme's DOM is touched.
      btn.classList.add("adsf-voice--floating");
      document.body.appendChild(btn);
      var place = function () {
        var r = input.getBoundingClientRect();
        // A box too small to have spared the room, or scrolled out of view.
        var visible = r.width > 120 && r.height > 20 && r.bottom > 0 && r.top < window.innerHeight;
        btn.hidden = !visible;
        if (!visible) return;
        btn.style.top = r.top + (r.height - 28) / 2 + "px";
        btn.style.left = r.right - 34 + "px";
      };
      place();
      var reposition = rafThrottle(place);
      window.addEventListener("resize", reposition);
      window.addEventListener("scroll", reposition, true);
    }

    var recognition = null;
    var listening = false;

    btn.addEventListener("click", function () {
      if (listening && recognition) {
        recognition.stop();
        return;
      }
      try {
        recognition = new Recognition();
      } catch (e) {
        btn.remove();
        return;
      }
      recognition.lang = document.documentElement.lang || "en";
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = function () {
        listening = true;
        btn.classList.add("is-listening");
        btn.setAttribute("aria-label", "Stop listening");
      };
      recognition.onresult = function (event) {
        var text = "";
        for (var i = event.resultIndex; i < event.results.length; i++) {
          text += event.results[i][0].transcript;
        }
        input.value = text.trim();
        // Let the theme's own listeners see the change too.
        input.dispatchEvent(new Event("input", { bubbles: true }));
        if (event.results[event.results.length - 1].isFinal) onResult();
      };
      var stop = function () {
        listening = false;
        btn.classList.remove("is-listening");
        btn.setAttribute("aria-label", "Search by voice");
      };
      recognition.onend = stop;
      // A denied microphone permission must leave the box usable, not stuck.
      recognition.onerror = stop;

      try {
        recognition.start();
      } catch (e) {
        stop();
      }
    });
  }

  // =======================================================================
  //  2. Faceted results application
  // =======================================================================
  /* ---- Adding to cart the way the theme does ----------------------------
   *
   * The old version POSTed JSON to a hardcoded "/cart/add.js" and then fired
   * two guessed events. That worked on a plain English-only Dawn store and
   * quietly failed everywhere else:
   *
   *   - a locale-prefixed storefront (/fr/...) needs the localised route, so
   *     the hardcoded path added to the wrong cart or 404ed;
   *   - a JSON body carries no form_type, which is the field most cart apps
   *     and slide-out drawers key off to notice an add;
   *   - nothing re-rendered the drawer, so the cart bubble stayed stale until
   *     the shopper navigated.
   *
   * So instead of inventing a request, we copy the one the theme already
   * makes: same route, same form fields, same headers, plus bundled section
   * rendering so the theme re-renders its own cart markup. */

  /** Locale-aware storefront root: "/" or "/fr/" on a translated store. */
  function routeRoot() {
    var r =
      window.Shopify && window.Shopify.routes && window.Shopify.routes.root;
    if (!r) return "/";
    return r.charAt(r.length - 1) === "/" ? r : r + "/";
  }

  /** The theme’s own add-to-cart URL when it publishes one, else the route. */
  function cartAddUrl() {
    var themeRoute =
      (window.routes && window.routes.cart_add_url) ||
      (window.theme && window.theme.routes && window.theme.routes.cart_add_url) ||
      (window.Shopify &&
        window.Shopify.routes &&
        window.Shopify.routes.cart_add_url);
    if (themeRoute) {
      return String(themeRoute).indexOf(".js") > -1 ? themeRoute : themeRoute + ".js";
    }
    return routeRoot() + "cart/add.js";
  }

  /**
   * The hidden fields the theme puts in its own product form.
   *
   * Shopify itself only needs id and quantity, but form_type and utf8 are what
   * a third-party cart app looks for to recognise an add as a real product-form
   * submission. Copying them from the live form means we match whatever this
   * theme sends, instead of hardcoding Dawn’s answer for every theme.
   */
  function themeFormFields() {
    var out = { form_type: "product", utf8: "✓" };
    var form = document.querySelector('form[action*="/cart/add"]');
    if (!form) return out;
    Array.prototype.forEach.call(
      form.querySelectorAll('input[type="hidden"]'),
      function (input) {
        var name = input.getAttribute("name");
        // id and quantity are per-product and set by the caller; properties
        // belong to the product that form was rendered for, not to ours.
        if (!name || name === "id" || name === "quantity") return;
        if (name.indexOf("properties[") === 0) return;
        out[name] = input.value;
      },
    );
    return out;
  }

  /* Elements that mean "this theme has a cart drawer". Attribute and tag based
     rather than class based: class names are theme-specific, but a custom
     element name or an id survives reskinning. */
  var CART_HOSTS = [
    "cart-drawer",
    "cart-notification",
    "#CartDrawer",
    "#cart-drawer",
    "#CartNotification",
    "[id*='cart-drawer' i]",
    "[data-cart-drawer]",
    "#cart-icon-bubble",
    ".cart-count-bubble",
    "[data-cart-count]",
  ];

  /** Section ids of everything on the page that renders cart state, max five. */
  function cartSectionIds() {
    var ids = [];
    CART_HOSTS.forEach(function (sel) {
      var nodes;
      try { nodes = document.querySelectorAll(sel); } catch (e) { return; }
      Array.prototype.forEach.call(nodes, function (node) {
        var section = node.closest ? node.closest('[id^="shopify-section-"]') : null;
        if (!section) return;
        var id = section.id.replace("shopify-section-", "");
        // Bundled section rendering accepts at most five.
        if (id && ids.indexOf(id) < 0 && ids.length < 5) ids.push(id);
      });
    });
    return ids;
  }

  /**
   * Swap in the cart markup the server just rendered.
   *
   * innerHTML does not run <script> tags, but every modern theme wraps its
   * drawer in a custom element, and inserting one runs connectedCallback —
   * which is how the theme rebinds its own behaviour. That is the mechanism
   * Shopify’s own docs point at, so we do not try to re-run anything ourselves.
   */
  function applyCartSections(sections) {
    if (!sections) return;
    Object.keys(sections).forEach(function (id) {
      var html = sections[id];
      if (typeof html !== "string") return; // a bad id comes back as null
      var host = document.getElementById("shopify-section-" + id);
      if (host) host.innerHTML = html;
    });
  }

  /* Events themes and cart apps listen for. Dispatching the union is safe:
     a theme that does not know an event simply never hears it, and the cost of
     one extra CustomEvent is nothing next to a cart that never opens. */
  var CART_EVENTS = [
    "cart:refresh",
    "cart:build",
    "cart:updated",
    "cart:added",
    "cart-drawer:open",
    "ajaxProduct:added",
    "product:added-to-cart",
  ];

  /** Ask the theme to show its cart, without guessing at class names. */
  function openThemeCart(detail) {
    CART_EVENTS.forEach(function (name) {
      document.dispatchEvent(
        new CustomEvent(name, { bubbles: true, detail: detail || {} }),
      );
    });
    // Dawn and its forks expose the drawer as a custom element with open().
    var drawer =
      document.querySelector("cart-drawer") ||
      document.querySelector("cart-notification");
    if (drawer && typeof drawer.open === "function") {
      try { drawer.open(); return true; } catch (e) { /* fall through */ }
    }
    // Otherwise click the theme’s own drawer toggle if it published one. Only
    // attribute hooks, never an <a href="/cart">: clicking that would navigate
    // away from the results the shopper is still browsing.
    var toggle = document.querySelector(
      "[data-cart-drawer-toggle], [data-drawer-open='cart'], [aria-controls='CartDrawer']",
    );
    if (toggle) { toggle.click(); return true; }
    return false;
  }
  /** The merchant’s add-to-cart wording, falling back to the default. */
  function addLabel(cfg) {
    return (cfg && cfg.cardButtonLabel) || "Add to cart";
  }

  function initResultsApp(root, globalCfg) {
    if (!claim(root)) return;
    // The facet UI is presented four ways; the stylesheet does the work, so
    // switching layout is one class rather than four render paths.
    var layout = (globalCfg && globalCfg.filterLayout) || "sidebar";
    root.classList.add("adsf-app--filters-" + layout);

    // A dropdown that only closes by clicking its own button is a trap on a
    // phone, where the button may have scrolled out of view.
    if (layout === "topbar") {
      document.addEventListener("click", function (e) {
        // e.target is an Element for any real click, but a synthetic event can
        // carry a document or a text node, and closest() does not exist there.
        var t = e.target && e.target.nodeType === 1 ? e.target : null;
        if (!t || !root.contains(t) || !t.closest(".adsf-facet")) closeAllFacets();
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closeAllFacets();
      });
    }
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
          ? '<button type="button" class="adsf-card__add' +
            (cfg.cardButtonFullWidth === false ? "" : " adsf-card__add--full") +
            '" data-adsf-add="' + esc(p.variantId) +
            '" data-adsf-add-product="' + esc(p.productId) + '">' +
            esc(addLabel(cfg)) + "</button>"
          : "") +
        "</article>";
    }

    /**
     * Add to cart without leaving the results, by making the same request the
     * theme’s own product form makes — see the cart helpers at the top of this
     * file for why the shape of the request matters.
     */
    function bindQuickAdd() {
      Array.prototype.forEach.call(grid.querySelectorAll("[data-adsf-add]"), function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-adsf-add");
          btn.disabled = true;
          btn.textContent = "Adding…";

          // Built as FormData, not JSON, because this is the shape a product
          // form submits and the shape cart apps recognise.
          var body = new FormData();
          var fields = themeFormFields();
          Object.keys(fields).forEach(function (k) { body.append(k, fields[k]); });
          body.append("id", id);
          body.append("quantity", "1");

          // Ask the server to re-render the theme’s own cart markup in the same
          // round trip, so the drawer and the count bubble are correct the
          // moment we open them.
          var sections = cartSectionIds();
          if (sections.length) {
            body.append("sections", sections.join(","));
            body.append("sections_url", location.pathname + location.search);
          }

          fetch(cartAddUrl(), {
            method: "POST",
            // No Content-Type: the browser must set the multipart boundary.
            // X-Requested-With is what several cart apps sniff for an AJAX add.
            headers: {
              Accept: "application/javascript",
              "X-Requested-With": "XMLHttpRequest",
            },
            body: body,
          })
            .then(function (r) { if (!r.ok) throw new Error("add failed"); return r.json(); })
            .then(function (data) {
              btn.textContent = "Added";
              track(cfg.proxy, "add_to_cart", state.term, btn.getAttribute("data-adsf-add-product"));
              applyCartSections(data && data.sections);
              openThemeCart({ id: id, quantity: 1, source: "anotherdev-search" });
              setTimeout(function () { btn.disabled = false; btn.textContent = addLabel(cfg); }, 2500);
            })
            .catch(function () {
              btn.textContent = "Unavailable";
              setTimeout(function () { btn.disabled = false; btn.textContent = addLabel(cfg); }, 2500);
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

    /**
     * One-click shortcuts the merchant defined ("Under 50", "New in").
     *
     * Rendered above the removable chips and only while nothing is narrowed:
     * once a shopper is filtering, the chips below are the controls that matter
     * and a second row of them is just noise.
     */
    function renderPresets() {
      if (!chips || hasActiveFilters()) return;
      var presets = (cfg.presets || []).slice(0, 12);
      if (!presets.length) return;
      presets.forEach(function (preset) {
        if (!preset || !preset.label || !preset.params) return;
        var b = el("button", "adsf-chip adsf-chip--preset");
        b.type = "button";
        b.textContent = preset.label;
        b.addEventListener("click", function () {
          var sp;
          try {
            sp = new URLSearchParams(String(preset.params).replace(/^[?&]/, ""));
          } catch (e) {
            return;
          }
          var filters = {};
          var min = null;
          var max = null;
          var sort = state.sort;
          sp.forEach(function (v, k) {
            if (k.indexOf("f.") === 0) (filters[k.slice(2)] = filters[k.slice(2)] || []).push(v);
            else if (k === "price.min") min = v;
            else if (k === "price.max") max = v;
            else if (k === "sort") sort = v;
          });
          state.filters = filters;
          state.priceMin = min;
          state.priceMax = max;
          state.sort = sort;
          state.page = 1;
          apply(true);
        });
        chips.appendChild(b);
      });
    }

    /** Removable chips for everything currently applied. */
    function renderChips() {
      if (!chips) return;
      chips.innerHTML = "";
      if (!hasActiveFilters()) {
        renderPresets();
        return;
      }

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

      // "Toolbar" is a row of dropdowns, not a row of open lists.
      //
      // It used to render exactly like "inline" — every facet expanded, side
      // by side — so the two settings were indistinguishable, and opening or
      // closing one pushed the product grid up and down the page. Toolbar now
      // starts closed and opens over the grid; inline stays permanently open.
      var asDropdown = layout === "topbar";

      facets.forEach(function (f) {
        var group = el("div", "adsf-facet");
        var heading = el("h4", "adsf-facet__title");
        var btn = el("button", "adsf-facet__toggle");
        btn.type = "button";
        btn.setAttribute("aria-expanded", asDropdown ? "false" : "true");
        btn.textContent = f.label;
        heading.appendChild(btn);
        group.appendChild(heading);

        var bodyWrap = el("div", "adsf-facet__body");
        bodyWrap.hidden = asDropdown;
        btn.addEventListener("click", function () {
          var open = btn.getAttribute("aria-expanded") === "true";
          // One open at a time in the toolbar: two overlapping panels on the
          // same row cover each other.
          if (asDropdown && !open) closeAllFacets();
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

    /** Collapse every open facet panel. Only meaningful in the toolbar. */
    function closeAllFacets() {
      var open = facetsInner.querySelectorAll(
        '.adsf-facet__toggle[aria-expanded="true"]',
      );
      Array.prototype.forEach.call(open, function (b) {
        b.setAttribute("aria-expanded", "false");
        var body = b.closest(".adsf-facet");
        body = body && body.querySelector(".adsf-facet__body");
        if (body) body.hidden = true;
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

      // "change" rather than "input": it fires on blur and on Enter, so a
      // half-typed number never triggers a request, and the merchant never
      // needed a button to say "I meant it".
      function commitRange() {
        var nextMin = min.value || null;
        var nextMax = max.value || null;
        if (nextMin === state.priceMin && nextMax === state.priceMax) return;
        state.priceMin = nextMin;
        state.priceMax = nextMax;
        state.page = 1;
        apply(true);
      }
      min.addEventListener("change", commitRange);
      max.addEventListener("change", commitRange);
      // Enter inside a number field submits the surrounding form in some
      // themes, which would reload the page and lose the filter state.
      function onKey(e) {
        if (e.key !== "Enter") return;
        e.preventDefault();
        commitRange();
      }
      min.addEventListener("keydown", onKey);
      max.addEventListener("keydown", onKey);

      var row = el("div", "adsf-facet__rangerow");
      row.appendChild(min);
      row.appendChild(el("span", "adsf-facet__dash", "–"));
      row.appendChild(max);
      wrap.appendChild(row);
      if (hi > lo) wrap.appendChild(slider);
      return wrap;
    }

    // How many values a facet shows before it needs "show more". Fifty open
    // checkboxes per facet, six facets deep, is a sidebar nobody reads.
    var FACET_VISIBLE = 8;
    // Above this, scanning the list is slower than typing what you want.
    var FACET_SEARCHABLE = 12;

    function listFacet(f) {
      var wrap = el("div", "adsf-facet__values");
      var list = el("ul", "adsf-facet__list");
      var selected = state.filters[f.source] || [];
      var rows = [];

      // Selected values first: after narrowing, what you chose must not be
      // hidden behind "show more".
      var ordered = f.values.slice().sort(function (a, b) {
        var aSel = selected.indexOf(a.value) >= 0 ? 0 : 1;
        var bSel = selected.indexOf(b.value) >= 0 ? 0 : 1;
        return aSel - bSel;
      });

      ordered.forEach(function (v, index) {
        var li = el("li", "adsf-facet__item" + (f.displayAs === "swatch" ? " adsf-facet__item--swatch" : ""));
        // Unique per row, not derived from the value.
        //
        // Stripping non-alphanumerics collapsed "Red" and "Red!" (and "X L" and
        // "XL") to the same id, so the <label> pointed at the wrong checkbox and
        // clicking one toggled the other.
        var id = "adsf_" + facetUid++;
        var checked = selected.indexOf(v.value) >= 0;
        var cb = el("input");
        cb.type = "checkbox"; cb.id = id; cb.checked = checked; cb.value = v.value;
        cb.addEventListener("change", function () { toggleFilter(f.source, v.value, cb.checked); });
        var lbl = el("label");
        lbl.setAttribute("for", id);
        if (f.displayAs === "swatch") {
          lbl.innerHTML = '<span class="adsf-swatch" style="' + swatchStyle(v.value, v, cfg) + '" title="' + esc(v.label) + '"></span>';
        }
        var count = cfg.showFacetCounts === false
          ? ""
          : ' <span class="adsf-facet__count">' + v.count + "</span>";
        lbl.insertAdjacentHTML("beforeend", '<span class="adsf-facet__label">' + esc(v.label) + "</span>" + count);
        li.appendChild(cb); li.appendChild(lbl);
        list.appendChild(li);
        rows.push({ li: li, text: String(v.label || v.value).toLowerCase(), index: index });
      });

      // Type to narrow the list. Only where it earns its space: on a facet with
      // five values a search box is noise.
      var query = "";
      var expanded = false;

      if (f.values.length > FACET_SEARCHABLE) {
        var finder = el("input", "adsf-facet__find");
        finder.type = "search";
        finder.placeholder = "Filter " + f.label.toLowerCase();
        finder.setAttribute("aria-label", "Filter " + f.label + " options");
        finder.addEventListener("input", function () {
          query = finder.value.trim().toLowerCase();
          // Typing is an explicit request to see everything that matches.
          if (query) expanded = true;
          applyVisibility();
        });
        wrap.appendChild(finder);
      }

      wrap.appendChild(list);

      var more = null;
      if (f.values.length > FACET_VISIBLE) {
        more = el("button", "adsf-facet__more");
        more.type = "button";
        more.addEventListener("click", function () {
          expanded = !expanded;
          applyVisibility();
        });
        wrap.appendChild(more);
      }

      function applyVisibility() {
        var shown = 0;
        rows.forEach(function (row) {
          var matches = !query || row.text.indexOf(query) >= 0;
          var withinLimit = expanded || shown < FACET_VISIBLE;
          var visible = matches && withinLimit;
          row.li.hidden = !visible;
          if (matches) shown++;
        });
        if (more) {
          var hiddenCount = Math.max(0, shown - FACET_VISIBLE);
          more.hidden = !expanded && hiddenCount === 0;
          more.textContent = expanded ? "Show less" : "Show " + hiddenCount + " more";
          more.setAttribute("aria-expanded", String(expanded));
        }
      }

      applyVisibility();
      return wrap;
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
    if (!claim(root)) return;
    var cfg = Object.assign({}, globalCfg || {}, {
      proxy: root.getAttribute("data-proxy") || (globalCfg && globalCfg.proxy) || "/apps/anotherdev-search",
      moneyFormat: root.getAttribute("data-money-format") || (globalCfg && globalCfg.moneyFormat),
    });
    var kind = root.getAttribute("data-kind") || "related";
    var productId = root.getAttribute("data-product-id") || "";
    var collection = root.getAttribute("data-collection") || "";
    var limit = parseInt(root.getAttribute("data-limit") || "8", 10);
    var track_ = root.querySelector("[data-adsf-rec-track]") || root;

    // A product page is where "recently viewed" is worth recording: it is the
    // strongest statement of interest a shopper makes without buying.
    if (productId) rememberViewed(productId);

    var qs = "kind=" + encodeURIComponent(kind) + "&limit=" + limit +
      (productId ? "&productId=" + encodeURIComponent(productId) : "") +
      (collection ? "&collection=" + encodeURIComponent(collection) : "");

    // The personalised rail is built from what THIS shopper has looked at, so
    // the ids travel with the request. Nothing is stored server-side.
    if (kind === "personalized") {
      var seen = recentlyViewed();
      if (seen.length) qs += "&seen=" + encodeURIComponent(seen.join(","));
    }

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
    ctx.cfg = cfg;
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
    // Bind once per FORM, not once per input. A theme with a desktop and a
    // mobile box in one form got a handler per input, each closing over its own
    // value, so a stale box could win and search for something never typed.
    if (form && !form.getAttribute("data-adsf-form")) {
      form.setAttribute("data-adsf-form", "1");
      form.addEventListener("submit", function (e) {
        var boxes = form.querySelectorAll(ADSF_SEARCH_SELECTOR);
        var chosen = null;
        for (var i = 0; i < boxes.length; i++) {
          if (boxes[i] === document.activeElement) { chosen = boxes[i]; break; }
          if (!chosen && String(boxes[i].value || "").trim()) chosen = boxes[i];
        }
        var term = String((chosen || input).value || "").trim();
        if (cfg.searchTakeover === false) { rememberSearch(term); return; }
        if (goToResults(cfg, term)) e.preventDefault();
      });
    }

    attachVoiceSearch(input, "floating", cfg, function () {
      run();
    });
    attachImageSearch(input, "floating", cfg, function (data) {
      render(data, "");
    });

    var reposition = rafThrottle(function () { if (!dropdown.hidden) place(); });
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("click", function (e) {
      // The mic sits over the theme's input, so a click on it must not be read
      // as a click away from the panel.
      if (e.target !== input && !dropdown.contains(e.target) &&
          !(e.target.closest && e.target.closest(".adsf-voice"))) ctx.close();
    });
  }

  /**
   * Search by photo.
   *
   * A shopper who has seen something and cannot name it has no way to search for
   * it — this gives them one. The button is only rendered once the server has
   * confirmed the shop can actually serve it (Pro, a multimodal provider, and
   * pgvector), so it never appears as a control that does nothing.
   *
   * The photo is downscaled in the browser before it is sent: a modern phone
   * camera produces several megabytes, the model uses a fraction of that, and
   * the shopper is on mobile data.
   */
  var visualAvailable = null;
  function checkVisualSearch(cfg) {
    // Tri-state on purpose: null means "not asked yet", so an explicit false is
    // remembered and the shop is not probed again on every focus.
    if (visualAvailable === true || visualAvailable === false) {
      return Promise.resolve(visualAvailable);
    }
    return fetch(cfg.proxy + "/visual", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        visualAvailable = !!(d && d.available);
        return visualAvailable;
      })
      .catch(function () {
        visualAvailable = false;
        return false;
      });
  }

  /** Downscale to at most `max` on the long edge and re-encode as JPEG. */
  function shrinkImage(file, max) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, max / Math.max(img.width, img.height));
          var canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        } catch (e) {
          reject(e);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("unreadable image"));
      };
      img.src = url;
    });
  }

  function attachImageSearch(input, mode, cfg, render) {
    if (input.getAttribute("data-adsf-visual")) return;
    input.setAttribute("data-adsf-visual", "1");

    checkVisualSearch(cfg).then(function (ok) {
      if (!ok) return;

      var file = el("input");
      file.type = "file";
      file.accept = "image/*";
      // `capture` opens the camera directly on a phone, which is where this is
      // used; on a desktop the attribute is ignored and it is a file picker.
      file.setAttribute("capture", "environment");
      file.className = "adsf-visually-hidden";

      var btn = el("button", "adsf-camera" + (mode === "floating" ? " adsf-camera--floating" : ""));
      btn.type = "button";
      btn.setAttribute("aria-label", "Search with a photo");
      btn.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
        '<rect x="2" y="5" width="16" height="12" rx="2" stroke="currentColor" stroke-width="2"/>' +
        '<circle cx="10" cy="11" r="3" stroke="currentColor" stroke-width="2"/>' +
        '<path d="M7 5l1.2-2h3.6L13 5" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

      if (mode === "floating") {
        document.body.appendChild(btn);
        var place = function () {
          var r = input.getBoundingClientRect();
          var visible = r.width > 150 && r.height > 20 && r.bottom > 0 && r.top < window.innerHeight;
          btn.hidden = !visible;
          if (!visible) return;
          btn.style.top = r.top + (r.height - 28) / 2 + "px";
          // Sits inboard of the microphone, which claims the rightmost slot.
          btn.style.left = r.right - 66 + "px";
        };
        place();
        var reposition = rafThrottle(place);
        window.addEventListener("resize", reposition);
        window.addEventListener("scroll", reposition, true);
      } else if (input.parentNode) {
        input.parentNode.insertBefore(btn, input.nextSibling);
      } else {
        return;
      }
      document.body.appendChild(file);

      btn.addEventListener("click", function () { file.click(); });

      file.addEventListener("change", function () {
        var chosen = file.files && file.files[0];
        if (!chosen) return;
        btn.classList.add("is-busy");
        shrinkImage(chosen, 640)
          .then(function (dataUrl) {
            return fetch(cfg.proxy + "/visual", {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ image: dataUrl, limit: cfg.maxSuggestions || 8 }),
            });
          })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            render({
              products: (d && d.products) || [],
              suggestions: [],
              collections: [],
              pages: [],
              // Tells the panel this is a photo result, so it does not label an
              // empty term as "Popular products" and offer recent searches.
              visual: true,
            });
          })
          .catch(function () {
            // Nothing to show and nothing to explain — the shopper still has the
            // box they were typing in.
          })
          .then(function () {
            btn.classList.remove("is-busy");
            // Let the same photo be picked twice in a row.
            file.value = "";
          });
      });
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
  //  Collection facets over the THEME’s own grid
  // =======================================================================
  //
  // Renders our facet UI and lets the theme keep rendering its product cards.
  //
  // How: facet values and counts come from our index, but a selection is
  // expressed as Shopify’s native storefront filter params and handed back to
  // the theme through the Section Rendering API. The theme re-renders its own
  // section, with its own cards, in its own Liquid context.
  //
  // The trade-off is real: this path can only express what Shopify’s native
  // filtering understands, and those params are ignored unless the merchant has
  // enabled the matching filters under Storefront filters. It also cannot apply
  // synonyms, typo tolerance or merchandising — none of which matter here,
  // because a collection page has no search term to be relevant to.

  // The Shopify param a facet maps to, or null when there is no equivalent.
  function paramForSource(source) {
    if (source === "vendor") return "filter.p.vendor";
    if (source === "productType") return "filter.p.product_type";
    if (source === "tag") return "filter.p.tag";
    if (source === "availability") return "filter.v.availability";
    if (source === "price") return "filter.v.price.gte";
    if (source.indexOf("option:") === 0) {
      return "filter.v.option." + source.slice(7).toLowerCase();
    }
    if (source.indexOf("metafield:") === 0) return "filter.p.m." + source.slice(10);
    return null;
  }

  /**
   * The filter params this storefront actually supports.
   *
   * Section Rendering only applies filters the merchant has enabled under
   * Storefront filters; anything else is silently ignored, so a facet we render
   * for it looks broken. The theme prints its own enabled filters as inputs
   * named filter.*, so reading those tells us exactly what will work.
   *
   * Returns null when the theme exposes none, which means "cannot tell" rather
   * than "none supported" — we show everything rather than hide the whole bar.
   */
  function themeFilterParams() {
    var found = {};
    var n = 0;
    var nodes = document.querySelectorAll('[name^="filter."]');
    Array.prototype.forEach.call(nodes, function (el) {
      var name = el.getAttribute("name") || "";
      // Price arrives as filter.v.price.gte / .lte; treat them as one.
      var key = name.indexOf("filter.v.price") === 0 ? "filter.v.price.gte" : name;
      if (!found[key]) { found[key] = true; n++; }
    });
    return n ? found : null;
  }

  // Our facet source -> Shopify storefront filter parameter.
  function shopifyFilterParams(state) {
    var sp = new URLSearchParams();
    Object.keys(state.filters).forEach(function (source) {
      (state.filters[source] || []).forEach(function (v) {
        if (source === "vendor") sp.append("filter.p.vendor", v);
        else if (source === "productType") sp.append("filter.p.product_type", v);
        else if (source === "tag") sp.append("filter.p.tag", v);
        else if (source === "availability") {
          sp.append("filter.v.availability", v === "in_stock" ? "1" : "0");
        } else if (source.indexOf("option:") === 0) {
          sp.append("filter.v.option." + source.slice(7).toLowerCase(), v);
        } else if (source.indexOf("metafield:") === 0) {
          sp.append("filter.p.m." + source.slice(10), v);
        }
      });
    });
    if (state.priceMin) sp.set("filter.v.price.gte", state.priceMin);
    if (state.priceMax) sp.set("filter.v.price.lte", state.priceMax);
    if (state.sort) sp.set("sort_by", state.sort);
    return sp;
  }

  // The theme section wrapping the grid, e.g. shopify-section-template--1__grid.
  function sectionIdFor(node) {
    var wrap = node && node.closest ? node.closest("[id^='shopify-section-']") : null;
    if (!wrap) return null;
    return { id: wrap.id.replace(/^shopify-section-/, ""), el: wrap };
  }

  /**
   * How many products a rendered grid contains.
   *
   * Counted structurally rather than by class name: a product is commonly an
   * <li class="grid__item"> wrapping a .card-wrapper, and a combined class
   * selector counted the same product two or three times.
   */
  function countProducts(root) {
    if (!root) return 0;
    // Direct children holding a product link. Counting by class name matched
    // nested wrappers and reported two or three per product.
    var n = productChildCount(root);
    if (n) return n;
    // Some themes wrap the items one level deeper than the node we swapped.
    for (var i = 0; i < root.children.length; i++) {
      n = productChildCount(root.children[i]);
      if (n > 1) return n;
    }
    return root.querySelectorAll(PRODUCT_LINK).length ? 1 : 0;
  }

  /**
   * Hide the theme’s own filter UI, whatever it is called.
   *
   * The CSS list of known containers (.facets-container, #FacetFiltersForm …)
   * only covers themes someone tested. Every theme that supports storefront
   * filtering renders inputs named filter.*, so the smallest element wrapping
   * those is the filter UI. Guarded so it can never hide the grid itself —
   * that mistake is what made the search box disappear once already.
   */
  function hideThemeFacets(grid) {
    var inputs = document.querySelectorAll('[name^="filter."]');
    Array.prototype.forEach.call(inputs, function (input) {
      var node = input.closest("form") || input.parentNode;
      if (!node || node.nodeType !== 1) return;
      if (node.hasAttribute && node.hasAttribute("data-adsf-themegrid")) return;
      if (node.contains && grid && node.contains(grid)) return; // holds the products
      if (node.querySelector && node.querySelector("[data-adsf-themegrid]")) return;
      node.setAttribute("data-adsf-hidden-facets", "");
    });
  }

  /**
   * Force the theme’s collection grid to a column count, when asked to.
   *
   * Re-applied after every swap, not just once: the grid element is replaced
   * wholesale by the Section Rendering response, so a class set on the
   * original node is gone the first time a filter is used.
   */
  function applyCollectionColumns(cfg, node) {
    if (!node) return;
    // The shell places its children explicitly, so the grid needs a hook of
    // its own. Set here rather than once at init because the Section
    // Rendering response replaces this element outright.
    node.classList.add("adsf-themegrid__products");
    if (!cfg || !cfg.collectionColumnsEnabled) return;
    node.classList.add("adsf-collection-cols");
    node.style.setProperty("--adsf-coll-cols", String(cfg.collectionColumns || 4));
    node.style.setProperty(
      "--adsf-coll-cols-mobile",
      String(cfg.collectionColumnsMobile || 2),
    );
  }

  function initThemeGridFacets(cfg, handle, grid, preloadedFacets) {
    var section = sectionIdFor(grid);
    if (!section) return false;
    if (document.querySelector("[data-adsf-themegrid]")) return false;

    // Honour the merchant's Filter layout choice instead of always going
    // horizontal. "sidebar" wraps the theme's grid in two columns so the
    // filters sit beside it, open, the way most storefronts present them.
    var layout = cfg.filterLayout || "sidebar";
    applyCollectionColumns(cfg, grid);
    var panel = el(
      "div",
      "adsf-app adsf-themegrid adsf-app--filters-" + layout,
    );
    panel.setAttribute("data-adsf-themegrid", "");
    panel.innerHTML =
      '<div class="adsf-app__topbar">' +
      '<button type="button" class="adsf-app__filter-toggle" data-adsf-filter-toggle aria-expanded="false">Filters</button>' +
      '<div class="adsf-app__meta" data-adsf-meta aria-live="polite"></div>' +
      '<label class="adsf-app__sort"><span class="adsf-visually-hidden">Sort by</span>' +
      '<select data-adsf-sort>' +
      '<option value="">Featured</option>' +
      '<option value="best-selling">Best selling</option>' +
      '<option value="title-ascending">Alphabetically, A-Z</option>' +
      '<option value="title-descending">Alphabetically, Z-A</option>' +
      '<option value="price-ascending">Price, low to high</option>' +
      '<option value="price-descending">Price, high to low</option>' +
      '<option value="created-descending">Date, new to old</option>' +
      '<option value="created-ascending">Date, old to new</option>' +
      "</select></label>" +
      "</div>" +
      '<div class="adsf-app__chips" data-adsf-chips></div>' +
      '<aside class="adsf-facets" data-adsf-facets aria-label="Filters">' +
      '<div class="adsf-facets__heading">Filters</div>' +
      '<div class="adsf-facets__inner" data-adsf-facets-inner></div></aside>';
    // Mounted inside the theme's page container, next to the grid, so it
    // inherits page width and padding. Inserting before the whole section
    // put it outside that container and it ran full-bleed.
    if (layout === "sidebar") {
      // Wrap the grid so filters can sit in their own column beside it.
      // Sidebar only: "inline" promises facets stacked ABOVE the grid, and
      // sharing this branch made it a second, identical sidebar.
      var shell = el("div", "adsf-themegrid__shell");
      if (cfg.collectionWidthEnabled) {
        // Overriding the theme’s container rather than living inside it.
        shell.classList.add("adsf-themegrid__shell--width");
        shell.style.setProperty(
          "--adsf-coll-max",
          (cfg.collectionMaxWidth || 1400) + "px",
        );
        shell.style.setProperty(
          "--adsf-coll-pad",
          (cfg.collectionSidePadding == null ? 24 : cfg.collectionSidePadding) + "px",
        );
      }
      grid.parentNode.insertBefore(shell, grid);
      shell.appendChild(panel);
      shell.appendChild(grid);
    } else {
      grid.parentNode.insertBefore(panel, grid);
    }
    document.body.classList.add("adsf-collection-active");

    var facetsInner = panel.querySelector("[data-adsf-facets-inner]");
    var meta = panel.querySelector("[data-adsf-meta]");
    var state = { filters: {}, priceMin: null, priceMax: null, sort: "" };

    // Seed from the URL so a shared or reloaded filtered page stays filtered.
    var current = new URLSearchParams(location.search);
    current.forEach(function (v, k) {
      if (k.indexOf("f.") === 0) {
        var src = k.slice(2);
        (state.filters[src] = state.filters[src] || []).push(v);
      }
    });
    state.priceMin = current.get("price.min");
    state.priceMax = current.get("price.max");

    function renderTheme() {
      var shop = shopifyFilterParams(state);
      // Our own params go in the address bar so the facet state survives a
      // reload; Shopify’s go to the section request.
      var mine = new URLSearchParams();
      Object.keys(state.filters).forEach(function (src) {
        state.filters[src].forEach(function (v) { mine.append("f." + src, v); });
      });
      if (state.priceMin) mine.set("price.min", state.priceMin);
      if (state.priceMax) mine.set("price.max", state.priceMax);
      var merged = new URLSearchParams(shop.toString());
      mine.forEach(function (v, k) { merged.append(k, v); });
      history.replaceState(null, "", location.pathname + (merged.toString() ? "?" + merged : ""));

      grid.setAttribute("aria-busy", "true");
      fetch(location.pathname + "?section_id=" + encodeURIComponent(section.id) + (shop.toString() ? "&" + shop : ""))
        .then(function (r) { return r.text(); })
        .then(function (html) {
          var tmp = document.createElement("div");
          tmp.innerHTML = html;
          // Pull just the grid out of the returned section and swap it in
          // place. Replacing the whole section would take our own filter bar
          // with it, since the bar now lives inside that section.
          var fresh = tmp.querySelector(GRID_SELECTORS.join(","));
          if (fresh && grid.parentNode) {
            grid.parentNode.replaceChild(fresh, grid);
            grid = fresh;
            applyCollectionColumns(cfg, grid);
          }
          grid.setAttribute("aria-busy", "false");
          if (meta) {
            // The theme knows the real filtered count; ours only knows the
            // unfiltered one, so read it back rather than assert a number.
            var n = countProducts(fresh);
            meta.textContent = n + " product" + (n === 1 ? "" : "s");
          }
        })
        .catch(function () { grid.setAttribute("aria-busy", "false"); });
    }

    function loadFacets() {
      if (preloadedFacets) {
        renderFacetList(preloadedFacets);
        return;
      }
      var q =
        cfg.proxy +
        "/search?perPage=1" +
        (handle ? "&collection=" + encodeURIComponent(handle) : "");
      fetch(q, { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.facets) return;
          if (meta) meta.textContent = d.total + " product" + (d.total === 1 ? "" : "s");
          renderFacetList(d.facets);
        })
        .catch(function () {});
    }

    // Facets render as dropdown buttons: a compact row of labels that open a
    // panel of options, rather than every value stacked open at once. A shop
    // with six facets and forty values is unreadable as open lists.
    function renderFacetList(facets) {
      facetsInner.innerHTML = "";
      var supported = themeFilterParams();
      var usable = facets.filter(function (fct) {
        var p = paramForSource(fct.source);
        if (!p) return false;
        // No signal from the theme: show everything rather than an empty bar.
        return !supported || supported[p];
      });
      if (!usable.length) { panel.hidden = true; return; }
      panel.hidden = false;

      usable.forEach(function (fct) {
        var chosen = (state.filters[fct.source] || []).length;
        var wrap = el("div", "adsf-fdd");
        var btn = el("button", "adsf-fdd__btn");
        btn.type = "button";
        btn.setAttribute("aria-expanded", "false");
        if (chosen) btn.classList.add("is-active");

        var caret = '<span class="adsf-fdd__caret" aria-hidden="true"></span>';
        btn.innerHTML =
          "<span>" + esc(fct.label) + (chosen ? " (" + chosen + ")" : "") + "</span>" + caret;

        var pop = el("div", "adsf-fdd__pop");
        pop.hidden = true;

        if (fct.displayAs === "range") {
          var rw = el("div", "adsf-facet__range");
          var min = el("input", "adsf-facet__num"); min.type = "number";
          min.placeholder = fct.min != null ? String(Math.floor(fct.min)) : "Min";
          min.value = state.priceMin || "";
          var max = el("input", "adsf-facet__num"); max.type = "number";
          max.placeholder = fct.max != null ? String(Math.ceil(fct.max)) : "Max";
          max.value = state.priceMax || "";
          // Same rule as the app grid: commit on change, no Apply button.
          // Function EXPRESSIONS, not declarations: this is a block, and a
          // declaration inside one is hoisted differently across engines.
          var commitRange = function () {
            var nextMin = min.value || null;
            var nextMax = max.value || null;
            if (nextMin === state.priceMin && nextMax === state.priceMax) return;
            state.priceMin = nextMin;
            state.priceMax = nextMax;
            renderTheme();
          };
          var onKey = function (e) {
            if (e.key !== "Enter") return;
            e.preventDefault();
            commitRange();
          };
          min.addEventListener("change", commitRange);
          max.addEventListener("change", commitRange);
          min.addEventListener("keydown", onKey);
          max.addEventListener("keydown", onKey);
          rw.appendChild(min);
          rw.appendChild(el("span", "adsf-facet__dash", "to"));
          rw.appendChild(max);
          pop.appendChild(rw);
        } else {
          var list = el("ul", "adsf-facet__list");
          var selected = state.filters[fct.source] || [];
          fct.values.forEach(function (v) {
            var li = el("li", "adsf-facet__item");
            var id = "adsfx_" + fct.source.replace(/[^a-z0-9]/gi, "") + "_" +
              String(v.value).replace(/[^a-z0-9]/gi, "");
            var cb = el("input"); cb.type = "checkbox"; cb.id = id;
            cb.checked = selected.indexOf(v.value) >= 0;
            cb.addEventListener("change", function () {
              var arr = (state.filters[fct.source] || []).slice();
              if (cb.checked) { if (arr.indexOf(v.value) < 0) arr.push(v.value); }
              else arr = arr.filter(function (x) { return x !== v.value; });
              if (arr.length) state.filters[fct.source] = arr;
              else delete state.filters[fct.source];
              renderTheme();
            });
            var lbl = el("label");
            lbl.setAttribute("for", id);
            var count = cfg.showFacetCounts === false
              ? ""
              : ' <span class="adsf-facet__count">' + v.count + "</span>";
            lbl.insertAdjacentHTML("beforeend",
              '<span class="adsf-facet__label">' + esc(v.label) + "</span>" + count);
            li.appendChild(cb); li.appendChild(lbl);
            list.appendChild(li);
          });
          pop.appendChild(list);
        }

        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          var open = pop.hidden;
          // In a column the panels stack, so several can be open at once and
          // closing the others would fight the merchant. Only the floating
          // layouts, where panels overlap, are exclusive.
          if (layout !== "sidebar" && layout !== "inline") closeAllPops();
          pop.hidden = !open;
          btn.setAttribute("aria-expanded", String(open));
        });
        pop.addEventListener("click", function (e) { e.stopPropagation(); });

        wrap.appendChild(btn);
        wrap.appendChild(pop);
        facetsInner.appendChild(wrap);
      });

      if (chosenCount()) {
        var clear = el("button", "adsf-fdd__clear", "Clear all");
        clear.type = "button";
        clear.addEventListener("click", function () {
          state.filters = {};
          state.priceMin = state.priceMax = null;
          renderTheme();
        });
        facetsInner.appendChild(clear);
      }
    }

    function chosenCount() {
      var n = state.priceMin || state.priceMax ? 1 : 0;
      Object.keys(state.filters).forEach(function (k) {
        n += (state.filters[k] || []).length;
      });
      return n;
    }

    function closeAllPops() {
      Array.prototype.forEach.call(
        panel.querySelectorAll(".adsf-fdd__pop"),
        function (p) { p.hidden = true; },
      );
      Array.prototype.forEach.call(
        panel.querySelectorAll(".adsf-fdd__btn"),
        function (b) { b.setAttribute("aria-expanded", "false"); },
      );
    }

    document.addEventListener("click", closeAllPops);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeAllPops();
    });
    var sortSel = panel.querySelector("[data-adsf-sort]");
    if (sortSel) {
      // Seed from the URL so a sorted page survives a reload.
      sortSel.value = current.get("sort_by") || "";
      state.sort = sortSel.value;
      sortSel.addEventListener("change", function () {
        state.sort = sortSel.value;
        renderTheme();
      });
    }

    var toggle = panel.querySelector("[data-adsf-filter-toggle]");
    var facetsEl = panel.querySelector("[data-adsf-facets]");
    if (toggle && facetsEl) {
      // The drawer this opens on a phone covers the page, so it needs the same
      // treatment the results-app drawer already had: a backdrop to click, the
      // page behind locked, focus moved in and trapped, and Escape to leave.
      // Without those it was a panel a keyboard user could tab out of, behind,
      // and never find their way back from.
      var backdrop = el("div", "adsf-drawer-backdrop");
      backdrop.hidden = true;
      panel.appendChild(backdrop);
      var lastFocused = null;

      var focusables = function () {
        return facetsEl.querySelectorAll(
          'button, input, select, a[href], [tabindex]:not([tabindex="-1"])',
        );
      };

      var openDrawer = function (open) {
        facetsEl.classList.toggle("is-open", open);
        backdrop.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
        facetsEl.setAttribute("aria-modal", String(open));
        document.body.style.overflow = open ? "hidden" : "";
        if (open) {
          lastFocused = document.activeElement;
          var f = focusables();
          if (f.length) f[0].focus();
        } else if (lastFocused && lastFocused.focus) {
          lastFocused.focus();
        }
      };

      toggle.addEventListener("click", function () {
        openDrawer(!facetsEl.classList.contains("is-open"));
      });
      backdrop.addEventListener("click", function () { openDrawer(false); });

      facetsEl.addEventListener("keydown", function (e) {
        if (!facetsEl.classList.contains("is-open")) return;
        if (e.key === "Escape") { openDrawer(false); return; }
        if (e.key !== "Tab") return;
        var f = focusables();
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });
    }

    loadFacets();
    return true;
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

  var PRODUCT_LINK = 'a[href*="/products/"]';

  /** Does this element contain (or is it) a link to a product page? */
  function holdsProduct(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.matches && node.matches(PRODUCT_LINK)) return true;
    return !!(node.querySelector && node.querySelector(PRODUCT_LINK));
  }

  /** How many direct children of `node` are separate products. */
  function productChildCount(node) {
    if (!node || !node.children) return 0;
    var n = 0;
    for (var i = 0; i < node.children.length; i++) {
      if (holdsProduct(node.children[i])) n++;
    }
    return n;
  }

  /**
   * Find the product grid without knowing the theme.
   *
   * A named-selector list only ever covers the themes someone thought to add,
   * and every other shop silently gets no filters at all. Structure is the same
   * everywhere though: a grid is the element with the most direct children that
   * each contain a product link. Walk up from the product links and keep the
   * best candidate.
   */
  function detectGrid(scopeEl) {
    var links = (scopeEl || document).querySelectorAll(PRODUCT_LINK);
    if (links.length < 2) return null;
    var best = null;
    var bestCount = 1;
    var seen = [];
    Array.prototype.forEach.call(links, function (a) {
      var node = a;
      while (node && node.parentNode && node.parentNode.nodeType === 1) {
        var parent = node.parentNode;
        if (parent === document.body || parent === document.documentElement) break;
        if (seen.indexOf(parent) < 0) {
          seen.push(parent);
          var count = productChildCount(parent);
          // Prefer the container holding the most products. Ties go to the
          // deepest one, which is the grid rather than a page wrapper.
          if (count > bestCount) { best = parent; bestCount = count; }
        }
        node = parent;
      }
    });
    return best;
  }

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
      // A named match still has to look like a grid: some themes reuse these
      // class names on a single-product block.
      if (node && productChildCount(node) >= 2) return node;
    }
    // Nothing recognised: work it out from the page structure instead.
    var main =
      document.querySelector("#MainContent") ||
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.body;
    return detectGrid(main);
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

    // /collections/all is Shopify’s virtual "everything" collection. No product
    // is actually a member of it, so scoping a search to the handle "all" can
    // only ever return nothing. Treat it as an unscoped browse instead.
    var scope = handle === "all" ? "" : handle;

    // Only ever touch the grid. If this theme lays its collection out in a way
    // we do not recognise, leave the page completely alone: silently rendering
    // nothing beats deleting the merchant's content.
    var host = findGridHost();
    if (!host) return false;



    // Ask before replacing anything.
    //
    // If our index has no products for this collection, the theme is showing a
    // perfectly good grid and we would swap it for "No products found" — which
    // is exactly what happened when collection membership was missing from the
    // index. An unfiltered collection that we believe is empty means OUR data
    // is wrong, not the store, so we leave the page alone.
    var probe =
      cfg.proxy +
      "/search?perPage=1" +
      (scope ? "&collection=" + encodeURIComponent(scope) : "");
    fetch(probe, { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.total) return;

        // Which path can serve this collection?
        //
        // Theme cards are better looking, but they can only be filtered through
        // Shopify’s native params, and those are ignored unless the merchant
        // enabled the matching filter under Storefront filters. Rather than
        // show a filter that silently does nothing, we check first: if every
        // configured facet is supported natively, the theme draws the cards; if
        // even one is not, we draw the grid ourselves so that ALL of them work.
        var mode = cfg.productCards || "auto";

        if (mode !== "app") {
          var supported = themeFilterParams();
          var wanted = (d.facets || []).filter(function (fc) {
            return paramForSource(fc.source);
          });
          var missing = supported
            ? wanted.filter(function (fc) { return !supported[paramForSource(fc.source)]; })
            : wanted; // theme exposes no filters at all
          // "theme" is a promise the merchant made about their cards, so we keep
          // it even when some facets cannot be applied: those are dropped by
          // initThemeGridFacets rather than rendered as buttons that do nothing.
          if (mode === "theme" || (!missing.length && wanted.length)) {
            if (initThemeGridFacets(cfg, scope, host, d.facets)) return;
          }
          // Only "auto" is allowed to fall through to our own grid. Under
          // "theme" the merchant asked us not to touch their cards, so an
          // unrecognised theme means we leave the page exactly as it was.
          if (mode === "theme") return;
        }

        var mount = el("div", "adsf-app");
        mount.setAttribute("data-adsf-results-app", "");
        mount.setAttribute("data-proxy", cfg.proxy);
        if (scope) mount.setAttribute("data-collection", scope);
        mount.setAttribute("data-per-page", String(cfg.resultsPerPage || 24));
        if (cfg.moneyFormat) mount.setAttribute("data-money-format", cfg.moneyFormat);
        mount.style.setProperty("--adsf-cols", String(cfg.gridColumns || 4));
        mount.innerHTML = RESULTS_MARKUP;
        host.innerHTML = "";
        host.appendChild(mount);
        // The theme's own facet form now drives a grid that is gone. Hide it
        // rather than delete it.
        document.body.classList.add("adsf-collection-active");
        hideThemeFacets(host);
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
    cfg.mode = s.mode || "both";
    // The mode decides which halves may run; the individual switches then
    // tune the half that is on. A switch can never re-enable a half the
    // merchant turned off.
    cfg.searchOn = cfg.mode !== "filters";
    cfg.filtersOn = cfg.mode !== "search";
    cfg.autoAttach = s.autoAttach !== false;
    cfg.searchTakeover = s.searchTakeover !== false;
    cfg.collectionFilters = s.collectionFilters !== false;
    cfg.filterLayout = s.filterLayout || "sidebar";
    cfg.collectionColumnsEnabled = s.collectionColumnsEnabled === true;
    cfg.collectionWidthEnabled = s.collectionWidthEnabled === true;
    cfg.collectionMaxWidth = s.collectionMaxWidth || 1400;
    cfg.collectionSidePadding =
      s.collectionSidePadding == null ? 24 : s.collectionSidePadding;
    cfg.collectionColumns = s.collectionColumns || 4;
    cfg.collectionColumnsMobile = s.collectionColumnsMobile || 2;
    cfg.productCards = s.productCards || "auto";
    cfg.cardButtonLabel = s.cardButtonLabel || "";
    cfg.cardButtonFullWidth = s.cardButtonFullWidth !== false;
    cfg.showFacetCounts = s.showFacetCounts !== false;
    cfg.resultsPerPage = s.resultsPerPage || 24;
    cfg.gridColumns = s.gridColumns || 4;
    cfg.showVendor = !!s.showVendor;
    cfg.quickAdd = !!s.quickAdd;
    cfg.swatches = s.swatches || {};
    cfg.presets = Array.isArray(s.presets) ? s.presets : [];
    cfg.voiceSearch = s.voiceSearch !== false;
    if (s.proxy) {
      cfg.proxy = s.proxy;
      // resultsUrl is DERIVED from the proxy base. The app embed hardcodes the
      // default subpath, so a merchant who changed it got working autocomplete
      // and a 404 from both "See all results" and the Enter key.
      cfg.resultsUrl = s.proxy.replace(/\/+$/, "") + "/results";
    }
    // Appearance → CSS variables
    var rs = document.documentElement.style;
    // Filter button appearance, applied as CSS variables so the stylesheet
    // stays free of merchant-specific values.
    var shape = s.filterButtonShape || "pill";
    var radius = shape === "square" ? "0" : shape === "rounded" ? "8px" : "999px";
    rs.setProperty("--adsf-filter-radius", radius);
    if (s.filterButtonBg) rs.setProperty("--adsf-filter-bg", s.filterButtonBg);
    if (s.filterButtonText) rs.setProperty("--adsf-filter-text", s.filterButtonText);
    if (s.filterActiveBg) rs.setProperty("--adsf-filter-active-bg", s.filterActiveBg);
    if (s.filterActiveText) rs.setProperty("--adsf-filter-active-text", s.filterActiveText);
    if (s.filterHoverText) rs.setProperty("--adsf-filter-hover-text", s.filterHoverText);
    if (s.filterHoverBg) rs.setProperty("--adsf-filter-hover-bg", s.filterHoverBg);
    if (s.accentColor) rs.setProperty("--adsf-accent", s.accentColor);
    if (s.backgroundColor) rs.setProperty("--adsf-dd-bg", s.backgroundColor);
    if (s.textColor) rs.setProperty("--adsf-dd-text", s.textColor);
    if (s.highlightColor) rs.setProperty("--adsf-hl-color", s.highlightColor);
    if (s.fontSize) rs.setProperty("--adsf-dd-font-size", s.fontSize + "px");
    if (s.fontWeight) rs.setProperty("--adsf-dd-font-weight", s.fontWeight);
    if (s.gridColumns) rs.setProperty("--adsf-cols", String(s.gridColumns));
    if (s.gridColumnsMobile) {
      rs.setProperty("--adsf-cols-mobile", String(s.gridColumnsMobile));
    }

    // Product card appearance. Every value was validated server-side by
    // resolveSettings - colours against a strict pattern, numbers clamped,
    // the button label stripped of angle brackets - so nothing here can
    // escape the declaration it lands in.
    var RATIOS = {
      square: "1 / 1",
      portrait: "3 / 4",
      landscape: "4 / 3",
      wide: "16 / 9",
      natural: "auto",
    };
    // A fixed image height wins over the shape: asking for both is
    // contradictory, and silently ignoring the number the merchant typed is
    // worse than ignoring the dropdown they left alone.
    var imgH = Number(s.cardImageHeight) || 0;
    rs.setProperty("--adsf-card-img-h", imgH > 0 ? imgH + "px" : "auto");
    rs.setProperty(
      "--adsf-card-ratio",
      imgH > 0 ? "auto" : RATIOS[s.cardRatio] || RATIOS.square,
    );
    rs.setProperty("--adsf-card-fit", s.cardImageFit === "contain" ? "contain" : "cover");
    rs.setProperty("--adsf-card-align", s.cardAlign === "center" ? "center" : "left");
    if (s.cardRadius != null) rs.setProperty("--adsf-card-radius", s.cardRadius + "px");
    if (s.cardBg) rs.setProperty("--adsf-card-bg", s.cardBg);
    if (s.cardPadding != null) rs.setProperty("--adsf-card-pad", s.cardPadding + "px");
    if (s.cardGap != null) rs.setProperty("--adsf-card-gap", s.cardGap + "px");
    if (s.cardTitleSize) rs.setProperty("--adsf-card-title-size", s.cardTitleSize + "px");
    if (s.cardTitleWeight) rs.setProperty("--adsf-card-title-weight", String(s.cardTitleWeight));
    if (s.cardTitleColor) rs.setProperty("--adsf-card-title-color", s.cardTitleColor);
    if (s.cardTitleLines) rs.setProperty("--adsf-card-title-lines", String(s.cardTitleLines));
    if (s.cardPriceSize) rs.setProperty("--adsf-card-price-size", s.cardPriceSize + "px");
    if (s.cardPriceWeight) rs.setProperty("--adsf-card-price-weight", String(s.cardPriceWeight));
    if (s.cardPriceColor) rs.setProperty("--adsf-card-price-color", s.cardPriceColor);
    if (s.cardButtonBg) {
      rs.setProperty("--adsf-card-btn-bg", s.cardButtonBg);
      rs.setProperty("--adsf-card-btn-border", s.cardButtonBg);
    }
    if (s.cardButtonText) rs.setProperty("--adsf-card-btn-text", s.cardButtonText);
    if (s.cardButtonRadius != null) rs.setProperty("--adsf-card-btn-radius", s.cardButtonRadius + "px");
    rs.setProperty("--adsf-card-btn-self", s.cardButtonFullWidth === false ? "flex-start" : "stretch");
    // Chrome and hover are classes, not variables: CSS cannot switch a whole
    // rule on the value of a custom property.
    var root = document.documentElement;
    root.classList.toggle("adsf-card-line", s.cardBorder === "line");
    root.classList.toggle("adsf-card-shadow", s.cardBorder === "shadow");
    root.classList.toggle("adsf-card-hover-zoom", s.cardHover === "zoom");
    root.classList.toggle("adsf-card-hover-lift", s.cardHover === "lift");
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
      mode: "both",
      searchOn: true,
      filtersOn: true,
      productCards: "auto",
      cardButtonFullWidth: true,
      autoAttach: g.autoAttach !== false,
      searchTakeover: true,
      collectionFilters: true,
      filterLayout: "sidebar",
      collectionColumnsEnabled: false,
      resultsPerPage: 24,
      gridColumns: 4,
      showVendor: false,
      quickAdd: false,
      swatches: {},
      presets: [],
      voiceSearch: true,
    };

    /**
     * Note the product being viewed, wherever the shopper arrived from.
     *
     * The recommendation block records this, but only on pages that carry one.
     * Shopify publishes the current product on every product page, so reading it
     * here means the personalised rail works from the first PDP a shopper opens
     * rather than from the first one that happens to have the rail on it.
     */
    function noteCurrentProduct() {
      try {
        var meta = window.ShopifyAnalytics &&
          window.ShopifyAnalytics.meta &&
          window.ShopifyAnalytics.meta.product;
        if (meta && meta.id) rememberViewed(meta.id);
      } catch (e) {
        // Theme without the analytics globals; the block still records.
      }
    }

    function start() {
      noteCurrentProduct();
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
        if (cfg.searchOn !== false && cfg.searchTakeover) takeoverSearchPage(cfg);
        if (cfg.filtersOn !== false && cfg.collectionFilters) {
          takeoverCollectionPage(cfg);
        }
        if (cfg.searchOn !== false && cfg.autoAttach) {
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
