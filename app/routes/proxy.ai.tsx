import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getSearchEngine } from "../lib/search/index.server";
import { getShopByDomain } from "../lib/shop.server";
import { parseSearchParams, jsonCors } from "../lib/proxy.server";
import type { SortKey, FilterSelection } from "../lib/search/types";

// GET apps/anotherdev-search/ai?q=...
// AIO (AI/answer-engine optimization): a clean, documented JSON contract that
// LLM shopping agents can call to query the catalog in natural language. Returns
// schema.org-typed products so an agent can act on them directly.
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return jsonCors({ error: "unauthorized" }, 401);

  const shop = await getShopByDomain(session.shop);
  if (!shop) return jsonCors({ error: "shop_not_initialized" }, 404);

  // The AI feed is a Pro feature.
  if (shop.planName !== "pro") {
    return jsonCors({ error: "upgrade_required", message: "The AI feed requires the Pro plan." }, 402);
  }

  const url = new URL(request.url);
  const { term, page, perPage, sort, filters, price, collection } =
    parseSearchParams(url.searchParams);

  const result = await getSearchEngine().search({
    shopId: shop.id,
    term,
    page,
    perPage: Math.min(perPage, 20),
    sort: sort as SortKey,
    filters: filters as FilterSelection,
    price,
    collection,
  });

  const base = `https://${session.shop}`;
  const body = {
    "@context": "https://schema.org",
    "@type": "SearchResultsPage",
    query: term,
    totalResults: result.total,
    // A compact facet map so an agent can refine ("filter to size M under $50").
    availableFilters: result.facets.map((f) => ({
      name: f.label,
      parameter: `f.${f.source}`,
      type: f.displayAs,
      ...(f.displayAs === "range"
        ? { min: f.min, max: f.max }
        : { values: f.values.map((v) => ({ value: v.value, count: v.count })) }),
    })),
    products: result.hits.map((p) => ({
      "@type": "Product",
      name: p.title,
      url: `${base}/products/${p.handle}`,
      image: p.imageUrl,
      brand: p.vendor || undefined,
      category: p.productType || undefined,
      offers: {
        "@type": "AggregateOffer",
        lowPrice: p.priceMin,
        highPrice: p.priceMax,
        priceCurrency: p.currencyCode || "USD",
        availability: p.available ? "InStock" : "OutOfStock",
      },
    })),
    // Self-describing so an agent can discover how to paginate/refine.
    usage: {
      description:
        "Product search for this store. Pass q for the query; refine with availableFilters parameters (repeat for multi-select) and price.min/price.max; paginate with page.",
      parameters: {
        q: "search query string",
        page: "1-based page number",
        sort: "relevance|price_asc|price_desc|newest|bestselling",
      },
    },
  };

  return jsonCors(body, 200, {
    "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
  });
}
