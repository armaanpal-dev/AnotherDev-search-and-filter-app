// Query normalisation + synonym handling. Pure functions, no DB — easy to unit test.

/**
 * Lowercase, strip control chars, fold accents, collapse whitespace.
 *
 * Accent folding MUST happen here as well as in SQL: the indexed columns are
 * `lower(ad_immutable_unaccent(...))`, so a query that still carries its accents
 * ("café") can never equal the folded index entry ("cafe"). Folding both sides
 * makes the comparison symmetric.
 */
export function normalizeQuery(raw: string): string {
  return foldAccents(String(raw ?? ""))
    .toLowerCase()
    // Matching control characters is the entire point: a pasted query can carry
    // NULs and newlines that would otherwise reach the tsquery parser.
    // eslint-disable-next-line no-control-regex
    .replace(/[\0-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Decompose then drop combining marks: "Café" -> "Cafe". */
export function foldAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").normalize("NFC");
}

/**
 * Escape the LIKE wildcards `%` and `_` (and the escape char itself) so a
 * shopper typing "50%" searches for the literal string instead of matching the
 * entire catalog. Pair with `ESCAPE '\'` in SQL.
 *
 * The replacement must be a literal backslash followed by `$&`. Writing "\$&"
 * collapses to "$&" when JS parses the string literal, which substitutes the
 * match back unchanged — i.e. no escaping happened at all, and a search for "%"
 * matched the entire catalog.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/**
 * Neutralise Liquid markup in any value interpolated into an App Proxy response.
 * Shopify renders those responses THROUGH Liquid in the merchant's theme
 * context, so an unescaped `{{ ... }}` in a search term or a product title is
 * executed server-side. HTML-escaping does not help: `{` and `%` are not
 * HTML-special. A zero-width space inside each delimiter breaks the token while
 * staying invisible to the shopper.
 */
export function stripLiquid(s: string): string {
  return String(s ?? "")
    .replace(/\{\{/g, "{​{")
    .replace(/\}\}/g, "}​}")
    .replace(/\{%/g, "{​%")
    .replace(/%\}/g, "%​}");
}

/**
 * The same defusing, for a value that will end up inside a JSON payload which is
 * itself rendered through Liquid — the `<script type="application/ld+json">`
 * block on the crawlable results page.
 *
 * Two things make this a separate function rather than a call to `stripLiquid`:
 *
 *  - The zero-width space above is invisible in rendered HTML but is a real
 *    character in structured data, so it would end up inside the product names
 *    Google reads. An ordinary space breaks the token just as well and is honest
 *    about it.
 *  - It must be applied to the VALUES before serialisation, never to the
 *    serialised JSON, because JSON's own `{` and `}` are structural. That is why
 *    `defuseLiquidDeep` exists.
 */
export function stripLiquidJson(s: string): string {
  return String(s ?? "")
    .replace(/\{\{/g, "{ {")
    .replace(/\}\}/g, "} }")
    .replace(/\{%/g, "{ %")
    .replace(/%\}/g, "% }");
}

/**
 * Recursively defuse every string in a JSON-able value, keys included.
 *
 * Without this, the JSON-LD block was the one place on the crawlable results
 * page where a value reached Liquid unescaped — and the search term is
 * shopper-controlled, so `?q={{ shop.email }}` was executed server-side in the
 * merchant's context.
 */
export function defuseLiquidDeep<T>(value: T): T {
  if (typeof value === "string") return stripLiquidJson(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => defuseLiquidDeep(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[stripLiquidJson(k)] = defuseLiquidDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Does this look like a SKU / product code rather than prose? Codes are short,
 * unspaced, and mix letters with digits or separators ("TSH-RED-M", "AB12345").
 * Drives the exact-SKU branch of the query, which outranks everything else.
 */
export function looksLikeSku(term: string): boolean {
  const t = term.trim();
  if (t.length < 3 || t.length > 64) return false;
  if (/\s/.test(t)) return false;
  return /\d/.test(t) && /^[\p{L}\p{N}._/-]+$/u.test(t);
}

/** Tokenise into words for prefix/fuzzy handling. */
export function tokenize(term: string): string[] {
  return normalizeQuery(term)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export interface SynonymRule {
  type: "multiway" | "oneway";
  input: string | null;
  terms: string[];
}

/**
 * Does `phrase` occur in `normalizedQuery` as a whole word / whole phrase?
 * Boundary-aware so "hat" does NOT match the synonym term "a". Single tokens
 * check word membership; multi-word phrases check space-padded inclusion.
 */
function phraseInQuery(
  phrase: string,
  normalizedQuery: string,
  words: Set<string>,
): boolean {
  const p = normalizeQuery(phrase);
  if (!p) return false;
  if (!p.includes(" ")) return words.has(p);
  return ` ${normalizedQuery} `.includes(` ${p} `);
}

/**
 * Cap on how many phrases reach the tsquery. Every expansion becomes another OR
 * group, and a merchant with hundreds of synonym rules could otherwise build a
 * query the planner cannot execute quickly.
 */
export const MAX_EXPANSIONS = 12;

/**
 * Expand a query with merchant synonyms.
 * - multiway: if any listed term appears, all listed terms are OR-added.
 * - oneway:   if `input` appears, `terms` are OR-added (but not vice-versa).
 * Returns the ORIGINAL query plus any expansion terms, de-duplicated and capped.
 */
export function expandSynonyms(term: string, rules: SynonymRule[]): string[] {
  const normalized = normalizeQuery(term);
  const words = new Set(tokenize(normalized));
  const expansions = new Set<string>([normalized]);

  for (const rule of rules) {
    if (expansions.size >= MAX_EXPANSIONS) break;
    if (rule.type === "oneway") {
      if (rule.input && phraseInQuery(rule.input, normalized, words)) {
        rule.terms.forEach((t) => expansions.add(normalizeQuery(t)));
      }
    } else {
      const hit = rule.terms.some((t) => phraseInQuery(t, normalized, words));
      if (hit) rule.terms.forEach((t) => expansions.add(normalizeQuery(t)));
    }
  }

  return [...expansions].filter(Boolean).slice(0, MAX_EXPANSIONS);
}

/**
 * Build a Postgres `websearch_to_tsquery` string from expansion phrases.
 * Each phrase becomes an OR group; within a phrase words are AND-ed by websearch.
 *
 * websearch_to_tsquery treats a leading `-` as NOT and a bare `or` as the OR
 * operator, so shopper input is sanitised first — otherwise searching
 * "shirt -blue" or the literal word "or" silently rewrites the query.
 */
export function toTsQuery(expansions: string[]): string {
  const clean = (phrase: string) =>
    phrase
      .replace(/["']/g, " ")
      .split(/\s+/)
      .map((w) => w.replace(/^[-!]+/, "")) // strip NOT operators
      .filter((w) => w && w.toLowerCase() !== "or")
      .join(" ")
      .trim();

  return expansions
    .map(clean)
    .filter(Boolean)
    .map((p) => (p.includes(" ") ? `(${p})` : p))
    .join(" OR ");
}
