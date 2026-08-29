import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getSearchEngine } from "../lib/search/index.server";
import { getShopByDomain } from "../lib/shop.server";
import { resolveSettings } from "../lib/settings";
import {
  parseSearchParams,
  proxyBase,
  escapeLiquidHtml as esc,
} from "../lib/proxy.server";
import type {
  SortKey,
  FilterSelection,
  PriceRange,
  ProductHit,
  Facet,
} from "../lib/search/types";

// GET apps/anotherdev-search/results?q=...
// Returns Liquid that Shopify renders INSIDE the merchant's theme, so the search
// results are real crawlable HTML on the store's own domain (SEO + AIO).
//
// EVERY interpolated value goes through `esc` (HTML-escape + Liquid-defuse).
// Shopify renders this response through the theme's Liquid engine, so an
// unescaped `{{ ... }}` in a search term or a product title would be executed
// server-side in the merchant's context.
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, liquid } = await authenticate.public.appProxy(request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const shop = await getShopByDomain(session.shop);
  if (!shop) return new Response("Not found", { status: 404 });

  const settings = resolveSettings(shop.settings);
  const url = new URL(request.url);
  const base = proxyBase(url.searchParams);
  const { term, page, perPage, sort, filters, price, collection } =
    parseSearchParams(url.searchParams, { perPage: settings.resultsPerPage });

  const result = await getSearchEngine().search({
    shopId: shop.id,
    term,
    page,
    perPage,
    sort: sort as SortKey,
    filters: filters as FilterSelection,
    price,
    collection,
    // The crawlable page must agree with the JSON API, or Google indexes a set
    // of results that shoppers never see.
    includeUnavailable: settings.showOutOfStock,
    typoTolerance: settings.typoTolerance,
  });

  // A merchant redirect should redirect here too, not render an empty grid.
  if (result.redirect) {
    return new Response(null, {
      status: 302,
      headers: { Location: result.redirect },
    });
  }

  const heading = term ? `Search results for “${esc(term)}”` : "All products";
  const totalPages = Math.max(1, Math.ceil(result.total / perPage));

  const cards = result.hits.map((h) => productCard(h, settings.showVendor)).join("\n");
  const jsonLd = buildItemListJsonLd(term, result.hits, session.shop, page, perPage);
  // Every link on this page is built from this, never from request.url.
  const linkParams = shopperParams({ term, sort, filters, price, collection });
  const pagination = buildPagination(linkParams, base, page, totalPages);
  const facetNav = buildFacetLinks(linkParams, base, result.facets, filters);

  // Faceted URLs are near-infinite and near-duplicate. Let Google index the
  // clean query page and keep the filter permutations out of the index, or the
  // crawl budget goes on `?f.vendor=…&f.option:Color=…` combinations.
  const isFaceted =
    Object.keys(filters).length > 0 || !!price || sort !== "relevance";
  const robots = isFaceted ? "noindex,follow" : "index,follow";

  // Canonical must point at THIS page, on the store's own domain. Pointing it at
  // /search told Google the crawlable results page was a duplicate of the theme's
  // own search page — i.e. asked it not to rank the page we built to rank.
  const canonicalParams = new URLSearchParams();
  if (term) canonicalParams.set("q", term);
  if (page > 1) canonicalParams.set("page", String(page));
  const canonicalQs = canonicalParams.toString();
  const canonical = `https://${session.shop}${base}/results${canonicalQs ? `?${canonicalQs}` : ""}`;

  // `content_for_header` already emitted <head>, so a <link>/<meta> placed here
  // sits in the body where Google ignores it. Liquid can still reach the head:
  // these tags are moved into it on parse, before the crawler-visible HTML is
  // serialised, by a tiny inline script — and the JSON-LD below (which IS valid
  // in the body) carries the same signals for parsers that never run JS.
  const headTags = `
<script>
(function(){try{
  var head=document.head;
  var c=document.createElement("link"); c.rel="canonical"; c.href=${JSON.stringify(canonical)};
  var old=head.querySelector('link[rel="canonical"]'); if(old) old.remove();
  head.appendChild(c);
  var r=document.createElement("meta"); r.name="robots"; r.content=${JSON.stringify(robots)};
  var oldR=head.querySelector('meta[name="robots"]'); if(oldR) oldR.remove();
  head.appendChild(r);
  ${page > 1 ? `var pv=document.createElement("link"); pv.rel="prev"; pv.href=${JSON.stringify(pageUrl(linkParams, base, page - 1))}; head.appendChild(pv);` : ""}
  ${page < totalPages ? `var nx=document.createElement("link"); nx.rel="next"; nx.href=${JSON.stringify(pageUrl(linkParams, base, page + 1))}; head.appendChild(nx);` : ""}
}catch(e){}})();
</script>`;

  const body = `
<div class="adsf-results" data-total="${result.total}" data-adsf-seo-results>
  <script type="application/ld+json">${jsonLd}</script>
  ${headTags}
  <h1 class="adsf-results__heading">${heading}</h1>
  <p class="adsf-results__count">${result.total} result${result.total === 1 ? "" : "s"}</p>
  ${
    result.suggestion && result.total < 3
      ? `<p class="adsf-results__suggest">Did you mean <a href="${esc(base)}/results?q=${encodeURIComponent(
          result.suggestion,
        )}">${esc(result.suggestion)}</a>?</p>`
      : ""
  }
  ${facetNav}
  ${
    result.hits.length
      ? `<ul class="adsf-results__grid">${cards}</ul>${pagination}`
      : `<p class="adsf-results__empty">No products matched your search. Try a different term.</p>`
  }
</div>
<style>
  .adsf-results{max-width:1200px;margin:0 auto;padding:1rem}
  .adsf-results__grid{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1.25rem;padding:0}
  .adsf-card a{display:block;text-decoration:none;color:inherit}
  .adsf-card img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:8px}
  .adsf-card__title{margin:.5rem 0 .25rem;font-size:.95rem;line-height:1.3}
  .adsf-card__vendor{font-size:.8rem;opacity:.7}
  .adsf-card__price{font-weight:600}
  .adsf-results__facets{display:flex;flex-wrap:wrap;gap:.4rem;margin:1rem 0}
  .adsf-results__facets a{font-size:.85rem;padding:.25rem .6rem;border:1px solid #ddd;border-radius:999px;text-decoration:none;color:inherit}
  .adsf-results__facets a[aria-pressed="true"]{background:#111;color:#fff;border-color:#111}
  .adsf-results__pagination{display:flex;gap:.5rem;justify-content:center;margin:2rem 0}
  .adsf-results__pagination a,.adsf-results__pagination span{padding:.4rem .7rem;border:1px solid #ddd;border-radius:6px;text-decoration:none;color:inherit}
  .adsf-results__pagination [aria-current="page"]{background:#111;color:#fff;border-color:#111}
</style>`;

  return liquid(body);
}

/**
 * The shopper-facing query string.
 *
 * Links MUST be built from the parsed search state, never by cloning
 * `request.url`. Shopify appends `shop`, `path_prefix`, `timestamp`,
 * `signature` and `logged_in_customer_id` to every App Proxy request, so
 * copying that URL put a one-time HMAC and the logged-in customer id into
 * crawlable hrefs — and sent a duplicate `signature` back through the proxy
 * on the next click, which fails signature validation.
 */
function shopperParams(q: {
  term: string;
  sort: SortKey;
  filters: FilterSelection;
  price?: PriceRange;
  collection?: string;
}): URLSearchParams {
  const sp = new URLSearchParams();
  if (q.term) sp.set("q", q.term);
  if (q.sort && q.sort !== "relevance") sp.set("sort", q.sort);
  if (q.collection) sp.set("collection", q.collection);
  if (q.price?.min != null) sp.set("price.min", String(q.price.min));
  if (q.price?.max != null) sp.set("price.max", String(q.price.max));
  // Sorted so one selection always yields one URL — otherwise two spellings
  // of the same filtered page compete for the same content in the index.
  for (const source of Object.keys(q.filters).sort()) {
    for (const value of q.filters[source]) sp.append(`f.${source}`, value);
  }
  return sp;
}

/** `?a=1&b=2`, or "" — never a bare "?". */
function qs(sp: URLSearchParams): string {
  const out = sp.toString();
  return out ? `?${out}` : "";
}

function productCard(p: ProductHit, showVendor: boolean): string {
  const priceText = formatPriceRange(p);
  const img = p.imageUrl
    ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.imageAlt ?? p.title)}" loading="lazy" width="300" height="300">`
    : `<div class="adsf-card__noimg" aria-hidden="true"></div>`;
  return `<li class="adsf-card">
    <a href="/products/${esc(p.handle)}">
      ${img}
      <div class="adsf-card__title">${esc(p.title)}</div>
      ${showVendor && p.vendor ? `<div class="adsf-card__vendor">${esc(p.vendor)}</div>` : ""}
      <div class="adsf-card__price">${priceText}</div>
      ${p.available ? "" : `<div class="adsf-card__soldout">Sold out</div>`}
    </a>
  </li>`;
}

/**
 * Crawlable facet links.
 *
 * Filters previously existed only in the JS app, so a crawler (or a shopper with
 * JS disabled) saw an unfiltered grid and no way to narrow it. These are real
 * <a> hrefs, and the filtered pages they lead to are noindex,follow — crawlable
 * for discovery, absent from the index.
 */
function buildFacetLinks(
  params: URLSearchParams,
  base: string,
  facets: Facet[],
  active: FilterSelection,
): string {
  const groups = facets
    .filter((f) => f.displayAs !== "range" && f.values.length)
    .slice(0, 4)
    .map((f) => {
      const links = f.values
        .slice(0, 12)
        .map((v) => {
          const selected = (active[f.source] ?? []).includes(v.value);
          const sp = new URLSearchParams(params);
          // Toggling a facet always returns to page 1.
          sp.delete("page");
          const current = sp.getAll(`f.${f.source}`);
          sp.delete(`f.${f.source}`);
          const next = selected
            ? current.filter((c) => c !== v.value)
            : [...current, v.value];
          next.forEach((n) => sp.append(`f.${f.source}`, n));
          const href = `${base}/results${qs(sp)}`;
          return `<a href="${esc(href)}" rel="nofollow" aria-pressed="${selected}">${esc(v.label)} (${v.count})</a>`;
        })
        .join("");
      return `<div class="adsf-results__facets"><strong>${esc(f.label)}:</strong> ${links}</div>`;
    })
    .join("");
  return groups ? `<nav aria-label="Filters">${groups}</nav>` : "";
}

function pageUrl(params: URLSearchParams, base: string, p: number): string {
  const sp = new URLSearchParams(params);
  // Page 1 is the canonical, parameterless form.
  if (p > 1) sp.set("page", String(p));
  else sp.delete("page");
  return `${base}/results${qs(sp)}`;
}

function buildItemListJsonLd(
  term: string,
  hits: ProductHit[],
  shopDomain: string,
  page: number,
  perPage: number,
): string {
  const offset = (page - 1) * perPage;
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: term ? `Search results for ${term}` : "Products",
    numberOfItems: hits.length,
    itemListElement: hits.map((p, i) => ({
      "@type": "ListItem",
      // Absolute position across pages, so page 2 does not restart at 1.
      position: offset + i + 1,
      item: {
        "@type": "Product",
        name: p.title,
        url: `https://${shopDomain}/products/${p.handle}`,
        image: p.imageUrl ?? undefined,
        brand: p.vendor || undefined,
        category: p.productType || undefined,
        offers: {
          "@type": "AggregateOffer",
          lowPrice: p.priceMin,
          highPrice: p.priceMax,
          priceCurrency: p.currencyCode || "USD",
          availability: p.available
            ? "https://schema.org/InStock"
            : "https://schema.org/OutOfStock",
        },
      },
    })),
  };
  // `</script>` inside JSON would close the block early; `<` is also the Liquid
  // -safe escape here since JSON strings accept \u.
  return JSON.stringify(itemList).replace(/</g, "\\u003c");
}

function buildPagination(
  params: URLSearchParams,
  base: string,
  page: number,
  totalPages: number,
): string {
  if (totalPages <= 1) return "";
  const mk = (p: number, label?: string, current = false) => {
    const path = pageUrl(params, base, p);
    if (current) return `<span aria-current="page">${label ?? p}</span>`;
    const rel = p === page - 1 ? ' rel="prev"' : p === page + 1 ? ' rel="next"' : "";
    return `<a href="${esc(path)}"${rel}>${label ?? p}</a>`;
  };
  const parts: string[] = [];
  if (page > 1) parts.push(mk(page - 1, "‹ Prev"));
  for (let p = Math.max(1, page - 2); p <= Math.min(totalPages, page + 2); p++) {
    parts.push(mk(p, undefined, p === page));
  }
  if (page < totalPages) parts.push(mk(page + 1, "Next ›"));
  return `<nav class="adsf-results__pagination" aria-label="Search results pages">${parts.join("")}</nav>`;
}

function formatPriceRange(p: ProductHit): string {
  const cur = p.currencyCode || "";
  const fmt = (n: number) => `${cur} ${n.toFixed(2)}`.trim();
  return p.priceMin === p.priceMax
    ? fmt(p.priceMin)
    : `${fmt(p.priceMin)} – ${fmt(p.priceMax)}`;
}
