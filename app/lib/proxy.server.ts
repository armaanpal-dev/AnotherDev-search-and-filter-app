import type { FilterSelection, PriceRange, SortKey } from "./search/types";
import { getShopByDomain } from "./shop.server";
import { resolveSettings, type WidgetSettings } from "./settings";

const VALID_SORTS: SortKey[] = [
  "relevance",
  "price_asc",
  "price_desc",
  "title_asc",
  "title_desc",
  "newest",
  "bestselling",
];

const MAX_PER_PAGE = 48;

/**
 * The storefront-facing base path of the App Proxy (e.g. `/apps/anotherdev-search`).
 *
 * Shopify forwards proxy requests to `{app_url}/proxy/...`, so `request.url` is
 * the APP's path, not the shopper's. Any link we render into the storefront must
 * use the shopper's path or it 404s. Shopify passes it as `path_prefix` on every
 * proxy request; the literal is only a fallback for local/manual calls.
 */
export function proxyBase(sp: URLSearchParams): string {
  const prefix = sp.get("path_prefix");
  if (prefix && prefix.startsWith("/") && !prefix.includes("//")) return prefix;
  return "/apps/anotherdev-search";
}

/**
 * Parse storefront query params into a typed search request.
 * Filter params use the `f.<source>` convention, repeated for multi-select:
 *   f.vendor=Nike&f.vendor=Adidas&f.option:Color=Red&price.min=10&price.max=50
 */
export function parseSearchParams(
  sp: URLSearchParams,
  defaults: { perPage?: number } = {},
): {
  term: string;
  page: number;
  perPage: number;
  sort: SortKey;
  filters: FilterSelection;
  price?: PriceRange;
  collection?: string;
} {
  const term = (sp.get("q") ?? sp.get("term") ?? "").slice(0, 200);
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const fallbackPerPage = defaults.perPage ?? 24;
  const perPage = Math.min(
    MAX_PER_PAGE,
    Math.max(
      1,
      parseInt(sp.get("perPage") ?? String(fallbackPerPage), 10) || fallbackPerPage,
    ),
  );
  const sortRaw = sp.get("sort") ?? "relevance";
  const sort = (VALID_SORTS.includes(sortRaw as SortKey)
    ? sortRaw
    : "relevance") as SortKey;

  const filters: FilterSelection = {};
  for (const [key, value] of sp.entries()) {
    if (!key.startsWith("f.")) continue;
    const source = key.slice(2);
    if (!value) continue;
    (filters[source] ??= []).push(value);
  }

  let price: PriceRange | undefined;
  const pmin = sp.get("price.min");
  const pmax = sp.get("price.max");
  if (pmin != null || pmax != null) {
    const min = pmin != null && pmin !== "" ? Number(pmin) : undefined;
    const max = pmax != null && pmax !== "" ? Number(pmax) : undefined;
    // A non-numeric bound would become NaN and silently drop every product.
    const clean = {
      min: Number.isFinite(min as number) ? min : undefined,
      max: Number.isFinite(max as number) ? max : undefined,
    };
    if (clean.min != null || clean.max != null) price = clean;
  }

  const collection = sp.get("collection") ?? undefined;

  return { term, page, perPage, sort, filters, price, collection };
}

export interface ProxyShopContext {
  shopId: string;
  domain: string;
  planName: string;
  settings: WidgetSettings;
}

/**
 * Resolve the Shop row + resolved widget settings for an App Proxy request.
 * Returns null when the shop was never initialised (app installed but the admin
 * has not been opened yet).
 */
export async function loadProxyShop(
  shopDomain: string,
): Promise<ProxyShopContext | null> {
  const shop = await getShopByDomain(shopDomain);
  if (!shop) return null;
  return {
    shopId: shop.id,
    domain: shop.domain,
    planName: shop.planName,
    settings: resolveSettings(shop.settings),
  };
}

export function jsonCors(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // The proxy is served from the merchant's own domain, so this is
      // same-origin; the header only helps manual/edge callers.
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}
