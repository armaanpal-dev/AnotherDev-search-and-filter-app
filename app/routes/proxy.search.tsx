import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getSearchEngine } from "../lib/search/index.server";
import { recordSearchEvent } from "../lib/analytics.server";
import {
  parseSearchParams,
  jsonCors,
  loadProxyShop,
  bucketFor,
} from "../lib/proxy.server";

// GET apps/anotherdev-search/search?q=...&page=1&sort=relevance&f.vendor=Nike&...
// Served on the merchant's own domain via App Proxy → first-party, SEO-friendly.
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return jsonCors({ error: "unauthorized" }, 401);

  const shop = await loadProxyShop(session.shop);
  if (!shop) return jsonCors({ error: "shop_not_initialized" }, 404);

  const url = new URL(request.url);
  const { settings } = shop;
  const { term, page, perPage, sort, filters, price, collection } =
    parseSearchParams(url.searchParams, { perPage: settings.resultsPerPage });

  // Stable A/B arm for this shopper, so a bucketed merchandising rule applies
  // consistently across paging and refinement rather than flipping per request.
  const sessionToken = url.searchParams.get("st") ?? undefined;
  const bucket = bucketFor(sessionToken);

  const result = await getSearchEngine().search({
    shopId: shop.shopId,
    term,
    page,
    perPage,
    sort,
    filters,
    price,
    collection,
    // Merchant toggles were previously stored but never reached the engine.
    includeUnavailable: settings.showOutOfStock,
    typoTolerance: settings.typoTolerance,
    semantic: settings.semanticSearch,
    bucket,
  });

  // Fire-and-forget analytics. Only a genuinely NEW search is counted: paging,
  // sorting and filter refinement all re-hit this endpoint with the same term,
  // and counting those inflated every metric (searches, CTR, conversion rate).
  if (term && isNewSearch({ page, sort, filters, price })) {
    void recordSearchEvent({
      shopId: shop.shopId,
      term,
      resultsCount: result.total,
      sessionToken,
      bucket,
    });
  }

  return jsonCors(result, 200, {
    // Short cache: storefront search can tolerate a few seconds of staleness.
    // `private` because results depend on this shop's index and settings.
    "Cache-Control": "private, max-age=5, stale-while-revalidate=30",
  });
}

function isNewSearch(q: {
  page: number;
  sort: string;
  filters: Record<string, string[]>;
  price?: unknown;
}): boolean {
  return (
    q.page === 1 &&
    q.sort === "relevance" &&
    !q.price &&
    Object.keys(q.filters).length === 0
  );
}

