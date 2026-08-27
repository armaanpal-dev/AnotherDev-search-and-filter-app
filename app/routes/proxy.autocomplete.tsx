import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getSearchEngine } from "../lib/search/index.server";
import { getShopByDomain } from "../lib/shop.server";
import { jsonCors } from "../lib/proxy.server";

// GET apps/anotherdev-search/autocomplete?q=sho&limit=6
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return jsonCors({ error: "unauthorized" }, 401);

  const shop = await getShopByDomain(session.shop);
  if (!shop) return jsonCors({ error: "shop_not_initialized" }, 404);

  const url = new URL(request.url);
  const term = (url.searchParams.get("q") ?? "").slice(0, 100);
  const limit = Math.min(
    12,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "6", 10) || 6),
  );

  const result = await getSearchEngine().autocomplete({
    shopId: shop.id,
    term,
    limit,
  });

  return jsonCors(result, 200, {
    "Cache-Control": "public, max-age=10, stale-while-revalidate=60",
  });
}
