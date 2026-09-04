import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../lib/shop.server";
import { getPlanStatus } from "../lib/billing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  const { isPro } = await getPlanStatus(billing);

  // Deep link into the theme editor with our app embed already switched on, so
  // step 2 is one click instead of a hunt through Theme settings. Shopify's
  // documented shape is {api_key}/{block handle}, where the handle is the
  // filename of the block's Liquid file (blocks/app-embed.liquid).
  const themeEditorUrl =
    `https://${session.shop}/admin/themes/current/editor` +
    `?context=apps&activateAppId=${process.env.SHOPIFY_API_KEY}/app-embed`;

  // The storefront surfaces this app adds, on the merchant's own domain. These
  // are real, visitable URLs — showing them is the only honest way to claim the
  // SEO and AI-feed features, because the merchant can go and check them.
  const storefront = {
    results: `https://${session.shop}/apps/anotherdev-search/results`,
    aiFeed: `https://${session.shop}/apps/anotherdev-search/ai`,
  };

  if (!shop) {
    return {
      productCount: 0,
      synced: false,
      searches7d: 0,
      zeroCount: 0,
      clicks7d: 0,
      isPro,
      themeEditorUrl,
      storefront,
    };
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [productCount, syncState, searches7d, zeroCount, clicks7d] = await Promise.all([
    prisma.product.count({ where: { shopId: shop.id } }),
    prisma.syncState.findUnique({ where: { shopId: shop.id } }),
    prisma.searchEvent.count({ where: { shopId: shop.id, createdAt: { gte: since } } }),
    prisma.searchEvent.count({ where: { shopId: shop.id, createdAt: { gte: since }, resultsCount: 0 } }),
    prisma.searchEvent.count({
      where: { shopId: shop.id, createdAt: { gte: since }, clickedProductId: { not: null } },
    }),
  ]);

  return {
    productCount,
    synced: !!syncState?.lastSyncAt,
    searches7d,
    zeroCount,
    clicks7d,
    isPro,
    themeEditorUrl,
    storefront,
  };
};

// Each admin page, in plain language. `pro` marks pages whose writes are gated.
const PAGES = [
  {
    href: "/app/sync",
    title: "Index",
    what: "Pull your catalog into the search engine.",
    why: "Nothing is searchable until you sync. After the first sync, product edits update automatically through webhooks.",
  },
  {
    href: "/app/filters",
    title: "Filters",
    what: "Choose which filters shoppers see: price, brand, type, colour, size, tags.",
    why: "Filters are the strongest lever on search-to-purchase for collection and results pages.",
  },
  {
    href: "/app/synonyms",
    title: "Synonyms",
    what: "Teach search that different words mean the same thing, such as sneaker and trainer.",
    why: "Turns zero-result searches into sales. Shoppers rarely use your exact product wording.",
  },
  {
    href: "/app/merchandising",
    title: "Merchandising",
    what: "Pin, boost, bury or hide products for specific searches, and set redirects.",
    why: "Control what shows first: promote new arrivals, move overstock, hide out-of-season items.",
    pro: true,
  },
  {
    href: "/app/analytics",
    title: "Analytics",
    what: "Top searches, zero-result searches, click-through and add-to-cart rates.",
    why: "Tells you what shoppers want, and where search is failing them.",
  },
  {
    href: "/app/plans",
    title: "Plans",
    what: "Free covers up to 100 products. Pro unlocks unlimited plus merchandising.",
    why: "Upgrade only when you outgrow Free.",
  },
  {
    href: "/app/settings",
    title: "Settings",
    what: "Instant search, search-page takeover, collection filters, typo tolerance, quick add to cart, colours and swatches.",
    why: "Everything about the storefront widget lives here rather than in the theme editor.",
  },
];

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const ctr = data.searches7d
    ? Math.round((data.clicks7d / data.searches7d) * 1000) / 10
    : 0;

  return (
    <s-page heading="AnotherDev Search and Filters">
      <s-button slot="primary-action" href="/app/sync" variant="primary">
        {data.synced ? "Manage index" : "Run first sync"}
      </s-button>

      {!data.synced && (
        <s-banner tone="warning" heading="Your catalog is not indexed yet">
          <s-paragraph>
            Shoppers will not see any results until the first sync finishes. It
            usually takes a couple of minutes.
          </s-paragraph>
          <s-button slot="primary-action" href="/app/sync" variant="primary">
            Run first sync
          </s-button>
        </s-banner>
      )}

      <s-section heading="Last 7 days">
        <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr" gap="base">
          <Metric label="Products indexed" value={data.productCount.toLocaleString()} />
          <Metric label="Searches" value={data.searches7d.toLocaleString()} />
          <Metric label="Zero results" value={data.zeroCount.toLocaleString()} />
          <Metric label="Click-through rate" value={`${ctr}%`} />
        </s-grid>
        <s-paragraph>
          <s-text color="subdued">
            Zero-result searches are the fastest thing to fix. Each one is a
            shopper who wanted something and was shown nothing.{" "}
            <s-link href="/app/analytics">See which terms failed</s-link>.
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section heading="Setup">
        <s-ordered-list>
          <s-list-item>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text type="strong">Sync your catalog.</s-text>
              {data.synced ? (
                <s-badge tone="success">Done</s-badge>
              ) : (
                <s-badge tone="warning">To do</s-badge>
              )}
            </s-stack>
            <s-paragraph>
              <s-text color="subdued">
                Open <s-link href="/app/sync">Index</s-link> and run the first
                sync. Product edits stay up to date automatically after that.
              </s-text>
            </s-paragraph>
          </s-list-item>

          <s-list-item>
            <s-text type="strong">Turn the app on in your theme.</s-text>
            <s-paragraph>
              <s-text color="subdued">
                <s-link href={data.themeEditorUrl} target="_top">
                  Open the theme editor with the app embed switched on
                </s-link>
                , then click Save. That one switch upgrades your existing search
                box, replaces your search page with faceted results, and adds
                filters to collection pages. There are no blocks to place.
              </s-text>
            </s-paragraph>
          </s-list-item>

          <s-list-item>
            <s-text type="strong">Optional: place blocks yourself.</s-text>
            <s-paragraph>
              <s-text color="subdued">
                In the theme editor, use Add section or Add block and choose
                AnotherDev Search Bar, AnotherDev Search Results, or AnotherDev
                Recommended. A block you place always takes priority over the
                automatic version.
              </s-text>
            </s-paragraph>
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section heading="Search visibility">
        <s-paragraph>
          Three things this app does beyond the search box itself. Each one is a
          real URL on your own domain, so you can open it and check.
        </s-paragraph>

        <s-stack direction="block" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small-200">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text type="strong">Crawlable results page</s-text>
                <s-badge tone="success">Included</s-badge>
              </s-stack>
              <s-text color="subdued">
                Search results render as real HTML inside your theme, with
                ItemList structured data, a canonical link, and filter links
                search engines can follow. Filtered pages are marked noindex so
                they do not compete with your product pages.
              </s-text>
              <s-link href={data.storefront.results} target="_blank">
                {data.storefront.results}
              </s-link>
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small-200">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text type="strong">Product feed for AI shopping agents</s-text>
                {data.isPro ? (
                  <s-badge tone="success">Active</s-badge>
                ) : (
                  <s-badge tone="info">Pro</s-badge>
                )}
              </s-stack>
              <s-text color="subdued">
                A documented JSON endpoint returning schema.org products, so
                assistants that shop on a customer&rsquo;s behalf can query and
                refine your catalog directly.
                {data.isPro
                  ? ""
                  : " On the Free plan this endpoint returns an upgrade notice instead of products."}
              </s-text>
              {data.isPro ? (
                <s-link href={data.storefront.aiFeed} target="_blank">
                  {data.storefront.aiFeed}
                </s-link>
              ) : (
                <s-link href="/app/plans">See the Pro plan</s-link>
              )}
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small-200">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text type="strong">Search-to-cart tracking</s-text>
                <s-badge tone="success">Included</s-badge>
              </s-stack>
              <s-text color="subdued">
                Every result click and add to cart is attributed back to the
                search that produced it, which is what the click-through and
                add-to-cart rates in Analytics are measured from. Add to cart is
                the furthest point the storefront can observe, because checkout
                runs on Shopify&rsquo;s own domain.
              </s-text>
              <s-link href="/app/analytics">Open Analytics</s-link>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="What each page does">
        <s-stack direction="block" gap="base">
          {PAGES.map((p) => (
            <s-box key={p.href} padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-link href={p.href}>
                    <s-text type="strong">{p.title}</s-text>
                  </s-link>
                  {p.pro && <s-badge tone="info">Pro</s-badge>}
                </s-stack>
                <s-text>{p.what}</s-text>
                <s-text color="subdued">{p.why}</s-text>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Where shoppers see it">
        <s-paragraph>
          <s-text color="subdued">
            The search bar sits in your header and shows results as customers
            type. The results page shows the full grid with filters down the
            side, and a filter drawer on mobile.
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Not seeing it in your theme?">
        <s-paragraph>
          <s-text color="subdued">
            Enable the app under App embeds first. The{" "}
            <s-link href={data.themeEditorUrl} target="_top">theme editor link</s-link>{" "}
            in step 2 takes you straight there. If a block will not drop into
            your header, your theme may only allow app blocks in the body. The
            app embed covers that case on its own.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
