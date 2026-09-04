import prisma from "../../db.server";
import {
  upsertProductsBatch,
  optionsFromVariants,
  gidId,
  type NormalizedProduct,
} from "./upsert.server";
import { syncCollectionsAndPages } from "./collections.server";
import { embedPendingProducts } from "../search/embeddings.server";
import { invalidateShopConfig } from "../search/config.server";
import { pruneAnalytics } from "../analytics.server";

// admin.graphql is the client returned by authenticate.admin(request)
type AdminGraphql = {
  graphql: (query: string, options?: { variables?: any }) => Promise<Response>;
};

// How many products go into one batched write. Large enough to amortise the
// round-trip, small enough that one transaction stays well inside Postgres'
// parameter ceiling and does not hold locks for long.
const WRITE_CHUNK = 100;

// A run whose heartbeat has been silent this long is a crashed run (process
// restarted mid-sync), not a live one — otherwise `status: "running"` sticks
// forever and the merchant can never start another sync.
const STALE_RUN_MS = 3 * 60_000;

/**
 * `published_status:published` restricts the export to products published to the
 * Online Store. An ACTIVE but unpublished product has no storefront URL, so
 * indexing it puts 404s in the search results.
 *
 * Metafields arrive as their own JSONL lines (nested connection) and are grouped
 * back onto the parent by __parentId, same as variants and collections.
 */
const BULK_QUERY = `#graphql
{
  products(query: "published_status:published") {
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
          edges { node { id handle } }
        }
        metafields {
          edges { node { id namespace key value type } }
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
): Promise<{ id: string | null; status: string; url: string | null; objectCount: number }> {
  const res = await admin.graphql(`#graphql
    { currentBulkOperation(type: QUERY) { id status errorCode objectCount url } }`);
  const json = await res.json();
  const op = json.data?.currentBulkOperation;
  return {
    id: op?.id ?? null,
    status: op?.status ?? "UNKNOWN",
    url: op?.url ?? null,
    objectCount: Number(op?.objectCount ?? 0),
  };
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
interface RawMetafield {
  id?: string;
  namespace?: string;
  key?: string;
  value?: string;
  type?: string;
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

// Metafield value types worth exposing as a filter. Anything structured
// (JSON blobs, references, rich text) is noise in a facet list.
const FILTERABLE_METAFIELD_TYPES = new Set([
  "single_line_text_field",
  "multi_line_text_field",
  "number_integer",
  "number_decimal",
  "boolean",
  "color",
  "rating",
  "dimension",
  "weight",
  "volume",
]);

/**
 * Parse bulk JSONL. Nested connections arrive as separate lines carrying
 * __parentId; we group variants/collections/metafields under their product,
 * then normalise.
 */
export function parseBulkJsonl(text: string): NormalizedProduct[] {
  const products = new Map<string, RawProduct>();
  const variantsByParent = new Map<string, RawVariant[]>();
  const collectionsByParent = new Map<string, string[]>();
  const metafieldsByParent = new Map<string, RawMetafield[]>();

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
    } else if (id.includes("/Metafield/") || (obj.__parentId && obj.key != null)) {
      // A metafield line is recognisable by `key` even with no id.
      if (obj.__parentId) push(metafieldsByParent, obj.__parentId, obj);
    } else if (id.includes("/Collection/") || (obj.__parentId && obj.handle && !id)) {
      // A collection line carries a handle and a parent, and no product line
      // ever has a __parentId, so this cannot swallow a product.
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
      // The export is already filtered to Online Store publications.
      publishedOnline: true,
      priceMin: Number(p.priceRangeV2?.minVariantPrice?.amount ?? 0),
      priceMax: Number(p.priceRangeV2?.maxVariantPrice?.amount ?? 0),
      currencyCode: p.priceRangeV2?.minVariantPrice?.currencyCode ?? "",
      imageUrl: p.featuredImage?.url ?? null,
      imageAlt: p.featuredImage?.altText ?? null,
      options: optionsFromVariants(variants),
      collections: collectionsByParent.get(gid) ?? [],
      metafields: normalizeMetafields(metafieldsByParent.get(gid) ?? []),
      publishedAt: p.publishedAt ? new Date(p.publishedAt) : null,
      productUpdatedAt: p.updatedAt ? new Date(p.updatedAt) : null,
      variants,
    });
  }
  return out;
}

/** Flatten metafields to `namespace.key -> value`, filtered to facetable types. */
export function normalizeMetafields(
  raw: RawMetafield[],
): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const mf of raw) {
    if (count >= 50) break;
    if (!mf.key || mf.value == null) continue;
    if (mf.type && !FILTERABLE_METAFIELD_TYPES.has(mf.type)) continue;
    const value = String(mf.value).slice(0, 200);
    if (!value) continue;
    // Both the qualified and bare key: merchants configure facets as
    // "metafield:material", not "metafield:custom.material".
    out[`${mf.namespace ?? "custom"}.${mf.key}`] = value;
    if (!(mf.key in out)) out[mf.key] = value;
    count++;
  }
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => {
      const map: Record<string, string> = {
        amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
      };
      return map[String(name).toLowerCase()] ?? " ";
    })
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
}

/** Is a sync already in flight for this shop (and still alive)? */
export async function isSyncRunning(shopId: string): Promise<boolean> {
  const state = await prisma.syncState.findUnique({ where: { shopId } });
  if (!state || state.status !== "running") return false;
  const beat = state.heartbeatAt ?? state.startedAt ?? state.updatedAt;
  return Date.now() - new Date(beat).getTime() < STALE_RUN_MS;
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
): Promise<{ count: number; truncated: boolean; skipped?: boolean }> {
  const maxWaitMs = opts.maxWaitMs ?? 30 * 60_000;
  const pollMs = opts.pollMs ?? 2_000;
  const productLimit = opts.productLimit ?? Infinity;

  // Two concurrent syncs would fight over the same rows and double the write
  // load for no benefit. A stale "running" row (crashed process) does not block.
  if (await isSyncRunning(shopId)) {
    return { count: 0, truncated: false, skipped: true };
  }

  // Everything written by THIS run gets an indexedAt at or after this instant.
  // Reconciliation then deletes by timestamp instead of by a "not in (...)" list
  // of every surviving id, which blew past Postgres' bind-parameter ceiling on
  // large catalogs and did nothing at all when the catalog was empty.
  const runStartedAt = new Date();

  const beat = async (data: Record<string, unknown>) => {
    await prisma.syncState.update({
      where: { shopId },
      data: { ...data, heartbeatAt: new Date() },
    });
  };

  await prisma.syncState.upsert({
    where: { shopId },
    create: {
      shopId, status: "running", phase: "exporting",
      startedAt: runStartedAt, heartbeatAt: runStartedAt,
      progressCurrent: 0, progressTotal: 0, message: "Exporting your catalog from Shopify…",
    },
    update: {
      status: "running", phase: "exporting",
      startedAt: runStartedAt, heartbeatAt: runStartedAt,
      progressCurrent: 0, progressTotal: 0, message: "Exporting your catalog from Shopify…",
    },
  });

  try {
    const opId = await startBulkSync(admin);
    await beat({ bulkOpId: opId, phase: "exporting", message: "Shopify is preparing your product export…" });

    const deadline = Date.now() + maxWaitMs;
    let url: string | null = null;
    let completed = false;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const op = await pollBulk(admin);
      // A heartbeat during the export phase too, so a long export is never
      // mistaken for a crashed process.
      await beat({
        message: op.objectCount
          ? `Shopify is preparing your export… ${op.objectCount.toLocaleString()} objects so far`
          : "Shopify is preparing your product export…",
      });
      if (op.status === "COMPLETED") {
        url = op.url;
        completed = true;
        break;
      }
      if (["FAILED", "CANCELED", "EXPIRED"].includes(op.status)) {
        throw new Error(`Bulk operation ${op.status}`);
      }
    }

    if (!completed) throw new Error("Bulk export timed out");

    let count = 0;
    let truncated = false;
    if (url) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Bulk result download failed (${resp.status})`);
      const text = await resp.text();
      const parsed = parseBulkJsonl(text);
      // Free plan caps the indexed catalog; Pro is unlimited.
      const toIndex = parsed.slice(0, productLimit);
      truncated = parsed.length > toIndex.length;

      // Enter the indexing phase with the known total, so the UI can show a
      // real progress bar and "X of Y (Z left)".
      await beat({
        phase: "indexing",
        progressTotal: toIndex.length,
        progressCurrent: 0,
        message: `Indexing ${toIndex.length} products…`,
      });

      for (let i = 0; i < toIndex.length; i += WRITE_CHUNK) {
        const chunk = toIndex.slice(i, i + WRITE_CHUNK);
        count += await upsertProductsBatch(shopId, chunk);
        await beat({
          progressCurrent: count,
          message: `Indexing… ${count} of ${toIndex.length} products`,
        });
      }
    }

    // Reconcile: anything not touched by this run is gone from the catalog (or
    // trimmed by the plan's product limit).
    const removed = await prisma.product.deleteMany({
      where: { shopId, indexedAt: { lt: runStartedAt } },
    });

    // Also index collections + pages for the autocomplete sections (resilient).
    await syncCollectionsAndPages(shopId, admin).catch(() => {});

    // Semantic backfill, if configured. Never fatal: keyword search is complete
    // without it, and this can take a while on a big catalog.
    await beat({ message: "Finishing up…" });
    const embedded = await embedPendingProducts(shopId).catch(() => 0);

    // Housekeeping that has to happen periodically and has no better trigger.
    await pruneAnalytics(shopId).catch(() => {});
    await decayPopularity(shopId).catch(() => {});

    invalidateShopConfig(shopId);

    await prisma.syncState.update({
      where: { shopId },
      data: {
        status: "idle",
        phase: "done",
        lastSyncAt: new Date(),
        heartbeatAt: new Date(),
        productCount: count,
        progressCurrent: count,
        progressTotal: count,
        message: truncated
          ? `Indexed ${count} products (Free plan limit — upgrade to index all)`
          : `Indexed ${count} products${removed.count ? `, removed ${removed.count} stale` : ""}${embedded ? `, embedded ${embedded}` : ""}`,
      },
    });
    return { count, truncated };
  } catch (e: any) {
    await prisma.syncState.update({
      where: { shopId },
      data: {
        status: "error",
        phase: "error",
        heartbeatAt: new Date(),
        message: e?.message?.slice(0, 500) ?? "Sync failed",
      },
    });
    throw e;
  }
}

/**
 * Popularity is a running total of clicks/carts/purchases. Without decay a
 * product that sold well last winter outranks this week's best seller forever,
 * and the "Most popular" sort slowly freezes. Halve everything roughly monthly.
 */
export async function decayPopularity(shopId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Product"
    SET "popularity" = "popularity" * 0.5,
        "popularityDecayedAt" = NOW()
    WHERE "shopId" = ${shopId}
      AND "popularity" > 0
      AND ("popularityDecayedAt" IS NULL OR "popularityDecayedAt" < NOW() - INTERVAL '30 days')`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
