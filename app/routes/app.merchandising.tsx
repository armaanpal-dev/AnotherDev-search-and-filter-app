import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { invalidateShopConfig } from "../lib/search/config.server";
import { getPlanStatus } from "../lib/billing.server";
import { Row, Empty } from "../components/ui";

const ids = (v: FormDataEntryValue | null) =>
  String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

/** Fields a condition can test. Mirrors conditionPredicate() in the engine. */
const CONDITION_FIELDS = [
  { value: "tag", label: "Tag" },
  { value: "vendor", label: "Brand / vendor" },
  { value: "productType", label: "Product type" },
  { value: "collection", label: "Collection handle" },
  { value: "available", label: "In stock (true/false)" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const { limits } = await getPlanStatus(billing, shop.planOverride);
  const isPro = limits.merchandising;
  const [rules, redirects, optionNames] = await Promise.all([
    prisma.merchandisingRule.findMany({ where: { shopId: shop.id }, orderBy: { priority: "desc" } }),
    prisma.redirect.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" } }),
    discoverOptionNames(shop.id),
  ]);
  return { rules, redirects, isPro, optionNames };
};

/** Option names present in the catalog, so conditions can target option:Color etc. */
async function discoverOptionNames(shopId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT DISTINCT jsonb_object_keys("options") AS name
    FROM "Product"
    WHERE "shopId" = ${shopId}
    LIMIT 30`;
  return rows.map((r) => r.name);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  // Gate on the capability so the tier boundary lives in one place.
  const { limits } = await getPlanStatus(billing, shop.planOverride);
  if (!limits.merchandising) {
    return { error: "Merchandising is available on the Growth and Pro plans." };
  }
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "createRule") {
    await prisma.merchandisingRule.create({
      data: {
        shopId: shop.id,
        name: String(form.get("name") || "Untitled rule").slice(0, 120),
        triggerQuery: String(form.get("triggerQuery") || "").trim() || null,
        triggerCollection: String(form.get("triggerCollection") || "").trim() || null,
        pinnedProductIds: ids(form.get("pinned")),
        boostedProductIds: ids(form.get("boosted")),
        buriedProductIds: ids(form.get("buried")),
        hiddenProductIds: ids(form.get("hidden")),
        conditions: parseConditionsForm(form),
        priority: parseInt(String(form.get("priority") || "0"), 10) || 0,
      },
    });
  } else if (intent === "deleteRule") {
    await prisma.merchandisingRule.deleteMany({ where: { id: String(form.get("id")), shopId: shop.id } });
  } else if (intent === "toggleRule") {
    await prisma.merchandisingRule.updateMany({
      where: { id: String(form.get("id")), shopId: shop.id },
      data: { active: form.get("active") === "true" },
    });
  } else if (intent === "createRedirect") {
    const query = String(form.get("query") || "").trim().toLowerCase();
    const url = String(form.get("url") || "").trim();
    // Only same-origin paths. An absolute URL here would turn the merchant's own
    // search box into an open redirect for anyone who can guess the term.
    if (query && url.startsWith("/") && !url.startsWith("//")) {
      await prisma.redirect.upsert({
        where: { shopId_query: { shopId: shop.id, query } },
        create: { shopId: shop.id, query, url },
        update: { url, active: true },
      });
    } else if (query && url) {
      return { error: "Redirect targets must be a path on your store, e.g. /collections/sale" };
    }
  } else if (intent === "deleteRedirect") {
    await prisma.redirect.deleteMany({ where: { id: String(form.get("id")), shopId: shop.id } });
  }
  invalidateShopConfig(shop.id);
  return { ok: true };
};

/** Condition rows arrive as parallel arrays (cond.field[], cond.op[], …). */
function parseConditionsForm(form: FormData) {
  const fields = form.getAll("cond.field").map(String);
  const ops = form.getAll("cond.op").map(String);
  const values = form.getAll("cond.value").map(String);
  const actions = form.getAll("cond.action").map(String);
  const weights = form.getAll("cond.weight").map(String);

  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]?.trim();
    const value = values[i]?.trim();
    if (!field || !value) continue;
    out.push({
      field,
      op: ops[i] || "eq",
      value,
      action: actions[i] || "boost",
      weight: Number(weights[i]) || 5,
    });
  }
  return out;
}

export default function MerchandisingPage() {
  const { rules, redirects, isPro, optionNames } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [sp] = useSearchParams();
  const [conditionRows, setConditionRows] = useState([0]);

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

  const fieldOptions = [
    ...CONDITION_FIELDS,
    ...optionNames.map((n) => ({ value: `option:${n}`, label: `Option: ${n}` })),
  ];

  return (
    <s-page heading="Merchandising">
      {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
        <s-banner tone="critical">{fetcher.data.error}</s-banner>
      )}

      <s-section heading="Rules">
        <s-paragraph>
          <s-text color="subdued">
            Rules run on the highest priority first. A rule fires when its trigger matches
            the shopper&rsquo;s search or the collection they&rsquo;re browsing.
          </s-text>
        </s-paragraph>
        {rules.length ? (
          <s-stack direction="block" gap="small">
            {rules.map((r) => (
              <Row
                key={r.id}
                  actions={
                    <>
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="toggleRule" />
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="active" value={String(!r.active)} />
                        <s-button type="submit" variant="secondary">
                          {r.active ? "Pause" : "Activate"}
                        </s-button>
                      </fetcher.Form>
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="deleteRule" />
                        <input type="hidden" name="id" value={r.id} />
                        <s-button type="submit" variant="secondary" tone="critical">Delete</s-button>
                      </fetcher.Form>
                    </>
                  }
                >
                  <s-stack direction="inline" gap="small-500" alignItems="center">
                    <s-badge tone={r.active ? "success" : undefined}>
                      {r.active ? "Active" : "Paused"}
                    </s-badge>
                    <s-text type="strong">{r.name}</s-text>
                  </s-stack>
                  <s-text color="subdued">
                    {r.triggerQuery ? `query “${r.triggerQuery}”` : ""}
                    {r.triggerQuery && r.triggerCollection ? " · " : ""}
                    {r.triggerCollection ? `collection ${r.triggerCollection}` : ""}
                    {!r.triggerQuery && !r.triggerCollection ? "always on" : ""}
                    {` · priority ${r.priority}`}
                  </s-text>
                  <RuleSummary rule={r} />
              </Row>
            ))}
          </s-stack>
        ) : (
          <Empty heading="No rules yet">
            Rules change what ranks first for a search. Start from a term in
            Analytics that returned results nobody clicked.
          </Empty>
        )}
      </s-section>

      <s-section heading="Add a rule">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="createRule" />
          <s-stack direction="block" gap="base">
            <s-text-field name="name" label="Rule name" placeholder="Push new arrivals for “jacket”" />
            <s-grid gridTemplateColumns="1.4fr 1.4fr 0.7fr" gap="base" alignItems="end">
              <s-text-field
                name="triggerQuery"
                label="When the search is (blank = any)"
                defaultValue={sp.get("query") ?? ""}
              />
              <s-text-field name="triggerCollection" label="…or the collection is (handle)" />
              <s-number-field name="priority" label="Priority" defaultValue="0" />
            </s-grid>

            <s-text type="strong">Specific products</s-text>
            <ProductPicker name="pinned" label="Pin to top (in order)" />
            <ProductPicker name="boosted" label="Boost" />
            <ProductPicker name="buried" label="Bury" />
            <ProductPicker name="hidden" label="Hide completely" />

            <s-text type="strong">…or by attribute</s-text>
            <s-paragraph>
              <s-text color="subdued">
                Attribute rules keep working as the catalog changes — “bury anything tagged
                clearance” never needs re-entering, unlike a list of product IDs.
              </s-text>
            </s-paragraph>
            {conditionRows.map((row) => (
              <s-grid
                key={row}
                gridTemplateColumns="1fr 1fr 1.5fr 1fr 0.8fr"
                gap="small"
                alignItems="end"
              >
                <s-select name="cond.field" label="Field" value="tag">
                  {fieldOptions.map((f) => (
                    <s-option key={f.value} value={f.value}>{f.label}</s-option>
                  ))}
                </s-select>
                <s-select name="cond.op" label="Is" value="eq">
                  <s-option value="eq">equal to</s-option>
                  <s-option value="neq">not equal to</s-option>
                  <s-option value="contains">containing</s-option>
                </s-select>
                <s-text-field name="cond.value" label="Value" placeholder="clearance" />
                <s-select name="cond.action" label="Then" value="boost">
                  <s-option value="boost">boost</s-option>
                  <s-option value="bury">bury</s-option>
                  <s-option value="pin">pin to top</s-option>
                  <s-option value="hide">hide</s-option>
                </s-select>
                <s-number-field name="cond.weight" label="Strength" min={1} max={20} defaultValue="5" />
              </s-grid>
            ))}
            <s-button
              type="button"
              variant="secondary"
              onClick={() => setConditionRows((r) => [...r, (r[r.length - 1] ?? 0) + 1])}
            >
              Add another condition
            </s-button>

            <s-button variant="primary" type="submit">Create rule</s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading="Search redirects">
        <s-paragraph>
          <s-text color="subdued">
            Send a search straight to a page instead of showing results — “shipping” to your
            policy page, “sale” to the sale collection.
          </s-text>
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="createRedirect" />
          <s-grid gridTemplateColumns="1fr 1fr auto" gap="base" alignItems="end">
            <s-text-field name="query" label="When someone searches" defaultValue={sp.get("redirect") ?? ""} />
            <s-text-field name="url" label="Send them to (a path on your store)" placeholder="/collections/sale" />
            <s-button variant="primary" type="submit">Add redirect</s-button>
          </s-grid>
        </fetcher.Form>
        {redirects.length ? (
          <s-stack direction="block" gap="small">
            {redirects.map((r) => (
              <Row
                key={r.id}
                actions={
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="deleteRedirect" />
                    <input type="hidden" name="id" value={r.id} />
                    <s-button type="submit" variant="secondary" tone="critical">Delete</s-button>
                  </fetcher.Form>
                }
              >
                <s-text type="strong">{r.query}</s-text>
                <s-text color="subdued">goes to {r.url}</s-text>
              </Row>
            ))}
          </s-stack>
        ) : null}
      </s-section>
    </s-page>
  );
}

function RuleSummary({ rule }: { rule: any }) {
  const counts = [
    rule.pinnedProductIds.length && `${rule.pinnedProductIds.length} pinned`,
    rule.boostedProductIds.length && `${rule.boostedProductIds.length} boosted`,
    rule.buriedProductIds.length && `${rule.buriedProductIds.length} buried`,
    rule.hiddenProductIds.length && `${rule.hiddenProductIds.length} hidden`,
    Array.isArray(rule.conditions) && rule.conditions.length
      ? `${rule.conditions.length} attribute condition${rule.conditions.length === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);
  return (
    <s-text color="subdued">{counts.length ? counts.join(" · ") : "No actions set"}</s-text>
  );
}

/**
 * Product selection via Shopify's own resource picker.
 *
 * Merchants previously had to paste comma-separated numeric product IDs, which
 * means leaving the app, finding each product, and copying digits out of a URL.
 * The hidden input keeps the same submitted shape, so the action is unchanged.
 */
function ProductPicker({ name, label }: { name: string; label: string }) {
  const [selected, setSelected] = useState<{ id: string; title: string }[]>([]);

  async function pick() {
    const bridge = (globalThis as any).shopify;
    if (!bridge?.resourcePicker) return;
    const picked = await bridge.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: selected.map((s) => ({ id: `gid://shopify/Product/${s.id}` })),
    });
    if (!picked) return;
    setSelected(
      picked.map((p: any) => ({
        // The engine stores the numeric part of the GID.
        id: String(p.id).split("/").pop(),
        title: p.title,
      })),
    );
  }

  return (
    <s-stack direction="block" gap="small">
      <input type="hidden" name={name} value={selected.map((s) => s.id).join(",")} />
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-button type="button" variant="secondary" onClick={pick}>{label}</s-button>
        <s-text color="subdued">
          {selected.length
            ? selected.map((s) => s.title).join(", ")
            : "none selected"}
        </s-text>
      </s-stack>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
