import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../lib/shop.server";
import { resolveSettings } from "../lib/settings";
import { jsonCors, proxyBase } from "../lib/proxy.server";

// GET apps/anotherdev-search/config
// Serves the merchant's widget settings to the storefront so appearance/behaviour
// are configured in the APP admin (not the theme editor).
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return jsonCors({}, 401);

  const shop = await getShopByDomain(session.shop);
  const settings = resolveSettings(shop?.settings);
  const url = new URL(request.url);

  // One-click filter shortcuts. Served with the config rather than with the
  // results so the chips render on first paint, before any search has run.
  const presets = shop
    ? await prisma.filterPreset.findMany({
        where: { shopId: shop.id, enabled: true },
        orderBy: { position: "asc" },
        take: 12,
        select: { label: true, params: true },
      })
    : [];

  const body = {
    ...settings,
    // The merchant can change the App Proxy subpath, so the storefront must be
    // told the real prefix rather than assuming the default.
    proxy: proxyBase(url.searchParams),
    // Lets the widget avoid advertising Pro-only behaviour on a Free shop.
    plan: shop?.planName ?? "free",
    presets,
  };

  return jsonCors(body, 200, {
    // Cache briefly; settings change rarely and this is on every page load.
    "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
  });
}
