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

  // Real, visitable URLs on the merchant's own domain. Linking them is the only
  // honest way to claim the SEO and AI-feed features: they can go and check.
  const storefront = {
    results: `https://${session.shop}/apps/anotherdev-search/results`,
    aiFeed: `https://${session.shop}/apps/anotherdev-search/ai`,
  };

  const empty = {
    productCount: 0,
    synced: false,
    searches7d: 0,
    zeroCount: 0,
    clicks7d: 0,
    isPro,
    themeEditorUrl,
    storefront,
  };
  if (!shop) return empty;

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
    ...empty,
    productCount,
    synced: !!syncState?.lastSyncAt,
    searches7d,
    zeroCount,
    clicks7d,
  };
};

// One line each. The dashboard is a map, not a manual.
const PAGES: { href: string; title: string; blurb: string; pro?: boolean }[] = [
  { href: "/app/sync", title: "Index", blurb: "Pull your catalog into the search engine." },
  { href: "/app/filters", title: "Filters", blurb: "Choose the filters shoppers see." },
  { href: "/app/synonyms", title: "Synonyms", blurb: "Teach search that words mean the same thing." },
  { href: "/app/merchandising", title: "Merchandising", blurb: "Pin, boost, bury, hide, redirect.", pro: true },
  { href: "/app/analytics", title: "Analytics", blurb: "Top terms, dead ends, click-through." },
  { href: "/app/plans", title: "Plans", blurb: "Free to 100 products. Pro for the rest." },
  { href: "/app/settings", title: "Settings", blurb: "Behaviour, layout, colours, swatches." },
];

// Responsive without media queries: tiles wrap when the column runs out of room.
const TILES = "repeat(auto-fit, minmax(170px, 1fr))";
const CARDS = "repeat(auto-fit, minmax(260px, 1fr))";

export default function Dashboard() {
  const d = useLoaderData<typeof loader>();
  const ctr = d.searches7d ? Math.round((d.clicks7d / d.searches7d) * 1000) / 10 : 0;

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
        <s-grid gridTemplateColumns={TILES} gap="base">
          <Stat label="Products indexed" value={d.productCount.toLocaleString()} />
          <Stat label="Searches" value={d.searches7d.toLocaleString()} />
          <Stat
            label="Zero results"
            value={d.zeroCount.toLocaleString()}
            tone={d.zeroCount > 0 ? "critical" : undefined}
            href={d.zeroCount > 0 ? "/app/analytics" : undefined}
          />
          <Stat label="Click-through" value={`${ctr}%`} />
          <Stat label="Plan" value={d.isPro ? "Pro" : "Free"} href="/app/plans" />
        </s-grid>
      </s-section>

      <s-grid gridTemplateColumns="repeat(12, 1fr)" gap="base">
        <s-grid-item gridColumn="span 7">
          <s-section heading="Setup">
            <s-stack direction="block" gap="base">
              <Step n="1" title="Sync your catalog" done={d.synced} href="/app/sync" cta="Open Index" />
              <Step n="2" title="Turn the app on in your theme" href={d.themeEditorUrl} cta="Open theme editor" external />
              <Step n="3" title="Optional: place blocks yourself" href={d.themeEditorUrl} cta="Add a block" external />
            </s-stack>
          </s-section>
        </s-grid-item>

        <s-grid-item gridColumn="span 5">
          <s-section heading="Storefront">
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">
                Step 2 upgrades your existing search box, replaces the search page
                with faceted results, and adds filters to collection pages.
              </s-text>
              <s-text color="subdued">
                Blocks you place by hand always win over the automatic version.
              </s-text>
            </s-stack>
          </s-section>
        </s-grid-item>
      </s-grid>

      <s-section heading="Search visibility">
        <s-grid gridTemplateColumns={CARDS} gap="base">
          <Card
            title="Crawlable results"
            badge="Included"
            tone="success"
            blurb="Real HTML in your theme with structured data and followable filter links."
            linkLabel="View page"
            href={d.storefront.results}
            external
          />
          <Card
            title="AI product feed"
            badge={d.isPro ? "Active" : "Pro"}
            tone={d.isPro ? "success" : "info"}
            blurb="schema.org products for assistants that shop on a customer's behalf."
            linkLabel={d.isPro ? "View feed" : "See Pro"}
            href={d.isPro ? d.storefront.aiFeed : "/app/plans"}
            external={d.isPro}
          />
          <Card
            title="Search to cart"
            badge="Included"
            tone="success"
            blurb="Clicks and add-to-carts attributed back to the search that caused them."
            linkLabel="Open Analytics"
            href="/app/analytics"
          />
        </s-grid>
      </s-section>

      <s-section heading="Pages">
        <s-grid gridTemplateColumns={CARDS} gap="base">
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

function Stat({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: string;
  tone?: "critical";
  href?: string;
}) {
  const body = (
    <s-stack direction="block" gap="small-500">
      <s-text color="subdued">{label}</s-text>
      <s-heading>{value}</s-heading>
      {tone === "critical" && <s-badge tone="critical">Needs attention</s-badge>}
    </s-stack>
  );
  return href ? (
    <s-clickable href={href} padding="base" background="subdued" borderRadius="base">
      {body}
    </s-clickable>
  ) : (
    <s-box padding="base" background="subdued" borderRadius="base">
      {body}
    </s-box>
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
        <s-button href={href} variant="tertiary" {...(external ? { target: "_top" } : {})}>
          {cta}
        </s-button>
      </s-grid>
    </s-box>
  );
}

function Card({
  title,
  badge,
  tone,
  blurb,
  linkLabel,
  href,
  external,
}: {
  title: string;
  badge: string;
  tone: "success" | "info";
  blurb: string;
  linkLabel: string;
  href: string;
  external?: boolean;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-stack direction="inline" gap="small-500" alignItems="center">
          <s-text type="strong">{title}</s-text>
          <s-badge tone={tone}>{badge}</s-badge>
        </s-stack>
        <s-text color="subdued">{blurb}</s-text>
        <s-link href={href} {...(external ? { target: "_blank" } : {})}>
          {linkLabel}
        </s-link>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
