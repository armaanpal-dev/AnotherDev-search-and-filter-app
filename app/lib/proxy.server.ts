import type { FilterSelection, PriceRange, SortKey } from "./search/types";
import { getShopByDomain } from "./shop.server";
import { resolveSettings, type WidgetSettings } from "./settings";
import { stripLiquid } from "./search/normalize";

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

// Mirrors MAX_PAGE in the engine. Deep pagination is a crawler artefact, not a
// shopper behaviour, and OFFSET makes it expensive.
const MAX_PAGE = 200;

// A shopper cannot meaningfully select more than a handful of values per facet;
// an unbounded list is a way to make one request build an enormous IN clause.
const MAX_FILTER_VALUES = 30;
const MAX_FILTER_SOURCES = 20;

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
  const page = Math.min(
    MAX_PAGE,
    Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1),
  );
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
    if (!filters[source] && Object.keys(filters).length >= MAX_FILTER_SOURCES) continue;
    const bucket = (filters[source] ??= []);
    if (bucket.length >= MAX_FILTER_VALUES) continue;
    bucket.push(value.slice(0, 200));
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

  const collection = sp.get("collection")?.slice(0, 200) || undefined;

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

/**
 * Escape a value for interpolation into an App Proxy Liquid response.
 *
 * Both halves matter. HTML-escaping stops markup injection in the rendered page;
 * `stripLiquid` stops the value being executed as Liquid, because Shopify renders
 * proxy responses through the theme's Liquid engine before the browser ever sees
 * them. HTML escaping alone leaves `{{ ... }}` intact — `{` and `%` are not
 * HTML-special — so a search term or product title could read shop data.
 */
export function escapeLiquidHtml(s: string): string {
  return stripLiquid(String(s ?? ""))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Identify the caller for rate-limiting purposes. Shopify forwards the shopper's
 * address in the usual proxy headers; the shop domain is the fallback so a
 * missing header degrades to a per-shop budget instead of no budget at all.
 */
export function clientKey(request: Request, shopDomain: string): string {
  const fwd =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("cf-connecting-ip") ||
    "";
  return `${shopDomain}:${fwd || "unknown"}`;
}
