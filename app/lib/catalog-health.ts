// Catalog health: compare what Shopify reports with what the index holds.
// Pure comparison logic; tested in test/features.test.mjs.

export interface HealthInput {
  shopifyActive: number;
  indexedActive: number;
  collections: { handle: string; title: string; shopify: number; indexed: number }[];
  recent: { productId: string; title: string; shopifyUpdatedAt: string; indexedUpdatedAt: string | null }[];
}

export interface HealthIssue {
  kind: "count" | "collection" | "missing" | "stale";
  message: string;
  productId?: string;
}

/** Allow a little slack: a webhook still in flight is not drift. */
const STALE_GRACE_MS = 10 * 60 * 1000;

export function compareCatalog(input: HealthInput, now = Date.now()): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const diff = input.shopifyActive - input.indexedActive;
  if (diff !== 0) {
    issues.push({
      kind: "count",
      message:
        diff > 0
          ? `Shopify has ${input.shopifyActive} active products; the index has ${input.indexedActive} (${diff} missing).`
          : `The index has ${-diff} more active products than Shopify (${input.indexedActive} vs ${input.shopifyActive}).`,
    });
  }
  for (const c of input.collections) {
    // Shopify's collection count includes drafts the index may skip, so only a
    // shortfall on the index side is worth flagging.
    if (c.indexed < c.shopify && c.shopify - c.indexed > Math.max(1, Math.round(c.shopify * 0.02))) {
      issues.push({
        kind: "collection",
        message: `“${c.title}”: Shopify lists ${c.shopify} products, the index has ${c.indexed}.`,
      });
    }
  }
  for (const r of input.recent) {
    if (!r.indexedUpdatedAt) {
      issues.push({ kind: "missing", productId: r.productId, message: `“${r.title}” is not in the index.` });
      continue;
    }
    const shopifyAt = Date.parse(r.shopifyUpdatedAt);
    const indexedAt = Date.parse(r.indexedUpdatedAt);
    if (shopifyAt - indexedAt > 1000 && now - shopifyAt > STALE_GRACE_MS) {
      issues.push({ kind: "stale", productId: r.productId, message: `“${r.title}” changed in Shopify after it was last indexed.` });
    }
  }
  return issues;
}
