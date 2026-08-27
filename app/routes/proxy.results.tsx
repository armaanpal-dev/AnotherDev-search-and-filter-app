import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getSearchEngine } from "../lib/search/index.server";
import { getShopByDomain } from "../lib/shop.server";
import { parseSearchParams } from "../lib/proxy.server";
import type { SortKey, FilterSelection, ProductHit } from "../lib/search/types";

// GET apps/anotherdev-search/results?q=...
// Returns Liquid that Shopify renders INSIDE the merchant's theme, so the search
// results are real crawlable HTML on the store's own domain (SEO + AIO).
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, liquid } = await authenticate.public.appProxy(request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const shop = await getShopByDomain(session.shop);
  if (!shop) return new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const { term, page, perPage, sort, filters, price, collection } =
    parseSearchParams(url.searchParams);

  const result = await getSearchEngine().search({
    shopId: shop.id,
    term,
    page,
    perPage,
    sort: sort as SortKey,
    filters: filters as FilterSelection,
    price,
    collection,
  });

  const heading = term ? `Search results for “${escapeHtml(term)}”` : "All products";
  const totalPages = Math.max(1, Math.ceil(result.total / perPage));

  const cards = result.hits.map(productCard).join("\n");
  const jsonLd = buildItemListJsonLd(term, result.hits, session.shop);
  const pagination = buildPagination(url, page, totalPages);

  // Canonical points at the store's search URL to avoid duplicate-content issues.
  const canonical = `https://${session.shop}/search?q=${encodeURIComponent(term)}`;

  const body = `
<div class="adsf-results" data-total="${result.total}">
  <script type="application/ld+json">${jsonLd}</script>
  <link rel="canonical" href="${canonical}">
  <h1 class="adsf-results__heading">${heading}</h1>
  <p class="adsf-results__count">${result.total} result${result.total === 1 ? "" : "s"}</p>
  ${
    result.suggestion && result.total < 3
      ? `<p class="adsf-results__suggest">Did you mean <a href="?q=${encodeURIComponent(
          result.suggestion,
        )}">${escapeHtml(result.suggestion)}</a>?</p>`
      : ""
  }
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
  .adsf-card__price{font-weight:600}
  .adsf-results__pagination{display:flex;gap:.5rem;justify-content:center;margin:2rem 0}
  .adsf-results__pagination a,.adsf-results__pagination span{padding:.4rem .7rem;border:1px solid #ddd;border-radius:6px;text-decoration:none;color:inherit}
  .adsf-results__pagination [aria-current="page"]{background:#111;color:#fff;border-color:#111}
</style>`;

  return liquid(body);
}

function productCard(p: ProductHit): string {
  const priceText = formatPriceRange(p);
  const img = p.imageUrl
    ? `<img src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.imageAlt ?? p.title)}" loading="lazy" width="300" height="300">`
    : `<div class="adsf-card__noimg" aria-hidden="true"></div>`;
  return `<li class="adsf-card">
    <a href="/products/${escapeHtml(p.handle)}">
      ${img}
      <div class="adsf-card__title">${escapeHtml(p.title)}</div>
      <div class="adsf-card__price">${priceText}</div>
    </a>
  </li>`;
}

function buildItemListJsonLd(
  term: string,
  hits: ProductHit[],
  shopDomain: string,
): string {
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: term ? `Search results for ${term}` : "Products",
    numberOfItems: hits.length,
    itemListElement: hits.map((p, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Product",
        name: p.title,
        url: `https://${shopDomain}/products/${p.handle}`,
        image: p.imageUrl ?? undefined,
        brand: p.vendor || undefined,
        category: p.productType || undefined,
        offers: {
          "@type": "Offer",
          price: p.priceMin,
          priceCurrency: p.currencyCode || "USD",
          availability: p.available
            ? "https://schema.org/InStock"
            : "https://schema.org/OutOfStock",
        },
      },
    })),
  };
  return JSON.stringify(itemList).replace(/</g, "\\u003c");
}

function buildPagination(url: URL, page: number, totalPages: number): string {
  if (totalPages <= 1) return "";
  const mk = (p: number, label?: string, current = false) => {
    const u = new URL(url);
    u.searchParams.set("page", String(p));
    const path = u.pathname + u.search;
    if (current) return `<span aria-current="page">${label ?? p}</span>`;
    return `<a href="${escapeHtml(path)}" rel="${p < page ? "prev" : "next"}">${label ?? p}</a>`;
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
