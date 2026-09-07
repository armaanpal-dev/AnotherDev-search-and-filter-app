import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getSearchEngine } from "../lib/search/index.server";
import { jsonCors, loadProxyShop } from "../lib/proxy.server";
import type { RecommendationKind } from "../lib/search/types";

const KINDS: RecommendationKind[] = [
  "related",
  "trending",
  "bestsellers",
  "recent",
  "personalized",
];

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

  // Recently-viewed ids for the personalised rail. They live in the shopper's
  // own localStorage and are sent up per request — nothing is stored here, so
  // this builds no profile and needs no customer account.
  const seenProductIds = (url.searchParams.get("seen") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{1,20}$/.test(s))
    .slice(0, 20);

  const products = await getSearchEngine().recommend({
    shopId: shop.shopId,
    kind,
    productId: url.searchParams.get("productId")?.slice(0, 32) || undefined,
    seenProductIds,
    collection: url.searchParams.get("collection")?.slice(0, 200) || undefined,
    limit,
    includeUnavailable: shop.settings.showOutOfStock,
  });

  // A personalised rail is different for every shopper, so it is the one kind
  // that must NOT be cached publicly — a shared cache would hand one shopper's
  // browsing history to the next visitor.
  const cacheControl =
    kind === "personalized"
      ? "private, max-age=60"
      : "public, max-age=300, stale-while-revalidate=3600";

  return jsonCors({ kind, products }, 200, { "Cache-Control": cacheControl });
}
