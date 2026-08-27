// Storefront widget settings — the single source of truth, stored on Shop.settings
// (JSON). The admin Settings page writes these; the storefront reads them live via
// the /apps/anotherdev-search/config proxy endpoint. Keeping them in the app (not
// the theme editor) means merchants configure everything in one place.

export interface WidgetSettings {
  // Behaviour
  autoAttach: boolean;         // upgrade the theme's own search box
  showRecommendations: boolean; // recommendations when the box is empty
  typoTolerance: boolean;
  showOutOfStock: boolean;
  minChars: number;
  maxSuggestions: number;
  // Layout / look
  panelStyle: "dropdown" | "spotlight";
  layout: "rich" | "list";     // two-pane hover preview vs simple list
  previewSide: "left" | "right";
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
  typoTolerance: true,
  showOutOfStock: false,
  minChars: 2,
  maxSuggestions: 8,
  panelStyle: "spotlight",
  layout: "rich",
  previewSide: "left",
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
    typoTolerance: bool(s.typoTolerance, DEFAULT_SETTINGS.typoTolerance),
    showOutOfStock: bool(s.showOutOfStock, DEFAULT_SETTINGS.showOutOfStock),
    minChars: num(s.minChars, DEFAULT_SETTINGS.minChars, 1, 4),
    maxSuggestions: num(s.maxSuggestions, DEFAULT_SETTINGS.maxSuggestions, 3, 12),
    panelStyle: s.panelStyle === "spotlight" ? "spotlight" : s.panelStyle === "dropdown" ? "dropdown" : DEFAULT_SETTINGS.panelStyle,
    layout: s.layout === "list" ? "list" : s.layout === "rich" ? "rich" : DEFAULT_SETTINGS.layout,
    previewSide: s.previewSide === "right" ? "right" : "left",
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
