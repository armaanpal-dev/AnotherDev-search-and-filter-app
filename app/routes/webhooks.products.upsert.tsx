import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import {
  upsertProduct,
  optionsFromVariants,
  gidId,
  type NormalizedProduct,
} from "../lib/sync/upsert.server";
import { invalidateShopConfig } from "../lib/search/config.server";

// Handles products/create, products/update and collections/update.
// Keeps the Postgres index in sync in near-real-time.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const shopRow = (await getShopByDomain(shop)) ?? (await ensureShop(shop));

  // collections/update: a product's collection membership may have changed.
  // Cheapest correct action is to let the next full sync reconcile; for the
  // product topics we upsert the single product from the webhook payload (REST shape).
  if (topic.startsWith("PRODUCTS_") || topic === "products/update" || topic === "products/create") {
    const p = normalizeRestProduct(payload);
    if (p) {
      await upsertProduct(shopRow.id, p);
      invalidateShopConfig(shopRow.id);
    }
  }

  return new Response();
};

/** Map the REST product webhook payload into our normalized shape. */
function normalizeRestProduct(payload: any): NormalizedProduct | null {
  if (!payload?.id) return null;

  const variants: NormalizedProduct["variants"] = (payload.variants ?? []).map((v: any) => {
    const optionValues: Record<string, string> = {};
    // REST variants expose option1/2/3 aligned to payload.options order.
    (payload.options ?? []).forEach((opt: any, idx: number) => {
      const val = v[`option${idx + 1}`];
      if (val) optionValues[opt.name] = val;
    });
    return {
      variantId: String(v.id),
      title: v.title ?? "",
      sku: v.sku ?? "",
      price: Number(v.price ?? 0),
      available:
        v.inventory_policy === "continue" ||
        (v.inventory_quantity ?? 0) > 0 ||
        v.inventory_management == null,
      optionValues,
    };
  });

  const prices = variants.map((v) => v.price).filter((n) => n > 0);
  const priceMin = prices.length ? Math.min(...prices) : 0;
  const priceMax = prices.length ? Math.max(...prices) : 0;
  const image = payload.image ?? (payload.images?.[0] ?? null);

  return {
    productId: String(payload.id),
    handle: payload.handle ?? "",
    title: payload.title ?? "",
    description: stripHtml(payload.body_html ?? ""),
    vendor: payload.vendor ?? "",
    productType: payload.product_type ?? "",
    tags:
      typeof payload.tags === "string"
        ? payload.tags.split(",").map((t: string) => t.trim()).filter(Boolean)
        : Array.isArray(payload.tags)
          ? payload.tags
          : [],
    status: (payload.status ?? "active").toUpperCase(),
    available: variants.some((v) => v.available),
    priceMin,
    priceMax,
    currencyCode: "",
    imageUrl: image?.src ?? null,
    imageAlt: image?.alt ?? null,
    options: optionsFromVariants(variants),
    collections: [], // collection membership reconciled by full sync
    metafields: {},
    publishedAt: payload.published_at ? new Date(payload.published_at) : null,
    productUpdatedAt: payload.updated_at ? new Date(payload.updated_at) : null,
    variants,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
}
