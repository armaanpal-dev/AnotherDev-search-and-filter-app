import prisma from "../../db.server";
import {
  upsertProduct,
  optionsFromVariants,
  gidId,
  type NormalizedProduct,
} from "./upsert.server";
import { syncCollectionsAndPages } from "./collections.server";

// admin.graphql is the client returned by authenticate.admin(request)
type AdminGraphql = {
  graphql: (query: string, options?: { variables?: any }) => Promise<Response>;
};

const BULK_QUERY = `#graphql
{
  products {
    edges {
      node {
        id
        handle
        title
        description
        vendor
        productType
        tags
        status
        publishedAt
        updatedAt
        featuredImage { url altText }
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        variants {
          edges {
            node {
              id
              title
              sku
              price
              availableForSale
              selectedOptions { name value }
            }
          }
        }
        collections {
          edges { node { handle } }
        }
      }
    }
  }
}`;

/** Kick off a bulk operation. Returns the operation GID. */
export async function startBulkSync(admin: AdminGraphql): Promise<string> {
  const res = await admin.graphql(
    `#graphql
    mutation bulkRun($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`,
    { variables: { query: BULK_QUERY } },
  );
  const json = await res.json();
  const errs = json.data?.bulkOperationRunQuery?.userErrors ?? [];
  if (errs.length) {
    throw new Error(
      "bulkOperationRunQuery failed: " +
        errs.map((e: any) => e.message).join("; "),
    );
  }
  const id = json.data?.bulkOperationRunQuery?.bulkOperation?.id;
  if (!id) throw new Error("bulkOperationRunQuery returned no operation id");
  return id;
}

async function pollBulk(
  admin: AdminGraphql,
): Promise<{ status: string; url: string | null }> {
  const res = await admin.graphql(`#graphql
    { currentBulkOperation(type: QUERY) { id status errorCode objectCount url } }`);
  const json = await res.json();
  const op = json.data?.currentBulkOperation;
  return { status: op?.status ?? "UNKNOWN", url: op?.url ?? null };
}

interface RawVariant {
  id: string;
  title: string;
  sku?: string;
  price?: string;
  availableForSale?: boolean;
  selectedOptions?: { name: string; value: string }[];
  __parentId?: string;
}
interface RawCollection {
  handle: string;
  __parentId?: string;
}
interface RawProduct {
  id: string;
  handle: string;
  title: string;
  description?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  status?: string;
  publishedAt?: string | null;
  updatedAt?: string | null;
  featuredImage?: { url: string; altText: string | null } | null;
  priceRangeV2?: {
    minVariantPrice?: { amount: string; currencyCode: string };
    maxVariantPrice?: { amount: string; currencyCode: string };
  };
}

/**
 * Parse bulk JSONL. Nested connections arrive as separate lines carrying
 * __parentId; we group variants/collections under their product, then normalise.
 */
export function parseBulkJsonl(text: string): NormalizedProduct[] {
  const products = new Map<string, RawProduct>();
  const variantsByParent = new Map<string, RawVariant[]>();
  const collectionsByParent = new Map<string, string[]>();

  const push = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const arr = map.get(key);
    if (arr) arr.push(value);
    else map.set(key, [value]);
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const id: string = obj.id ?? "";
    if (id.includes("/ProductVariant/")) {
      if (obj.__parentId) push(variantsByParent, obj.__parentId, obj);
    } else if (id.includes("/Collection/")) {
      if (obj.__parentId && obj.handle)
        push(collectionsByParent, obj.__parentId, obj.handle);
    } else if (id.includes("/Product/")) {
      products.set(id, obj);
    }
  }

  const out: NormalizedProduct[] = [];
  for (const [gid, p] of products) {
    const rawVariants = variantsByParent.get(gid) ?? [];
    const variants = rawVariants.map((v) => ({
      variantId: gidId(v.id),
      title: v.title ?? "",
      sku: v.sku ?? "",
      price: Number(v.price ?? 0),
      available: Boolean(v.availableForSale),
      optionValues: Object.fromEntries(
        (v.selectedOptions ?? []).map((o) => [o.name, o.value]),
      ),
    }));

    out.push({
      productId: gidId(p.id),
      handle: p.handle,
      title: p.title,
      description: stripHtml(p.description ?? ""),
      vendor: p.vendor ?? "",
      productType: p.productType ?? "",
      tags: p.tags ?? [],
      status: p.status ?? "ACTIVE",
      available: variants.some((v) => v.available),
      priceMin: Number(p.priceRangeV2?.minVariantPrice?.amount ?? 0),
      priceMax: Number(p.priceRangeV2?.maxVariantPrice?.amount ?? 0),
      currencyCode: p.priceRangeV2?.minVariantPrice?.currencyCode ?? "",
      imageUrl: p.featuredImage?.url ?? null,
      imageAlt: p.featuredImage?.altText ?? null,
      options: optionsFromVariants(variants),
      collections: collectionsByParent.get(gid) ?? [],
      metafields: {},
      publishedAt: p.publishedAt ? new Date(p.publishedAt) : null,
      productUpdatedAt: p.updatedAt ? new Date(p.updatedAt) : null,
      variants,
    });
  }
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
}

/**
 * Full sync: start bulk op, poll to completion, download, parse, upsert.
 * Designed to be called from an admin route (has `admin`) and update SyncState.
 * Polling uses provided sleep so callers can inject timing in tests.
 */
export async function runFullSync(
  shopId: string,
  admin: AdminGraphql,
  opts: { maxWaitMs?: number; pollMs?: number; productLimit?: number } = {},
): Promise<{ count: number; truncated: boolean }> {
  const maxWaitMs = opts.maxWaitMs ?? 5 * 60_000;
  const pollMs = opts.pollMs ?? 2_000;
  const productLimit = opts.productLimit ?? Infinity;

  await prisma.syncState.upsert({
    where: { shopId },
    create: {
      shopId, status: "running", phase: "exporting",
      progressCurrent: 0, progressTotal: 0, message: "Exporting your catalog from Shopify…",
    },
    update: {
      status: "running", phase: "exporting",
      progressCurrent: 0, progressTotal: 0, message: "Exporting your catalog from Shopify…",
    },
  });

  try {
    const opId = await startBulkSync(admin);
    await prisma.syncState.update({
      where: { shopId },
      data: { bulkOpId: opId, phase: "exporting", message: "Shopify is preparing your product export…" },
    });

    const deadline = Date.now() + maxWaitMs;
    let url: string | null = null;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const { status, url: u } = await pollBulk(admin);
      if (status === "COMPLETED") {
        url = u;
        break;
      }
      if (["FAILED", "CANCELED", "EXPIRED"].includes(status)) {
        throw new Error(`Bulk operation ${status}`);
      }
    }

    if (url === null) {
      // Empty result set completes with a null URL — treat as zero products.
      const { status } = await pollBulk(admin);
      if (status !== "COMPLETED") throw new Error("Bulk export timed out");
    }

    let count = 0;
    let truncated = false;
    if (url) {
      const resp = await fetch(url);
      const text = await resp.text();
      const parsed = parseBulkJsonl(text);
      // Free plan caps the indexed catalog; Pro is unlimited.
      const toIndex = parsed.slice(0, productLimit);
      truncated = parsed.length > toIndex.length;

      // Enter the indexing phase with the known total, so the UI can show a
      // real progress bar and "X of Y (Z left)".
      await prisma.syncState.update({
        where: { shopId },
        data: {
          phase: "indexing",
          progressTotal: toIndex.length,
          progressCurrent: 0,
          message: `Indexing ${toIndex.length} products…`,
        },
      });

      let lastReport = Date.now();
      for (const p of toIndex) {
        await upsertProduct(shopId, p);
        count++;
        // Throttle progress writes: at most ~2/sec, plus the final one.
        if (Date.now() - lastReport > 400 || count === toIndex.length) {
          lastReport = Date.now();
          await prisma.syncState.update({
            where: { shopId },
            data: {
              progressCurrent: count,
              message: `Indexing… ${count} of ${toIndex.length} products`,
            },
          });
        }
      }
      // Remove any previously-indexed products beyond the current sync set
      // (e.g. after a downgrade) so the index reflects the active plan.
      const keepIds = toIndex.map((p) => p.productId);
      if (keepIds.length) {
        await prisma.product.deleteMany({
          where: { shopId, productId: { notIn: keepIds } },
        });
      }
    }

    // Also index collections + pages for the autocomplete sections (resilient).
    await syncCollectionsAndPages(shopId, admin).catch(() => {});

    await prisma.syncState.update({
      where: { shopId },
      data: {
        status: "idle",
        phase: "done",
        lastSyncAt: new Date(),
        productCount: count,
        progressCurrent: count,
        progressTotal: count,
        message: truncated
          ? `Indexed ${count} products (Free plan limit — upgrade to index all)`
          : `Indexed ${count} products`,
      },
    });
    return { count, truncated };
  } catch (e: any) {
    await prisma.syncState.update({
      where: { shopId },
      data: { status: "error", phase: "error", message: e?.message?.slice(0, 500) ?? "Sync failed" },
    });
    throw e;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
