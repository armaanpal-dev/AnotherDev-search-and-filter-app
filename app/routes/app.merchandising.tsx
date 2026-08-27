import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { invalidateShopConfig } from "../lib/search/config.server";
import { getPlanStatus } from "../lib/billing.server";

const ids = (v: FormDataEntryValue | null) =>
  String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const { isPro } = await getPlanStatus(billing);
  const [rules, redirects] = await Promise.all([
    prisma.merchandisingRule.findMany({ where: { shopId: shop.id }, orderBy: { priority: "desc" } }),
    prisma.redirect.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" } }),
  ]);
  return { rules, redirects, isPro };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  // Merchandising is a Pro feature — reject writes on Free.
  const { isPro } = await getPlanStatus(billing);
  if (!isPro) return { error: "Merchandising is a Pro feature." };
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "createRule") {
    await prisma.merchandisingRule.create({
      data: {
        shopId: shop.id,
        name: String(form.get("name") || "Untitled rule"),
        triggerQuery: String(form.get("triggerQuery") || "").trim() || null,
        triggerCollection: String(form.get("triggerCollection") || "").trim() || null,
        pinnedProductIds: ids(form.get("pinned")),
        boostedProductIds: ids(form.get("boosted")),
        buriedProductIds: ids(form.get("buried")),
        hiddenProductIds: ids(form.get("hidden")),
        priority: parseInt(String(form.get("priority") || "0"), 10) || 0,
      },
    });
  } else if (intent === "deleteRule") {
    await prisma.merchandisingRule.deleteMany({ where: { id: String(form.get("id")), shopId: shop.id } });
  } else if (intent === "createRedirect") {
    const query = String(form.get("query") || "").trim().toLowerCase();
    const url = String(form.get("url") || "").trim();
    if (query && url) {
      await prisma.redirect.upsert({
        where: { shopId_query: { shopId: shop.id, query } },
        create: { shopId: shop.id, query, url },
        update: { url, active: true },
      });
    }
  } else if (intent === "deleteRedirect") {
    await prisma.redirect.deleteMany({ where: { id: String(form.get("id")), shopId: shop.id } });
  }
  invalidateShopConfig(shop.id);
  return { ok: true };
};

export default function MerchandisingPage() {
  const { rules, redirects, isPro } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  if (!isPro) {
    return (
      <s-page heading="Merchandising">
        <s-banner tone="info" heading="Merchandising is a Pro feature">
          <s-paragraph>
            Pin products to the top of results, boost or bury by relevance, hide products,
            and set search redirects. Upgrade to Pro to unlock these controls.
          </s-paragraph>
          <s-button slot="primary-action" href="/app/plans" variant="primary">
            See Pro plan
          </s-button>
        </s-banner>
      </s-page>
    );
  }

  return (
    <s-page heading="Merchandising">
      <s-section heading="Ranking rules">
        <s-paragraph>
          <s-text color="subdued">
            Pin products to the top, boost or bury by relevance, or hide them entirely for a
            given search term and/or collection. Enter product IDs (numeric) comma-separated.
          </s-text>
        </s-paragraph>
        <s-stack direction="block" gap="small">
          {rules.map((r) => (
            <s-box key={r.id} padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-text type="strong">{r.name}</s-text>
                  <s-badge>priority {r.priority}</s-badge>
                  <fetcher.Form method="post" style={{ marginInlineStart: "auto" }}>
                    <input type="hidden" name="intent" value="deleteRule" />
                    <input type="hidden" name="id" value={r.id} />
                    <s-button type="submit" variant="tertiary" tone="critical">Delete</s-button>
                  </fetcher.Form>
                </s-stack>
                <s-text color="subdued">
                  Trigger: {r.triggerQuery ? `query “${r.triggerQuery}”` : "any query"}
                  {r.triggerCollection ? ` · collection ${r.triggerCollection}` : ""}
                </s-text>
                <s-text color="subdued">
                  {r.pinnedProductIds.length} pinned · {r.boostedProductIds.length} boosted ·{" "}
                  {r.buriedProductIds.length} buried · {r.hiddenProductIds.length} hidden
                </s-text>
              </s-stack>
            </s-box>
          ))}
          {!rules.length && <s-paragraph><s-text color="subdued">No rules yet.</s-text></s-paragraph>}
        </s-stack>
      </s-section>

      <s-section heading="Add a rule">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="createRule" />
          <s-stack direction="block" gap="base">
            <s-text-field name="name" label="Rule name" placeholder="Promote summer line for “dress”" />
            <s-stack direction="inline" gap="base">
              <s-text-field name="triggerQuery" label="Trigger query" placeholder="dress" />
              <s-text-field name="triggerCollection" label="Trigger collection handle" placeholder="summer" />
            </s-stack>
            <s-text-field name="pinned" label="Pin product IDs (top, in order)" placeholder="123, 456" />
            <s-text-field name="boosted" label="Boost product IDs" placeholder="789" />
            <s-text-field name="buried" label="Bury product IDs" placeholder="" />
            <s-text-field name="hidden" label="Hide product IDs" placeholder="" />
            <s-text-field name="priority" label="Priority" defaultValue="0" />
            <s-button variant="primary" type="submit">Add rule</s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading="Search redirects">
        <s-paragraph>
          <s-text color="subdued">Send a specific search term straight to a URL (e.g. “gift card” → /products/gift-card).</s-text>
        </s-paragraph>
        <s-stack direction="block" gap="small">
          {redirects.map((r) => (
            <s-box key={r.id} padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-text>{r.query} → {r.url}</s-text>
                <fetcher.Form method="post" style={{ marginInlineStart: "auto" }}>
                  <input type="hidden" name="intent" value="deleteRedirect" />
                  <input type="hidden" name="id" value={r.id} />
                  <s-button type="submit" variant="tertiary" tone="critical">Delete</s-button>
                </fetcher.Form>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="createRedirect" />
          <s-stack direction="inline" gap="base">
            <s-text-field name="query" label="Search term" placeholder="gift card" />
            <s-text-field name="url" label="Redirect to URL" placeholder="/products/gift-card" />
            <s-button variant="primary" type="submit">Add redirect</s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
