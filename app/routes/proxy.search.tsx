import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSearchEngine } from "../lib/search/index.server";
import { getShopByDomain } from "../lib/shop.server";
import type { FilterSelection, SortKey } from "../lib/search/types";
import { parseSearchParams, jsonCors } from "../lib/proxy.server";

// GET apps/anotherdev-search/search?q=...&page=1&sort=relevance&f.vendor=Nike&...
// Served on the merchant's own domain via App Proxy → first-party, SEO-friendly.
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return jsonCors({ error: "unauthorized" }, 401);

  const shop = await getShopByDomain(session.shop);
  if (!shop) return jsonCors({ error: "shop_not_initialized" }, 404);

  const url = new URL(request.url);
  const { term, page, perPage, sort, filters, price, collection } =
    parseSearchParams(url.searchParams);

  const engine = getSearchEngine();
  const result = await engine.search({
    shopId: shop.id,
    term,
    page,
    perPage,
    sort: sort as SortKey,
    filters: filters as FilterSelection,
    price,
    collection,
  });

  // Fire-and-forget analytics (don't block the response).
  if (term) {
    const sessionToken = url.searchParams.get("st") ?? undefined;
    prisma.searchEvent
      .create({
        data: {
          shopId: shop.id,
          query: term,
          normalized: term.toLowerCase().trim(),
          resultsCount: result.total,
          sessionToken,
        },
      })
      .catch(() => {});
  }

  return jsonCors(result, 200, {
    // Short cache: storefront search can tolerate a few seconds of staleness.
    "Cache-Control": "public, max-age=5, stale-while-revalidate=30",
  });
}
