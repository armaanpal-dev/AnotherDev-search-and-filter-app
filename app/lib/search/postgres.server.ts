import { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { getShopConfig } from "./config.server";
import {
  normalizeQuery,
  expandSynonyms,
  toTsQuery,
  escapeLike,
  tokenize,
} from "./normalize";
import type {
  SearchEngine,
  SearchQuery,
  SearchResult,
  ProductHit,
  Facet,
  AutocompleteQuery,
  AutocompleteResult,
  FilterSelection,
  SortKey,
} from "./types";

const FUZZY_THRESHOLD = 0.2; // pg_trgm similarity floor for typo tolerance

// unaccent+lower helper mirrored from the SQL migration, for parameter comparisons.
const uaLower = (col: Prisma.Sql) =>
  Prisma.sql`lower(ad_immutable_unaccent(${col}))`;

// A single backslash inside the generated SQL: `ESCAPE '\'`. Written as `\\` here
// because this is a template literal.
const ESC = Prisma.raw(`ESCAPE '\\'`);

/** `col LIKE 'pattern' ESCAPE '\'` — the pattern is built from shopper input,
 *  whose wildcards the caller escapes with `escapeLike`. */
const like = (col: Prisma.Sql, pattern: string) =>
  Prisma.sql`${col} LIKE ${pattern} ${ESC}`;

// The columns every product-hit query selects. Kept in one place so the row
// shape and `rowToHit` can never drift apart.
const HIT_COLUMNS = Prisma.sql`
  p."productId", p."handle", p."title", p."vendor", p."productType",
  p."priceMin", p."priceMax", p."currencyCode", p."imageUrl", p."imageAlt",
  p."available", p."tags", p."options"`;

function rowToHit(r: any, extra: Partial<ProductHit> = {}): ProductHit {
  return {
    productId: r.productId,
    handle: r.handle,
    title: r.title,
    vendor: r.vendor,
    productType: r.productType,
    priceMin: Number(r.priceMin),
    priceMax: Number(r.priceMax),
    currencyCode: r.currencyCode,
    imageUrl: r.imageUrl,
    imageAlt: r.imageAlt,
    available: r.available,
    tags: r.tags ?? [],
    options: (r.options as Record<string, string[]>) ?? {},
    score: Number(r.score ?? 0),
    pinned: false,
    ...(r.description != null ? { description: r.description } : {}),
    ...extra,
  };
}

/** Build one SQL predicate per active filter, keyed by its source so facet
 *  counting can compose "every filter except my own dimension". */
function buildFilterPredicates(
  filters: FilterSelection,
  price?: { min?: number; max?: number },
  collection?: string,
): Map<string, Prisma.Sql> {
  const preds = new Map<string, Prisma.Sql>();

  for (const [source, values] of Object.entries(filters)) {
    if (!values || values.length === 0) continue;
    if (source === "vendor") {
      preds.set(source, Prisma.sql`p."vendor" IN (${Prisma.join(values)})`);
    } else if (source === "productType") {
      preds.set(source, Prisma.sql`p."productType" IN (${Prisma.join(values)})`);
    } else if (source === "tag") {
      preds.set(source, Prisma.sql`p."tags" && ARRAY[${Prisma.join(values)}]::text[]`);
    } else if (source === "collection") {
      // Shopper-selected collections (a facet), distinct from the page's scope.
      preds.set(source, Prisma.sql`p."collections" && ARRAY[${Prisma.join(values)}]::text[]`);
    } else if (source === "availability") {
      const wantIn = values.includes("in_stock");
      const wantOut = values.includes("out_of_stock");
      // Both (or neither) selected is a no-op rather than an empty result set.
      if (wantIn !== wantOut) {
        preds.set(source, Prisma.sql`p."available" = ${wantIn}`);
      }
    } else if (source.startsWith("option:")) {
      const opt = source.slice("option:".length);
      // options is { "Color": ["Red","Blue"] }; ?| tests any selected value present.
      preds.set(
        source,
        Prisma.sql`(p."options" -> ${opt}) ?| ARRAY[${Prisma.join(values)}]::text[]`,
      );
    } else if (source.startsWith("metafield:")) {
      const key = source.slice("metafield:".length);
      preds.set(
        source,
        Prisma.sql`(p."metafields" ->> ${key}) IN (${Prisma.join(values)})`,
      );
    }
  }

  if (price && (price.min != null || price.max != null)) {
    const parts: Prisma.Sql[] = [];
    if (price.min != null) parts.push(Prisma.sql`p."priceMax" >= ${price.min}`);
    if (price.max != null) parts.push(Prisma.sql`p."priceMin" <= ${price.max}`);
    preds.set("price", Prisma.sql`(${Prisma.join(parts, " AND ")})`);
  }

  if (collection) {
    preds.set(
      "__collection",
      Prisma.sql`p."collections" && ARRAY[${collection}]::text[]`,
    );
  }

  return preds;
}

function combine(preds: Prisma.Sql[]): Prisma.Sql {
  if (preds.length === 0) return Prisma.sql`TRUE`;
  return Prisma.join(preds, " AND ");
}

function orderByClause(sort: SortKey, hasTerm: boolean): Prisma.Sql {
  switch (sort) {
    case "price_asc":
      return Prisma.sql`p."priceMin" ASC`;
    case "price_desc":
      return Prisma.sql`p."priceMax" DESC`;
    case "title_asc":
      return Prisma.sql`p."title" ASC`;
    case "title_desc":
      return Prisma.sql`p."title" DESC`;
    case "newest":
      return Prisma.sql`p."publishedAt" DESC NULLS LAST`;
    case "bestselling":
      return Prisma.sql`p."popularity" DESC, p."publishedAt" DESC NULLS LAST`;
    case "relevance":
    default:
      return hasTerm
        ? Prisma.sql`score DESC, p."popularity" DESC`
        : Prisma.sql`p."popularity" DESC, p."publishedAt" DESC NULLS LAST`;
  }
}

export class PostgresSearchEngine implements SearchEngine {
  async search(q: SearchQuery): Promise<SearchResult> {
    const started = Date.now();
    const cfg = await getShopConfig(q.shopId);
    const normalized = normalizeQuery(q.term);
    const fuzzy = q.typoTolerance !== false;

    // 1. Redirects short-circuit everything.
    if (normalized) {
      const r = cfg.redirects.get(normalized);
      if (r) {
        return {
          hits: [],
          total: 0,
          page: 1,
          perPage: q.perPage,
          facets: [],
          redirect: r,
          strategy: "browse",
          tookMs: Date.now() - started,
        };
      }
    }

    const hasTerm = normalized.length > 0;
    const expansions = hasTerm ? expandSynonyms(normalized, cfg.synonyms) : [];
    const tsQueryStr = hasTerm ? toTsQuery(expansions) : "";

    // 2. Base predicate: shop scope + status/availability.
    // `base` deliberately excludes the availability clause: the availability
    // FACET has to count the out-of-stock bucket, which it cannot do if
    // "available = TRUE" is baked into every predicate it composes.
    const base: Prisma.Sql[] = [
      Prisma.sql`p."shopId" = ${q.shopId}`,
      Prisma.sql`p."status" = 'ACTIVE'`,
    ];
    const availPred: Prisma.Sql | null = q.includeUnavailable
      ? null
      : Prisma.sql`p."available" = TRUE`;
    if (availPred) base.push(availPred);

    // Merchandising: hidden products removed globally for matching rule.
    const rule = cfg.matchRule(normalized, q.collection);
    if (rule && rule.hiddenProductIds.length) {
      base.push(
        Prisma.sql`p."productId" NOT IN (${Prisma.join(rule.hiddenProductIds)})`,
      );
    }
    // Pins are prepended to page 1 only, so they may only be excluded from the
    // ORGANIC query on page 1. Excluding them on every page deleted them from
    // the catalog entirely from page 2 onwards.
    const pinsActive =
      !!rule?.pinnedProductIds.length && q.sort === "relevance" && q.page === 1;
    const baseForPins = [...base];
    if (pinsActive) {
      base.push(
        Prisma.sql`p."productId" NOT IN (${Prisma.join(rule!.pinnedProductIds)})`,
      );
    }

    // 3. Text predicate (full-text OR fuzzy OR substring). Empty term => browse.
    let textPred = Prisma.sql`TRUE`;
    let scoreExpr = Prisma.sql`0::float`;
    let strategy: SearchResult["strategy"] = "browse";

    if (hasTerm) {
      strategy = fuzzy ? "hybrid" : "fulltext";
      const tsq = Prisma.sql`websearch_to_tsquery('simple', ad_immutable_unaccent(${tsQueryStr}))`;
      const termParam = normalized;
      const esc = escapeLike(termParam);
      const title = uaLower(Prisma.sql`p."title"`);

      const textParts: Prisma.Sql[] = [
        Prisma.sql`p."searchVector" @@ ${tsq}`,
        like(title, `%${esc}%`),
      ];
      if (fuzzy) {
        textParts.push(
          Prisma.sql`similarity(${title}, ${termParam}) > ${FUZZY_THRESHOLD}`,
        );
      }
      textPred = Prisma.sql`(${Prisma.join(textParts, " OR ")})`;

      // Boost/bury from merchandising rule.
      let boostExpr = Prisma.sql`0::float`;
      if (rule) {
        if (rule.boostedProductIds.length)
          boostExpr = Prisma.sql`${boostExpr} + (CASE WHEN p."productId" IN (${Prisma.join(rule.boostedProductIds)}) THEN 5 ELSE 0 END)`;
        if (rule.buriedProductIds.length)
          boostExpr = Prisma.sql`${boostExpr} - (CASE WHEN p."productId" IN (${Prisma.join(rule.buriedProductIds)}) THEN 5 ELSE 0 END)`;
      }
      const simTerm = fuzzy
        ? Prisma.sql`similarity(${title}, ${termParam}) * 2.0`
        : Prisma.sql`0::float`;

      scoreExpr = Prisma.sql`(
        ts_rank_cd(p."searchVector", ${tsq}) * 4.0
        + ${simTerm}
        + (CASE WHEN ${title} LIKE ${esc + "%"} ${ESC} THEN 1.5 ELSE 0 END)
        + ln(1 + p."popularity") * 0.3
        + ${boostExpr}
      )`;
    }

    // 4. Filter predicates.
    const filterPreds = buildFilterPredicates(q.filters, q.price, q.collection);
    const whereAll = combine([
      ...base,
      textPred,
      ...filterPreds.values(),
    ]);

    // 5. Rows, total and every facet are independent queries. Run them
    //    concurrently rather than paying ~8 sequential round-trips per search.
    const offset = (q.page - 1) * q.perPage;
    const order = orderByClause(q.sort, hasTerm);

    const rowsPromise = q.facetsOnly
      ? Promise.resolve([] as any[])
      : prisma.$queryRaw<any[]>(Prisma.sql`
          SELECT ${HIT_COLUMNS}, ${scoreExpr} AS score
          FROM "Product" p
          WHERE ${whereAll}
          ORDER BY ${order}
          LIMIT ${q.perPage} OFFSET ${offset}
        `);

    const countPromise = prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count FROM "Product" p WHERE ${whereAll}
    `);

    const facetsPromise = this.computeFacets(
      base,
      availPred,
      textPred,
      filterPreds,
      cfg,
    );

    const [rows, countRows, facets] = await Promise.all([
      rowsPromise,
      countPromise,
      facetsPromise,
    ]);

    const total = Number(countRows[0]?.count ?? 0);
    let hits: ProductHit[] = rows.map((r) => rowToHit(r));

    // 6. Merchandising pins: prepend pinned products on page 1 when the shopper
    //    hasn't chosen an explicit sort (pins are a relevance-time concept).
    //    Pinned products must also satisfy the active filters + availability,
    //    and the page is trimmed back to perPage so pins don't overflow it.
    if (pinsActive && !q.facetsOnly) {
      const pinWhere = combine([...baseForPins, ...filterPreds.values()]);
      hits = await this.applyPins(
        rule!.pinnedProductIds,
        hits,
        pinWhere,
        q.perPage,
      );
    }

    // 7. "Did you mean" when the term returned little.
    let suggestion: string | undefined;
    if (hasTerm && total < 3 && fuzzy) {
      suggestion = await this.suggestSpelling(q.shopId, normalized);
    }

    return {
      hits,
      total,
      page: q.page,
      perPage: q.perPage,
      facets,
      suggestion,
      strategy,
      tookMs: Date.now() - started,
    };
  }

  private async applyPins(
    pinnedIds: string[],
    hits: ProductHit[],
    pinWhere: Prisma.Sql,
    perPage: number,
  ): Promise<ProductHit[]> {
    // Only pin products that ALSO satisfy the active filters + availability
    // (pinWhere = base + filter predicates). A product pinned for the query but
    // filtered out by the shopper must not reappear.
    const pinnedRows = await prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT ${HIT_COLUMNS}
      FROM "Product" p
      WHERE ${pinWhere} AND p."productId" IN (${Prisma.join(pinnedIds)})
    `);
    const byId = new Map(pinnedRows.map((p) => [p.productId, p]));
    const pinned: ProductHit[] = pinnedIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((p) => rowToHit(p, { score: 999, pinned: true }));
    const pinnedSet = new Set(pinned.map((p) => p.productId));
    // Prepend pins, drop them from the organic list, and trim back to perPage.
    return [...pinned, ...hits.filter((h) => !pinnedSet.has(h.productId))].slice(
      0,
      perPage,
    );
  }

  /** Facet counts. For each configured facet, apply the base + text + all OTHER
   *  filter predicates, then aggregate over that facet's dimension. */
  private async computeFacets(
    base: Prisma.Sql[],
    availPred: Prisma.Sql | null,
    textPred: Prisma.Sql,
    filterPreds: Map<string, Prisma.Sql>,
    cfg: Awaited<ReturnType<typeof getShopConfig>>,
  ): Promise<Facet[]> {
    const othersThan = (source: string) =>
      [...filterPreds.entries()]
        .filter(([s]) => s !== source)
        .map(([, sql]) => sql);

    const whereExcept = (source: string): Prisma.Sql =>
      combine([...base, textPred, ...othersThan(source)]);

    // An availability facet must ignore the "available = TRUE" clause, otherwise
    // the out-of-stock bucket always counts zero.
    const whereForAvailability = (): Prisma.Sql => {
      const baseNoAvail = availPred ? base.filter((s) => s !== availPred) : base;
      return combine([...baseNoAvail, textPred, ...othersThan("availability")]);
    };

    const enabled = cfg.filters.filter((f) => f.enabled);

    const built = await Promise.all(
      enabled.map(async (fc): Promise<Facet | null> => {
        if (fc.source === "price") {
          const rows = await prisma.$queryRaw<{ min: number | null; max: number | null }[]>(
            Prisma.sql`SELECT MIN(p."priceMin") AS min, MAX(p."priceMax") AS max
                       FROM "Product" p WHERE ${whereExcept("price")}`,
          );
          const min = rows[0]?.min;
          const max = rows[0]?.max;
          // No matching products => no meaningful range; drop the facet rather
          // than render a 0–0 slider.
          if (min == null || max == null) return null;
          return {
            source: "price",
            label: fc.label,
            displayAs: "range",
            values: [],
            min: Number(min),
            max: Number(max),
          };
        }

        if (fc.source === "availability") {
          const rows = await prisma.$queryRaw<{ available: boolean; count: bigint }[]>(
            Prisma.sql`SELECT p."available" AS available, COUNT(*)::bigint AS count
                       FROM "Product" p WHERE ${whereForAvailability()}
                       GROUP BY p."available"`,
          );
          const values = rows
            .map((r) => ({
              value: r.available ? "in_stock" : "out_of_stock",
              label: r.available ? "In stock" : "Out of stock",
              count: Number(r.count),
            }))
            .sort((a) => (a.value === "in_stock" ? -1 : 1));
          return values.length
            ? { source: fc.source, label: fc.label, displayAs: fc.displayAs, values }
            : null;
        }

        const where = whereExcept(fc.source);
        let rows: { value: string; count: bigint }[] = [];

        if (fc.source === "vendor") {
          rows = await prisma.$queryRaw(Prisma.sql`
            SELECT p."vendor" AS value, COUNT(*)::bigint AS count FROM "Product" p
            WHERE ${where} AND p."vendor" <> '' GROUP BY p."vendor" ORDER BY count DESC LIMIT 50`);
        } else if (fc.source === "productType") {
          rows = await prisma.$queryRaw(Prisma.sql`
            SELECT p."productType" AS value, COUNT(*)::bigint AS count FROM "Product" p
            WHERE ${where} AND p."productType" <> '' GROUP BY p."productType" ORDER BY count DESC LIMIT 50`);
        } else if (fc.source === "tag") {
          rows = await prisma.$queryRaw(Prisma.sql`
            SELECT tag AS value, COUNT(*)::bigint AS count
            FROM "Product" p, unnest(p."tags") AS tag
            WHERE ${where} GROUP BY tag ORDER BY count DESC LIMIT 50`);
        } else if (fc.source === "collection") {
          rows = await prisma.$queryRaw(Prisma.sql`
            SELECT handle AS value, COUNT(*)::bigint AS count
            FROM "Product" p, unnest(p."collections") AS handle
            WHERE ${where} GROUP BY handle ORDER BY count DESC LIMIT 50`);
        } else if (fc.source.startsWith("option:")) {
          const opt = fc.source.slice("option:".length);
          rows = await prisma.$queryRaw(Prisma.sql`
            SELECT val AS value, COUNT(*)::bigint AS count
            FROM "Product" p, jsonb_array_elements_text(COALESCE(p."options" -> ${opt}, '[]'::jsonb)) AS val
            WHERE ${where} GROUP BY val ORDER BY count DESC LIMIT 50`);
        } else if (fc.source.startsWith("metafield:")) {
          // Metafield facets were configurable but never counted, so the facet
          // simply never appeared. Aggregate over the mirrored metafield map.
          const key = fc.source.slice("metafield:".length);
          rows = await prisma.$queryRaw(Prisma.sql`
            SELECT p."metafields" ->> ${key} AS value, COUNT(*)::bigint AS count
            FROM "Product" p
            WHERE ${where} AND COALESCE(p."metafields" ->> ${key}, '') <> ''
            GROUP BY 1 ORDER BY count DESC LIMIT 50`);
        }

        if (!rows.length) return null;

        // Collection facets store handles; show the human title when we have it.
        const labelFor =
          fc.source === "collection"
            ? (v: string) => cfg.collectionTitles.get(v) ?? v
            : (v: string) => v;

        return {
          source: fc.source,
          label: fc.label,
          displayAs: fc.displayAs,
          values: rows.map((r) => ({
            value: r.value,
            label: labelFor(r.value),
            count: Number(r.count),
          })),
        };
      }),
    );

    return built.filter((f): f is Facet => f !== null);
  }

  /**
   * "Did you mean" — the closest word in the catalog to what was typed.
   *
   * Uses the `%` trigram operator so the GIN index on
   * lower(unaccent(title)) does the work. The previous version computed
   * similarity() for every ACTIVE product in the shop on every thin-result
   * search, i.e. a sequential scan of the whole catalog.
   */
  private async suggestSpelling(
    shopId: string,
    term: string,
  ): Promise<string | undefined> {
    const rows = await prisma.$queryRaw<{ title: string; sim: number }[]>(Prisma.sql`
      SELECT p."title" AS title,
             similarity(${uaLower(Prisma.sql`p."title"`)}, ${term}) AS sim
      FROM "Product" p
      WHERE p."shopId" = ${shopId} AND p."status" = 'ACTIVE'
        AND ${uaLower(Prisma.sql`p."title"`)} % ${term}
      ORDER BY sim DESC
      LIMIT 5`);
    if (!rows.length) return undefined;

    // Suggest the closest WORD, not the whole product title — "did you mean
    // 'Merino Wool Crew Neck Sweater — Charcoal'?" is not a usable suggestion.
    const typed = tokenize(term);
    let best: { word: string; score: number } | null = null;
    for (const row of rows) {
      for (const word of tokenize(row.title)) {
        if (word.length < 3) continue;
        const score = typed.length
          ? Math.max(...typed.map((t) => trigramSim(t, word)))
          : 0;
        if (!best || score > best.score) best = { word, score };
      }
    }
    if (best && best.score > 0.34 && !typed.includes(best.word)) return best.word;

    const top = rows[0];
    return top.sim > 0.3 && top.title.toLowerCase() !== term ? top.title : undefined;
  }

  async autocomplete(q: AutocompleteQuery): Promise<AutocompleteResult> {
    const cfg = await getShopConfig(q.shopId);
    const normalized = normalizeQuery(q.term);
    const fuzzy = q.typoTolerance !== false;
    // Empty query → recommendations (popular products, collections, trending searches).
    if (!normalized) {
      return this.recommendations(q.shopId, q.limit, q.includeUnavailable);
    }

    // A redirect configured for this term should fire from the dropdown too,
    // not only from the full results page.
    const redirect = cfg.redirects.get(normalized);

    const expansions = expandSynonyms(normalized, cfg.synonyms);
    const tsq = Prisma.sql`websearch_to_tsquery('simple', ad_immutable_unaccent(${toTsQuery(expansions)}))`;
    const esc = escapeLike(normalized);
    const title = uaLower(Prisma.sql`p."title"`);
    const collTitle = uaLower(Prisma.sql`"title"`);

    const availPred = q.includeUnavailable
      ? Prisma.sql`TRUE`
      : Prisma.sql`p."available" = TRUE`;
    const matchParts: Prisma.Sql[] = [
      Prisma.sql`p."searchVector" @@ ${tsq}`,
      like(title, `%${esc}%`),
    ];
    if (fuzzy) {
      matchParts.push(Prisma.sql`similarity(${title}, ${normalized}) > ${FUZZY_THRESHOLD}`);
    }
    const simTerm = fuzzy
      ? Prisma.sql`similarity(${title}, ${normalized}) * 2`
      : Prisma.sql`0::float`;

    // All four dropdown sections are independent — fetch them concurrently so
    // the panel opens in one round-trip's time, not four.
    const [rows, sugg, collRows, pageRows] = await Promise.all([
      prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT ${HIT_COLUMNS}, LEFT(p."description", 300) AS description,
               (ts_rank_cd(p."searchVector", ${tsq}) * 4
                + ${simTerm}
                + (CASE WHEN ${title} LIKE ${esc + "%"} ${ESC} THEN 2 ELSE 0 END)) AS score
        FROM "Product" p
        WHERE p."shopId" = ${q.shopId} AND p."status" = 'ACTIVE' AND ${availPred}
          AND (${Prisma.join(matchParts, " OR ")})
        ORDER BY score DESC, p."popularity" DESC
        LIMIT ${q.limit}`),

      // Query-completion suggestions from recent popular searches.
      prisma.$queryRaw<{ normalized: string }[]>(Prisma.sql`
        SELECT "normalized", COUNT(*) AS c FROM "SearchEvent"
        WHERE "shopId" = ${q.shopId} AND "normalized" LIKE ${esc + "%"} ${ESC}
          AND "resultsCount" > 0
        GROUP BY "normalized" ORDER BY c DESC LIMIT 5`),

      // Matching collections (name match, fuzzy-tolerant).
      prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT "handle", "title", "imageUrl", "productCount"
        FROM "Collection"
        WHERE "shopId" = ${q.shopId}
          AND (${collTitle} LIKE ${"%" + esc + "%"} ${ESC}
               OR similarity(${collTitle}, ${normalized}) > ${FUZZY_THRESHOLD})
        ORDER BY (${collTitle} LIKE ${esc + "%"} ${ESC}) DESC,
                 similarity(${collTitle}, ${normalized}) DESC
        LIMIT 4`),

      // Matching pages.
      prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT "handle", "title"
        FROM "Page"
        WHERE "shopId" = ${q.shopId}
          AND (${collTitle} LIKE ${"%" + esc + "%"} ${ESC}
               OR similarity(${collTitle}, ${normalized}) > ${FUZZY_THRESHOLD})
        ORDER BY (${collTitle} LIKE ${esc + "%"} ${ESC}) DESC
        LIMIT 4`),
    ]);

    return {
      products: rows.map((r) => rowToHit(r)),
      suggestions: sugg.map((s) => s.normalized).filter((s) => s !== normalized),
      collections: collRows.map((c) => ({
        handle: c.handle,
        title: c.title,
        imageUrl: c.imageUrl,
        productCount: Number(c.productCount ?? 0),
      })),
      pages: pageRows.map((p) => ({ handle: p.handle, title: p.title })),
      ...(redirect ? { redirect } : {}),
    };
  }

  /** Empty-query recommendations shown when the search box is focused but blank. */
  private async recommendations(
    shopId: string,
    limit: number,
    includeUnavailable?: boolean,
  ): Promise<AutocompleteResult> {
    const availPred = includeUnavailable
      ? Prisma.sql`TRUE`
      : Prisma.sql`p."available" = TRUE`;

    const [prodRows, collRows, trending] = await Promise.all([
      // Popular / recent products.
      prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT ${HIT_COLUMNS}, LEFT(p."description", 300) AS description
        FROM "Product" p
        WHERE p."shopId" = ${shopId} AND p."status" = 'ACTIVE' AND ${availPred}
        ORDER BY p."popularity" DESC, p."publishedAt" DESC NULLS LAST
        LIMIT ${limit}`),
      // Biggest collections.
      prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT "handle", "title", "imageUrl", "productCount"
        FROM "Collection" WHERE "shopId" = ${shopId}
        ORDER BY "productCount" DESC LIMIT 6`),
      // Trending searches from the last 30 days.
      prisma.$queryRaw<{ normalized: string }[]>(Prisma.sql`
        SELECT "normalized", COUNT(*) AS c FROM "SearchEvent"
        WHERE "shopId" = ${shopId} AND "normalized" <> '' AND "resultsCount" > 0
          AND "createdAt" > NOW() - INTERVAL '30 days'
        GROUP BY "normalized" ORDER BY c DESC LIMIT 6`),
    ]);

    return {
      products: prodRows.map((r) => rowToHit(r)),
      suggestions: trending.map((t) => t.normalized),
      collections: collRows.map((c) => ({
        handle: c.handle,
        title: c.title,
        imageUrl: c.imageUrl,
        productCount: Number(c.productCount ?? 0),
      })),
      pages: [],
    };
  }
}

/** Dice coefficient over character trigrams — mirrors pg_trgm's similarity()
 *  closely enough to rank candidate words without a second DB round-trip. */
function trigramSim(a: string, b: string): number {
  const grams = (s: string) => {
    const padded = `  ${s} `;
    const out = new Set<string>();
    for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let shared = 0;
  ga.forEach((g) => {
    if (gb.has(g)) shared++;
  });
  return shared / (ga.size + gb.size - shared);
}
