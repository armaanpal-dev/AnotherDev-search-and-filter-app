import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { compareCatalog } from "../lib/catalog-health";
import { Stat, Row, Empty, TILES } from "../components/ui";

const HEALTH_QUERY = `#graphql
  query CatalogHealth {
    productsCount(query: "status:active", limit: null) {
      count
      precision
    }
    collections(first: 25, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        handle
        title
        productsCount {
          count
        }
      }
    }
    products(first: 50, sortKey: UPDATED_AT, reverse: true, query: "status:active") {
      nodes {
        legacyResourceId
        title
        updatedAt
      }
    }
  }`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const run = new URL(request.url).searchParams.get("run") === "1";
  if (!run) return { ran: false as const };

  const res = await admin.graphql(HEALTH_QUERY);
  const json: any = await res.json();
  if (json.errors?.length) return { ran: true as const, error: "Shopify did not answer. Try again in a minute." };
  const d = json.data;

  const handles: string[] = d.collections.nodes.map((c: any) => c.handle);
  const ids: string[] = d.products.nodes.map((p: any) => String(p.legacyResourceId));
  const [indexedActive, collCounts, indexed] = await Promise.all([
    prisma.product.count({ where: { shopId: shop.id, status: "ACTIVE" } }),
    Promise.all(
      handles.map((h) => prisma.product.count({ where: { shopId: shop.id, collections: { has: h } } })),
    ),
    prisma.product.findMany({
      where: { shopId: shop.id, productId: { in: ids } },
      select: { productId: true, productUpdatedAt: true },
    }),
  ]);
  const indexedAt = new Map(indexed.map((p) => [p.productId, p.productUpdatedAt?.toISOString() ?? null]));

  const issues = compareCatalog({
    shopifyActive: d.productsCount.count,
    indexedActive,
    collections: d.collections.nodes.map((c: any, i: number) => ({
      handle: c.handle,
      title: c.title,
      shopify: c.productsCount?.count ?? 0,
      indexed: collCounts[i],
    })),
    recent: d.products.nodes.map((p: any) => ({
      productId: String(p.legacyResourceId),
      title: p.title,
      shopifyUpdatedAt: p.updatedAt,
      indexedUpdatedAt: indexedAt.has(String(p.legacyResourceId)) ? indexedAt.get(String(p.legacyResourceId)) ?? "1970-01-01T00:00:00Z" : null,
    })),
  });

  return {
    ran: true as const,
    shopifyActive: d.productsCount.count as number,
    indexedActive,
    checkedCollections: handles.length,
    checkedProducts: ids.length,
    issues,
  };
};

export default function CatalogHealthPage() {
  const data = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle" ? { loading: true } : {};

  return (
    <s-page heading="Catalog check">
      <s-link slot="breadcrumb-actions" href="C:/Program Files/Git/app/settings">Settings</s-link>
      <s-section heading="Is the index in step with Shopify?">
        <s-paragraph>
          <s-text color="subdued">
            Compares your active product count, your 25 most recently changed
            collections and your 50 most recently edited products against the index.
          </s-text>
        </s-paragraph>
        <s-button variant="primary" href="/app/catalog-health?run=1" {...busy}>
          {data.ran ? "Check again" : "Check catalog"}
        </s-button>
      </s-section>

      {data.ran && "error" in data && data.error && <s-banner tone="critical">{data.error}</s-banner>}

      {data.ran && "issues" in data && data.issues && (
        <>
          <s-section heading="Result">
            <s-grid gridTemplateColumns={TILES} gap="large-100">
              <Stat label="Active in Shopify" value={String(data.shopifyActive)} />
              <Stat label="Active in index" value={String(data.indexedActive)} />
              <Stat label="Collections checked" value={String(data.checkedCollections)} />
              <Stat
                label="Problems"
                value={String(data.issues.length)}
                {...(data.issues.length ? { tone: "critical" as const } : {})}
              />
            </s-grid>
          </s-section>
          <s-section heading="Problems">
            {data.issues.length ? (
              <s-stack direction="block" gap="small-300">
                {data.issues.map((i, n) => (
                  <Row key={n}>
                    <s-stack direction="inline" gap="small-300" alignItems="center">
                      <s-badge tone={i.kind === "count" ? "critical" : "warning"}>
                        {i.kind === "count" ? "Count" : i.kind === "collection" ? "Collection" : i.kind === "missing" ? "Missing" : "Out of date"}
                      </s-badge>
                      <s-text>{i.message}</s-text>
                    </s-stack>
                  </Row>
                ))}
                <s-paragraph>
                  <s-text color="subdued">
                    A full re-index on the <s-link href="/app/sync">Index</s-link> page fixes all of these.
                  </s-text>
                </s-paragraph>
              </s-stack>
            ) : (
              <Empty heading="Everything matches">The index agrees with Shopify.</Empty>
            )}
          </s-section>
        </>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
