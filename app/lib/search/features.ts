// Pure logic for the features ported from the source "AI Search & Filter" app:
// search banners, suggestion blacklist, multi-query lists, size ordering, merged
// filter values, per-collection filter groups and Quick View variant selection.
// No DB access here, so all of it is unit-tested in test/features.test.mjs.
import { normalizeQuery } from "./normalize";
import type { FacetValue, FilterSelection } from "./types";

export class ValidationError extends Error {}

/* ------------------------------------------------------------------ banners */

export type BannerPlacement = "top" | "grid";

export interface BannerInput {
  query: string;
  placement: BannerPlacement;
  position: number;
  imageUrl: string;
  targetUrl: string;
  heading: string;
  content: string;
  buttonLabel: string;
  backgroundColor: string;
  textColor: string;
}

export interface Banner extends BannerInput {
  id: string;
}

interface FormLike {
  get(name: string): unknown;
}

const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

/** A link a banner or redirect may point at: a store path, or an https URL. */
export function safeLink(raw: unknown, what = "link"): string {
  const v = String(raw ?? "").trim();
  if (!v) return "";
  if (v.startsWith("/") && !v.startsWith("//") && !v.includes("\\")) return v.slice(0, 500);
  try {
    const u = new URL(v);
    if (u.protocol === "https:") return u.toString().slice(0, 500);
  } catch {
    /* fall through */
  }
  throw new ValidationError(`The ${what} must be a path on your store (e.g. /collections/sale) or an https:// URL.`);
}

function text(form: FormLike, key: string, max: number): string {
  return String(form.get(key) ?? "").trim().slice(0, max);
}

function colour(form: FormLike, key: string, fallback: string): string {
  const v = text(form, key, 7);
  if (!v) return fallback;
  if (!HEX.test(v)) throw new ValidationError(`Enter a hex colour like #ffffff for ${key}.`);
  return v.toLowerCase();
}

export function validateBanner(form: FormLike): BannerInput {
  const query = normalizeQuery(String(form.get("query") ?? ""));
  if (!query || query.length > 200) throw new ValidationError("Enter the search term this banner shows for.");
  const placement = form.get("placement");
  if (placement !== "top" && placement !== "grid") throw new ValidationError("Choose Top or Product grid placement.");
  const position =
    placement === "grid" ? Math.min(48, Math.max(1, Math.floor(Number(form.get("position")) || 1))) : 1;
  const imageUrl = safeLink(form.get("imageUrl"), "image URL");
  const heading = text(form, "heading", 120);
  const content = text(form, "content", 500);
  if (placement === "top" && !imageUrl) throw new ValidationError("Top banners need an image URL.");
  if (placement === "grid" && !imageUrl && !heading) throw new ValidationError("Grid banners need an image or a heading.");
  return {
    query,
    placement,
    position,
    imageUrl,
    targetUrl: safeLink(form.get("targetUrl")),
    heading,
    content,
    buttonLabel: text(form, "buttonLabel", 40),
    backgroundColor: colour(form, "backgroundColor", "#f4f4f5"),
    textColor: colour(form, "textColor", "#18181b"),
  };
}

/** Insert grid banners into a list of cards at their 1-based positions. */
export function placeGridBanners<T, B extends { position: number }>(
  items: T[],
  banners: B[],
): Array<T | { banner: B }> {
  const out: Array<T | { banner: B }> = [...items];
  for (const b of [...banners].sort((a, z) => a.position - z.position)) {
    out.splice(Math.min(out.length, b.position - 1), 0, { banner: b });
  }
  return out;
}

/* ---------------------------------------------------------------- blacklist */

export type BlacklistOperator = "equals" | "contains" | "starts_with";

export interface BlacklistRule {
  term: string;
  operator: BlacklistOperator | string;
}

export const BLACKLIST_OPERATORS: BlacklistOperator[] = ["equals", "contains", "starts_with"];

export function isSuggestionBlocked(suggestion: string, rules: BlacklistRule[]): boolean {
  const s = normalizeQuery(suggestion);
  return rules.some((r) => {
    const t = normalizeQuery(r.term);
    if (!t) return false;
    if (r.operator === "contains") return s.includes(t);
    if (r.operator === "starts_with") return s.startsWith(t);
    return s === t;
  });
}

/* --------------------------------------------------------------- query list */

/** "Shoes, boots\nsneakers" -> normalised, de-duplicated terms (max 50). */
export function parseQueryList(raw: unknown): string[] {
  const seen = new Set<string>();
  for (const part of String(raw ?? "").split(/[,\n]/)) {
    const q = normalizeQuery(part);
    if (q && q.length <= 200) seen.add(q);
    if (seen.size >= 50) break;
  }
  return [...seen];
}

/* ------------------------------------------------------------- size mapping */

// Aliases share a rank: "xxs" and "2xs" are the same size.
const BUILT_IN_RANK = new Map<string, number>();
[["xxxs", "3xs"], ["xxs", "2xs"], ["xs"], ["s", "small"], ["m", "medium"], ["l", "large"],
  ["xl"], ["xxl", "2xl"], ["xxxl", "3xl"], ["4xl"], ["5xl"]]
  .forEach((g, i) => g.forEach((v) => BUILT_IN_RANK.set(v, 1000 + i)));

/**
 * Order size facet values. Merchant ranks win, then letter sizes, then numeric
 * sizes, then anything unrecognised alphabetically.
 */
export function sortSizeValues(values: string[], merchantRanks: Map<string, number>): string[] {
  const key = (v: string): [number, number, string] => {
    const lower = v.trim().toLowerCase();
    const m = merchantRanks.get(lower);
    if (m != null) return [0, m, lower];
    const b = BUILT_IN_RANK.get(lower);
    if (b != null) return [1, b, lower];
    const n = Number(lower.replace(",", "."));
    if (lower !== "" && Number.isFinite(n)) return [2, n, lower];
    return [3, 0, lower];
  };
  return [...values].sort((a, z) => {
    const ka = key(a), kz = key(z);
    return ka[0] - kz[0] || ka[1] - kz[1] || ka[2].localeCompare(kz[2]);
  });
}

/** Which facet sources are size-like and should use sortSizeValues. */
export function isSizeSource(source: string): boolean {
  return /^option:(size|taille|größe|grosse|talla|maat)$/i.test(source);
}

/* ------------------------------------------------------------ merged values */

export interface MergeRule {
  source: string;
  target: string;
  sourceValues: string[];
}

/** A selected merged target filters by every value folded into it. */
export function expandMergedSelection(filters: FilterSelection, merges: MergeRule[]): FilterSelection {
  if (!merges.length) return filters;
  const out: FilterSelection = {};
  for (const [source, values] of Object.entries(filters)) {
    const set = new Set(values);
    for (const m of merges) {
      if (m.source === source && set.has(m.target)) m.sourceValues.forEach((v) => set.add(v));
    }
    out[source] = [...set];
  }
  return out;
}

/** Fold merged source values into their target and sum their counts. */
export function mergeFacetValues(source: string, values: FacetValue[], merges: MergeRule[]): FacetValue[] {
  const relevant = merges.filter((m) => m.source === source);
  if (!relevant.length) return values;
  const targetOf = new Map<string, string>();
  for (const m of relevant) {
    targetOf.set(m.target, m.target);
    m.sourceValues.forEach((v) => targetOf.set(v, m.target));
  }
  const out = new Map<string, FacetValue>();
  for (const v of values) {
    const target = targetOf.get(v.value) ?? v.value;
    const existing = out.get(target);
    if (existing) existing.count += v.count;
    else out.set(target, { ...v, value: target, label: target === v.value ? v.label : target, count: v.count });
  }
  return [...out.values()].sort((a, z) => z.count - a.count);
}

/* ------------------------------------------------------------ filter groups */

export interface FilterGroupLite {
  collections: string[];
  sources: string[];
}

/** Facet sources for a collection page, or null to use the shop defaults. */
export function facetSourcesFor(collection: string | undefined, groups: FilterGroupLite[]): string[] | null {
  if (!collection) return null;
  const g = groups.find((x) => x.collections.includes(collection));
  return g ? g.sources : null;
}

/* --------------------------------------------------------------- quick view */

export interface QvVariant {
  id: number | string;
  options: string[];
  available: boolean;
}

export interface QvProduct {
  options: Array<{ name: string } | string>;
  variants: QvVariant[];
}

export function resolveVariant<V extends QvVariant>(product: { variants: V[] }, selected: string[]): V | null {
  return product.variants.find((v) => selected.every((s, i) => v.options[i] === s)) ?? null;
}

export function firstAvailableVariant<V extends QvVariant>(product: { variants: V[] }): V | null {
  return product.variants.find((v) => v.available) ?? product.variants[0] ?? null;
}
