import prisma from "../../db.server";
import type { SynonymRule } from "./normalize";
import { normalizeQuery } from "./normalize";
import { TtlCache } from "../cache.server";
import { resolveSettings, type WidgetSettings } from "../settings";

/** A single attribute-driven merchandising clause. */
export interface MerchCondition {
  // "tag" | "vendor" | "productType" | "collection" | "available" | "option:Color"
  field: string;
  op: "eq" | "neq" | "contains";
  value: string;
  action: "boost" | "bury" | "hide" | "pin";
  weight: number;
}

export interface MerchRule {
  triggerQuery: string | null;
  triggerCollection: string | null;
  pinnedProductIds: string[];
  boostedProductIds: string[];
  buriedProductIds: string[];
  hiddenProductIds: string[];
  conditions: MerchCondition[];
  priority: number;
}

export interface FilterConfigLite {
  source: string;
  label: string;
  displayAs: "checkbox" | "range" | "swatch" | "list";
  position: number;
  enabled: boolean;
}

export interface ShopConfig {
  planName: string;
  settings: WidgetSettings;
  synonyms: SynonymRule[];
  redirects: Map<string, string>;
  rules: MerchRule[];
  filters: FilterConfigLite[];
  // handle -> title, so a collection facet can show "Summer Sale" instead of
  // "summer-sale".
  collectionTitles: Map<string, string>;
  // lowercased option value -> CSS colour or image URL, merchant-configurable.
  swatches: Map<string, string>;
  matchRule: (normalizedQuery: string, collection?: string) => MerchRule | null;
}

// Storefront search is hot; config changes rarely.
const CACHE_TTL_MS = 30_000;
const cache = new TtlCache<ShopConfig>(CACHE_TTL_MS, 500);

export function invalidateShopConfig(shopId: string) {
  cache.delete(shopId);
  // Facet counts are derived from this config (which facets are enabled), so a
  // config change has to drop them too or a disabled facet keeps rendering.
  facetCache.deletePrefix(`${shopId}:`);
}

/** Cached facet aggregates, keyed by shop + the exact predicate signature. */
export const facetCache = new TtlCache<unknown>(
  Number(process.env.FACET_CACHE_TTL_MS ?? 20_000),
  3000,
);

/** Sensible default facets when a merchant hasn't customised them yet. */
export const DEFAULT_FILTERS: FilterConfigLite[] = [
  { source: "price", label: "Price", displayAs: "range", position: 0, enabled: true },
  { source: "productType", label: "Product type", displayAs: "checkbox", position: 1, enabled: true },
  { source: "vendor", label: "Brand", displayAs: "checkbox", position: 2, enabled: true },
  { source: "option:Color", label: "Color", displayAs: "swatch", position: 3, enabled: true },
  { source: "option:Size", label: "Size", displayAs: "list", position: 4, enabled: true },
  { source: "tag", label: "Tag", displayAs: "checkbox", position: 5, enabled: false },
  { source: "availability", label: "Availability", displayAs: "checkbox", position: 6, enabled: false },
  { source: "collection", label: "Collection", displayAs: "checkbox", position: 7, enabled: false },
];

/** Defensive parse — `conditions` is merchant-authored JSON in a Json column. */
function parseConditions(raw: unknown): MerchCondition[] {
  if (!Array.isArray(raw)) return [];
  const ops = new Set(["eq", "neq", "contains"]);
  const actions = new Set(["boost", "bury", "hide", "pin"]);
  return raw
    .filter((c: any) => c && typeof c.field === "string" && typeof c.value === "string")
    .filter((c: any) => ops.has(c.op) && actions.has(c.action))
    .map((c: any) => ({
      field: String(c.field),
      op: c.op as MerchCondition["op"],
      value: String(c.value),
      action: c.action as MerchCondition["action"],
      // Clamp: an unbounded weight would let one rule dominate every score.
      weight: Math.max(0, Math.min(20, Number(c.weight) || 5)),
    }))
    .slice(0, 20);
}

/** Merchant swatch map lives in Shop.settings so it needs no extra table. */
function parseSwatches(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value) out.set(key.trim().toLowerCase(), value);
  }
  return out;
}

async function loadShopConfig(shopId: string): Promise<ShopConfig> {
  const [shop, synonyms, redirects, rules, filters, collections] = await Promise.all([
    prisma.shop.findUnique({
      where: { id: shopId },
      select: { planName: true, settings: true },
    }),
    prisma.synonym.findMany({ where: { shopId }, take: 2000 }),
    prisma.redirect.findMany({ where: { shopId, active: true }, take: 2000 }),
    prisma.merchandisingRule.findMany({
      where: { shopId, active: true },
      orderBy: { priority: "desc" },
      take: 500,
    }),
    prisma.filterConfig.findMany({
      where: { shopId },
      orderBy: { position: "asc" },
    }),
    prisma.collection.findMany({
      where: { shopId },
      select: { handle: true, title: true },
    }),
  ]);

  const settings = resolveSettings(shop?.settings);

  const cfg: ShopConfig = {
    planName: shop?.planName ?? "free",
    settings,
    synonyms: synonyms.map((s) => ({
      type: s.type === "oneway" ? "oneway" : "multiway",
      input: s.input,
      terms: s.terms,
    })),
    redirects: new Map(redirects.map((r) => [normalizeQuery(r.query), r.url])),
    rules: rules.map((r) => ({
      triggerQuery: r.triggerQuery ? normalizeQuery(r.triggerQuery) : null,
      triggerCollection: r.triggerCollection,
      pinnedProductIds: r.pinnedProductIds,
      boostedProductIds: r.boostedProductIds,
      buriedProductIds: r.buriedProductIds,
      hiddenProductIds: r.hiddenProductIds,
      conditions: parseConditions(r.conditions),
      priority: r.priority,
    })),
    filters: filters.length
      ? filters.map((f) => ({
          source: f.source,
          label: f.label,
          displayAs: f.displayAs as FilterConfigLite["displayAs"],
          position: f.position,
          enabled: f.enabled,
        }))
      : DEFAULT_FILTERS,
    collectionTitles: new Map(collections.map((c) => [c.handle, c.title])),
    swatches: parseSwatches((settings as any).swatches),
    matchRule(normalizedQuery: string, collection?: string) {
      // Highest-priority rule whose trigger(s) match. A rule with no trigger at
      // all is a global rule — valid now that conditions exist, since it can
      // still target products by attribute rather than by query.
      for (const r of this.rules) {
        const qOk = !r.triggerQuery || r.triggerQuery === normalizedQuery;
        const cOk = !r.triggerCollection || r.triggerCollection === collection;
        if (!qOk || !cOk) continue;
        const hasTrigger = Boolean(r.triggerQuery || r.triggerCollection);
        if (hasTrigger || r.conditions.length) return r;
      }
      return null;
    },
  };

  return cfg;
}

export async function getShopConfig(shopId: string): Promise<ShopConfig> {
  return cache.wrap(shopId, () => loadShopConfig(shopId));
}
