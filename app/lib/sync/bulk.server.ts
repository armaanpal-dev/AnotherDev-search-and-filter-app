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
import { toTsConfig } from "../search/languages";
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

/** One product plus every child line that named it as parent. */
interface ProductGroup {
  product: RawProduct;
  variants: RawVariant[];
  collections: string[];
  metafields: RawMetafield[];
}

/** Turn a grouped product into the shape the index stores. */
function normalizeGroup(g: ProductGroup): NormalizedProduct {
  const p = g.product;
  const variants = g.variants.map((v) => ({
    variantId: gidId(v.id),
    title: v.title ?? "",
    sku: v.sku ?? "",
    price: Number(v.price ?? 0),
    available: Boolean(v.availableForSale),
    optionValues: Object.fromEntries(
      (v.selectedOptions ?? []).map((o) => [o.name, o.value]),
    ),
  }));

  return {
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
    collections: g.collections,
    metafields: normalizeMetafields(g.metafields),
    publishedAt: p.publishedAt ? new Date(p.publishedAt) : null,
    productUpdatedAt: p.updatedAt ? new Date(p.updatedAt) : null,
    variants,
  };
}

/**
 * Sort one JSONL line into the group it belongs to.
 *
 * Nested connections arrive as their own lines carrying `__parentId`; only the
 * product lines have none. Kept separate from the reader so both the streaming
 * and the whole-string paths classify lines identically.
 */
function classifyLine(
  obj: any,
  groups: Map<string, ProductGroup>,
  onProduct: (gid: string) => void,
): void {
  const id: string = obj.id ?? "";
  const parent: string | undefined = obj.__parentId;

  const group = (key: string) => {
    let g = groups.get(key);
    if (!g) {
      // A child seen before its parent: hold an empty shell for it. Shopify
      // normally emits the parent first, but nothing in the format guarantees it
      // and a dropped product would be silent.
      g = { product: { id: key } as RawProduct, variants: [], collections: [], metafields: [] };
      groups.set(key, g);
    }
    return g;
  };

  if (id.includes("/ProductVariant/")) {
    if (parent) group(parent).variants.push(obj);
  } else if (id.includes("/Metafield/") || (parent && obj.key != null)) {
    // A metafield line is recognisable by `key` even with no id.
    if (parent) group(parent).metafields.push(obj);
  } else if (id.includes("/Collection/") || (parent && obj.handle && !id)) {
    // A collection line carries a handle and a parent, and no product line
    // ever has a __parentId, so this cannot swallow a product.
    if (parent && obj.handle) group(parent).collections.push(obj.handle);
  } else if (id.includes("/Product/")) {
    group(id).product = obj;
    onProduct(id);
  }
}

/**
 * Parse a whole bulk JSONL string. Kept for tests and small ad-hoc use; the sync
 * itself uses `streamBulkJsonl`, which never holds the file in memory.
 */
export function parseBulkJsonl(text: string): NormalizedProduct[] {
  const groups = new Map<string, ProductGroup>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      classifyLine(JSON.parse(trimmed), groups, () => {});
    } catch {
      continue;
    }
  }
  const out: NormalizedProduct[] = [];
  for (const g of groups.values()) {
    if (g.product?.id) out.push(normalizeGroup(g));
  }
  return out;
}

/**
 * Stream the bulk export, handing out fixed-size batches of products.
 *
 * The previous version did `await resp.text()` and then `split("\n")` — the
 * entire export as one JS string, plus an array of every line, plus the parsed
 * objects, all live at once. On a 512 MB container a large catalog ran the
 * machine out of memory during the one operation it exists to perform.
 *
 * Here nothing is retained but the batch being filled and the groups still
 * waiting for their children. Shopify emits a product's children immediately
 * after it, so a group can be released as soon as the NEXT product line starts —
 * `pendingGid` is that watermark. Anything still open at the end (a child that
 * arrived out of order) is flushed by the final drain, so correctness does not
 * depend on that ordering, only memory does.
 *
 * `onBatch` returning false stops the walk — that is how the Free plan's product
 * limit avoids downloading and parsing a catalog it will not index.
 */
export async function streamBulkJsonl(
  body: ReadableStream<Uint8Array>,
  batchSize: number,
  onBatch: (batch: NormalizedProduct[]) => Promise<boolean | void>,
): Promise<number> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const groups = new Map<string, ProductGroup>();
  let batch: NormalizedProduct[] = [];
  let pendingGid: string | null = null;
  let total = 0;
  let stopped = false;
  let carry = "";

  const release = async (gid: string) => {
    const g = groups.get(gid);
    groups.delete(gid);
    if (!g?.product?.id) return;
    batch.push(normalizeGroup(g));
    if (batch.length >= batchSize) {
      total += batch.length;
      const keepGoing = await onBatch(batch);
      batch = [];
      if (keepGoing === false) stopped = true;
    }
  };

  const handleLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    let started: string | null = null;
    classifyLine(obj, groups, (gid) => {
      started = gid;
    });
    if (started && started !== pendingGid) {
      if (pendingGid) await release(pendingGid);
      pendingGid = started;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        await handleLine(line);
        if (stopped) return total;
      }
    }
    carry += decoder.decode();
    if (carry) await handleLine(carry);
  } finally {
    // Releasing the reader lets the socket close even when we stopped early.
    try {
      reader.releaseLock();
    } catch {
      // Already released, or the stream errored — nothing to recover.
    }
  }

  // Drain: the last product, plus any group whose parent line arrived late.
  if (pendingGid) await release(pendingGid);
  for (const gid of [...groups.keys()]) await release(gid);
  if (batch.length) {
    total += batch.length;
    await onBatch(batch);
  }
  return total;
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
    // Attribute names seen while indexing. Collected here because this is the
    // one pass that already touches every product — the Filters and
    // Merchandising pages were each running `SELECT DISTINCT
    // jsonb_object_keys(...)` over the whole Product table on every page load to
    // learn the same thing.
    const optionNames = new Set<string>();
    const metafieldKeys = new Set<string>();

    if (url) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Bulk result download failed (${resp.status})`);
      if (!resp.body) throw new Error("Bulk result download returned no body");

      // The stemming configuration is a per-row column because searchVector is a
      // generated column; read it once and stamp it on everything this run writes.
      const shopRow = await prisma.shop.findUnique({
        where: { id: shopId },
        select: { searchLanguage: true },
      });
      const tsConfig = toTsConfig(shopRow?.searchLanguage);

      // The total is unknown until the stream ends, so the progress message
      // counts up rather than showing a percentage of nothing.
      await beat({
        phase: "indexing",
        progressTotal: 0,
        progressCurrent: 0,
        message: "Indexing your products…",
      });

      await streamBulkJsonl(resp.body, WRITE_CHUNK, async (batch) => {
        // Free plan caps the indexed catalog; Pro is unlimited. Trimming here
        // rather than after parsing means a capped shop never downloads the
        // remainder of its export at all.
        const room = productLimit - count;
        const chunk = batch.length > room ? batch.slice(0, Math.max(0, room)) : batch;
        if (chunk.length < batch.length) truncated = true;

        for (const p of chunk) {
          p.tsConfig = tsConfig;
          for (const name of Object.keys(p.options ?? {})) optionNames.add(name);
          for (const key of Object.keys(p.metafields ?? {})) metafieldKeys.add(key);
        }

        if (chunk.length) count += await upsertProductsBatch(shopId, chunk);
        await beat({
          progressCurrent: count,
          progressTotal: count,
          message: `Indexing… ${count.toLocaleString()} products`,
        });
        // Stop the walk once the plan's ceiling is reached.
        return count < productLimit;
      });
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
        // Sorted so the admin's pickers are stable between syncs.
        optionNames: [...optionNames].sort().slice(0, 100),
        metafieldKeys: [...metafieldKeys].sort().slice(0, 100),
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
