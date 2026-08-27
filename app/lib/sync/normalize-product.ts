// Pure normalisation shared by the bulk sync and the product webhooks.
//
// Deliberately free of any database or Shopify import so it can be unit-tested
// directly, and so a route that needs it does not drag server-only code into the
// client bundle.

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
  publishedOnline: boolean;
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

/** Flattened variant text + SKU list, folded into the generated search vector. */
export function variantIndexFields(p: NormalizedProduct): {
  variantText: string;
  skus: string[];
} {
  const skus = [
    ...new Set(p.variants.map((v) => v.sku).filter((s) => s && s.trim())),
  ].slice(0, 200);
  const titles = [
    ...new Set(
      p.variants
        .map((v) => v.title)
        .filter((t) => t && t.toLowerCase() !== "default title"),
    ),
  ];
  return {
    variantText: titles.join(" ").slice(0, 2000),
    skus,
  };
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
}

/**
 * Product descriptions are HTML. Indexing the markup means shoppers match on tag
 * names and inline styles, so it is stripped — including numeric entities, which
 * the previous version turned into spaces and so lost apostrophes and dashes
 * from every description that used them.
 */
export function stripHtml(html: string): string {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (_, name) => ENTITIES[String(name).toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
}

/**
 * Map the REST product webhook payload into our normalized shape.
 *
 * `collections`, `metafields` and `currencyCode` are intentionally empty here:
 * the webhook payload does not carry them, and `upsert.server` skips those
 * columns on the webhook path so they keep whatever the last full sync wrote.
 */
export function normalizeRestProduct(payload: any): NormalizedProduct | null {
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

  // Zero-priced products are real (free samples, gift wrap). Excluding them from
  // the min/max meant they indexed as 0–0 and disappeared from every price
  // filter; only variants with no usable price at all should be skipped.
  const prices = variants
    .map((v) => v.price)
    .filter((n) => Number.isFinite(n) && n >= 0);
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
    // `published_at` is the Online Store publication timestamp; null means the
    // product exists but has no storefront URL.
    publishedOnline: Boolean(payload.published_at),
    priceMin,
    priceMax,
    currencyCode: "",
    imageUrl: image?.src ?? null,
    imageAlt: image?.alt ?? null,
    options: optionsFromVariants(variants),
    collections: [],
    metafields: {},
    publishedAt: payload.published_at ? new Date(payload.published_at) : null,
    productUpdatedAt: payload.updated_at ? new Date(payload.updated_at) : null,
    variants,
  };
}
