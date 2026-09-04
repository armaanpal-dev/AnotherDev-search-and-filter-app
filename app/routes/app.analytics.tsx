import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { getPlanStatus } from "../lib/billing.server";
import { getAnalytics, analyticsToCsv } from "../lib/analytics.server";
import { Stat, Row, Bar, Empty, TILES, WIDE } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const { plan, limits } = await getPlanStatus(billing, shop.planOverride);

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

  return { ...summary, plan };
};

// Below this many searches a percentage is noise. Two searches, one of which
// found nothing, is not a 50% failure rate worth flagging in red.
const MIN_SAMPLE = 20;

export default function AnalyticsPage() {
  const d = useLoaderData<typeof loader>();
  const peak = Math.max(1, ...d.daily.map((x) => x.searches));
  const topPeak = Math.max(1, ...d.top.map((t) => t.count));
  const prodPeak = Math.max(1, ...d.topProducts.map((p) => p.clicks));

  return (
    <s-page heading="Search analytics">
      <s-button slot="primary-action" href="?export=csv" variant="secondary">
        Export CSV
      </s-button>

      <s-section heading={`Last ${d.windowDays} days`}>
        <s-grid gridTemplateColumns={TILES} gap="large-100">
          <Stat label="Searches" value={d.total.toLocaleString()} />
          <Stat label="Click-through" value={`${d.ctr}%`} />
          <Stat label="Add to cart" value={`${d.cartRate}%`} />
          <Stat
            label="Zero results"
            value={`${d.zeroRate}%`}
            {...(d.total >= MIN_SAMPLE && d.zeroRate > 10
              ? { tone: "critical" as const, hint: "High" }
              : {})}
          />
        </s-grid>
        {d.plan !== "pro" && (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-text color="subdued">
              This plan shows {d.windowDays} days.{" "}
              <s-link href="/app/plans">Pro</s-link> extends this to 90.
            </s-text>
          </s-box>
        )}
      </s-section>

      {d.daily.length > 1 && (
        <s-section heading="Searches per day">
          {/* One bar per day. Polaris ships no chart component, so this is a
              small inline SVG: dependency-free, and it prints correctly inside
              the embedded admin frame. currentColor makes it follow the theme
              rather than pinning a brand hex that breaks in dark mode. */}
          <svg
            viewBox={`0 0 ${Math.max(d.daily.length * 12, 120)} 60`}
            style={{ width: "100%", height: 96 }}
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
                  fill="currentColor"
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
          <s-stack direction="block" gap="small-500">
            {d.top.map((t) => (
              <Bar key={t.term} label={t.term} value={t.count} max={topPeak} />
            ))}
          </s-stack>
        ) : (
          <Empty heading="No searches yet">
            Numbers appear here once shoppers start using the search box.
          </Empty>
        )}
      </s-section>

      <s-grid gridTemplateColumns={WIDE} gap="large-100">
        <s-grid-item>
          <s-section heading="Found nothing">
            <s-text color="subdued">
              Shoppers searched for these and got no results.
            </s-text>
            {d.zero.length ? (
              <s-stack direction="block" gap="small-300">
                {d.zero.slice(0, 10).map((z) => (
                  <Row
                    key={z.term}
                    actions={
                      <>
                        <s-button
                          variant="secondary"
                          href={`/app/synonyms?prefill=${encodeURIComponent(z.term)}`}
                        >
                          Synonym
                        </s-button>
                        <s-button
                          variant="secondary"
                          href={`/app/merchandising?redirect=${encodeURIComponent(z.term)}`}
                        >
                          Redirect
                        </s-button>
                      </>
                    }
                  >
                    <s-text type="strong">{z.term}</s-text>
                    <s-text color="subdued">{z.count} searches</s-text>
                  </Row>
                ))}
              </s-stack>
            ) : (
              <Empty heading="Every search returns results" />
            )}
          </s-section>
        </s-grid-item>

        <s-grid-item>
          <s-section heading="Nobody clicked">
            <s-text color="subdued">
              These returned products, but no one opened any. The results were
              wrong rather than missing.
            </s-text>
            {d.noClick.length ? (
              <s-stack direction="block" gap="small-300">
                {d.noClick.slice(0, 10).map((z) => (
                  <Row
                    key={z.term}
                    actions={
                      <s-button
                        variant="secondary"
                        href={`/app/merchandising?query=${encodeURIComponent(z.term)}`}
                      >
                        Merchandise
                      </s-button>
                    }
                  >
                    <s-text type="strong">{z.term}</s-text>
                    <s-text color="subdued">
                      {z.count} searches, {z.avgResults} results each
                    </s-text>
                  </Row>
                ))}
              </s-stack>
            ) : (
              <Empty heading="Shoppers are clicking" />
            )}
          </s-section>
        </s-grid-item>
      </s-grid>

      <s-section heading="Most clicked from search">
        {d.topProducts.length ? (
          <s-stack direction="block" gap="small-500">
            {d.topProducts.map((p) => (
              <Bar key={p.productId} label={p.title} value={p.clicks} max={prodPeak} />
            ))}
          </s-stack>
        ) : (
          <Empty heading="No clicks recorded yet" />
        )}
      </s-section>

      <s-section slot="aside" heading="What these measure">
        <s-paragraph>
          <s-text color="subdued">
            Click-through is the share of searches where a shopper opened a
            result. Add to cart is the share that ended with a product in the
            cart, which is as far as we can follow a shopper: checkout runs on
            Shopify&rsquo;s domain, not your storefront. Both are attributed back
            to the specific search that produced them.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
