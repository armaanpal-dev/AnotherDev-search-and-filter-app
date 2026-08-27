import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getSearchEngine } from "../lib/search/index.server";
import { jsonCors, loadProxyShop } from "../lib/proxy.server";
import type { RecommendationKind } from "../lib/search/types";

const KINDS: RecommendationKind[] = ["related", "trending", "bestsellers", "recent"];

/**
 * GET apps/anotherdev-search/recommend?kind=related&productId=123&limit=8
 *
 * The search index already knows what shoppers click, what sells and what sits
 * near what — the same data a separate recommendations app would charge for.
 * Exposed as its own endpoint so a theme block can drop a rail onto a product
 * page, the cart, or an empty search state.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return jsonCors({ error: "unauthorized" }, 401);

  const shop = await loadProxyShop(session.shop);
  if (!shop) return jsonCors({ error: "shop_not_initialized" }, 404);

  const url = new URL(request.url);
  const kindRaw = url.searchParams.get("kind") ?? "related";
  const kind = (KINDS.includes(kindRaw as RecommendationKind)
    ? kindRaw
    : "related") as RecommendationKind;

  const limit = Math.min(
    24,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "8", 10) || 8),
  );

  const products = await getSearchEngine().recommend({
    shopId: shop.shopId,
    kind,
    productId: url.searchParams.get("productId")?.slice(0, 32) || undefined,
    collection: url.searchParams.get("collection")?.slice(0, 200) || undefined,
    limit,
    includeUnavailable: shop.settings.showOutOfStock,
  });

  return jsonCors(
    { kind, products },
    200,
    // Recommendations shift slowly (popularity, click counts) and are identical
    // for every shopper, so this is the one storefront response worth caching
    // publicly at the edge.
    { "Cache-Control": "public, max-age=300, stale-while-revalidate=3600" },
  );
}
