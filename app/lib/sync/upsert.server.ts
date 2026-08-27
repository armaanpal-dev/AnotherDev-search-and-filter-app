import prisma from "../../db.server";
import { invalidateShopConfig } from "../search/config.server";
import { variantIndexFields } from "./normalize-product";
import type { NormalizedProduct } from "./normalize-product";

// The pure half of normalisation lives in ./normalize-product so a route can
// import it without dragging Prisma into the client bundle. Re-exported here so
// existing callers keep working.
export {
  gidId,
  optionsFromVariants,
  variantIndexFields,
  stripHtml,
  normalizeRestProduct,
} from "./normalize-product";
export type { NormalizedProduct } from "./normalize-product";

/**
 * Fields a webhook must NOT touch.
 *
 * A `products/update` webhook payload has no collection membership and no
 * metafields, and its price block carries no currency. Writing the normalised
 * shape wholesale therefore blanked all three on every product edit — silently
 * dropping the product out of every collection-scoped search and collection
 * facet until the next full catalog sync. Only a full sync knows these values,
 * so only a full sync is allowed to write them.
 */
const FULL_SYNC_ONLY = ["collections", "metafields", "currencyCode"] as const;

export type WriteSource = "bulk" | "webhook";

function productData(p: NormalizedProduct) {
  const { variantText, skus } = variantIndexFields(p);
  return {
    handle: p.handle,
    title: p.title,
    description: p.description,
    vendor: p.vendor,
    productType: p.productType,
    tags: p.tags,
    status: p.status,
    available: p.available,
    publishedOnline: p.publishedOnline,
    priceMin: p.priceMin,
    priceMax: p.priceMax,
    currencyCode: p.currencyCode,
    imageUrl: p.imageUrl,
    imageAlt: p.imageAlt,
    options: p.options,
    collections: p.collections,
    metafields: p.metafields,
    variantText,
    skus,
    publishedAt: p.publishedAt,
    productUpdatedAt: p.productUpdatedAt,
    indexedAt: new Date(),
    // Content changed, so any stored embedding is stale. Null marks it for the
    // next backfill pass; search falls back to keyword until then.
    embeddedAt: null,
  };
}

function updateData(p: NormalizedProduct, source: WriteSource) {
  const data: Record<string, unknown> = productData(p);
  if (source === "webhook") {
    for (const field of FULL_SYNC_ONLY) delete data[field];
  }
  return data;
}

/**
 * Write one product. Used by webhooks (single product, low volume).
 * Full syncs use `upsertProductsBatch`, which is an order of magnitude faster.
 */
export async function upsertProduct(
  shopId: string,
  p: NormalizedProduct,
  source: WriteSource = "bulk",
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const product = await tx.product.upsert({
      where: { shopId_productId: { shopId, productId: p.productId } },
      create: { shopId, productId: p.productId, ...productData(p) },
      update: updateData(p, source) as any,
    });

    // Replace variants wholesale — simplest correct strategy for a mirror.
    await tx.productVariant.deleteMany({ where: { productId: product.id } });
    if (p.variants.length) {
      await tx.productVariant.createMany({
        data: p.variants.map((v) => ({
          productId: product.id,
          variantId: v.variantId,
          title: v.title,
          sku: v.sku,
          price: v.price,
          available: v.available,
          optionValues: v.optionValues,
        })),
      });
    }
  });
}

/**
 * Write a batch of products in a handful of round-trips.
 *
 * The previous implementation opened one transaction per product, so a
 * 20k-product catalog paid 20k sequential round-trips to a pooled, possibly
 * cross-region database — tens of minutes of wall clock for a sync that should
 * take a couple of minutes. Here each chunk costs: one batched upsert
 * transaction, one id lookup, one variant delete, one variant insert.
 */
export async function upsertProductsBatch(
  shopId: string,
  products: NormalizedProduct[],
): Promise<number> {
  if (!products.length) return 0;

  // 1. Products — a single transaction carrying every upsert in the chunk.
  await prisma.$transaction(
    products.map((p) =>
      prisma.product.upsert({
        where: { shopId_productId: { shopId, productId: p.productId } },
        create: { shopId, productId: p.productId, ...productData(p) },
        update: updateData(p, "bulk") as any,
      }),
    ),
  );

  // 2. Map Shopify product ids back to our row ids so variants can be attached.
  const rows = await prisma.product.findMany({
    where: { shopId, productId: { in: products.map((p) => p.productId) } },
    select: { id: true, productId: true },
  });
  const idByProductId = new Map(rows.map((r) => [r.productId, r.id]));

  // 3. Replace variants for the whole chunk at once.
  const rowIds = [...idByProductId.values()];
  if (rowIds.length) {
    await prisma.productVariant.deleteMany({
      where: { productId: { in: rowIds } },
    });
  }

  const variantRows = products.flatMap((p) => {
    const rowId = idByProductId.get(p.productId);
    if (!rowId) return [];
    return p.variants.map((v) => ({
      productId: rowId,
      variantId: v.variantId,
      title: v.title,
      sku: v.sku,
      price: v.price,
      available: v.available,
      optionValues: v.optionValues,
    }));
  });
  if (variantRows.length) {
    await prisma.productVariant.createMany({
      data: variantRows,
      skipDuplicates: true,
    });
  }

  return products.length;
}

export async function deleteProduct(shopId: string, productId: string) {
  await prisma.product.deleteMany({ where: { shopId, productId } });
}

export { invalidateShopConfig };
