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

  if (!shop) {
    return { productCount: 0, synced: false, searches7d: 0, zeroCount: 0, isPro };
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [productCount, syncState, searches7d, zeroCount] = await Promise.all([
    prisma.product.count({ where: { shopId: shop.id } }),
    prisma.syncState.findUnique({ where: { shopId: shop.id } }),
    prisma.searchEvent.count({ where: { shopId: shop.id, createdAt: { gte: since } } }),
    prisma.searchEvent.count({ where: { shopId: shop.id, createdAt: { gte: since }, resultsCount: 0 } }),
  ]);

  return {
    productCount,
    synced: !!syncState?.lastSyncAt,
    searches7d,
    zeroCount,
    isPro,
  };
};

// Each admin page, described in plain language.
const FEATURES = [
  { href: "/app/sync", title: "Index", icon: "🔄", what: "Pull your catalog into the search engine.", why: "Nothing is searchable until you sync. After the first sync, product edits update automatically." },
  { href: "/app/filters", title: "Filters", icon: "🎛️", what: "Choose which filters shoppers see — price, brand, type, color, size, tags.", why: "Good filters are the #1 driver of search-to-purchase on collection and results pages." },
  { href: "/app/synonyms", title: "Synonyms", icon: "🔤", what: "Teach search that different words mean the same thing (e.g. “sneaker” = “trainer”).", why: "Turns zero-result searches into sales — shoppers rarely use your exact product wording." },
  { href: "/app/merchandising", title: "Merchandising", icon: "📌", what: "Pin, boost, bury or hide products for specific searches, and set redirects.", why: "Control what shows first — promote new arrivals, push overstock, hide out-of-season items.", pro: true },
  { href: "/app/analytics", title: "Analytics", icon: "📊", what: "See top searches, zero-result searches, click-through and conversion rates.", why: "Tells you exactly what shoppers want — and where search is failing them." },
  { href: "/app/plans", title: "Plans", icon: "💳", what: "Free covers up to 100 products; Pro unlocks unlimited + merchandising.", why: "Upgrade only when you outgrow Free." },
  { href: "/app/settings", title: "Settings", icon: "⚙️", what: "Toggle instant search, search-page takeover, collection filters, typo tolerance, quick add-to-cart, colours and swatches.", why: "Fine-tune behaviour and match the widget to your brand — everything lives here, not in the theme editor." },
];

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const step2Done = data.synced;

  return (
    <s-page heading="AnotherDev Search & Filters">
      <s-button slot="primary-action" href="/app/sync" variant="primary">
        {data.synced ? "Manage index" : "Run first sync"}
      </s-button>

      {/* What this app does */}
      <s-section heading="What this app does">
        <s-paragraph>
          Replaces your store’s basic search with a fast, typo-tolerant search bar and
          smart filters — the kind big stores use. Shoppers find products in fewer clicks,
          which means more sales. It also makes your search pages SEO- and AI-friendly.
        </s-paragraph>
        <s-stack direction="inline" gap="large">
          <Metric label="Products indexed" value={data.productCount.toLocaleString()} />
          <Metric label="Searches (7 days)" value={data.searches7d.toLocaleString()} />
          <Metric label="Zero-result (7d)" value={data.zeroCount.toLocaleString()} />
          <Metric label="Plan" value={data.isPro ? "Pro" : "Free"} />
        </s-stack>
      </s-section>

      {/* Setup */}
      <s-section heading="Setup — 3 steps to go live">
        <s-ordered-list>
          <s-list-item>
            <s-text type="strong">Sync your catalog.</s-text>{" "}
            {step2Done ? (
              <s-badge tone="success">Done</s-badge>
            ) : (
              <>Go to <s-link href="/app/sync">Index</s-link> → “Run first sync”. {" "}
                <s-badge tone="warning">To do</s-badge></>
            )}
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Turn the app on in your theme.</s-text>{" "}
            In your store: <s-text type="strong">Online Store → Themes → Customize → App embeds</s-text>,
            then enable <s-text type="strong">AnotherDev Search</s-text>. That one switch upgrades
            your existing search box, replaces your search page with faceted results, and adds
            filters to collection pages — no blocks to place.
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Optional: place blocks where you want them.</s-text>{" "}
            In the theme editor click <s-text type="strong">Add section / Add block</s-text> and choose{" "}
            <s-text type="strong">AnotherDev Search Bar</s-text>,{" "}
            <s-text type="strong">AnotherDev Search Results</s-text>, or{" "}
            <s-text type="strong">AnotherDev Recommendations</s-text> (a “you may also like” rail
            for product pages). A block you place always wins over the automatic version.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      {/* Feature guide */}
      <s-section heading="What each page does">
        <s-stack direction="block" gap="base">
          {FEATURES.map((f) => (
            <s-box key={f.href} padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-text type="strong">{f.icon} {f.title}</s-text>
                  {f.pro && <s-badge tone="info">Pro</s-badge>}
                  <s-link href={f.href}>Open →</s-link>
                </s-stack>
                <s-text>{f.what}</s-text>
                <s-text color="subdued">{f.why}</s-text>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      {/* Aside: where things live on the storefront */}
      <s-section slot="aside" heading="Where it appears for shoppers">
        <s-paragraph>
          <s-text color="subdued">
            The search bar sits in your header and shows instant results as customers type.
            The results page shows the full grid with filters down the side (a drawer on mobile).
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Not seeing it in your theme?">
        <s-paragraph>
          <s-text color="subdued">
            First enable the app under <s-text type="strong">App embeds</s-text> (step 2 above).
            If a block won’t drop into your header, your theme may only allow app blocks in the
            body — add the <s-text type="strong">Search Bar</s-text> block to a section that accepts
            blocks, or use the search on the results page.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" minInlineSize="150px">
      <s-stack direction="block" gap="small">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
