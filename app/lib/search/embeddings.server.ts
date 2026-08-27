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
    model: process.env.EMBEDDINGS_MODEL ?? "voyage-3.5-lite",
  };
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
    const res = await fetch("https://api.openai.com/v1/embeddings", {
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

  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
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
    return await callProvider(cfg, texts, inputType);
  } catch (e: any) {
    console.error("[embeddings] batch failed:", e?.message);
    return null;
  }
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
  const batchSize = opts.batchSize ?? 64;
  const maxBatches = opts.maxBatches ?? 40;
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
      },
      take: batchSize,
    });
    if (!pending.length) break;

    const vectors = await embed(pending.map(productEmbeddingText), "document");
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
