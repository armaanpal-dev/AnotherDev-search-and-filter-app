import { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { getShopConfig } from "./config.server";
import {
  normalizeQuery,
  expandSynonyms,
  toTsQuery,
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
      return Prisma.sql`p."popularity" DESC`;
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
    const base: Prisma.Sql[] = [
      Prisma.sql`p."shopId" = ${q.shopId}`,
      Prisma.sql`p."status" = 'ACTIVE'`,
    ];
    if (!q.includeUnavailable) base.push(Prisma.sql`p."available" = TRUE`);

    // Merchandising: hidden products removed globally for matching rule.
    const rule = cfg.matchRule(normalized, q.collection);
    if (rule && rule.hiddenProductIds.length) {
      base.push(
        Prisma.sql`p."productId" NOT IN (${Prisma.join(rule.hiddenProductIds)})`,
      );
    }
    // When pins are active (relevance sort, page 1 prepends them), exclude pinned
    // IDs from the ORGANIC query so they never appear twice across pages.
    // Capture the base BEFORE that exclusion so the pin lookup can still find them.
    const pinsActive = !!rule?.pinnedProductIds.length && q.sort === "relevance";
    const baseForPins = [...base];
    if (pinsActive) {
      base.push(
        Prisma.sql`p."productId" NOT IN (${Prisma.join(rule!.pinnedProductIds)})`,
      );
    }

    // 3. Text predicate (full-text OR fuzzy OR prefix). Empty term => browse.
    let textPred = Prisma.sql`TRUE`;
    let scoreExpr = Prisma.sql`0::float`;
    let strategy: SearchResult["strategy"] = "browse";

    if (hasTerm) {
      strategy = "hybrid";
      const tsq = Prisma.sql`websearch_to_tsquery('simple', ad_immutable_unaccent(${tsQueryStr}))`;
      const termParam = normalized;
      textPred = Prisma.sql`(
        p."searchVector" @@ ${tsq}
        OR similarity(${uaLower(Prisma.sql`p."title"`)}, ${termParam}) > ${FUZZY_THRESHOLD}
        OR ${uaLower(Prisma.sql`p."title"`)} LIKE ${"%" + termParam + "%"}
      )`;

      // Boost/bury from merchandising rule.
      let boostExpr = Prisma.sql`0::float`;
      if (rule) {
        if (rule.boostedProductIds.length)
          boostExpr = Prisma.sql`${boostExpr} + (CASE WHEN p."productId" IN (${Prisma.join(rule.boostedProductIds)}) THEN 5 ELSE 0 END)`;
        if (rule.buriedProductIds.length)
          boostExpr = Prisma.sql`${boostExpr} - (CASE WHEN p."productId" IN (${Prisma.join(rule.buriedProductIds)}) THEN 5 ELSE 0 END)`;
      }

      scoreExpr = Prisma.sql`(
        ts_rank_cd(p."searchVector", ${tsq}) * 4.0
        + similarity(${uaLower(Prisma.sql`p."title"`)}, ${termParam}) * 2.0
        + (CASE WHEN ${uaLower(Prisma.sql`p."title"`)} LIKE ${termParam + "%"} THEN 1.5 ELSE 0 END)
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

    // 5. Fetch page of hits + total (unless facetsOnly).
    const offset = (q.page - 1) * q.perPage;
    const order = orderByClause(q.sort, hasTerm);

    let hits: ProductHit[] = [];
    let total = 0;

    if (!q.facetsOnly) {
      const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT p."productId", p."handle", p."title", p."vendor", p."productType",
               p."priceMin", p."priceMax", p."currencyCode", p."imageUrl", p."imageAlt",
               p."available", p."tags", p."options", ${scoreExpr} AS score
        FROM "Product" p
        WHERE ${whereAll}
        ORDER BY ${order}
        LIMIT ${q.perPage} OFFSET ${offset}
      `);

      const countRows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS count FROM "Product" p WHERE ${whereAll}
      `);
      total = Number(countRows[0]?.count ?? 0);

      hits = rows.map((r) => ({
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
        options: r.options ?? {},
        score: Number(r.score ?? 0),
        pinned: false,
      }));

      // 6. Merchandising pins: prepend pinned products on page 1, but ONLY when
      //    the shopper hasn't chosen an explicit sort (pins are a relevance-time
      //    concept). Pinned products must also satisfy the active filters +
      //    availability, and the page is trimmed back to perPage so pins don't
      //    overflow it.
      if (
        rule?.pinnedProductIds.length &&
        q.page === 1 &&
        q.sort === "relevance"
      ) {
        const pinWhere = combine([...baseForPins, ...filterPreds.values()]);
        hits = await this.applyPins(
          rule.pinnedProductIds,
          hits,
          pinWhere,
          q.perPage,
        );
      }
    }

    // 7. Facets (each computed with all filters EXCEPT its own dimension).
    const facets = await this.computeFacets(q, base, textPred, filterPreds, cfg);

    // 8. "Did you mean" when the term returned little.
    let suggestion: string | undefined;
    if (hasTerm && total < 3) {
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
      SELECT p."productId", p."handle", p."title", p."vendor", p."productType",
             p."priceMin", p."priceMax", p."currencyCode", p."imageUrl", p."imageAlt",
             p."available", p."tags", p."options"
      FROM "Product" p
      WHERE ${pinWhere} AND p."productId" IN (${Prisma.join(pinnedIds)})
    `);
    const byId = new Map(pinnedRows.map((p) => [p.productId, p]));
    const pinned: ProductHit[] = pinnedIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((p) => ({
        productId: p.productId,
        handle: p.handle,
        title: p.title,
        vendor: p.vendor,
        productType: p.productType,
        priceMin: Number(p.priceMin),
        priceMax: Number(p.priceMax),
        currencyCode: p.currencyCode,
        imageUrl: p.imageUrl,
        imageAlt: p.imageAlt,
        available: p.available,
        tags: p.tags ?? [],
        options: (p.options as Record<string, string[]>) ?? {},
        score: 999,
        pinned: true,
      }));
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
    q: SearchQuery,
    base: Prisma.Sql[],
    textPred: Prisma.Sql,
    filterPreds: Map<string, Prisma.Sql>,
    cfg: Awaited<ReturnType<typeof getShopConfig>>,
  ): Promise<Facet[]> {
    const facets: Facet[] = [];

    const whereExcept = (source: string): Prisma.Sql => {
      const others = [...filterPreds.entries()]
        .filter(([s]) => s !== source)
        .map(([, sql]) => sql);
      return combine([...base, textPred, ...others]);
    };

    for (const fc of cfg.filters) {
      if (!fc.enabled) continue;

      if (fc.source === "price") {
        const where = whereExcept("price");
        const rows = await prisma.$queryRaw<{ min: number; max: number }[]>(
          Prisma.sql`SELECT MIN(p."priceMin") AS min, MAX(p."priceMax") AS max
                     FROM "Product" p WHERE ${where}`,
        );
        facets.push({
          source: "price",
          label: fc.label,
          displayAs: "range",
          values: [],
          min: Number(rows[0]?.min ?? 0),
          max: Number(rows[0]?.max ?? 0),
        });
        continue;
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
      } else if (fc.source.startsWith("option:")) {
        const opt = fc.source.slice("option:".length);
        rows = await prisma.$queryRaw(Prisma.sql`
          SELECT val AS value, COUNT(*)::bigint AS count
          FROM "Product" p, jsonb_array_elements_text(COALESCE(p."options" -> ${opt}, '[]'::jsonb)) AS val
          WHERE ${where} GROUP BY val ORDER BY count DESC LIMIT 50`);
      }

      if (rows.length) {
        facets.push({
          source: fc.source,
          label: fc.label,
          displayAs: fc.displayAs,
          values: rows.map((r) => ({
            value: r.value,
            label: r.value,
            count: Number(r.count),
          })),
        });
      }
    }

    return facets;
  }

  private async suggestSpelling(
    shopId: string,
    term: string,
  ): Promise<string | undefined> {
    const rows = await prisma.$queryRaw<{ title: string; sim: number }[]>(Prisma.sql`
      SELECT p."title" AS title,
             similarity(${uaLower(Prisma.sql`p."title"`)}, ${term}) AS sim
      FROM "Product" p
      WHERE p."shopId" = ${shopId} AND p."status" = 'ACTIVE'
      ORDER BY sim DESC LIMIT 1`);
    const best = rows[0];
    if (best && best.sim > 0.3 && best.title.toLowerCase() !== term) {
      return best.title;
    }
    return undefined;
  }

  async autocomplete(q: AutocompleteQuery): Promise<AutocompleteResult> {
    const cfg = await getShopConfig(q.shopId);
    const normalized = normalizeQuery(q.term);
    // Empty query → recommendations (popular products, collections, trending searches).
    if (!normalized) {
      return this.recommendations(q.shopId, q.limit);
    }
    const expansions = expandSynonyms(normalized, cfg.synonyms);
    const tsq = Prisma.sql`websearch_to_tsquery('simple', ad_immutable_unaccent(${toTsQuery(expansions)}))`;

    const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT p."productId", p."handle", p."title", p."vendor", p."productType",
             p."priceMin", p."priceMax", p."currencyCode", p."imageUrl", p."imageAlt",
             p."available", p."tags", p."options", LEFT(p."description", 300) AS description,
             (ts_rank_cd(p."searchVector", ${tsq}) * 4
              + similarity(${uaLower(Prisma.sql`p."title"`)}, ${normalized}) * 2
              + (CASE WHEN ${uaLower(Prisma.sql`p."title"`)} LIKE ${normalized + "%"} THEN 2 ELSE 0 END)) AS score
      FROM "Product" p
      WHERE p."shopId" = ${q.shopId} AND p."status" = 'ACTIVE' AND p."available" = TRUE
        AND (p."searchVector" @@ ${tsq}
             OR ${uaLower(Prisma.sql`p."title"`)} LIKE ${"%" + normalized + "%"}
             OR similarity(${uaLower(Prisma.sql`p."title"`)}, ${normalized}) > ${FUZZY_THRESHOLD})
      ORDER BY score DESC
      LIMIT ${q.limit}`);

    const products: ProductHit[] = rows.map((r) => ({
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
      options: r.options ?? {},
      score: Number(r.score ?? 0),
      pinned: false,
      description: r.description ?? "",
    }));

    // Query-completion suggestions from recent popular searches.
    const sugg = await prisma.$queryRaw<{ normalized: string }[]>(Prisma.sql`
      SELECT "normalized", COUNT(*) AS c FROM "SearchEvent"
      WHERE "shopId" = ${q.shopId} AND "normalized" LIKE ${normalized + "%"}
        AND "resultsCount" > 0
      GROUP BY "normalized" ORDER BY c DESC LIMIT 5`);

    // Matching collections (name match, fuzzy-tolerant).
    const collRows = await prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT "handle", "title", "imageUrl", "productCount"
      FROM "Collection"
      WHERE "shopId" = ${q.shopId}
        AND (${uaLower(Prisma.sql`"title"`)} LIKE ${"%" + normalized + "%"}
             OR similarity(${uaLower(Prisma.sql`"title"`)}, ${normalized}) > ${FUZZY_THRESHOLD})
      ORDER BY (${uaLower(Prisma.sql`"title"`)} LIKE ${normalized + "%"}) DESC,
               similarity(${uaLower(Prisma.sql`"title"`)}, ${normalized}) DESC
      LIMIT 4`);

    // Matching pages.
    const pageRows = await prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT "handle", "title"
      FROM "Page"
      WHERE "shopId" = ${q.shopId}
        AND (${uaLower(Prisma.sql`"title"`)} LIKE ${"%" + normalized + "%"}
             OR similarity(${uaLower(Prisma.sql`"title"`)}, ${normalized}) > ${FUZZY_THRESHOLD})
      ORDER BY (${uaLower(Prisma.sql`"title"`)} LIKE ${normalized + "%"}) DESC
      LIMIT 4`);

    return {
      products,
      suggestions: sugg.map((s) => s.normalized).filter((s) => s !== normalized),
      collections: collRows.map((c) => ({
        handle: c.handle,
        title: c.title,
        imageUrl: c.imageUrl,
        productCount: Number(c.productCount ?? 0),
      })),
      pages: pageRows.map((p) => ({ handle: p.handle, title: p.title })),
    };
  }

  /** Empty-query recommendations shown when the search box is focused but blank. */
  private async recommendations(
    shopId: string,
    limit: number,
  ): Promise<AutocompleteResult> {
    const [prodRows, collRows, trending] = await Promise.all([
      // Popular / recent products.
      prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT p."productId", p."handle", p."title", p."vendor", p."productType",
               p."priceMin", p."priceMax", p."currencyCode", p."imageUrl", p."imageAlt",
               p."available", p."tags", p."options", LEFT(p."description", 300) AS description
        FROM "Product" p
        WHERE p."shopId" = ${shopId} AND p."status" = 'ACTIVE' AND p."available" = TRUE
        ORDER BY p."popularity" DESC, p."publishedAt" DESC NULLS LAST
        LIMIT ${limit}`),
      // Biggest collections.
      prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT "handle", "title", "imageUrl", "productCount"
        FROM "Collection" WHERE "shopId" = ${shopId}
        ORDER BY "productCount" DESC LIMIT 6`),
      // Trending searches from history.
      prisma.$queryRaw<{ normalized: string }[]>(Prisma.sql`
        SELECT "normalized", COUNT(*) AS c FROM "SearchEvent"
        WHERE "shopId" = ${shopId} AND "normalized" <> '' AND "resultsCount" > 0
        GROUP BY "normalized" ORDER BY c DESC LIMIT 6`),
    ]);

    return {
      products: prodRows.map((r) => ({
        productId: r.productId, handle: r.handle, title: r.title, vendor: r.vendor,
        productType: r.productType, priceMin: Number(r.priceMin), priceMax: Number(r.priceMax),
        currencyCode: r.currencyCode, imageUrl: r.imageUrl, imageAlt: r.imageAlt,
        available: r.available, tags: r.tags ?? [], options: r.options ?? {}, score: 0, pinned: false,
        description: r.description ?? "",
      })),
      suggestions: trending.map((t) => t.normalized),
      collections: collRows.map((c) => ({
        handle: c.handle, title: c.title, imageUrl: c.imageUrl, productCount: Number(c.productCount ?? 0),
      })),
      pages: [],
    };
  }
}
