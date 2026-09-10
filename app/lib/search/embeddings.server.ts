// Optional semantic layer. Keyword search answers "which products contain these
// words"; embeddings answer "which products MEAN this" — the difference between
// finding nothing for "something warm for a winter wedding" and surfacing the
// wool coats. Entirely opt-in: with SEMANTIC_SEARCH_ENABLED unset the app runs
// exactly as before, and every function here short-circuits.
//
// Providers are HTTP-only so there is no SDK to install. 1024 dimensions to match
// the `vector(1024)` column in prisma/sql/search_index.sql — Voyage's native size,
// and reachable on OpenAI's v3 models via the `dimensions` parameter.
import prisma from "../../db.server";

export const EMBEDDING_DIMS = 1024;

type Provider = "voyage" | "openai";

interface ProviderConfig {
  provider: Provider;
  apiKey: string;
  model: string;
}

/**
 * Where the embeddings API lives.
 *
 * Voyage was acquired by MongoDB, who serve the same API from their own host
 * for keys issued there — so a key can be perfectly valid and still 401 against
 * api.voyageai.com. The host is therefore a config value, not a constant: a
 * merchant or operator moving hosts is an env change, not a code change.
 *
 * Only the ORIGIN is configurable. If a provider ever changes the path as well,
 * that is a real API change and belongs in code where it can be reviewed.
 */
function apiBase(provider: Provider): string {
  const override = process.env.EMBEDDINGS_BASE_URL;
  if (override) return override.replace(/\/+$/, "");
  return provider === "openai" ? "https://api.openai.com" : "https://api.voyageai.com";
}

/**
 * POST to the embeddings provider, retrying the failures that are worth retrying.
 *
 * A document batch asks the provider to fetch every product image, which is
 * heavy enough to trip rate limiting — a live sync returned 429 on the very
 * first batch and, because nothing retried, the whole catalog ended with no
 * vectors at all. 429 and 5xx are transient by definition; 4xx of any other
 * kind is a bad request and retrying it just wastes time and quota.
 *
 * Honours Retry-After when the provider sends one, since it knows better than
 * a fixed backoff does.
 */
async function postWithRetry(
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, init);
    if (res.ok || (res.status !== 429 && res.status < 500)) return res;
    last = res;
    if (i === attempts - 1) break;
    const header = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(header) && header > 0
      ? Math.min(header * 1000, 15_000)
      : 1_000 * 2 ** i; // 1s, 2s, 4s
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return last as Response;
}

function providerConfig(): ProviderConfig | null {
  if (process.env.SEMANTIC_SEARCH_ENABLED !== "true") return null;
  const provider = (process.env.EMBEDDINGS_PROVIDER ?? "voyage") as Provider;
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    return {
      provider,
      apiKey,
      model: process.env.EMBEDDINGS_MODEL ?? "text-embedding-3-small",
    };
  }
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;
  return {
    provider: "voyage",
    apiKey,
    // Multimodal puts text and images in ONE space, which is the whole trick
    // behind search-by-photo: the product vectors and the uploaded picture
    // become comparable without a second index. Same 1024 dimensions, so the
    // existing column and HNSW index are unchanged.
    model:
      process.env.EMBEDDINGS_MODEL ??
      (multimodalEnabled() ? "voyage-multimodal-3" : "voyage-3.5-lite"),
  };
}

/**
 * Is search-by-image switched on for this deployment?
 *
 * Separate from SEMANTIC_SEARCH_ENABLED because it costs something real: the
 * product vectors have to be built by a multimodal model, which is slower and
 * dearer than the text one, and turning it on invalidates every embedding
 * already stored. OpenAI has no multimodal embedding endpoint, so this is
 * Voyage-only — and says so rather than silently doing nothing.
 */
export function multimodalEnabled(): boolean {
  return (
    process.env.SEMANTIC_SEARCH_ENABLED === "true" &&
    process.env.EMBEDDINGS_MULTIMODAL === "true" &&
    (process.env.EMBEDDINGS_PROVIDER ?? "voyage") === "voyage" &&
    !!process.env.VOYAGE_API_KEY
  );
}

/** Image search needs the multimodal model AND the pgvector column. */
export async function imageSearchReady(): Promise<boolean> {
  return multimodalEnabled() && (await hasVectorColumn());
}

/** Cheap synchronous check callers use before doing any semantic work. */
export function isSemanticEnabled(): boolean {
  return providerConfig() !== null;
}

/**
 * Does the database actually have the pgvector column? The migration adds it only
 * when the extension is installable, so a managed Postgres without pgvector must
 * degrade to keyword-only rather than erroring on every search. Cached after the
 * first probe — the answer cannot change without a redeploy.
 */
let vectorColumnPresent: boolean | null = null;
export async function hasVectorColumn(): Promise<boolean> {
  if (vectorColumnPresent !== null) return vectorColumnPresent;
  try {
    const rows = await prisma.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'Product' AND column_name = 'embedding'
      ) AS present`;
    vectorColumnPresent = Boolean(rows[0]?.present);
  } catch {
    vectorColumnPresent = false;
  }
  return vectorColumnPresent;
}

/** Semantic search is only live when BOTH the provider and the column exist. */
export async function semanticReady(): Promise<boolean> {
  return isSemanticEnabled() && (await hasVectorColumn());
}

/**
 * `input_type` materially improves retrieval on Voyage: queries and documents get
 * embedded into the same space but with different framing. OpenAI has no such
 * parameter, so the argument is ignored there.
 */
type InputType = "query" | "document";

async function callProvider(
  cfg: ProviderConfig,
  texts: string[],
  inputType: InputType,
): Promise<number[][]> {
  if (cfg.provider === "openai") {
    const res = await postWithRetry(apiBase("openai") + "/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        input: texts,
        dimensions: EMBEDDING_DIMS,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}`);
    const json: any = await res.json();
    return (json.data ?? []).map((d: any) => d.embedding as number[]);
  }

  const res = await postWithRetry(apiBase("voyage") + "/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      input: texts,
      input_type: inputType,
      output_dimension: EMBEDDING_DIMS,
    }),
  });
  if (!res.ok) throw new Error(`Voyage embeddings ${res.status}`);
  const json: any = await res.json();
  return (json.data ?? []).map((d: any) => d.embedding as number[]);
}

/**
 * Embed a batch. Returns null (never throws) when semantic search is off or the
 * provider is unreachable — a failing embeddings API must degrade search to
 * keyword-only, not take the storefront down.
 */
export async function embed(
  texts: string[],
  inputType: InputType,
): Promise<number[][] | null> {
  const cfg = providerConfig();
  if (!cfg || texts.length === 0) return null;
  try {
    /* Multimodal and text models are NOT interchangeable, in two ways that both
       bite:

       1. They live on different endpoints. /v1/embeddings rejects
          voyage-multimodal-3 outright — "Model voyage-multimodal-3 is not
          supported" — so every query embedding was a hard 400.
       2. They produce different vector spaces. When multimodal is on, product
          documents are embedded through the multimodal endpoint; a query
          embedded by a text model would not be comparable to them, and every
          cosine distance would be noise rather than meaning.

       So the choice of endpoint has to follow multimodalEnabled(), not the call
       site. Routing here means embedQuery and every other caller inherit it. */
    if (multimodalEnabled() && cfg.provider === "voyage") {
      return await callMultimodalText(cfg, texts, inputType);
    }
    return await callProvider(cfg, texts, inputType);
  } catch (e: any) {
    console.error("[embeddings] batch failed:", e?.message);
    return null;
  }
}

/**
 * Text through the multimodal endpoint, so text queries land in the same space
 * as the multimodal product vectors. The content array is the multimodal
 * endpoint's input shape; a text-only block is a perfectly valid member of it.
 */
async function callMultimodalText(
  cfg: ProviderConfig,
  texts: string[],
  inputType: InputType,
): Promise<number[][]> {
  const res = await postWithRetry(apiBase("voyage") + "/v1/multimodalembeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      inputs: texts.map((t) => ({ content: [{ type: "text", text: t.slice(0, 4000) }] })),
      input_type: inputType,
    }),
  });
  if (!res.ok) throw new Error(`Voyage multimodal text ${res.status}`);
  const json: { data?: { embedding?: number[] }[] } = await res.json();
  return (json.data ?? []).map((d) => d.embedding as number[]);
}

// Query embeddings are the hot path: the same handful of terms repeat all day,
// and each miss is a network round-trip in front of the search. A small LRU keeps
// popular queries free.
const QUERY_CACHE_MAX = 500;
const queryCache = new Map<string, number[]>();

export async function embedQuery(term: string): Promise<number[] | null> {
  const key = term.trim().toLowerCase();
  if (!key) return null;
  const hit = queryCache.get(key);
  if (hit) {
    // Re-insert to mark most-recently-used.
    queryCache.delete(key);
    queryCache.set(key, hit);
    return hit;
  }
  const out = await embed([key], "query");
  const vec = out?.[0];
  if (!vec) return null;
  queryCache.set(key, vec);
  if (queryCache.size > QUERY_CACHE_MAX) {
    queryCache.delete(queryCache.keys().next().value as string);
  }
  return vec;
}

/** pgvector's text input format: '[0.1,0.2,...]'. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Embed a shopper's uploaded photo into the same space as the product vectors.
 *
 * "Find me that jacket" is a query no keyword index can answer, and it is
 * exactly what a shopper does when they have seen something and cannot name it.
 * Multimodal embeddings make it a nearest-neighbour lookup against the index the
 * app already maintains — no separate service, no second index.
 *
 * Never throws: an unreachable provider, an unreadable image or a model that
 * declines it must all degrade to "no results from the photo", not to a broken
 * storefront.
 */
export async function embedImage(
  dataUrl: string,
): Promise<number[] | null> {
  if (!multimodalEnabled()) return null;
  const cfg = providerConfig();
  if (!cfg || cfg.provider !== "voyage") return null;

  try {
    const res = await postWithRetry(apiBase("voyage") + "/v1/multimodalembeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        // The content array is how the multimodal endpoint takes mixed input;
        // one image and nothing else is a pure visual query.
        inputs: [{ content: [{ type: "image_base64", image_base64: dataUrl }] }],
        input_type: "query",
      }),
    });
    if (!res.ok) throw new Error(`Voyage multimodal ${res.status}`);
    const json: { data?: { embedding?: number[] }[] } = await res.json();
    const vec = json.data?.[0]?.embedding;
    return Array.isArray(vec) && vec.length === EMBEDDING_DIMS ? vec : null;
  } catch (e: unknown) {
    console.error("[embeddings] image embed failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Product vectors, built from the title AND the product photo when multimodal is
 * on. Embedding both is what lets a text query and a photo query rank against
 * the same rows.
 */
async function embedDocuments(
  rows: { text: string; imageUrl: string | null }[],
): Promise<number[][] | null> {
  const cfg = providerConfig();
  if (!cfg || !rows.length) return null;

  if (!multimodalEnabled() || cfg.provider !== "voyage") {
    return embed(rows.map((r) => r.text), "document");
  }

  try {
    const res = await postWithRetry(apiBase("voyage") + "/v1/multimodalembeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        inputs: rows.map((r) => ({
          content: [
            { type: "text", text: r.text.slice(0, 4000) },
            // Shopify's CDN URLs are public, so the provider can fetch them
            // directly and we never proxy image bytes through this server.
            ...(r.imageUrl ? [{ type: "image_url", image_url: r.imageUrl }] : []),
          ],
        })),
        input_type: "document",
      }),
    });
    if (!res.ok) throw new Error(`Voyage multimodal ${res.status}`);
    const json: { data?: { embedding?: number[] }[] } = await res.json();
    const vectors = (json.data ?? []).map((d) => d.embedding as number[]);
    return vectors.length === rows.length ? vectors : null;
  } catch (e: unknown) {
    console.error(
      "[embeddings] multimodal document batch failed:",
      e instanceof Error ? e.message : e,
    );
    // Text-only is a worse index, not a broken one, so it is the right fallback.
    return embed(rows.map((r) => r.text), "document");
  }
}

/** What we actually embed for a product — the fields that carry meaning. */
export function productEmbeddingText(p: {
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
  description: string;
}): string {
  return [
    p.title,
    p.productType,
    p.vendor,
    p.tags.join(" "),
    p.description.slice(0, 1000),
  ]
    .filter(Boolean)
    .join(". ")
    .slice(0, 4000);
}

/**
 * Embed products whose `embeddedAt` is null (new or changed since the last run).
 * Called at the tail of a catalog sync and safe to call repeatedly — it walks the
 * backlog in batches and stops when there is nothing left or the budget runs out.
 *
 * Returns how many rows were embedded.
 */
export async function embedPendingProducts(
  shopId: string,
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<number> {
  if (!(await semanticReady())) return 0;
  // A multimodal batch makes the provider fetch one image per row, so 64 at a
  // time is what tripped the rate limiter. Text-only batches are cheap and stay
  // large; the batch count budget grows to match so the catalog still finishes.
  const multimodal = multimodalEnabled();
  const batchSize = opts.batchSize ?? (multimodal ? 8 : 64);
  const maxBatches = opts.maxBatches ?? (multimodal ? 320 : 40);
  let done = 0;

  for (let i = 0; i < maxBatches; i++) {
    const pending = await prisma.product.findMany({
      where: { shopId, embeddedAt: null },
      select: {
        id: true,
        title: true,
        vendor: true,
        productType: true,
        tags: true,
        description: true,
        imageUrl: true,
      },
      take: batchSize,
    });
    if (!pending.length) break;

    const vectors = await embedDocuments(
      pending.map((p) => ({ text: productEmbeddingText(p), imageUrl: p.imageUrl })),
    );
    if (!vectors || vectors.length !== pending.length) break; // provider trouble

    // One statement per row: pgvector has no bulk-update helper, and these run
    // outside the request path so latency is not critical.
    for (let j = 0; j < pending.length; j++) {
      const literal = toVectorLiteral(vectors[j]);
      await prisma.$executeRawUnsafe(
        `UPDATE "Product" SET "embedding" = $1::vector, "embeddedAt" = NOW() WHERE "id" = $2`,
        literal,
        pending[j].id,
      );
    }
    done += pending.length;
  }
  return done;
}
