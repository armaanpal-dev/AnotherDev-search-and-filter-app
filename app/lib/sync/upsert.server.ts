import prisma from "../../db.server";
import { invalidateShopConfig } from "../search/config.server";

// Shape we normalise every source (bulk JSONL + webhooks) into before writing.
export interface NormalizedProduct {
  productId: string; // numeric part of the GID
  handle: string;
  title: string;
  description: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: string; // ACTIVE | DRAFT | ARCHIVED
  available: boolean;
  priceMin: number;
  priceMax: number;
  currencyCode: string;
  imageUrl: string | null;
  imageAlt: string | null;
  options: Record<string, string[]>;
  collections: string[];
  metafields: Record<string, string>;
  publishedAt: Date | null;
  productUpdatedAt: Date | null;
  variants: {
    variantId: string;
    title: string;
    sku: string;
    price: number;
    available: boolean;
    optionValues: Record<string, string>;
  }[];
}

/** Extract the trailing numeric id from a Shopify GID. */
export function gidId(gid: string): string {
  const m = /\/(\d+)(?:\?.*)?$/.exec(gid);
  return m ? m[1] : gid;
}

export async function upsertProduct(
  shopId: string,
  p: NormalizedProduct,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const product = await tx.product.upsert({
      where: { shopId_productId: { shopId, productId: p.productId } },
      create: {
        shopId,
        productId: p.productId,
        handle: p.handle,
        title: p.title,
        description: p.description,
        vendor: p.vendor,
        productType: p.productType,
        tags: p.tags,
        status: p.status,
        available: p.available,
        priceMin: p.priceMin,
        priceMax: p.priceMax,
        currencyCode: p.currencyCode,
        imageUrl: p.imageUrl,
        imageAlt: p.imageAlt,
        options: p.options,
        collections: p.collections,
        metafields: p.metafields,
        publishedAt: p.publishedAt,
        productUpdatedAt: p.productUpdatedAt,
        indexedAt: new Date(),
      },
      update: {
        handle: p.handle,
        title: p.title,
        description: p.description,
        vendor: p.vendor,
        productType: p.productType,
        tags: p.tags,
        status: p.status,
        available: p.available,
        priceMin: p.priceMin,
        priceMax: p.priceMax,
        currencyCode: p.currencyCode,
        imageUrl: p.imageUrl,
        imageAlt: p.imageAlt,
        options: p.options,
        collections: p.collections,
        metafields: p.metafields,
        publishedAt: p.publishedAt,
        productUpdatedAt: p.productUpdatedAt,
        indexedAt: new Date(),
      },
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

export async function deleteProduct(shopId: string, productId: string) {
  await prisma.product.deleteMany({ where: { shopId, productId } });
}

/** Build the { OptionName: [values] } facet map from variant selectedOptions. */
export function optionsFromVariants(
  variants: NormalizedProduct["variants"],
): Record<string, string[]> {
  const acc: Record<string, Set<string>> = {};
  for (const v of variants) {
    for (const [name, value] of Object.entries(v.optionValues)) {
      if (!value || value.toLowerCase() === "default title") continue;
      (acc[name] ??= new Set()).add(value);
    }
  }
  return Object.fromEntries(
    Object.entries(acc).map(([k, set]) => [k, [...set]]),
  );
}

export { invalidateShopConfig };
