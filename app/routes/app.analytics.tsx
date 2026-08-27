import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [total, withClicks, conversions, top, zero] = await Promise.all([
    prisma.searchEvent.count({ where: { shopId: shop.id, createdAt: { gte: since } } }),
    prisma.searchEvent.count({ where: { shopId: shop.id, createdAt: { gte: since }, clickedProductId: { not: null } } }),
    prisma.searchEvent.count({ where: { shopId: shop.id, createdAt: { gte: since }, converted: true } }),
    prisma.searchEvent.groupBy({
      by: ["normalized"],
      where: { shopId: shop.id, createdAt: { gte: since }, normalized: { not: "" } },
      _count: { normalized: true },
      _avg: { resultsCount: true },
      orderBy: { _count: { normalized: "desc" } },
      take: 20,
    }),
    prisma.searchEvent.groupBy({
      by: ["normalized"],
      where: { shopId: shop.id, createdAt: { gte: since }, resultsCount: 0, normalized: { not: "" } },
      _count: { normalized: true },
      orderBy: { _count: { normalized: "desc" } },
      take: 20,
    }),
  ]);

  const ctr = total ? Math.round((withClicks / total) * 1000) / 10 : 0;
  const cvr = total ? Math.round((conversions / total) * 1000) / 10 : 0;

  return {
    total, ctr, cvr,
    top: top.map((t) => ({ term: t.normalized, count: t._count.normalized, avgResults: Math.round(t._avg.resultsCount ?? 0) })),
    zero: zero.map((z) => ({ term: z.normalized, count: z._count.normalized })),
  };
};

export default function AnalyticsPage() {
  const d = useLoaderData<typeof loader>();
  return (
    <s-page heading="Search analytics">
      <s-section heading="Last 30 days">
        <s-stack direction="inline" gap="large">
          <Metric label="Searches" value={String(d.total)} />
          <Metric label="Click-through rate" value={`${d.ctr}%`} />
          <Metric label="Conversion rate" value={`${d.cvr}%`} />
        </s-stack>
      </s-section>

      <s-section heading="Top searches">
        {d.top.length ? (
          <s-table>
            <s-table-header-row>
              <s-table-header>Query</s-table-header>
              <s-table-header>Searches</s-table-header>
              <s-table-header>Avg results</s-table-header>
            </s-table-header-row>
            {d.top.map((t) => (
              <s-table-row key={t.term}>
                <s-table-cell>{t.term}</s-table-cell>
                <s-table-cell>{t.count}</s-table-cell>
                <s-table-cell>{t.avgResults}</s-table-cell>
              </s-table-row>
            ))}
          </s-table>
        ) : (
          <s-paragraph><s-text color="subdued">No search data yet.</s-text></s-paragraph>
        )}
      </s-section>

      <s-section heading="Zero-result searches">
        {d.zero.length ? (
          <s-unordered-list>
            {d.zero.map((z) => (
              <s-list-item key={z.term}>
                {z.term} — {z.count}{" "}
                <s-link href={`/app/synonyms?prefill=${encodeURIComponent(z.term)}`}>Fix with synonym</s-link>
              </s-list-item>
            ))}
          </s-unordered-list>
        ) : (
          <s-paragraph><s-text color="subdued">None — every search returns results.</s-text></s-paragraph>
        )}
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
