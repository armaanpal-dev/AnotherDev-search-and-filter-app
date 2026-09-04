import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { invalidateShopConfig } from "../lib/search/config.server";
import { Stat, Row, Empty, TILES } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  // Surface every option and metafield key present in the catalog so a merchant
  // can turn one into a facet without guessing the exact spelling. Done in SQL
  // over the whole catalog: sampling the first 500 products missed attributes
  // that only appear further down a large catalog.
  const [optionRows, metafieldRows, filters] = await Promise.all([
    prisma.$queryRaw<{ name: string }[]>`
      SELECT DISTINCT jsonb_object_keys("options") AS name
      FROM "Product" WHERE "shopId" = ${shop.id} LIMIT 50`,
    prisma.$queryRaw<{ name: string }[]>`
      SELECT DISTINCT jsonb_object_keys("metafields") AS name
      FROM "Product" WHERE "shopId" = ${shop.id} LIMIT 50`,
    prisma.filterConfig.findMany({
      where: { shopId: shop.id },
      orderBy: { position: "asc" },
    }),
  ]);

  const configured = new Set(filters.map((f) => f.source));
  return {
    filters,
    discoveredOptions: optionRows
      .map((r) => `option:${r.name}`)
      .filter((s) => !configured.has(s)),
    discoveredMetafields: metafieldRows
      .map((r) => `metafield:${r.name}`)
      .filter((s) => !configured.has(s)),
  };
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
  const { filters, discoveredOptions, discoveredMetafields } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const discovered = [...discoveredOptions, ...discoveredMetafields];
  const on = filters.filter((f) => f.enabled).length;

  return (
    <s-page heading="Filters">
      <s-section heading="Overview">
        <s-grid gridTemplateColumns={TILES} gap="base">
          <Stat label="Shown to shoppers" value={String(on)} />
          <Stat label="Configured" value={String(filters.length)} />
          <Stat
            label="Available, unused"
            value={String(discovered.length)}
            hint={discovered.length ? "From your catalog" : undefined}
          />
        </s-grid>
      </s-section>

      <s-section heading="Active facets">
        {filters.length ? (
          <s-stack direction="block" gap="small-300">
            {filters.map((f) => (
              <Row
                key={f.id}
                actions={
                  <>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="toggle" />
                      <input type="hidden" name="id" value={f.id} />
                      <input type="hidden" name="enabled" value={String(!f.enabled)} />
                      <s-button type="submit" variant="tertiary">
                        {f.enabled ? "Hide" : "Show"}
                      </s-button>
                    </fetcher.Form>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={f.id} />
                      <s-button type="submit" variant="tertiary" tone="critical">
                        Remove
                      </s-button>
                    </fetcher.Form>
                  </>
                }
              >
                <s-stack direction="inline" gap="small-500" alignItems="center">
                  <s-text type="strong">{f.label}</s-text>
                  <s-badge tone={f.enabled ? "success" : undefined}>
                    {f.enabled ? "Shown" : "Hidden"}
                  </s-badge>
                  <s-badge>{f.displayAs}</s-badge>
                </s-stack>
                <s-text color="subdued">{f.source}</s-text>
              </Row>
            ))}
          </s-stack>
        ) : (
          <Empty heading="No filters configured">
            Add a facet below and it will appear beside your search results.
          </Empty>
        )}
      </s-section>

      <s-section heading="Add a facet">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="add" />
          <s-stack direction="block" gap="base">
            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base" alignItems="end">
              <s-text-field
                name="source"
                label="Source"
                placeholder="option:Material"
              />
              <s-text-field name="label" label="Label shoppers see" placeholder="Material" />
              <s-select name="displayAs" label="Display as" value="checkbox">
                <s-option value="checkbox">Checkbox list</s-option>
                <s-option value="swatch">Colour swatch</s-option>
                <s-option value="list">Compact list</s-option>
                <s-option value="range">Numeric range</s-option>
              </s-select>
            </s-grid>
            <s-button variant="primary" type="submit">Add facet</s-button>
          </s-stack>
        </fetcher.Form>

        {discovered.length > 0 && (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small-500">
              <s-text type="strong">Found in your catalog</s-text>
              <s-text color="subdued">
                Not yet used as a filter: {discovered.join(", ")}
              </s-text>
            </s-stack>
          </s-box>
        )}
      </s-section>

      <s-section slot="aside" heading="Colour swatches">
        <s-paragraph>
          <s-text color="subdued">
            Swatch facets read their colours from{" "}
            <s-link href="/app/settings">Settings</s-link>. Anything not mapped
            there falls back to a built-in list of common colour names.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
