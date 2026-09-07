import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../lib/shop.server";
import { limitsForPlanName } from "../lib/plans";
import { proxyBase } from "../lib/proxy.server";

/**
 * GET apps/anotherdev-search/llms — an llms.txt for the storefront.
 *
 * The AI feed at /ai is a machine contract; this is the document that tells an
 * agent the contract exists. An assistant asked to shop a store fetches the page
 * and gets HTML built for humans; llms.txt is the emerging convention for
 * handing it the structured entry point instead, in plain Markdown it can read
 * without a parser.
 *
 * Served through the App Proxy so it lives on the merchant's own domain, which
 * is the only place a crawler will look for it. Merchants who want it at the
 * conventional /llms.txt add one redirect in Shopify; the canonical URL is here
 * either way, and it is linked from the crawlable results page.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const shop = await getShopByDomain(session.shop);
  if (!shop) return new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const base = `https://${session.shop}${proxyBase(url.searchParams)}`;
  const hasAiFeed = limitsForPlanName(shop.planName).aiFeed;

  // Markdown, not JSON: llms.txt is read as prose. Nothing here is
  // merchant-authored free text, so there is no interpolation to escape — and
  // this is served as text/plain, which Shopify does not render through Liquid.
  const body = [
    `# ${session.shop}`,
    "",
    "> Product catalog for this Shopify store, queryable as structured data.",
    "",
    "## Search",
    "",
    hasAiFeed
      ? `- [Product search API](${base}/ai): schema.org \`SearchResultsPage\` JSON. Pass \`?q=\` for a query. Refine with the parameters listed under \`availableFilters\` (repeat a parameter for multi-select) and \`price.min\` / \`price.max\`. Paginate with \`?page=\`. Sort with \`?sort=\` (relevance, price_asc, price_desc, newest, bestselling).`
      : `- Structured product search is available on this store's paid plan and is not currently enabled.`,
    `- [Human-readable results](${base}/results?q=): the same catalog as crawlable HTML with ItemList structured data.`,
    "",
    "## Notes",
    "",
    "- Prices are returned in the store's own currency; check `priceCurrency` on each offer.",
    "- Only products published to the Online Store are listed, so every returned URL resolves.",
    "- `availability` is live stock at request time.",
    "- Product URLs are canonical and safe to link directly.",
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
