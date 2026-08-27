import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getSearchEngine } from "../lib/search/index.server";
import { jsonCors, loadProxyShop } from "../lib/proxy.server";

// GET apps/anotherdev-search/autocomplete?q=sho&limit=6
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return jsonCors({ error: "unauthorized" }, 401);

  const shop = await loadProxyShop(session.shop);
  if (!shop) return jsonCors({ error: "shop_not_initialized" }, 404);

  const url = new URL(request.url);
  const term = (url.searchParams.get("q") ?? "").slice(0, 100);
  const { settings } = shop;
  const limit = Math.min(
    12,
    Math.max(
      1,
      parseInt(url.searchParams.get("limit") ?? String(settings.maxSuggestions), 10) ||
        settings.maxSuggestions,
    ),
  );

  const result = await getSearchEngine().autocomplete({
    shopId: shop.shopId,
    term,
    limit,
    includeUnavailable: settings.showOutOfStock,
    typoTolerance: settings.typoTolerance,
  });

  return jsonCors(result, 200, {
    "Cache-Control": "private, max-age=10, stale-while-revalidate=60",
  });
}
