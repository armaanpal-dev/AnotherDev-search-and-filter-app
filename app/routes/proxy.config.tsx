import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../lib/shop.server";
import { resolveSettings } from "../lib/settings";
import { jsonCors } from "../lib/proxy.server";

// GET apps/anotherdev-search/config
// Serves the merchant's widget settings to the storefront so appearance/behaviour
// are configured in the APP admin (not the theme editor).
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return jsonCors({}, 401);

  const shop = await getShopByDomain(session.shop);
  const settings = resolveSettings(shop?.settings);

  return jsonCors(settings, 200, {
    // Cache briefly; settings change rarely and this is on every page load.
    "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
  });
}
