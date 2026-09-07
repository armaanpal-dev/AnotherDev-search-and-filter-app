import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { getPlanStatus } from "../lib/billing.server";
import { getAnalytics, analyticsToCsv } from "../lib/analytics.server";
import { getPixelState } from "../lib/pixel.server";
import { Stat, Row, Bar, Empty, Card, TILES, WIDE } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing, admin } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const { plan, limits } = await getPlanStatus(billing, shop.planOverride);

  const url = new URL(request.url);

  // The window comes from the plan, and the merchant can narrow it further.
  // The page used to hardcode 30 days, so Free shops saw more history than they
  // were sold and Pro shops saw a third of theirs.
  const requested = parseInt(url.searchParams.get("days") ?? "", 10);
  const windowDays =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, limits.analyticsDays)
      : limits.analyticsDays;

  const summary = await getAnalytics(shop.id, windowDays);

  if (url.searchParams.get("export") === "csv") {
    return new Response(analyticsToCsv(summary), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="search-analytics-${summary.windowDays}d.csv"`,
      },
    });
  }

  // Purchase numbers are only meaningful once the pixel is live; without it the
  // revenue tiles would read as "search earns nothing" rather than "not measured
  // yet", which is the opposite of the truth.
  const pixel = await getPixelState(admin);

  return { ...summary, plan, maxDays: limits.analyticsDays, pixel };
};

// Below this many searches a percentage is noise. Two searches, one of which
// found nothing, is not a 50% failure rate worth flagging in red.
const MIN_SAMPLE = 20;

/** The ranges offered, capped to what the plan actually retains. */
const RANGES = [7, 30, 90, 365];

export default function AnalyticsPage() {
  const d = useLoaderData<typeof loader>();
  const peak = Math.max(1, ...d.daily.map((x) => x.searches));
  const topPeak = Math.max(1, ...d.top.map((t) => t.count));
  const prodPeak = Math.max(1, ...d.topProducts.map((p) => p.clicks));
  const money = (n: number) =>
    `${d.currency ? d.currency + " " : ""}${Math.round(n).toLocaleString()}`;

  return (
    <s-page heading="Search analytics">
      <s-button
        slot="primary-action"
        href={`?export=csv&days=${d.windowDays}`}
        variant="secondary"
        download={`search-analytics-${d.windowDays}d.csv`}
      >
        Export CSV
      </s-button>

      <s-section heading={`Last ${d.windowDays} days`}>
        {/* Range picker. The window was previously fixed to the plan's maximum,
            so a merchant checking whether yesterday's change helped had to read
            a 90-day average that buried it. */}
        <s-stack direction="inline" gap="small-300">
          {RANGES.filter((r) => r <= d.maxDays).map((r) => (
            <s-button
              key={r}
              href={`?days=${r}`}
              variant={r === d.windowDays ? "primary" : "secondary"}
            >
              {r === 365 ? "1 year" : `${r} days`}
            </s-button>
          ))}
        </s-stack>

        <s-grid gridTemplateColumns={TILES} gap="large-100">
          <Stat
            label="Searches"
            value={d.total.toLocaleString()}
            {...delta(d.total, d.previous.total)}
          />
          <Stat label="Click-through" value={`${d.ctr}%`} {...delta(d.ctr, d.previous.ctr, "pt")} />
          <Stat
            label="Add to cart"
            value={`${d.cartRate}%`}
            {...delta(d.cartRate, d.previous.cartRate, "pt")}
          />
          <Stat
            label="Search revenue"
            value={d.pixel === "active" ? money(d.revenue) : "—"}
            {...(d.pixel === "active"
              ? delta(d.revenue, d.previous.revenue)
              : { hint: "Turn on tracking", tone: "info" as const })}
          />
          <Stat
            label="Zero results"
            value={`${d.zeroRate}%`}
            {...(d.total >= MIN_SAMPLE && d.zeroRate > 10
              ? { tone: "critical" as const, hint: "High" }
              : delta(d.zeroRate, d.previous.zeroRate, "pt", true))}
          />
        </s-grid>

        {d.pixel !== "active" && (
          <s-banner tone="info" heading="Revenue tracking is not switched on">
            <s-paragraph>
              Checkout runs on Shopify&rsquo;s own domain, so measuring which searches
              lead to orders needs a small pixel. Turn it on in{" "}
              <s-link href="/app/settings">Settings</s-link> and this page starts
              reporting search-driven revenue.
            </s-paragraph>
          </s-banner>
        )}

        {d.plan !== "pro" && d.plan !== "custom" && (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-text color="subdued">
              This plan keeps {d.maxDays} days of history.{" "}
              <s-link href="/app/plans">Pro</s-link> extends this to 90.
            </s-text>
          </s-box>
        )}
      </s-section>

      {d.daily.length > 1 && (
        <s-section heading="Searches per day">
          {/* One bar per day, INCLUDING days with nothing.
              The query used to return only days that had events while this chart
              plots by array index, so a quiet week collapsed and the surviving
              bars sat side by side — a trend line describing something that never
              happened. Polaris ships no chart component, so this is a small
              inline SVG: dependency-free, prints correctly inside the embedded
              admin frame, and currentColor makes it follow the theme. */}
          <svg
            viewBox={`0 0 ${Math.max(d.daily.length * 12, 120)} 60`}
            style={{ width: "100%", height: 96 }}
            role="img"
            aria-label={`Searches per day for the last ${d.windowDays} days, peaking at ${peak}`}
          >
            {d.daily.map((x, i) => {
              const h = (x.searches / peak) * 52;
              return (
                <g key={x.day}>
                  {/* A hairline for an empty day, so "nothing happened" is
                      visible rather than absent. */}
                  <rect
                    x={i * 12 + 2}
                    y={x.searches ? 56 - Math.max(1, h) : 55}
                    width={8}
                    height={x.searches ? Math.max(1, h) : 1}
                    rx={2}
                    fill="currentColor"
                    opacity={x.searches ? 1 : 0.25}
                  >
                    <title>{`${x.day}: ${x.searches} searches, ${x.clicks} clicks, ${x.carts} added to cart${
                      x.purchases ? `, ${x.purchases} purchased` : ""
                    }`}</title>
                  </rect>
                </g>
              );
            })}
          </svg>
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-text color="subdued">{d.daily[0]?.day}</s-text>
            <s-stack direction="inline" gap="none" alignItems="end">
              <s-text color="subdued">{d.daily[d.daily.length - 1]?.day}</s-text>
            </s-stack>
          </s-grid>
        </s-section>
      )}

      {d.buckets.length > 1 && (
        <s-section heading="A/B test">
          <s-paragraph>
            <s-text color="subdued">
              Two merchandising strategies, running side by side. Shoppers are split
              evenly and stay in the same group, so these are comparable.
            </s-text>
          </s-paragraph>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap="large-100">
            {d.buckets.map((b) => {
              const other = d.buckets.find((x) => x.bucket !== b.bucket);
              const better =
                other && b.purchaseRate > other.purchaseRate && b.searches >= MIN_SAMPLE;
              return (
                <Card
                  key={b.bucket}
                  title={`Group ${b.bucket.toUpperCase()}`}
                  {...(better ? { badge: "Ahead", tone: "success" as const } : {})}
                >
                  <Bar label="Searches" value={b.searches} max={Math.max(...d.buckets.map((x) => x.searches))} />
                  <s-text color="subdued">
                    {b.ctr}% clicked · {b.cartRate}% added to cart
                    {d.pixel === "active" ? ` · ${b.purchaseRate}% bought` : ""}
                  </s-text>
                  {d.pixel === "active" && (
                    <s-text type="strong">{money(b.revenue)}</s-text>
                  )}
                </Card>
              );
            })}
          </s-grid>
          {d.buckets.some((b) => b.searches < MIN_SAMPLE) && (
            <s-text color="subdued">
              Too few searches to call it yet — give it more traffic before acting.
            </s-text>
          )}
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
                          href={`/app/preview?q=${encodeURIComponent(z.term)}`}
                        >
                          Test
                        </s-button>
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
            {d.zero.length > 0 && (
              <s-text color="subdued">
                <s-link href="/app/synonyms">Synonyms</s-link> suggests fixes for these
                automatically.
              </s-text>
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
                      <>
                        <s-button
                          variant="secondary"
                          href={`/app/preview?q=${encodeURIComponent(z.term)}`}
                        >
                          Test
                        </s-button>
                        <s-button
                          variant="secondary"
                          href={`/app/merchandising?query=${encodeURIComponent(z.term)}`}
                        >
                          Merchandise
                        </s-button>
                      </>
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
            cart. Search revenue is the share that ended in a completed order, and
            what those orders were worth — measured by a pixel Shopify runs inside
            checkout, since checkout is not on your storefront. All three are
            attributed back to the specific search that produced them.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text color="subdued">
            Each figure is compared with the {d.windowDays} days before it.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

/**
 * Movement against the previous window, as a Stat hint.
 *
 * A bare number tells a merchant nothing about whether to act. `invert` is for
 * metrics where down is good (zero-result rate), so the colour follows the
 * meaning rather than the sign. No previous data means no claim is made.
 */
function delta(
  current: number,
  previous: number,
  unit: "%" | "pt" = "%",
  invert = false,
): { hint?: string; tone?: "success" | "critical" } {
  if (!previous) return {};
  const diff = unit === "pt" ? current - previous : ((current - previous) / previous) * 100;
  const rounded = Math.round(diff * 10) / 10;
  if (Math.abs(rounded) < 0.1) return { hint: "No change" };
  const better = invert ? rounded < 0 : rounded > 0;
  const sign = rounded > 0 ? "+" : "";
  return {
    hint: `${sign}${rounded}${unit === "pt" ? "pt" : "%"} vs previous`,
    tone: better ? "success" : "critical",
  };
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
