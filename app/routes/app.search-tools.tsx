import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { invalidateShopConfig } from "../lib/search/config.server";
import { mergeSettings, resolveSettings } from "../lib/settings";
import {
  BLACKLIST_OPERATORS,
  ValidationError,
  validateBanner,
} from "../lib/search/features";
import { normalizeQuery } from "../lib/search/normalize";
import { Row, Empty, useSaveToast } from "../components/ui";

const MAX_BANNERS = 500;
const MAX_BLACKLIST = 1000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const settings = resolveSettings(shop.settings);
  const [banners, blacklist, emptyProducts] = await Promise.all([
    prisma.searchBanner.findMany({ where: { shopId: shop.id }, orderBy: [{ query: "asc" }, { position: "asc" }] }),
    prisma.suggestionBlacklist.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" } }),
    prisma.product.findMany({
      where: { shopId: shop.id, productId: { in: settings.emptySearchProductIds } },
      select: { productId: true, title: true, imageUrl: true },
    }),
  ]);
  const byId = new Map(emptyProducts.map((p) => [p.productId, p]));
  return {
    banners,
    blacklist,
    emptySearch: settings.emptySearchProductIds.map(
      (id) => byId.get(id) ?? { productId: id, title: `Product ${id} (not indexed)`, imageUrl: null },
    ),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");

  try {
    switch (intent) {
      case "banner.create": {
        if ((await prisma.searchBanner.count({ where: { shopId: shop.id } })) >= MAX_BANNERS) {
          return { error: `A store can have at most ${MAX_BANNERS} banners.` };
        }
        await prisma.searchBanner.create({ data: { shopId: shop.id, ...validateBanner(form) } });
        break;
      }
      case "banner.update":
        await prisma.searchBanner.updateMany({ where: { id, shopId: shop.id }, data: validateBanner(form) });
        break;
      case "banner.toggle":
        await prisma.searchBanner.updateMany({
          where: { id, shopId: shop.id },
          data: { active: form.get("active") === "true" },
        });
        break;
      case "banner.delete":
        await prisma.searchBanner.deleteMany({ where: { id, shopId: shop.id } });
        break;
      case "blacklist.create": {
        const term = normalizeQuery(String(form.get("term") ?? "")).slice(0, 120);
        const operator = String(form.get("operator") ?? "contains");
        if (!term) return { error: "Enter a word or phrase to block." };
        if (!BLACKLIST_OPERATORS.includes(operator as any)) return { error: "Choose how the term should match." };
        if ((await prisma.suggestionBlacklist.count({ where: { shopId: shop.id } })) >= MAX_BLACKLIST) {
          return { error: `A store can have at most ${MAX_BLACKLIST} blocked terms.` };
        }
        await prisma.suggestionBlacklist.upsert({
          where: { shopId_term_operator: { shopId: shop.id, term, operator } },
          create: { shopId: shop.id, term, operator },
          update: { active: true },
        });
        break;
      }
      case "blacklist.toggle":
        await prisma.suggestionBlacklist.updateMany({
          where: { id, shopId: shop.id },
          data: { active: form.get("active") === "true" },
        });
        break;
      case "blacklist.delete":
        await prisma.suggestionBlacklist.deleteMany({ where: { id, shopId: shop.id } });
        break;
      case "empty.save": {
        const ids = String(form.get("ids") ?? "")
          .split(",")
          .map((s) => s.trim().replace(/^gid:\/\/shopify\/Product\//, ""))
          .filter(Boolean);
        const settings = mergeSettings(shop.settings, { emptySearchProductIds: ids });
        await prisma.shop.update({ where: { id: shop.id }, data: { settings: settings as any } });
        break;
      }
      default:
        return { error: "Unknown action." };
    }
  } catch (e) {
    if (e instanceof ValidationError) return { error: e.message };
    throw e;
  }

  invalidateShopConfig(shop.id);
  return { ok: true };
};

type Banner = Awaited<ReturnType<typeof loader>>["banners"][number];

function BannerFields({ b }: { b?: Banner }) {
  return (
    <s-stack direction="block" gap="base">
      <s-grid gridTemplateColumns="2fr 1fr 1fr" gap="base" alignItems="end">
        <s-text-field name="query" label="Search term" defaultValue={b?.query ?? ""} details="Shown when a shopper searches exactly this" />
        <s-select name="placement" label="Placement" value={b?.placement ?? "top"}>
          <s-option value="top">Top of results</s-option>
          <s-option value="grid">In the product grid</s-option>
        </s-select>
        <s-number-field
          name="position"
          label="Grid position"
          min={1}
          max={48}
          defaultValue={String(b?.position ?? 1)}
          details="Grid banners only"
        />
      </s-grid>
      <s-grid gridTemplateColumns="1fr 1fr" gap="base">
        <s-url-field name="imageUrl" label="Image URL" defaultValue={b?.imageUrl ?? ""} details="Required for top banners" />
        <s-text-field name="targetUrl" label="Link" defaultValue={b?.targetUrl ?? ""} details="e.g. /collections/sale" />
        <s-text-field name="heading" label="Heading" defaultValue={b?.heading ?? ""} />
        <s-text-field name="buttonLabel" label="Button label" defaultValue={b?.buttonLabel ?? ""} />
      </s-grid>
      <s-text-area name="content" label="Text" rows={2} defaultValue={b?.content ?? ""} />
      <s-grid gridTemplateColumns="1fr 1fr" gap="base">
        <s-color-field name="backgroundColor" label="Background" defaultValue={b?.backgroundColor ?? "#f4f4f5"} />
        <s-color-field name="textColor" label="Text colour" defaultValue={b?.textColor ?? "#18181b"} />
      </s-grid>
    </s-stack>
  );
}

export default function SearchToolsPage() {
  const { banners, blacklist, emptySearch } = useLoaderData<typeof loader>();
  // ?view=banners|blacklist|empty opens one tool on its own (from the Search hub).
  const [sp] = useSearchParams();
  const view = sp.get("view");
  const show = (v: string) => !view || view === v;
  const heading =
    view === "banners" ? "Search banners"
    : view === "blacklist" ? "Blocked suggestions"
    : view === "empty" ? "Empty search products"
    : "Search tools";
  const fetcher = useFetcher<typeof action>();
  useSaveToast(fetcher, "Saved");
  const data = fetcher.data;
  const error = data && "error" in data ? data.error : null;
  const busy = fetcher.state !== "idle" ? { loading: true } : {};

  const pickEmpty = async () => {
    const shopify = (window as any).shopify;
    const picked = await shopify?.resourcePicker?.({
      type: "product",
      multiple: 24,
      selectionIds: emptySearch.map((p) => ({ id: `gid://shopify/Product/${p.productId}` })),
    });
    if (!picked) return;
    fetcher.submit(
      { intent: "empty.save", ids: picked.map((p: { id: string }) => p.id).join(",") },
      { method: "post" },
    );
  };

  return (
    <s-page heading={heading}>
      <s-link slot="breadcrumb-actions" href="/app/search">Search</s-link>
      {error && <s-banner tone="critical">{error}</s-banner>}

      {show("banners") && (
      <s-section heading="Search banners">
        <s-paragraph>
          <s-text color="subdued">
            Promote a sale or a collection when a shopper searches a specific term.
            Top banners sit above the results; grid banners take a card slot.
          </s-text>
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="banner.create" />
          <s-stack direction="block" gap="base">
            <BannerFields />
            <s-button type="submit" variant="primary" {...busy}>Add banner</s-button>
          </s-stack>
        </fetcher.Form>
        {banners.length ? (
          <s-stack direction="block" gap="small-300">
            {banners.map((b) => (
              <Row
                key={b.id}
                actions={
                  <s-stack direction="inline" gap="small-300">
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="banner.toggle" />
                      <input type="hidden" name="id" value={b.id} />
                      <input type="hidden" name="active" value={String(!b.active)} />
                      <s-button type="submit" variant="secondary">{b.active ? "Disable" : "Enable"}</s-button>
                    </fetcher.Form>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="banner.delete" />
                      <input type="hidden" name="id" value={b.id} />
                      <s-button type="submit" variant="secondary" tone="critical">Delete</s-button>
                    </fetcher.Form>
                  </s-stack>
                }
              >
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-text type="strong">“{b.query}”</s-text>
                  <s-badge>{b.placement === "top" ? "Top" : `Grid #${b.position}`}</s-badge>
                  {!b.active && <s-badge tone="warning">Disabled</s-badge>}
                </s-stack>
                <details>
                  <summary style={{ cursor: "pointer", padding: "4px 0" }}>Edit</summary>
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="banner.update" />
                    <input type="hidden" name="id" value={b.id} />
                    <s-stack direction="block" gap="base">
                      <BannerFields b={b} />
                      <s-button type="submit" variant="secondary">Save</s-button>
                    </s-stack>
                  </fetcher.Form>
                </details>
              </Row>
            ))}
          </s-stack>
        ) : (
          <Empty heading="No banners yet">Add one above for your most-searched term.</Empty>
        )}
      </s-section>
      )}

      {show("blacklist") && (
      <s-section heading="Blocked suggestions">
        <s-paragraph>
          <s-text color="subdued">
            Search suggestions come from what shoppers typed. Block words you never
            want offered back, such as competitor names or profanity.
          </s-text>
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="blacklist.create" />
          <s-grid gridTemplateColumns="2fr 1fr auto" gap="base" alignItems="end">
            <s-text-field name="term" label="Word or phrase" />
            <s-select name="operator" label="Match" value="contains">
              <s-option value="contains">Contains</s-option>
              <s-option value="starts_with">Starts with</s-option>
              <s-option value="equals">Exactly</s-option>
            </s-select>
            <s-button type="submit" variant="primary" {...busy}>Block</s-button>
          </s-grid>
        </fetcher.Form>
        {blacklist.length ? (
          <s-stack direction="block" gap="small-300">
            {blacklist.map((r) => (
              <Row
                key={r.id}
                actions={
                  <s-stack direction="inline" gap="small-300">
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="blacklist.toggle" />
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="active" value={String(!r.active)} />
                      <s-button type="submit" variant="secondary">{r.active ? "Disable" : "Enable"}</s-button>
                    </fetcher.Form>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="blacklist.delete" />
                      <input type="hidden" name="id" value={r.id} />
                      <s-button type="submit" variant="secondary" tone="critical">Delete</s-button>
                    </fetcher.Form>
                  </s-stack>
                }
              >
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-text type="strong">{r.term}</s-text>
                  <s-badge>{r.operator === "starts_with" ? "Starts with" : r.operator === "equals" ? "Exactly" : "Contains"}</s-badge>
                  {!r.active && <s-badge tone="warning">Disabled</s-badge>}
                </s-stack>
              </Row>
            ))}
          </s-stack>
        ) : (
          <Empty heading="Nothing blocked">Every suggestion that found products can be offered.</Empty>
        )}
      </s-section>
      )}

      {show("empty") && (
      <s-section heading="Empty search products">
        <s-paragraph>
          <s-text color="subdued">
            Shown first when a shopper opens the search box before typing. Without
            any, your most popular products appear.
          </s-text>
        </s-paragraph>
        <s-stack direction="block" gap="small-300">
          {emptySearch.map((p) => (
            <Row key={p.productId}>
              <s-text>{p.title}</s-text>
            </Row>
          ))}
        </s-stack>
        <s-stack direction="inline" gap="small-300">
          <s-button variant="primary" onClick={pickEmpty} {...busy}>
            {emptySearch.length ? "Change products" : "Choose products"}
          </s-button>
          {emptySearch.length > 0 && (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="empty.save" />
              <input type="hidden" name="ids" value="" />
              <s-button type="submit" variant="secondary" tone="critical">Clear</s-button>
            </fetcher.Form>
          )}
        </s-stack>
      </s-section>
      )}

      <s-section slot="aside" heading="Related">
        <s-paragraph>
          <s-text color="subdued">
            Send a term straight to a page with a redirect, or pin products for a
            term, in <s-link href="/app/merchandising">Merchandising</s-link>.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
