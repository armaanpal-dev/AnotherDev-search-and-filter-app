// Storefront widget settings — the single source of truth, stored on Shop.settings
// (JSON). The admin Settings page writes these; the storefront reads them live via
// the /apps/anotherdev-search/config proxy endpoint. Keeping them in the app (not
// the theme editor) means merchants configure everything in one place.

export interface WidgetSettings {
  // Behaviour
  autoAttach: boolean;          // upgrade the theme's own search box
  showRecommendations: boolean; // recommendations when the box is empty
  recentSearches: boolean;      // remember this shopper's recent searches
  typoTolerance: boolean;
  showOutOfStock: boolean;
  minChars: number;
  maxSuggestions: number;
  // Where the widget takes over
  collectionFilters: boolean;   // inject filters + grid on collection pages
  // Layout / look
  panelStyle: "dropdown" | "spotlight";
  layout: "rich" | "list";      // two-pane hover preview vs simple list
  previewSide: "left" | "right";
  resultsPerPage: number;
  gridColumns: number;
  showVendor: boolean;
  // Appearance
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  highlightColor: string;
  fontSize: number;
  fontWeight: string;
}

export const DEFAULT_SETTINGS: WidgetSettings = {
  autoAttach: true,
  showRecommendations: true,
  recentSearches: true,
  typoTolerance: true,
  showOutOfStock: false,
  minChars: 2,
  maxSuggestions: 8,
  collectionFilters: true,
  panelStyle: "spotlight",
  layout: "rich",
  previewSide: "left",
  resultsPerPage: 24,
  gridColumns: 4,
  showVendor: false,
  accentColor: "#111111",
  backgroundColor: "#ffffff",
  textColor: "#1a1a1a",
  highlightColor: "#4f46e5",
  fontSize: 14,
  fontWeight: "400",
};

/** Merge stored (partial) settings over defaults, coercing types safely. */
export function resolveSettings(stored: unknown): WidgetSettings {
  const s = (stored ?? {}) as Partial<WidgetSettings>;
  return {
    autoAttach: bool(s.autoAttach, DEFAULT_SETTINGS.autoAttach),
    showRecommendations: bool(s.showRecommendations, DEFAULT_SETTINGS.showRecommendations),
    recentSearches: bool(s.recentSearches, DEFAULT_SETTINGS.recentSearches),
    typoTolerance: bool(s.typoTolerance, DEFAULT_SETTINGS.typoTolerance),
    showOutOfStock: bool(s.showOutOfStock, DEFAULT_SETTINGS.showOutOfStock),
    minChars: num(s.minChars, DEFAULT_SETTINGS.minChars, 1, 4),
    maxSuggestions: num(s.maxSuggestions, DEFAULT_SETTINGS.maxSuggestions, 3, 12),
    collectionFilters: bool(s.collectionFilters, DEFAULT_SETTINGS.collectionFilters),
    panelStyle: oneOf(s.panelStyle, ["spotlight", "dropdown"], DEFAULT_SETTINGS.panelStyle),
    layout: oneOf(s.layout, ["rich", "list"], DEFAULT_SETTINGS.layout),
    previewSide: oneOf(s.previewSide, ["left", "right"], DEFAULT_SETTINGS.previewSide),
    resultsPerPage: num(s.resultsPerPage, DEFAULT_SETTINGS.resultsPerPage, 12, 48),
    gridColumns: num(s.gridColumns, DEFAULT_SETTINGS.gridColumns, 2, 5),
    showVendor: bool(s.showVendor, DEFAULT_SETTINGS.showVendor),
    accentColor: str(s.accentColor, DEFAULT_SETTINGS.accentColor),
    backgroundColor: str(s.backgroundColor, DEFAULT_SETTINGS.backgroundColor),
    textColor: str(s.textColor, DEFAULT_SETTINGS.textColor),
    highlightColor: str(s.highlightColor, DEFAULT_SETTINGS.highlightColor),
    fontSize: num(s.fontSize, DEFAULT_SETTINGS.fontSize, 12, 22),
    fontWeight: str(s.fontWeight, DEFAULT_SETTINGS.fontWeight),
  };
}

const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const str = (v: unknown, d: string) => (typeof v === "string" && v ? v : d);
const num = (v: unknown, d: number, min: number, max: number) => {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  allowed.includes(v as T) ? (v as T) : d;
