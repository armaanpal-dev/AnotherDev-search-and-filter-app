import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { invalidateShopConfig } from "../lib/search/config.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  // Surface discovered option names so the merchant can enable them as facets.
  const products = await prisma.product.findMany({
    where: { shopId: shop.id },
    select: { options: true },
    take: 500,
  });
  const optionNames = new Set<string>();
  for (const p of products) {
    Object.keys((p.options as Record<string, unknown>) ?? {}).forEach((k) => optionNames.add(k));
  }
  const filters = await prisma.filterConfig.findMany({
    where: { shopId: shop.id },
    orderBy: { position: "asc" },
  });
  return { filters, discoveredOptions: [...optionNames] };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "toggle") {
    const id = String(form.get("id"));
    const enabled = form.get("enabled") === "true";
    await prisma.filterConfig.updateMany({ where: { id, shopId: shop.id }, data: { enabled } });
  } else if (intent === "add") {
    const source = String(form.get("source") || "").trim();
    const label = String(form.get("label") || "").trim() || source;
    const displayAs = String(form.get("displayAs") || "checkbox");
    if (source) {
      const max = await prisma.filterConfig.aggregate({
        where: { shopId: shop.id }, _max: { position: true },
      });
      await prisma.filterConfig.upsert({
        where: { shopId_source: { shopId: shop.id, source } },
        create: { shopId: shop.id, source, label, displayAs, position: (max._max.position ?? 0) + 1, enabled: true },
        update: { label, displayAs, enabled: true },
      });
    }
  } else if (intent === "delete") {
    await prisma.filterConfig.deleteMany({ where: { id: String(form.get("id")), shopId: shop.id } });
  }
  invalidateShopConfig(shop.id);
  return { ok: true };
};

export default function FiltersPage() {
  const { filters, discoveredOptions } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  return (
    <s-page heading="Filters">
      <s-section heading="Active facets">
        <s-paragraph>
          <s-text color="subdued">Toggle which filters appear on the storefront. Order follows position.</s-text>
        </s-paragraph>
        <s-stack direction="block" gap="small">
          {filters.map((f) => (
            <s-box key={f.id} padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-badge tone={f.enabled ? "success" : undefined}>{f.enabled ? "On" : "Off"}</s-badge>
                <s-text type="strong">{f.label}</s-text>
                <s-text color="subdued">{f.source} · {f.displayAs}</s-text>
                <span style={{ marginInlineStart: "auto", display: "flex", gap: "0.5rem" }}>
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="toggle" />
                    <input type="hidden" name="id" value={f.id} />
                    <input type="hidden" name="enabled" value={String(!f.enabled)} />
                    <s-button type="submit" variant="tertiary">{f.enabled ? "Disable" : "Enable"}</s-button>
                  </fetcher.Form>
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="id" value={f.id} />
                    <s-button type="submit" variant="tertiary" tone="critical">Remove</s-button>
                  </fetcher.Form>
                </span>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Add a facet">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="add" />
          <s-stack direction="block" gap="base">
            <s-text-field name="source" label="Source" placeholder="option:Material or metafield:fabric or tag" />
            <s-text-field name="label" label="Label shown to shoppers" placeholder="Material" />
            <s-select name="displayAs" label="Display as" value="checkbox">
              <s-option value="checkbox">Checkbox list</s-option>
              <s-option value="swatch">Color swatch</s-option>
              <s-option value="list">Compact list</s-option>
              <s-option value="range">Numeric range</s-option>
            </s-select>
            <s-button variant="primary" type="submit">Add facet</s-button>
          </s-stack>
        </fetcher.Form>
        {discoveredOptions.length > 0 && (
          <s-paragraph>
            <s-text color="subdued">
              Detected product options you can add: {discoveredOptions.map((o) => `option:${o}`).join(", ")}
            </s-text>
          </s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
