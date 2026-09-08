import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { invalidateShopConfig } from "../lib/search/config.server";
import { Stat, Row, Empty, TILES, useSaveToast } from "../components/ui";

/** How a facet may be rendered. Anything else is a typo, not a choice. */
const DISPLAY_AS = ["checkbox", "swatch", "list", "range"] as const;
type DisplayAs = (typeof DISPLAY_AS)[number];

/** Sources with no `option:`/`metafield:` prefix that the engine understands. */
const BUILTIN_SOURCES = [
  "price",
  "vendor",
  "productType",
  "tag",
  "availability",
  "collection",
];

/**
 * Is this a source the engine can actually build a facet from?
 *
 * `buildFilterPredicates` and `computeFacets` both switch on a fixed set of
 * prefixes and ignore anything else, so a merchant who typed `colour` instead of
 * `option:Colour` got a facet row in the admin that silently never appeared on
 * the storefront and gave no clue why.
 */
function isValidSource(source: string): boolean {
  if (BUILTIN_SOURCES.includes(source)) return true;
  if (source.startsWith("option:") && source.length > "option:".length) return true;
  if (source.startsWith("metafield:") && source.length > "metafield:".length) return true;
  return false;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));

  // Attribute names come from the cache the last sync wrote.
  //
  // Both this page and Merchandising used to run
  // `SELECT DISTINCT jsonb_object_keys(...)` across the whole Product table on
  // every load — a full scan no index can help, on the app's largest table, to
  // learn something that only changes when the catalog is re-synced.
  const [syncState, filters, presets] = await Promise.all([
    prisma.syncState.findUnique({
      where: { shopId: shop.id },
      select: { optionNames: true, metafieldKeys: true, lastSyncAt: true },
    }),
    prisma.filterConfig.findMany({
      where: { shopId: shop.id },
      orderBy: { position: "asc" },
    }),
    prisma.filterPreset.findMany({
      where: { shopId: shop.id },
      orderBy: { position: "asc" },
    }),
  ]);

  const configured = new Set(filters.map((f) => f.source));
  return {
    filters,
    presets,
    // Never synced means the cache is legitimately empty rather than the catalog
    // having no attributes — say so instead of implying the store has none.
    everSynced: !!syncState?.lastSyncAt,
    discoveredOptions: (syncState?.optionNames ?? [])
      .map((n) => `option:${n}`)
      .filter((s) => !configured.has(s)),
    discoveredMetafields: (syncState?.metafieldKeys ?? [])
      .map((n) => `metafield:${n}`)
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
  } else if (intent === "add" || intent === "edit") {
    const source = String(form.get("source") || "").trim();
    const label = String(form.get("label") || "").trim() || source;
    const displayAsRaw = String(form.get("displayAs") || "checkbox");
    const displayAs: DisplayAs = (DISPLAY_AS as readonly string[]).includes(displayAsRaw)
      ? (displayAsRaw as DisplayAs)
      : "checkbox";

    if (!source) return { error: "A source is required." };
    if (!isValidSource(source)) {
      return {
        error:
          `"${source}" is not a filter the engine understands. Use one of ` +
          `${BUILTIN_SOURCES.join(", ")}, or prefix a product option with ` +
          `"option:" (e.g. option:Colour) or a metafield with "metafield:".`,
      };
    }

    if (intent === "edit") {
      // Scoped by shopId as well as id, so an id from another shop matches
      // nothing rather than editing someone else's row.
      await prisma.filterConfig.updateMany({
        where: { id: String(form.get("id")), shopId: shop.id },
        data: { label, displayAs },
      });
    } else {
      const max = await prisma.filterConfig.aggregate({
        where: { shopId: shop.id }, _max: { position: true },
      });
      await prisma.filterConfig.upsert({
        where: { shopId_source: { shopId: shop.id, source } },
        create: {
          shopId: shop.id, source, label, displayAs,
          position: (max._max.position ?? 0) + 1, enabled: true,
        },
        update: { label, displayAs, enabled: true },
      });
    }
  } else if (intent === "move") {
    // Reordering: `position` has always existed and driven the storefront order,
    // but nothing in the admin could change it, so the order was whatever the
    // seed happened to be. Swap with the neighbour rather than rewriting every
    // row — one move, two updates, and positions stay meaningful.
    const id = String(form.get("id"));
    const direction = form.get("direction") === "up" ? -1 : 1;
    const all = await prisma.filterConfig.findMany({
      where: { shopId: shop.id },
      orderBy: { position: "asc" },
      select: { id: true, position: true },
    });
    const index = all.findIndex((f) => f.id === id);
    const target = index + direction;
    if (index >= 0 && target >= 0 && target < all.length) {
      await prisma.$transaction([
        prisma.filterConfig.update({
          where: { id: all[index].id }, data: { position: all[target].position },
        }),
        prisma.filterConfig.update({
          where: { id: all[target].id }, data: { position: all[index].position },
        }),
      ]);
      // Equal positions (from an older seed) would swap to no visible effect.
      if (all[index].position === all[target].position) {
        await prisma.$transaction(
          all.map((f, i) =>
            prisma.filterConfig.update({ where: { id: f.id }, data: { position: i } }),
          ),
        );
      }
    }
  } else if (intent === "delete") {
    await prisma.filterConfig.deleteMany({ where: { id: String(form.get("id")), shopId: shop.id } });
  } else if (intent === "addPreset") {
    const label = String(form.get("presetLabel") || "").trim().slice(0, 60);
    const raw = String(form.get("presetParams") || "").trim().replace(/^[?&]/, "");
    if (!label || !raw) return { error: "A preset needs both a label and a filter." };

    // Normalised through URLSearchParams and filtered to parameters the search
    // endpoint understands, so a typo becomes a clear error here rather than a
    // chip that silently does nothing on the storefront.
    const allowed = new URLSearchParams();
    for (const [k, v] of new URLSearchParams(raw).entries()) {
      if (k.startsWith("f.") || k === "price.min" || k === "price.max" || k === "sort") {
        allowed.append(k, v);
      }
    }
    if (![...allowed.keys()].length) {
      return {
        error:
          "A preset must use f.<source>, price.min, price.max or sort — " +
          'for example "price.max=50" or "f.tag=new&sort=newest".',
      };
    }
    const max = await prisma.filterPreset.aggregate({
      where: { shopId: shop.id }, _max: { position: true },
    });
    await prisma.filterPreset.create({
      data: {
        shopId: shop.id, label, params: allowed.toString(),
        position: (max._max.position ?? 0) + 1,
      },
    });
  } else if (intent === "deletePreset") {
    await prisma.filterPreset.deleteMany({
      where: { id: String(form.get("id")), shopId: shop.id },
    });
  }

  invalidateShopConfig(shop.id);
  return { ok: true };
};

export default function FiltersPage() {
  const { filters, presets, discoveredOptions, discoveredMetafields, everSynced } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  useSaveToast(fetcher, "Filters saved");
  const found = [...discoveredOptions, ...discoveredMetafields];
  const on = filters.filter((f) => f.enabled).length;
  const error = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  return (
    <s-page heading="Filters">
      {error && <s-banner tone="critical">{error}</s-banner>}

      <s-section heading="Overview">
        <s-grid gridTemplateColumns={TILES} gap="large-100">
          <Stat label="Shown to shoppers" value={String(on)} />
          <Stat label="Configured" value={String(filters.length)} />
          <Stat
            label="Available, unused"
            value={String(found.length)}
            hint={everSynced ? (found.length ? "From your catalog" : undefined) : "Sync first"}
          />
          <Stat label="Quick filters" value={String(presets.length)} />
        </s-grid>
      </s-section>

      <s-section heading="Active facets">
        <s-paragraph>
          <s-text color="subdued">
            Shoppers see these top to bottom, in this order.
          </s-text>
        </s-paragraph>
        {filters.length ? (
          <s-stack direction="block" gap="small-300">
            {filters.map((f, i) => (
              <Row
                key={f.id}
                actions={
                  <>
                    <MoveButton id={f.id} direction="up" disabled={i === 0} fetcher={fetcher} />
                    <MoveButton
                      id={f.id}
                      direction="down"
                      disabled={i === filters.length - 1}
                      fetcher={fetcher}
                    />
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="toggle" />
                      <input type="hidden" name="id" value={f.id} />
                      <input type="hidden" name="enabled" value={String(!f.enabled)} />
                      <s-button type="submit" variant="secondary">
                        {f.enabled ? "Hide" : "Show"}
                      </s-button>
                    </fetcher.Form>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={f.id} />
                      <s-button type="submit" variant="secondary" tone="critical">
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

                {/* Editing in place. Previously the only way to correct a label
                    or change how a facet renders was to delete it and add it
                    again, which also lost its position. */}
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="edit" />
                  <input type="hidden" name="id" value={f.id} />
                  <input type="hidden" name="source" value={f.source} />
                  <s-grid gridTemplateColumns="1fr 1fr auto" gap="small-300" alignItems="end">
                    <s-text-field
                      name="label"
                      label="Label shoppers see"
                      defaultValue={f.label}
                    />
                    <s-select name="displayAs" label="Display as" value={f.displayAs}>
                      <s-option value="checkbox">Checkbox list</s-option>
                      <s-option value="swatch">Colour swatch</s-option>
                      <s-option value="list">Compact list</s-option>
                      <s-option value="range">Numeric range</s-option>
                    </s-select>
                    <s-button type="submit" variant="secondary">Save</s-button>
                  </s-grid>
                </fetcher.Form>
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
                details="price, vendor, productType, tag, availability, collection, option:X or metafield:X"
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

        {found.length > 0 && (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small-500">
              <s-text type="strong">Found in your catalog</s-text>
              <s-text color="subdued">Not yet used as a filter:</s-text>
              <s-stack direction="inline" gap="small-300">
                {found.slice(0, 20).map((source) => (
                  <fetcher.Form method="post" key={source}>
                    <input type="hidden" name="intent" value="add" />
                    <input type="hidden" name="source" value={source} />
                    <input type="hidden" name="label" value={prettyLabel(source)} />
                    <input
                      type="hidden"
                      name="displayAs"
                      value={/colou?r/i.test(source) ? "swatch" : "checkbox"}
                    />
                    <s-button type="submit" variant="secondary">
                      {`+ ${prettyLabel(source)}`}
                    </s-button>
                  </fetcher.Form>
                ))}
              </s-stack>
            </s-stack>
          </s-box>
        )}
        {!everSynced && (
          <s-text color="subdued">
            Run your first <s-link href="/app/sync">sync</s-link> and the options and
            metafields in your catalog will be offered here.
          </s-text>
        )}
      </s-section>

      <s-section heading="Quick filters">
        <s-paragraph>
          <s-text color="subdued">
            One-click chips above the grid, for the narrowing shoppers do most —
            &ldquo;Under 50&rdquo;, &ldquo;New in&rdquo;, &ldquo;On sale&rdquo;. A preset can
            combine several filters at once, which no single facet can.
          </s-text>
        </s-paragraph>
        {presets.length > 0 && (
          <s-stack direction="block" gap="small-300">
            {presets.map((p) => (
              <Row
                key={p.id}
                actions={
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="deletePreset" />
                    <input type="hidden" name="id" value={p.id} />
                    <s-button type="submit" variant="secondary" tone="critical">Remove</s-button>
                  </fetcher.Form>
                }
              >
                <s-text type="strong">{p.label}</s-text>
                <s-text color="subdued">{p.params}</s-text>
              </Row>
            ))}
          </s-stack>
        )}
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="addPreset" />
          <s-grid gridTemplateColumns="1fr 1.6fr auto" gap="base" alignItems="end">
            <s-text-field name="presetLabel" label="Chip label" placeholder="Under 50" />
            <s-text-field
              name="presetParams"
              label="Filter it applies"
              placeholder="price.max=50"
              details='e.g. price.max=50 · f.tag=new&sort=newest · f.option:Size=M'
            />
            <s-button variant="primary" type="submit">Add quick filter</s-button>
          </s-grid>
        </fetcher.Form>
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

/** Reorder control. Disabled at the ends rather than hidden, so the row's
 *  action column does not change width as items move. */
function MoveButton({
  id,
  direction,
  disabled,
  fetcher,
}: {
  id: string;
  direction: "up" | "down";
  disabled: boolean;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="move" />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="direction" value={direction} />
      <s-button
        type="submit"
        variant="secondary"
        accessibilityLabel={direction === "up" ? "Move up" : "Move down"}
        {...(disabled ? { disabled: true } : {})}
      >
        {direction === "up" ? "↑" : "↓"}
      </s-button>
    </fetcher.Form>
  );
}

/** "option:Colour" -> "Colour". The prefix is machinery, not a label. */
function prettyLabel(source: string): string {
  return source.replace(/^option:/, "").replace(/^metafield:/, "");
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
