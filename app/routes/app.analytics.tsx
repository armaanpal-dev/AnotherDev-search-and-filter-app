import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { getPlanStatus } from "../lib/billing.server";
import { getAnalytics, analyticsToCsv } from "../lib/analytics.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const { isPro, limits } = await getPlanStatus(billing);

  // The window comes from the plan. This page used to hardcode 30 days, so Free
  // shops saw more history than they were sold and Pro shops saw a third of theirs.
  const summary = await getAnalytics(shop.id, limits.analyticsDays);

  const url = new URL(request.url);
  if (url.searchParams.get("export") === "csv") {
    return new Response(analyticsToCsv(summary), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="search-analytics-${summary.windowDays}d.csv"`,
      },
    });
  }

  return { ...summary, isPro };
};

export default function AnalyticsPage() {
  const d = useLoaderData<typeof loader>();
  const peak = Math.max(1, ...d.daily.map((x) => x.searches));

  return (
    <s-page heading="Search analytics">
      <s-button slot="primary-action" href="?export=csv" variant="secondary">
        Export CSV
      </s-button>

      <s-section heading={`Last ${d.windowDays} days`}>
        <s-stack direction="inline" gap="large">
          <Metric label="Searches" value={d.total.toLocaleString()} />
          <Metric label="Click-through rate" value={`${d.ctr}%`} />
          <Metric label="Add-to-cart rate" value={`${d.cartRate}%`} />
          <Metric label="Zero-result rate" value={`${d.zeroRate}%`} />
        </s-stack>
        {!d.isPro && (
          <s-paragraph>
            <s-text color="subdued">
              Free shows {d.windowDays} days.{" "}
              <s-link href="/app/plans">Pro</s-link> extends this to 90 days.
            </s-text>
          </s-paragraph>
        )}
      </s-section>

      {d.daily.length > 1 && (
        <s-section heading="Searches per day">
          {/* A bar per day. Inline SVG keeps this dependency-free and prints
              correctly inside the embedded admin frame. */}
          <svg
            viewBox={`0 0 ${Math.max(d.daily.length * 12, 120)} 60`}
            style={{ width: "100%", height: 90 }}
            role="img"
            aria-label={`Searches per day for the last ${d.windowDays} days`}
          >
            {d.daily.map((x, i) => {
              const h = Math.max(1, (x.searches / peak) * 52);
              return (
                <rect
                  key={x.day}
                  x={i * 12 + 2}
                  y={56 - h}
                  width={8}
                  height={h}
                  rx={2}
                  fill="#4f46e5"
                >
                  <title>{`${x.day}: ${x.searches} searches, ${x.clicks} clicks, ${x.carts} added to cart`}</title>
                </rect>
              );
            })}
          </svg>
        </s-section>
      )}

      <s-section heading="Top searches">
        {d.top.length ? (
          <s-table>
            <s-table-header-row>
              <s-table-header>Query</s-table-header>
              <s-table-header>Searches</s-table-header>
              <s-table-header>Clicks</s-table-header>
              <s-table-header>CTR</s-table-header>
              <s-table-header>Avg results</s-table-header>
            </s-table-header-row>
            {d.top.map((t) => (
              <s-table-row key={t.term}>
                <s-table-cell>{t.term}</s-table-cell>
                <s-table-cell>{t.count}</s-table-cell>
                <s-table-cell>{t.clicks}</s-table-cell>
                <s-table-cell>{t.ctr}%</s-table-cell>
                <s-table-cell>{t.avgResults}</s-table-cell>
              </s-table-row>
            ))}
          </s-table>
        ) : (
          <s-paragraph><s-text color="subdued">No search data yet.</s-text></s-paragraph>
        )}
      </s-section>

      <s-section heading="Zero-result searches">
        <s-paragraph>
          <s-text color="subdued">
            Shoppers looked for these and found nothing. A synonym or a redirect fixes
            most of them.
          </s-text>
        </s-paragraph>
        {d.zero.length ? (
          <s-unordered-list>
            {d.zero.map((z) => (
              <s-list-item key={z.term}>
                {z.term} — {z.count}{" "}
                <s-link href={`/app/synonyms?prefill=${encodeURIComponent(z.term)}`}>Fix with synonym</s-link>
                {" · "}
                <s-link href={`/app/merchandising?redirect=${encodeURIComponent(z.term)}`}>Redirect</s-link>
              </s-list-item>
            ))}
          </s-unordered-list>
        ) : (
          <s-paragraph><s-text color="subdued">None — every search returns results.</s-text></s-paragraph>
        )}
      </s-section>

      <s-section heading="Searches nobody clicked">
        <s-paragraph>
          <s-text color="subdued">
            These returned products, but no one clicked any of them — the results were
            wrong rather than missing. Pinning the right product usually fixes it.
          </s-text>
        </s-paragraph>
        {d.noClick.length ? (
          <s-unordered-list>
            {d.noClick.map((z) => (
              <s-list-item key={z.term}>
                {z.term} — {z.count} searches, {z.avgResults} results each{" "}
                <s-link href={`/app/merchandising?query=${encodeURIComponent(z.term)}`}>
                  Merchandise this query
                </s-link>
              </s-list-item>
            ))}
          </s-unordered-list>
        ) : (
          <s-paragraph><s-text color="subdued">Nothing here — shoppers are clicking.</s-text></s-paragraph>
        )}
      </s-section>

      <s-section heading="Most-clicked products from search">
        {d.topProducts.length ? (
          <s-table>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>Clicks from search</s-table-header>
            </s-table-header-row>
            {d.topProducts.map((p) => (
              <s-table-row key={p.productId}>
                <s-table-cell>{p.title}</s-table-cell>
                <s-table-cell>{p.clicks}</s-table-cell>
              </s-table-row>
            ))}
          </s-table>
        ) : (
          <s-paragraph><s-text color="subdued">No clicks recorded yet.</s-text></s-paragraph>
        )}
      </s-section>

      <s-section slot="aside" heading="What these numbers measure">
        <s-paragraph>
          <s-text color="subdued">
            Click-through is the share of searches where a shopper opened a result.
            Add-to-cart is the share that ended with a product in the cart — the
            furthest we can follow a shopper, since checkout runs on Shopify&rsquo;s
            own domain rather than on your storefront. Both are attributed back to
            the specific search that produced them.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" minInlineSize="160px">
      <s-stack direction="block" gap="small">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
