import prisma from "../../db.server";
import type { SynonymRule } from "./normalize";
import { normalizeQuery } from "./normalize";

export interface MerchRule {
  triggerQuery: string | null;
  triggerCollection: string | null;
  pinnedProductIds: string[];
  boostedProductIds: string[];
  buriedProductIds: string[];
  hiddenProductIds: string[];
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
  synonyms: SynonymRule[];
  redirects: Map<string, string>;
  rules: MerchRule[];
  filters: FilterConfigLite[];
  // handle -> title, so a collection facet can show "Summer Sale" instead of
  // "summer-sale".
  collectionTitles: Map<string, string>;
  matchRule: (normalizedQuery: string, collection?: string) => MerchRule | null;
}

// Small in-process cache. Storefront search is hot; config changes rarely.
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; cfg: ShopConfig }>();

export function invalidateShopConfig(shopId: string) {
  cache.delete(shopId);
}

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

export async function getShopConfig(shopId: string): Promise<ShopConfig> {
  const cached = cache.get(shopId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.cfg;

  const [synonyms, redirects, rules, filters, collections] = await Promise.all([
    prisma.synonym.findMany({ where: { shopId } }),
    prisma.redirect.findMany({ where: { shopId, active: true } }),
    prisma.merchandisingRule.findMany({
      where: { shopId, active: true },
      orderBy: { priority: "desc" },
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

  const cfg: ShopConfig = {
    synonyms: synonyms.map((s) => ({
      type: s.type === "oneway" ? "oneway" : "multiway",
      input: s.input,
      terms: s.terms,
    })),
    redirects: new Map(
      redirects.map((r) => [normalizeQuery(r.query), r.url]),
    ),
    rules: rules.map((r) => ({
      triggerQuery: r.triggerQuery ? normalizeQuery(r.triggerQuery) : null,
      triggerCollection: r.triggerCollection,
      pinnedProductIds: r.pinnedProductIds,
      boostedProductIds: r.boostedProductIds,
      buriedProductIds: r.buriedProductIds,
      hiddenProductIds: r.hiddenProductIds,
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
    matchRule(normalizedQuery: string, collection?: string) {
      // Highest-priority rule whose trigger(s) match. Null triggers are wildcards.
      for (const r of this.rules) {
        const qOk = !r.triggerQuery || r.triggerQuery === normalizedQuery;
        const cOk = !r.triggerCollection || r.triggerCollection === collection;
        if ((r.triggerQuery || r.triggerCollection) && qOk && cOk) return r;
      }
      return null;
    },
  };

  cache.set(shopId, { at: Date.now(), cfg });
  return cfg;
}
