// The search contract. Everything (storefront API, admin preview) talks to a
// `SearchEngine`, never to Postgres directly. Swapping to Meilisearch/Typesense
// later means writing one new implementation of this interface — nothing else moves.

export type SortKey =
  | "relevance"
  | "price_asc"
  | "price_desc"
  | "title_asc"
  | "title_desc"
  | "newest"
  | "bestselling";

export interface FilterSelection {
  // source -> selected values. e.g. { "option:Color": ["Red"], "vendor": ["Nike"] }
  [source: string]: string[];
}

export interface PriceRange {
  min?: number;
  max?: number;
}

export interface SearchQuery {
  shopId: string;
  term: string;
  page: number;
  perPage: number;
  sort: SortKey;
  filters: FilterSelection;
  price?: PriceRange;
  collection?: string; // scope to a collection handle
  // When true, only faceting metadata is needed (used by filter-only collection pages)
  facetsOnly?: boolean;
  // Include out-of-stock products in results
  includeUnavailable?: boolean;
  // Merchant toggle: when false, fuzzy/trigram matching is skipped (exact only).
  typoTolerance?: boolean;
  // Merchant toggle: blend pgvector similarity into ranking (Pro + configured).
  semantic?: boolean;
}

export interface ProductHit {
  productId: string;
  handle: string;
  title: string;
  vendor: string;
  productType: string;
  priceMin: number;
  priceMax: number;
  currencyCode: string;
  imageUrl: string | null;
  imageAlt: string | null;
  available: boolean;
  tags: string[];
  options: Record<string, string[]>;
  score: number;
  pinned: boolean;
  // Short description, included in autocomplete for the hover-preview pane.
  description?: string;
  // First variant id — lets the storefront offer add-to-cart straight from the
  // results grid for single-variant products.
  variantId?: string | null;
  variantCount?: number;
}

export interface FacetValue {
  value: string;
  label: string;
  count: number;
  // Optional swatch colour/image resolved from the merchant's swatch map.
  swatch?: string;
}

export interface Facet {
  source: string;
  label: string;
  displayAs: "checkbox" | "range" | "swatch" | "list";
  values: FacetValue[];
  // for range facets
  min?: number;
  max?: number;
}

export interface SearchResult {
  hits: ProductHit[];
  total: number;
  page: number;
  perPage: number;
  facets: Facet[];
  // Populated when the term matched a merchant redirect rule.
  redirect?: string;
  // "did you mean" suggestion when results are thin.
  suggestion?: string;
  // Debug/telemetry: which strategy produced the hits.
  strategy: "fulltext" | "fuzzy" | "hybrid" | "browse" | "sku" | "semantic";
  tookMs: number;
}

export interface AutocompleteQuery {
  shopId: string;
  term: string;
  limit: number;
  includeUnavailable?: boolean;
  typoTolerance?: boolean;
}

export interface CollectionHit {
  handle: string;
  title: string;
  imageUrl: string | null;
  productCount: number;
}

export interface PageHit {
  handle: string;
  title: string;
}

export interface AutocompleteResult {
  products: ProductHit[];
  suggestions: string[]; // query completions
  collections: CollectionHit[];
  pages: PageHit[];
  // Set when the typed term matches a merchant redirect, so the dropdown can
  // offer/perform the jump instead of showing an empty product list.
  redirect?: string;
}

/** Product recommendations — same index, different surface (PDP, cart, empty search). */
export type RecommendationKind = "related" | "trending" | "bestsellers" | "recent";

export interface RecommendationQuery {
  shopId: string;
  kind: RecommendationKind;
  // Anchor product for "related" (Shopify product id, numeric part).
  productId?: string;
  collection?: string;
  limit: number;
  includeUnavailable?: boolean;
}

export interface SearchEngine {
  search(query: SearchQuery): Promise<SearchResult>;
  autocomplete(query: AutocompleteQuery): Promise<AutocompleteResult>;
  recommend(query: RecommendationQuery): Promise<ProductHit[]>;
}
