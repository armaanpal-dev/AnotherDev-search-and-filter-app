import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { invalidateShopConfig, DEFAULT_FILTERS } from "../lib/search/config.server";
import { Row, Empty, useSaveToast } from "../components/ui";

const list = (raw: unknown, max = 100) =>
  [...new Set(String(raw ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((s) => s.slice(0, 120)))].slice(0, max);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const [sizes, merges, groups, sync, configs, collections] = await Promise.all([
    prisma.sizeMapping.findMany({ where: { shopId: shop.id }, orderBy: { rank: "asc" } }),
    prisma.mergedValue.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" } }),
    prisma.filterGroup.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "asc" } }),
    prisma.syncState.findUnique({ where: { shopId: shop.id }, select: { optionNames: true, metafieldKeys: true } }),
    prisma.filterConfig.findMany({ where: { shopId: shop.id }, orderBy: { position: "asc" } }),
    prisma.collection.findMany({ where: { shopId: shop.id }, select: { handle: true, title: true }, orderBy: { title: "asc" }, take: 500 }),
  ]);
  const sources = [
    ...new Set([
      ...DEFAULT_FILTERS.map((f) => f.source),
      ...configs.map((c) => c.source),
      ...(sync?.optionNames ?? []).map((o) => `option:${o}`),
      ...(sync?.metafieldKeys ?? []).map((k) => `metafield:${k}`),
    ]),
  ];
  return { sizes, merges, groups, sources, collections };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");

  switch (intent) {
    case "sizes.save": {
      // One size per line, in display order.
      const values = list(form.get("sizes"), 300).map((v) => v.toLowerCase());
      await prisma.$transaction([
        prisma.sizeMapping.deleteMany({ where: { shopId: shop.id } }),
        prisma.sizeMapping.createMany({
          data: values.map((value, rank) => ({ shopId: shop.id, value, rank })),
          skipDuplicates: true,
        }),
      ]);
      break;
    }
    case "merge.create": {
      const source = String(form.get("source") ?? "");
      const target = String(form.get("target") ?? "").trim().slice(0, 120);
      const sourceValues = list(form.get("sourceValues")).filter((v) => v !== target);
      if (!source || !target || !sourceValues.length) {
        return { error: "Choose a filter, the value to show, and at least one value to fold into it." };
      }
      await prisma.mergedValue.create({ data: { shopId: shop.id, source, target, sourceValues } });
      break;
    }
    case "merge.toggle":
      await prisma.mergedValue.updateMany({ where: { id, shopId: shop.id }, data: { active: form.get("active") === "true" } });
      break;
    case "merge.delete":
      await prisma.mergedValue.deleteMany({ where: { id, shopId: shop.id } });
      break;
    case "group.create":
    case "group.update": {
      const name = String(form.get("name") ?? "").trim().slice(0, 80);
      const collections = form.getAll("collections").map(String).filter(Boolean).slice(0, 200);
      const sources = list(form.get("sources"), 30);
      if (!name || !collections.length || !sources.length) {
        return { error: "A filter group needs a name, at least one collection and at least one filter." };
      }
      if (intent === "group.create") {
        await prisma.filterGroup.create({ data: { shopId: shop.id, name, collections, sources } });
      } else {
        await prisma.filterGroup.updateMany({ where: { id, shopId: shop.id }, data: { name, collections, sources } });
      }
      break;
    }
    case "group.toggle":
      await prisma.filterGroup.updateMany({ where: { id, shopId: shop.id }, data: { active: form.get("active") === "true" } });
      break;
    case "group.delete":
      await prisma.filterGroup.deleteMany({ where: { id, shopId: shop.id } });
      break;
    default:
      return { error: "Unknown action." };
  }
  invalidateShopConfig(shop.id);
  return { ok: true };
};

type Data = Awaited<ReturnType<typeof loader>>;

function GroupFields({ g, sources, collections }: { g?: Data["groups"][number]; sources: string[]; collections: Data["collections"] }) {
  return (
    <s-stack direction="block" gap="base">
      <s-text-field name="name" label="Name" defaultValue={g?.name ?? ""} />
      <s-choice-list name="collections" label="Collections" multiple values={g?.collections ?? []}>
        {collections.map((c) => (
          <s-choice key={c.handle} value={c.handle}>{c.title}</s-choice>
        ))}
      </s-choice-list>
      <s-text-area
        name="sources"
        label="Filters, in order"
        rows={4}
        defaultValue={(g?.sources ?? []).join("\n")}
        details={`One per line. Available: ${sources.join(", ")}`}
      />
    </s-stack>
  );
}

export default function FilterToolsPage() {
  const { sizes, merges, groups, sources, collections } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  useSaveToast(fetcher, "Saved");
  const data = fetcher.data;
  const error = data && "error" in data ? data.error : null;
  const busy = fetcher.state !== "idle" ? { loading: true } : {};
  const titleOf = new Map(collections.map((c) => [c.handle, c.title]));

  return (
    <s-page heading="Filter tools">
      {error && <s-banner tone="critical">{error}</s-banner>}

      <s-section heading="Filter groups">
        <s-paragraph>
          <s-text color="subdued">
            Show a different set of filters on specific collections, e.g. Size and
            Width on Shoes, Material on Furniture. Other collections keep the
            filters set on the Filters page.
          </s-text>
        </s-paragraph>
        <details>
          <summary style={{ cursor: "pointer", padding: "4px 0" }}>New filter group</summary>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="group.create" />
            <s-stack direction="block" gap="base">
              <GroupFields sources={sources} collections={collections} />
              <s-button type="submit" variant="primary" {...busy}>Add group</s-button>
            </s-stack>
          </fetcher.Form>
        </details>
        {groups.length ? (
          <s-stack direction="block" gap="small-300">
            {groups.map((g) => (
              <Row
                key={g.id}
                actions={
                  <s-stack direction="inline" gap="small-300">
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="group.toggle" />
                      <input type="hidden" name="id" value={g.id} />
                      <input type="hidden" name="active" value={String(!g.active)} />
                      <s-button type="submit" variant="secondary">{g.active ? "Disable" : "Enable"}</s-button>
                    </fetcher.Form>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="group.delete" />
                      <input type="hidden" name="id" value={g.id} />
                      <s-button type="submit" variant="secondary" tone="critical">Delete</s-button>
                    </fetcher.Form>
                  </s-stack>
                }
              >
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-text type="strong">{g.name}</s-text>
                  {!g.active && <s-badge tone="warning">Disabled</s-badge>}
                </s-stack>
                <s-text color="subdued">
                  {g.collections.map((h) => titleOf.get(h) ?? h).join(", ")} · {g.sources.join(", ")}
                </s-text>
                <details>
                  <summary style={{ cursor: "pointer", padding: "4px 0" }}>Edit</summary>
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="group.update" />
                    <input type="hidden" name="id" value={g.id} />
                    <s-stack direction="block" gap="base">
                      <GroupFields g={g} sources={sources} collections={collections} />
                      <s-button type="submit" variant="secondary">Save</s-button>
                    </s-stack>
                  </fetcher.Form>
                </details>
              </Row>
            ))}
          </s-stack>
        ) : (
          <Empty heading="No filter groups">Every collection uses the same filters.</Empty>
        )}
      </s-section>

      <s-section heading="Merged values">
        <s-paragraph>
          <s-text color="subdued">
            Fold values that mean the same thing into one filter option. “Crimson”,
            “red” and “Scarlet” can all show as “Red”, and choosing it finds all three.
          </s-text>
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="merge.create" />
          <s-grid gridTemplateColumns="1fr 1fr 2fr auto" gap="base" alignItems="end">
            <s-select name="source" label="Filter" value="option:Color">
              {sources.filter((s) => s !== "price" && s !== "availability").map((s) => (
                <s-option key={s} value={s}>{s}</s-option>
              ))}
            </s-select>
            <s-text-field name="target" label="Show as" />
            <s-text-field name="sourceValues" label="Values to fold in" details="Comma separated, exact spelling" />
            <s-button type="submit" variant="primary" {...busy}>Merge</s-button>
          </s-grid>
        </fetcher.Form>
        {merges.length ? (
          <s-stack direction="block" gap="small-300">
            {merges.map((m) => (
              <Row
                key={m.id}
                actions={
                  <s-stack direction="inline" gap="small-300">
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="merge.toggle" />
                      <input type="hidden" name="id" value={m.id} />
                      <input type="hidden" name="active" value={String(!m.active)} />
                      <s-button type="submit" variant="secondary">{m.active ? "Disable" : "Enable"}</s-button>
                    </fetcher.Form>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="merge.delete" />
                      <input type="hidden" name="id" value={m.id} />
                      <s-button type="submit" variant="secondary" tone="critical">Delete</s-button>
                    </fetcher.Form>
                  </s-stack>
                }
              >
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-badge>{m.source}</s-badge>
                  <s-text>{m.sourceValues.join(", ")}</s-text>
                  <s-text color="subdued">→</s-text>
                  <s-text type="strong">{m.target}</s-text>
                  {!m.active && <s-badge tone="warning">Disabled</s-badge>}
                </s-stack>
              </Row>
            ))}
          </s-stack>
        ) : (
          <Empty heading="No merged values">Filter options show exactly as they are spelled in your catalog.</Empty>
        )}
      </s-section>

      <s-section heading="Size order">
        <s-paragraph>
          <s-text color="subdued">
            Size filters already sort XS → 5XL and numbers in order. List any other
            sizes your catalog uses, smallest first, and they will sort ahead of the
            rest.
          </s-text>
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="sizes.save" />
          <s-stack direction="block" gap="base">
            <s-text-area name="sizes" label="Sizes, one per line" rows={6} defaultValue={sizes.map((s) => s.value).join("\n")} />
            <s-button type="submit" variant="primary" {...busy}>Save order</s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
