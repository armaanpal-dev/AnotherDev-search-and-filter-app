// The Postgres text-search configurations this app will use for stemming.
//
// This list is the allowlist AND the picker's options. It exists because the
// config name is interpolated into SQL as an identifier (`websearch_to_tsquery
// ('english', …)`) — it cannot be a bind parameter, so the only thing standing
// between a stored value and injection is that nothing outside this list is ever
// allowed through `toTsConfig`.
//
// Keep in sync with ad_ts_config() in prisma/sql/search_index.sql, which maps the
// same names inside the generated column.

export const SEARCH_LANGUAGES = [
  // No stemming. The right answer for a mixed-language catalog, and for one that
  // is mostly product codes and brand names, where a stemmer only loses matches.
  { value: "simple", label: "None — match words exactly (default)" },
  { value: "english", label: "English" },
  { value: "french", label: "French" },
  { value: "german", label: "German" },
  { value: "spanish", label: "Spanish" },
  { value: "italian", label: "Italian" },
  { value: "portuguese", label: "Portuguese" },
  { value: "dutch", label: "Dutch" },
  { value: "danish", label: "Danish" },
  { value: "swedish", label: "Swedish" },
  { value: "norwegian", label: "Norwegian" },
  { value: "finnish", label: "Finnish" },
  { value: "russian", label: "Russian" },
  { value: "turkish", label: "Turkish" },
  { value: "hungarian", label: "Hungarian" },
] as const;

export type SearchLanguage = (typeof SEARCH_LANGUAGES)[number]["value"];

const ALLOWED = new Set<string>(SEARCH_LANGUAGES.map((l) => l.value));

/**
 * Coerce a stored value to a configuration name that is safe to inline in SQL.
 * Anything unrecognised becomes "simple" rather than throwing: a shop whose
 * language was set before an entry was removed should degrade to exact matching,
 * not stop being searchable.
 */
export function toTsConfig(value: string | null | undefined): SearchLanguage {
  const v = String(value ?? "").trim().toLowerCase();
  return (ALLOWED.has(v) ? v : "simple") as SearchLanguage;
}

export function languageLabel(value: string | null | undefined): string {
  const v = toTsConfig(value);
  return SEARCH_LANGUAGES.find((l) => l.value === v)?.label ?? v;
}
