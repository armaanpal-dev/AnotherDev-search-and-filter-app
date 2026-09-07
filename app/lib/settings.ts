// Storefront widget settings — the single source of truth, stored on Shop.settings
// (JSON). The admin Settings page writes these; the storefront reads them live via
// the /apps/anotherdev-search/config proxy endpoint. Keeping them in the app (not
// the theme editor) means merchants configure everything in one place.

export interface WidgetSettings {
  /**
   * What the app does on the storefront at all.
   *
   * The three switches below (autoAttach, searchTakeover, collectionFilters)
   * are fine-grained, but nothing said what the app was FOR. A merchant who
   * only wants collection filters had to know that two unrelated-sounding
   * toggles were the search half.
   *
   *   both     search and filters (default)
   *   search   instant search only, collection pages untouched
   *   filters  collection filters only, the theme keeps its own search
   */
  mode: "both" | "search" | "filters";
  // Behaviour
  autoAttach: boolean;          // upgrade the theme's own search box
  searchTakeover: boolean;      // hijack the theme's /search page with our results
  showRecommendations: boolean; // recommendations when the box is empty
  recentSearches: boolean;      // remember this shopper's recent searches
  typoTolerance: boolean;
  // Offer a microphone beside the search box where the browser supports it.
  // Most storefront traffic is a phone, where typing is the slowest part of the
  // journey; the Web Speech API is built in, so this costs nothing to ship.
  voiceSearch: boolean;
  semanticSearch: boolean;      // blend embedding similarity into ranking (Pro)
  showOutOfStock: boolean;
  minChars: number;
  maxSuggestions: number;
  // Where the widget takes over
  collectionFilters: boolean;   // inject filters + grid on collection pages
  /**
   * Who draws the product cards on a collection page.
   *
   * These are not interchangeable, and the trade-off is forced on us by
   * Shopify: theme cards are re-rendered through the Section Rendering API,
   * which can only be filtered by Shopify’s native filter params, and those
   * are ignored unless the merchant enabled the matching filter under Search
   * & Discovery. Our own grid is filtered by our index, so every facet works
   * — but the cards are ours, not the theme’s.
   *
   *   auto   theme cards when every configured facet is natively supported,
   *          our grid when one is not, so filters always work (default)
   *   theme  always the theme’s cards; facets Shopify cannot apply are
   *          dropped rather than shown broken
   *   app    always our grid, so every facet works regardless of the theme
   */
  productCards: "auto" | "theme" | "app";
  // How the facet UI is presented on results and collection pages.
  //   sidebar  column beside the grid, drawer on mobile (default)
  //   topbar   one horizontal row above the grid
  //   drawer   always behind a Filters button, at every width
  //   inline   always open, stacked above the grid
  filterLayout: "sidebar" | "topbar" | "drawer" | "inline";
  // Filter button appearance.
  filterButtonShape: "pill" | "rounded" | "square";
  filterButtonBg: string;
  filterButtonText: string;
  filterActiveBg: string;
  filterActiveText: string;
  showFacetCounts: boolean;
  // Layout / look
  panelStyle: "dropdown" | "spotlight";
  layout: "rich" | "list";      // two-pane hover preview vs simple list
  previewSide: "left" | "right";
  resultsPerPage: number;
  gridColumns: number;
  showVendor: boolean;
  quickAdd: boolean;            // add-to-cart straight from the results grid
  // Appearance
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  highlightColor: string;
  fontSize: number;
  fontWeight: string;
  // option value -> CSS colour or image URL, e.g. { "royal blue": "#4169e1" }
  swatches: Record<string, string>;
}

export const DEFAULT_SETTINGS: WidgetSettings = {
  mode: "both",
  autoAttach: true,
  searchTakeover: true,
  showRecommendations: true,
  recentSearches: true,
  typoTolerance: true,
  voiceSearch: true,
  semanticSearch: false,
  showOutOfStock: false,
  minChars: 2,
  maxSuggestions: 8,
  collectionFilters: true,
  productCards: "auto",
  filterLayout: "sidebar",
  filterButtonShape: "pill",
  filterButtonBg: "transparent",
  filterButtonText: "#1a1a1a",
  filterActiveBg: "#111111",
  filterActiveText: "#ffffff",
  showFacetCounts: true,
  panelStyle: "spotlight",
  layout: "rich",
  previewSide: "left",
  resultsPerPage: 24,
  gridColumns: 4,
  showVendor: false,
  quickAdd: false,
  accentColor: "#111111",
  backgroundColor: "#ffffff",
  textColor: "#1a1a1a",
  highlightColor: "#4f46e5",
  fontSize: 14,
  fontWeight: "400",
  swatches: {},
};

/** Merge stored (partial) settings over defaults, coercing types safely. */
export function resolveSettings(stored: unknown): WidgetSettings {
  const s = (stored ?? {}) as Partial<WidgetSettings>;
  return {
    mode: oneOf(s.mode, ["both", "search", "filters"], DEFAULT_SETTINGS.mode),
    autoAttach: bool(s.autoAttach, DEFAULT_SETTINGS.autoAttach),
    searchTakeover: bool(s.searchTakeover, DEFAULT_SETTINGS.searchTakeover),
    showRecommendations: bool(s.showRecommendations, DEFAULT_SETTINGS.showRecommendations),
    recentSearches: bool(s.recentSearches, DEFAULT_SETTINGS.recentSearches),
    typoTolerance: bool(s.typoTolerance, DEFAULT_SETTINGS.typoTolerance),
    voiceSearch: bool(s.voiceSearch, DEFAULT_SETTINGS.voiceSearch),
    semanticSearch: bool(s.semanticSearch, DEFAULT_SETTINGS.semanticSearch),
    showOutOfStock: bool(s.showOutOfStock, DEFAULT_SETTINGS.showOutOfStock),
    minChars: num(s.minChars, DEFAULT_SETTINGS.minChars, 1, 4),
    maxSuggestions: num(s.maxSuggestions, DEFAULT_SETTINGS.maxSuggestions, 3, 12),
    collectionFilters: bool(s.collectionFilters, DEFAULT_SETTINGS.collectionFilters),
    productCards: oneOf(s.productCards, ["auto", "theme", "app"], DEFAULT_SETTINGS.productCards),
    filterButtonShape: oneOf(s.filterButtonShape, ["pill", "rounded", "square"], DEFAULT_SETTINGS.filterButtonShape),
    filterButtonBg: color(s.filterButtonBg, DEFAULT_SETTINGS.filterButtonBg),
    filterButtonText: color(s.filterButtonText, DEFAULT_SETTINGS.filterButtonText),
    filterActiveBg: color(s.filterActiveBg, DEFAULT_SETTINGS.filterActiveBg),
    filterActiveText: color(s.filterActiveText, DEFAULT_SETTINGS.filterActiveText),
    showFacetCounts: bool(s.showFacetCounts, DEFAULT_SETTINGS.showFacetCounts),
    filterLayout: oneOf(
      s.filterLayout,
      ["sidebar", "topbar", "drawer", "inline"],
      DEFAULT_SETTINGS.filterLayout,
    ),
    panelStyle: oneOf(s.panelStyle, ["spotlight", "dropdown"], DEFAULT_SETTINGS.panelStyle),
    layout: oneOf(s.layout, ["rich", "list"], DEFAULT_SETTINGS.layout),
    previewSide: oneOf(s.previewSide, ["left", "right"], DEFAULT_SETTINGS.previewSide),
    resultsPerPage: num(s.resultsPerPage, DEFAULT_SETTINGS.resultsPerPage, 12, 48),
    gridColumns: num(s.gridColumns, DEFAULT_SETTINGS.gridColumns, 2, 5),
    showVendor: bool(s.showVendor, DEFAULT_SETTINGS.showVendor),
    quickAdd: bool(s.quickAdd, DEFAULT_SETTINGS.quickAdd),
    accentColor: color(s.accentColor, DEFAULT_SETTINGS.accentColor),
    backgroundColor: color(s.backgroundColor, DEFAULT_SETTINGS.backgroundColor),
    textColor: color(s.textColor, DEFAULT_SETTINGS.textColor),
    highlightColor: color(s.highlightColor, DEFAULT_SETTINGS.highlightColor),
    fontSize: num(s.fontSize, DEFAULT_SETTINGS.fontSize, 12, 22),
    fontWeight: oneOf(String(s.fontWeight), ["300", "400", "500", "600", "700"], DEFAULT_SETTINGS.fontWeight),
    swatches: swatchMap(s.swatches),
  };
}

/**
 * Apply a partial update on top of what is already stored.
 *
 * The Settings form only renders a subset of these fields. Rebuilding the whole
 * object from the form alone silently reset every setting the form does not
 * include (resultsPerPage, gridColumns, showVendor, recentSearches,
 * collectionFilters) back to its default on every save.
 */
export function mergeSettings(
  stored: unknown,
  patch: Partial<Record<keyof WidgetSettings, unknown>>,
): WidgetSettings {
  const current = resolveSettings(stored);
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && value !== null) defined[key] = value;
  }
  return resolveSettings({ ...current, ...defined });
}

const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number, min: number, max: number) => {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  allowed.includes(v as T) ? (v as T) : d;

/**
 * Colours are injected straight into a CSS custom property on the storefront, so
 * only accept shapes that cannot escape the declaration. Anything else falls back
 * to the default rather than becoming a style-injection vector.
 */
const COLOR_RE =
  /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\)|[a-z]{3,20})$/i;
const color = (v: unknown, d: string) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s && COLOR_RE.test(s) ? s : d;
};

/** Merchant-defined swatches: option value -> colour or image URL. */
function swatchMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (count >= 300) break;
    if (typeof value !== "string") continue;
    const k = key.trim().toLowerCase();
    const val = value.trim();
    if (!k || !val) continue;
    // Either a safe colour token or an https image URL — nothing else reaches CSS.
    const ok = COLOR_RE.test(val) || /^https:\/\/[^\s'"()]+$/i.test(val);
    if (!ok) continue;
    out[k] = val;
    count++;
  }
  return out;
}
