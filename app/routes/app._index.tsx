import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../lib/shop.server";
import { getPlanStatus } from "../lib/billing.server";
import { PLAN_LIMITS } from "../lib/plans";
import { DEFAULT_PROXY_BASE } from "../lib/proxy.server";
// The shared primitives exist so seven pages cannot drift into seven looks.
// This page used to define its own Stat, Card and column templates alongside
// them, which is exactly the drift they were introduced to prevent.
import { Stat, Card, TILES, CARDS } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  const { plan, limits } = await getPlanStatus(billing, shop?.planOverride);

  // Deep link into the theme editor with our app embed already switched on, so
  // step 2 is one click instead of a hunt through Theme settings. Shopify's
  // documented shape is {api_key}/{block handle}, where the handle is the
  // filename of the block's Liquid file (blocks/app-embed.liquid).
  const themeEditorUrl =
    `https://${session.shop}/admin/themes/current/editor` +
    `?context=apps&activateAppId=${process.env.SHOPIFY_API_KEY}/app-embed`;

  // Real, visitable URLs on the merchant's own domain. Linking them is the only
  // honest way to claim the SEO and AI-feed features: they can go and check.
  //
  // Built from the shared constant, not a second hardcoded copy of the path.
  // The admin has no proxy request to read `path_prefix` from, so if these two
  // ever disagree with shopify.app.toml both links silently 404 — which is what
  // was happening.
  const storefront = {
    results: `https://${session.shop}${DEFAULT_PROXY_BASE}/results`,
    aiFeed: `https://${session.shop}${DEFAULT_PROXY_BASE}/ai`,
    llms: `https://${session.shop}${DEFAULT_PROXY_BASE}/llms`,
  };

  const empty = {
    productCount: 0,
    synced: false,
    searches7d: 0,
    zeroCount: 0,
    clicks7d: 0,
    revenue7d: 0,
    currency: "",
    embedActivated: false,
    plan,
    aiFeed: limits.aiFeed,
    themeEditorUrl,
    storefront,
  };
  if (!shop) return empty;

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [productCount, syncState, searches7d, zeroCount, clicks7d, revenue] =
    await Promise.all([
      prisma.product.count({ where: { shopId: shop.id } }),
      prisma.syncState.findUnique({ where: { shopId: shop.id } }),
      prisma.searchEvent.count({ where: { shopId: shop.id, createdAt: { gte: since } } }),
      prisma.searchEvent.count({ where: { shopId: shop.id, createdAt: { gte: since }, resultsCount: 0 } }),
      prisma.searchEvent.count({
        where: { shopId: shop.id, createdAt: { gte: since }, clickedProductId: { not: null } },
      }),
      prisma.searchEvent.aggregate({
        where: { shopId: shop.id, createdAt: { gte: since }, purchased: true },
        _sum: { revenue: true },
      }),
    ]);

  // Step 2 is the one a merchant most often thinks they did and did not. A
  // search event can only exist if the widget ran on the storefront, so the
  // presence of one is proof the embed is live — no extra API call, and no
  // banner nagging someone who already finished.
  const embedActivated = searches7d > 0 || !!shop.onboardedAt;
  if (embedActivated && !shop.onboardedAt) {
    await prisma.shop
      .update({ where: { id: shop.id }, data: { onboardedAt: new Date(), onboarded: true } })
      .catch(() => {});
  }

  return {
    ...empty,
    productCount,
    synced: !!syncState?.lastSyncAt,
    searches7d,
    zeroCount,
    clicks7d,
    revenue7d: revenue._sum.revenue ?? 0,
    currency: shop.currencyCode ?? "",
    embedActivated,
  };
};

// One line each. The dashboard is a map, not a manual.
const PAGES: { href: string; title: string; blurb: string; pro?: boolean }[] = [
  { href: "/app/sync", title: "Index", blurb: "Pull your catalog into the search engine." },
  { href: "/app/preview", title: "Test search", blurb: "See what shoppers get, and why it ranks that way." },
  { href: "/app/filters", title: "Filters", blurb: "Choose the filters shoppers see." },
  { href: "/app/synonyms", title: "Synonyms", blurb: "Teach search that words mean the same thing." },
  { href: "/app/merchandising", title: "Merchandising", blurb: "Pin, boost, bury, hide, redirect.", pro: true },
  { href: "/app/analytics", title: "Analytics", blurb: "Top terms, dead ends, revenue." },
  { href: "/app/plans", title: "Plans", blurb: "Free to 100 products. Pro for the rest." },
  { href: "/app/settings", title: "Settings", blurb: "Behaviour, layout, colours, swatches." },
];

export default function Dashboard() {
  const d = useLoaderData<typeof loader>();
  const ctr = d.searches7d ? Math.round((d.clicks7d / d.searches7d) * 1000) / 10 : 0;
  const money = (n: number) =>
    n
      ? `${d.currency ? d.currency + " " : ""}${Math.round(n).toLocaleString()}`
      : "—";

  return (
    <s-page heading="AnotherDev Search and Filters">
      <s-button slot="primary-action" href="/app/sync" variant="primary">
        {d.synced ? "Manage index" : "Run first sync"}
      </s-button>

      {!d.synced && (
        <s-banner tone="warning" heading="Your catalog is not indexed yet">
          <s-paragraph>Shoppers see no results until the first sync finishes.</s-paragraph>
          <s-button slot="primary-action" href="/app/sync" variant="primary">
            Run first sync
          </s-button>
        </s-banner>
      )}

      <s-section heading="Last 7 days">
        <s-grid gridTemplateColumns={TILES} gap="large-100">
          <Stat label="Products indexed" value={d.productCount.toLocaleString()} />
          <Stat label="Searches" value={d.searches7d.toLocaleString()} />
          <Stat
            label="Zero results"
            value={d.zeroCount.toLocaleString()}
            {...(d.zeroCount > 0
              ? { tone: "critical" as const, hint: "Needs attention", href: "/app/analytics" }
              : {})}
          />
          <Stat label="Click-through" value={`${ctr}%`} />
          <Stat
            label="Search revenue"
            value={money(d.revenue7d)}
            hint={d.revenue7d ? undefined : "Needs the pixel"}
            href="/app/analytics"
          />
          <Stat label="Plan" value={PLAN_LIMITS[d.plan].name} href="/app/plans" />
        </s-grid>
      </s-section>

      <s-section heading="Setup">
        <s-grid gridTemplateColumns="repeat(12, 1fr)" gap="large-100">
          <s-grid-item gridColumn="span 7">
            <s-stack direction="block" gap="base">
              <Step n="1" title="Sync your catalog" done={d.synced} href="/app/sync" cta="Open Index" />
              <Step
                n="2"
                title="Turn the app on in your theme"
                done={d.embedActivated}
                href={d.themeEditorUrl}
                cta="Open theme editor"
                external
              />
              <Step n="3" title="Optional: place blocks yourself" href={d.themeEditorUrl} cta="Add a block" external />
            </s-stack>
          </s-grid-item>

          <s-grid-item gridColumn="span 5">
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small-300">
                <s-text type="strong">What step 2 changes</s-text>
                <s-text color="subdued">
                  It upgrades your existing search box, replaces the search page
                  with faceted results, and adds filters to collection pages.
                </s-text>
                <s-text color="subdued">
                  Blocks you place by hand always win over the automatic version.
                </s-text>
              </s-stack>
            </s-box>
          </s-grid-item>
        </s-grid>
      </s-section>

      <s-section heading="Search visibility">
        <s-grid gridTemplateColumns={CARDS} gap="large-100">
          <Card title="Crawlable results" badge="Included" tone="success">
            <s-text color="subdued">
              Real HTML in your theme with structured data and followable filter links.
            </s-text>
            <s-link href={d.storefront.results} target="_blank">View page</s-link>
          </Card>
          <Card
            title="AI product feed"
            badge={d.aiFeed ? "Active" : "Pro"}
            tone={d.aiFeed ? "success" : "info"}
          >
            <s-text color="subdued">
              schema.org products for assistants that shop on a customer&rsquo;s behalf,
              plus an llms.txt telling them the feed exists.
            </s-text>
            {d.aiFeed ? (
              <s-stack direction="inline" gap="base">
                <s-link href={d.storefront.aiFeed} target="_blank">View feed</s-link>
                <s-link href={d.storefront.llms} target="_blank">llms.txt</s-link>
              </s-stack>
            ) : (
              <s-link href="/app/plans">See Pro</s-link>
            )}
          </Card>
          <Card
            title="Search to revenue"
            badge={d.revenue7d ? "Active" : "Included"}
            tone={d.revenue7d ? "success" : "info"}
          >
            <s-text color="subdued">
              Clicks, add-to-carts and completed orders attributed back to the search
              that caused them.
            </s-text>
            <s-link href="/app/analytics">Open Analytics</s-link>
          </Card>
        </s-grid>
      </s-section>

      <s-section heading="Pages">
        <s-grid gridTemplateColumns={CARDS} gap="large-100">
          {PAGES.map((p) => (
            <s-clickable key={p.href} href={p.href} padding="base" background="subdued" borderRadius="base">
              <s-stack direction="block" gap="small-500">
                <s-stack direction="inline" gap="small-500" alignItems="center">
                  <s-text type="strong">{p.title}</s-text>
                  {p.pro && <s-badge tone="info">Pro</s-badge>}
                </s-stack>
                <s-text color="subdued">{p.blurb}</s-text>
              </s-stack>
            </s-clickable>
          ))}
        </s-grid>
      </s-section>
    </s-page>
  );
}

function Step({
  n,
  title,
  done,
  href,
  cta,
  external,
}: {
  n: string;
  title: string;
  done?: boolean;
  href: string;
  cta: string;
  external?: boolean;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-grid gridTemplateColumns="auto 1fr auto" gap="base" alignItems="center">
        <s-badge tone={done ? "success" : undefined}>{done ? "Done" : n}</s-badge>
        <s-text type="strong">{title}</s-text>
        <s-button href={href} variant="secondary" {...(external ? { target: "_top" } : {})}>
          {cta}
        </s-button>
      </s-grid>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
