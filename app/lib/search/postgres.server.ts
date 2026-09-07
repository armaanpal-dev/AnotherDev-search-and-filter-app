import { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { getShopConfig, facetCache, type MerchCondition, type MerchRule } from "./config.server";
import {
  normalizeQuery,
  expandSynonyms,
  toTsQuery,
  escapeLike,
  tokenize,
  looksLikeSku,
} from "./normalize";
import { embedQuery, semanticReady, toVectorLiteral } from "./embeddings.server";
import { limitsForPlanName } from "../plans";
import { toTsConfig, type SearchLanguage } from "./languages";
import type {
  SearchEngine,
  SearchQuery,
  SearchResult,
  SearchExplain,
  ProductHit,
  Facet,
  FacetValue,
  AutocompleteQuery,
  AutocompleteResult,
  FilterSelection,
  SortKey,
  RecommendationQuery,
} from "./types";

const FUZZY_THRESHOLD = 0.2; // pg_trgm similarity floor for typo tolerance

// Cosine DISTANCE ceiling for a semantic match. pgvector's <=> returns 0 for
// identical and 2 for opposite; anything past this is noise, not a near-miss.
const SEMANTIC_MAX_DISTANCE = 0.62;

// OFFSET makes Postgres materialise and discard every skipped row, so a crawler
// walking to page 100000 turns one request into a full-table scan. Real shoppers
// never go past a handful of pages; bots are what find this.
const MAX_PAGE = 200;

// unaccent+lower helper mirrored from the SQL migration, for parameter comparisons.
const uaLower = (col: Prisma.Sql) =>
  Prisma.sql`lower(ad_immutable_unaccent(${col}))`;

// A single backslash inside the generated SQL: `ESCAPE '\'`. Written as `\\` here
// because this is a template literal.
const ESC = Prisma.raw(`ESCAPE '\\'`);

/**
 * The shop's text-search configuration, as a SQL literal.
 *
 * A regconfig cannot be a bind parameter in `websearch_to_tsquery(cfg, …)`, so
 * this is the one value in the file that is inlined rather than bound.
 * `toTsConfig` is the reason that is safe: it maps anything not on the allowlist
 * in ./languages.ts to "simple", so the string reaching `Prisma.raw` is always
 * one of a fixed set of identifiers we wrote ourselves — never merchant input.
 */
const tsConfigSql = (lang: SearchLanguage) => Prisma.raw(`'${toTsConfig(lang)}'`);

/** `col LIKE 'pattern' ESCAPE '\'` — the pattern is built from shopper input,
 *  whose wildcards the caller escapes with `escapeLike`. */
const like = (col: Prisma.Sql, pattern: string) =>
  Prisma.sql`${col} LIKE ${pattern} ${ESC}`;

// The columns every product-hit query selects. Kept in one place so the row
// shape and `rowToHit` can never drift apart. The variant subqueries let the
// storefront offer add-to-cart directly from a result card for single-variant
// products (and know to send multi-variant products to the PDP instead).
const HIT_COLUMNS = Prisma.sql`
  p."productId", p."handle", p."title", p."vendor", p."productType",
  p."priceMin", p."priceMax", p."currencyCode", p."imageUrl", p."imageAlt",
  p."available", p."tags", p."options",
  (SELECT v."variantId" FROM "ProductVariant" v
    WHERE v."productId" = p."id"
    ORDER BY v."available" DESC, v."id" ASC LIMIT 1) AS "variantId",
  (SELECT COUNT(*)::int FROM "ProductVariant" v
    WHERE v."productId" = p."id") AS "variantCount"`;

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
    variantId: r.variantId ?? null,
    variantCount: Number(r.variantCount ?? 0),
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

/**
 * Turn one merchandising condition into a SQL predicate over a product row.
 * This is what lets a merchant say "bury anything tagged clearance" instead of
 * pasting a list of product ids that goes stale the moment the catalog changes.
 */
function conditionPredicate(c: MerchCondition): Prisma.Sql | null {
  const v = c.value;
  const contains = c.op === "contains";
  let pred: Prisma.Sql | null = null;

  if (c.field === "tag") {
    pred = contains
      ? Prisma.sql`EXISTS (SELECT 1 FROM unnest(p."tags") t WHERE lower(t) LIKE ${"%" + escapeLike(v.toLowerCase()) + "%"} ${ESC})`
      : Prisma.sql`p."tags" && ARRAY[${v}]::text[]`;
  } else if (c.field === "vendor" || c.field === "productType") {
    const col =
      c.field === "vendor" ? Prisma.sql`p."vendor"` : Prisma.sql`p."productType"`;
    pred = contains
      ? Prisma.sql`lower(${col}) LIKE ${"%" + escapeLike(v.toLowerCase()) + "%"} ${ESC}`
      : Prisma.sql`${col} = ${v}`;
  } else if (c.field === "collection") {
    pred = Prisma.sql`p."collections" && ARRAY[${v}]::text[]`;
  } else if (c.field === "available") {
    pred = Prisma.sql`p."available" = ${v === "true"}`;
  } else if (c.field.startsWith("option:")) {
    const opt = c.field.slice("option:".length);
    pred = Prisma.sql`(p."options" -> ${opt}) ? ${v}`;
  } else if (c.field.startsWith("metafield:")) {
    const key = c.field.slice("metafield:".length);
    pred = contains
      ? Prisma.sql`lower(coalesce(p."metafields" ->> ${key}, '')) LIKE ${"%" + escapeLike(v.toLowerCase()) + "%"} ${ESC}`
      : Prisma.sql`(p."metafields" ->> ${key}) = ${v}`;
  }

  if (!pred) return null;
  return c.op === "neq" ? Prisma.sql`NOT (${pred})` : pred;
}

/** Score contribution from every boost/bury/pin condition on the active rule. */
function conditionScoreExpr(rule: MerchRule | null): Prisma.Sql {
  if (!rule || !rule.conditions.length) return Prisma.sql`0::float`;
  let expr = Prisma.sql`0::float`;
  for (const c of rule.conditions) {
    if (c.action === "hide") continue; // handled as a hard predicate
    const pred = conditionPredicate(c);
    if (!pred) continue;
    // A conditional "pin" cannot literally prepend an unbounded set without
    // breaking pagination, so it becomes a boost large enough to clear the
    // organic score range instead.
    const weight = c.action === "bury" ? -c.weight : c.action === "pin" ? c.weight + 50 : c.weight;
    expr = Prisma.sql`${expr} + (CASE WHEN ${pred} THEN ${weight}::float ELSE 0 END)`;
  }
  return expr;
}

/** Hard exclusions from every `hide` condition on the active rule. */
function conditionHidePredicates(rule: MerchRule | null): Prisma.Sql[] {
  if (!rule) return [];
  const out: Prisma.Sql[] = [];
  for (const c of rule.conditions) {
    if (c.action !== "hide") continue;
    const pred = conditionPredicate(c);
    if (pred) out.push(Prisma.sql`NOT (${pred})`);
  }
  return out;
}

function combine(preds: Prisma.Sql[]): Prisma.Sql {
  if (preds.length === 0) return Prisma.sql`TRUE`;
  return Prisma.join(preds, " AND ");
}

/**
 * Every ordering ends with a unique tiebreaker.
 *
 * Postgres makes no ordering guarantee between rows that compare equal, and it
 * is free to pick a different plan for the LIMIT/OFFSET of page 2 than it did
 * for page 1. On a catalog where the sort key ties — a fresh index where every
 * `popularity` is 0, or a price sort with many identical prices — that means a
 * shopper can see the same product on two pages and never see another at all.
 */
const STABLE = Prisma.sql`p."id" ASC`;

function orderByClause(sort: SortKey, hasTerm: boolean): Prisma.Sql {
  switch (sort) {
    case "price_asc":
      return Prisma.sql`p."priceMin" ASC, ${STABLE}`;
    case "price_desc":
      return Prisma.sql`p."priceMax" DESC, ${STABLE}`;
    case "title_asc":
      return Prisma.sql`p."title" ASC, ${STABLE}`;
    case "title_desc":
      return Prisma.sql`p."title" DESC, ${STABLE}`;
    case "newest":
      return Prisma.sql`p."publishedAt" DESC NULLS LAST, ${STABLE}`;
    case "bestselling":
      return Prisma.sql`p."popularity" DESC, p."publishedAt" DESC NULLS LAST, ${STABLE}`;
    case "relevance":
    default:
      return hasTerm
        ? Prisma.sql`score DESC, p."popularity" DESC, ${STABLE}`
        : Prisma.sql`p."popularity" DESC, p."publishedAt" DESC NULLS LAST, ${STABLE}`;
  }
}

export class PostgresSearchEngine implements SearchEngine {
  async search(q: SearchQuery): Promise<SearchResult> {
    const started = Date.now();
    const cfg = await getShopConfig(q.shopId);
    const normalized = normalizeQuery(q.term);
    const fuzzy = q.typoTolerance !== false;
    const page = Math.min(Math.max(1, q.page), MAX_PAGE);

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

    // 2. Base predicate: shop scope + status/publication/availability.
    // `base` deliberately excludes the availability clause: the availability
    // FACET has to count the out-of-stock bucket, which it cannot do if
    // "available = TRUE" is baked into every predicate it composes.
    //
    // publishedOnline matters as much as status: an ACTIVE product that is not
    // published to the Online Store channel has no storefront URL, so indexing
    // it means shoppers click a search result and land on a 404.
    const base: Prisma.Sql[] = [
      Prisma.sql`p."shopId" = ${q.shopId}`,
      Prisma.sql`p."status" = 'ACTIVE'`,
      Prisma.sql`p."publishedOnline" = TRUE`,
    ];
    const availPred: Prisma.Sql | null = q.includeUnavailable
      ? null
      : Prisma.sql`p."available" = TRUE`;
    if (availPred) base.push(availPred);

    // Merchandising: hidden products removed globally for matching rule.
    const rule = cfg.matchRule(normalized, q.collection, q.bucket);
    if (rule && rule.hiddenProductIds.length) {
      base.push(
        Prisma.sql`p."productId" NOT IN (${Prisma.join(rule.hiddenProductIds)})`,
      );
    }
    base.push(...conditionHidePredicates(rule));

    // Pins are prepended to page 1 only, so they may only be excluded from the
    // ORGANIC query on page 1. Excluding them on every page deleted them from
    // the catalog entirely from page 2 onwards.
    //
    // `base` is the ORGANIC predicate (page 1 minus the pins, so they are not
    // listed twice). `baseForCounting` is the whole matching set, pins included,
    // and it is what the total, the facets and the pin lookup all use. Sharing
    // one array meant page 1 reported `total - pinned` while page 2 reported
    // `total` — the page count flickered and the last page came up short — and
    // the facet counts disagreed between the two in the same way.
    const pinsActive =
      !!rule?.pinnedProductIds.length && q.sort === "relevance" && page === 1;
    const baseForCounting = [...base];
    if (pinsActive) {
      base.push(
        Prisma.sql`p."productId" NOT IN (${Prisma.join(rule!.pinnedProductIds)})`,
      );
    }

    // 3. Text predicate (SKU OR full-text OR fuzzy OR substring OR semantic).
    let textPred = Prisma.sql`TRUE`;
    let scoreExpr = conditionScoreExpr(rule);
    let strategy: SearchResult["strategy"] = "browse";
    // Named score components, populated only when there is a term. Used both to
    // build the total and, when asked, to report the breakdown.
    let explainParts: Record<string, Prisma.Sql> | null = null;

    // Semantic is opt-in per shop, needs Pro, a provider and the pgvector column.
    const wantSemantic =
      hasTerm && q.semantic !== false && cfg.settings.semanticSearch &&
      limitsForPlanName(cfg.planName).semantic;
    const queryVector =
      wantSemantic && (await semanticReady()) ? await embedQuery(normalized) : null;

    if (hasTerm) {
      strategy = queryVector ? "semantic" : fuzzy ? "hybrid" : "fulltext";
      // Same configuration the row's `searchVector` was generated with, or a
      // stemmed query would never match an unstemmed index (and vice versa).
      const tsq = Prisma.sql`websearch_to_tsquery(${tsConfigSql(cfg.searchLanguage)}, ad_immutable_unaccent(${tsQueryStr}))`;
      const termParam = normalized;
      const esc = escapeLike(termParam);
      const title = uaLower(Prisma.sql`p."title"`);

      const textParts: Prisma.Sql[] = [
        Prisma.sql`p."searchVector" @@ ${tsq}`,
        like(title, `%${esc}%`),
      ];

      // Exact SKU: someone pasting a product code wants that product, full stop.
      const skuMatch = looksLikeSku(termParam);
      if (skuMatch) {
        textParts.push(
          Prisma.sql`EXISTS (SELECT 1 FROM unnest(p."skus") s WHERE lower(s) = ${termParam})`,
        );
        strategy = "sku";
      }

      if (fuzzy) {
        textParts.push(
          Prisma.sql`similarity(${title}, ${termParam}) > ${FUZZY_THRESHOLD}`,
        );
      }

      let semanticScore = Prisma.sql`0::float`;
      if (queryVector) {
        const vec = toVectorLiteral(queryVector);
        textParts.push(
          Prisma.sql`(p."embedding" IS NOT NULL AND (p."embedding" <=> ${vec}::vector) < ${SEMANTIC_MAX_DISTANCE})`,
        );
        // Distance -> similarity, weighted below exact lexical matching so a
        // literal title match still beats a merely-related product.
        semanticScore = Prisma.sql`(CASE WHEN p."embedding" IS NULL THEN 0
          ELSE GREATEST(0, 1 - (p."embedding" <=> ${vec}::vector)) * 2.5 END)`;
      }

      textPred = Prisma.sql`(${Prisma.join(textParts, " OR ")})`;

      // Boost/bury from explicit product-id lists on the merchandising rule.
      let boostExpr = scoreExpr;
      if (rule) {
        if (rule.boostedProductIds.length)
          boostExpr = Prisma.sql`${boostExpr} + (CASE WHEN p."productId" IN (${Prisma.join(rule.boostedProductIds)}) THEN 5 ELSE 0 END)`;
        if (rule.buriedProductIds.length)
          boostExpr = Prisma.sql`${boostExpr} - (CASE WHEN p."productId" IN (${Prisma.join(rule.buriedProductIds)}) THEN 5 ELSE 0 END)`;
      }
      const simTerm = fuzzy
        ? Prisma.sql`similarity(${title}, ${termParam}) * 2.0`
        : Prisma.sql`0::float`;
      const skuBonus = skuMatch
        ? Prisma.sql`(CASE WHEN EXISTS (SELECT 1 FROM unnest(p."skus") s WHERE lower(s) = ${termParam}) THEN 50 ELSE 0 END)`
        : Prisma.sql`0::float`;

      // Every component is kept as its own expression rather than being inlined
      // into one sum, so the relevance tester can select them individually and
      // show a merchant WHY a product ranked where it did. Nothing changes for a
      // shopper: the same expressions are added up below.
      explainParts = {
        textRank: Prisma.sql`ts_rank_cd(p."searchVector", ${tsq}) * 4.0`,
        similarity: simTerm,
        semantic: semanticScore,
        prefix: Prisma.sql`(CASE WHEN ${title} LIKE ${esc + "%"} ${ESC} THEN 1.5 ELSE 0 END)`,
        popularity: Prisma.sql`ln(1 + p."popularity") * 0.3`,
        merchandising: Prisma.sql`(${skuBonus} + ${boostExpr})`,
      };

      scoreExpr = Prisma.sql`(
        ${explainParts.textRank}
        + ${explainParts.similarity}
        + ${explainParts.semantic}
        + ${explainParts.prefix}
        + ${explainParts.popularity}
        + ${explainParts.merchandising}
      )`;
    }

    // 4. Filter predicates.
    const filterPreds = buildFilterPredicates(q.filters, q.price, q.collection);
    const whereOrganic = combine([
      ...base,
      textPred,
      ...filterPreds.values(),
    ]);
    // The full matching set, pins included — what the shopper is told they have.
    const whereAll = combine([
      ...baseForCounting,
      textPred,
      ...filterPreds.values(),
    ]);

    // 5. Rows, total and every facet are independent queries. Run them
    //    concurrently rather than paying ~8 sequential round-trips per search.
    const offset = (page - 1) * q.perPage;
    const order = orderByClause(q.sort, hasTerm);

    // Only for the admin's relevance tester, and only when there is a term to
    // break down. One extra column per component, on at most one page of rows.
    const explainCols =
      q.explain && explainParts
        ? Prisma.sql`, ${Prisma.join(
            Object.entries(explainParts).map(
              ([name, sql]) => Prisma.sql`(${sql}) AS ${Prisma.raw(`"x_${name}"`)}`,
            ),
            ", ",
          )}`
        : Prisma.sql``;

    const rowsPromise = q.facetsOnly
      ? Promise.resolve([] as any[])
      : prisma.$queryRaw<any[]>(Prisma.sql`
          SELECT ${HIT_COLUMNS}, ${scoreExpr} AS score${explainCols}
          FROM "Product" p
          WHERE ${whereOrganic}
          ORDER BY ${order}
          LIMIT ${q.perPage} OFFSET ${offset}
        `);

    const countPromise = prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count FROM "Product" p WHERE ${whereAll}
    `);

    // Facet aggregates are the expensive half of a search (one GROUP BY per
    // enabled facet). They depend only on the predicate set, not on the page or
    // sort, so paging and re-sorting reuse the cached counts — which is exactly
    // why they must be computed from the pin-INCLUSIVE predicate. Page 1 and
    // page 2 otherwise produced different counts under the same cache key,
    // and whichever ran first won.
    const signature = facetSignature(q, normalized, rule);
    const facetsPromise = this.computeFacets(
      baseForCounting,
      availPred,
      textPred,
      filterPreds,
      cfg,
      signature,
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
      const pinWhere = combine([...baseForCounting, ...filterPreds.values()]);
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
      page,
      perPage: q.perPage,
      facets,
      presets: cfg.presets,
      suggestion,
      strategy,
      tookMs: Date.now() - started,
      ...(q.explain
        ? {
            explain: buildExplain(
              normalized,
              expansions,
              tsQueryStr,
              cfg.searchLanguage,
              rule,
              rows,
            ),
          }
        : {}),
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
    signature: string,
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
      enabled.map((fc) =>
        facetCache.wrap(`${signature}|${fc.source}`, async (): Promise<Facet | null> => {
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

          const values: FacetValue[] = rows.map((r) => {
            const swatch = cfg.swatches.get(String(r.value).toLowerCase());
            return {
              value: r.value,
              label: labelFor(r.value),
              count: Number(r.count),
              ...(swatch ? { swatch } : {}),
            };
          });

          return {
            source: fc.source,
            label: fc.label,
            displayAs: fc.displayAs,
            values,
          };
        }) as Promise<Facet | null>,
      ),
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
        AND p."publishedOnline" = TRUE
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
    const tsq = Prisma.sql`websearch_to_tsquery(${tsConfigSql(cfg.searchLanguage)}, ad_immutable_unaccent(${toTsQuery(expansions)}))`;
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
    if (looksLikeSku(normalized)) {
      matchParts.push(
        Prisma.sql`EXISTS (SELECT 1 FROM unnest(p."skus") s WHERE lower(s) = ${normalized})`,
      );
    }
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
        WHERE p."shopId" = ${q.shopId} AND p."status" = 'ACTIVE'
          AND p."publishedOnline" = TRUE AND ${availPred}
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

  /**
   * Search by photo.
   *
   * "Find me that jacket" is the one query a keyword index can never answer, and
   * it is exactly what a shopper does when they have seen something and cannot
   * name it. With multimodal embeddings the shopper's picture lands in the same
   * vector space as the product rows, so this is a nearest-neighbour lookup
   * against the index that already exists — no second service, no second index.
   *
   * The plan and provider checks live in the caller; by here the vector is real.
   */
  async searchByVector(
    shopId: string,
    vector: number[],
    opts: { limit: number; includeUnavailable?: boolean; collection?: string },
  ): Promise<ProductHit[]> {
    const vec = toVectorLiteral(vector);
    const availPred = opts.includeUnavailable
      ? Prisma.sql`TRUE`
      : Prisma.sql`p."available" = TRUE`;
    const collScope = opts.collection
      ? Prisma.sql`AND p."collections" && ARRAY[${opts.collection}]::text[]`
      : Prisma.sql``;

    const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT ${HIT_COLUMNS},
             (1 - (p."embedding" <=> ${vec}::vector)) AS score
      FROM "Product" p
      WHERE p."shopId" = ${shopId} AND p."status" = 'ACTIVE'
        AND p."publishedOnline" = TRUE AND ${availPred}
        ${collScope}
        AND p."embedding" IS NOT NULL
        AND (p."embedding" <=> ${vec}::vector) < ${SEMANTIC_MAX_DISTANCE}
      ORDER BY p."embedding" <=> ${vec}::vector
      LIMIT ${Math.min(Math.max(1, opts.limit), 48)}`);
    return rows.map((r) => rowToHit(r));
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
        WHERE p."shopId" = ${shopId} AND p."status" = 'ACTIVE'
          AND p."publishedOnline" = TRUE AND ${availPred}
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

  /**
   * Product recommendations. Same index, different surface — a PDP "you may also
   * like" rail, a cart upsell, or the empty-search state. "related" prefers
   * embedding neighbours when semantic search is configured and falls back to
   * shared collection / type / tags, which works on every plan.
   */
  async recommend(q: RecommendationQuery): Promise<ProductHit[]> {
    const limit = Math.min(Math.max(1, q.limit), 24);
    const availPred = q.includeUnavailable
      ? Prisma.sql`TRUE`
      : Prisma.sql`p."available" = TRUE`;
    const base = Prisma.sql`p."shopId" = ${q.shopId} AND p."status" = 'ACTIVE'
      AND p."publishedOnline" = TRUE AND ${availPred}`;
    const collScope = q.collection
      ? Prisma.sql`AND p."collections" && ARRAY[${q.collection}]::text[]`
      : Prisma.sql``;

    if (q.kind === "related" && q.productId) {
      const anchorRows = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT p."id", p."productType", p."vendor", p."tags", p."collections",
               (p."embedding" IS NOT NULL) AS "hasEmbedding"
        FROM "Product" p
        WHERE p."shopId" = ${q.shopId} AND p."productId" = ${q.productId}
        LIMIT 1`).catch(async () =>
          // The embedding column is absent when pgvector was unavailable.
          prisma.$queryRaw<any[]>(Prisma.sql`
            SELECT p."id", p."productType", p."vendor", p."tags", p."collections",
                   FALSE AS "hasEmbedding"
            FROM "Product" p
            WHERE p."shopId" = ${q.shopId} AND p."productId" = ${q.productId}
            LIMIT 1`),
        );
      const anchor = anchorRows[0];
      if (!anchor) return [];

      if (anchor.hasEmbedding && (await semanticReady())) {
        const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
          SELECT ${HIT_COLUMNS},
                 (1 - (p."embedding" <=> (SELECT a."embedding" FROM "Product" a WHERE a."id" = ${anchor.id}))) AS score
          FROM "Product" p
          WHERE ${base} ${collScope}
            AND p."id" <> ${anchor.id}
            AND p."embedding" IS NOT NULL
          ORDER BY p."embedding" <=> (SELECT a."embedding" FROM "Product" a WHERE a."id" = ${anchor.id})
          LIMIT ${limit}`);
        if (rows.length) return rows.map((r) => rowToHit(r));
      }

      // Attribute fallback: shared collection is the strongest signal a merchant
      // gives us, then product type, then tag overlap.
      const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT ${HIT_COLUMNS},
               ( (CASE WHEN p."collections" && ${anchor.collections ?? []}::text[] THEN 3 ELSE 0 END)
               + (CASE WHEN p."productType" = ${anchor.productType ?? ""} AND p."productType" <> '' THEN 2 ELSE 0 END)
               + (CASE WHEN p."vendor" = ${anchor.vendor ?? ""} AND p."vendor" <> '' THEN 1 ELSE 0 END)
               + (CASE WHEN p."tags" && ${anchor.tags ?? []}::text[] THEN 1 ELSE 0 END)
               )::float AS score
        FROM "Product" p
        WHERE ${base} ${collScope} AND p."id" <> ${anchor.id}
        ORDER BY score DESC, p."popularity" DESC
        LIMIT ${limit}`);
      return rows.filter((r) => Number(r.score) > 0).map((r) => rowToHit(r));
    }

    // Personalised: "more like the things you have been looking at".
    //
    // The shopper's recently-viewed ids come up from localStorage on the
    // request; nothing is stored server-side, so this needs no customer account,
    // builds no profile, and survives a shopper clearing their browser. Products
    // already seen are excluded — recommending what someone just looked at is
    // the classic way these rails waste their slots.
    if (q.kind === "personalized") {
      const seen = (q.seenProductIds ?? []).filter(Boolean).slice(0, 20);
      if (!seen.length) {
        return this.recommend({ ...q, kind: "bestsellers" });
      }
      const anchors = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT p."productType", p."vendor", p."tags", p."collections"
        FROM "Product" p
        WHERE p."shopId" = ${q.shopId} AND p."productId" IN (${Prisma.join(seen)})
        LIMIT 20`);
      if (!anchors.length) return this.recommend({ ...q, kind: "bestsellers" });

      // Union the attributes of everything seen, then score candidates by how
      // much they overlap. Weighted the same way "related" is, so the two rails
      // agree about what "similar" means.
      const types = [...new Set(anchors.map((a) => a.productType).filter(Boolean))];
      const vendors = [...new Set(anchors.map((a) => a.vendor).filter(Boolean))];
      const tags = [...new Set(anchors.flatMap((a) => a.tags ?? []))].slice(0, 60);
      const colls = [...new Set(anchors.flatMap((a) => a.collections ?? []))].slice(0, 60);

      const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT ${HIT_COLUMNS},
               ( (CASE WHEN p."collections" && ${colls}::text[] THEN 3 ELSE 0 END)
               + (CASE WHEN p."productType" = ANY(${types}::text[]) THEN 2 ELSE 0 END)
               + (CASE WHEN p."vendor" = ANY(${vendors}::text[]) THEN 1 ELSE 0 END)
               + (CASE WHEN p."tags" && ${tags}::text[] THEN 1 ELSE 0 END)
               )::float AS score
        FROM "Product" p
        WHERE ${base} ${collScope}
          AND p."productId" NOT IN (${Prisma.join(seen)})
        ORDER BY score DESC, p."popularity" DESC, p."id" ASC
        LIMIT ${limit}`);
      const scored = rows.filter((r) => Number(r.score) > 0);
      // A shopper whose history overlaps nothing in stock still deserves a rail.
      if (!scored.length) return this.recommend({ ...q, kind: "bestsellers" });
      return scored.map((r) => rowToHit(r));
    }

    if (q.kind === "trending") {
      // What shoppers actually clicked out of search in the last week.
      const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT ${HIT_COLUMNS}, COUNT(e."id")::float AS score
        FROM "Product" p
        JOIN "SearchEvent" e
          ON e."shopId" = p."shopId" AND e."clickedProductId" = p."productId"
        WHERE ${base} ${collScope}
          AND e."createdAt" > NOW() - INTERVAL '7 days'
        GROUP BY p."id"
        ORDER BY score DESC
        LIMIT ${limit}`);
      if (rows.length) return rows.map((r) => rowToHit(r));
      // A quiet week is not an error — fall through to bestsellers.
    }

    if (q.kind === "recent") {
      const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT ${HIT_COLUMNS}, 0::float AS score
        FROM "Product" p
        WHERE ${base} ${collScope}
        ORDER BY p."publishedAt" DESC NULLS LAST
        LIMIT ${limit}`);
      return rows.map((r) => rowToHit(r));
    }

    const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT ${HIT_COLUMNS}, p."popularity" AS score
      FROM "Product" p
      WHERE ${base} ${collScope}
      ORDER BY p."popularity" DESC, p."publishedAt" DESC NULLS LAST
      LIMIT ${limit}`);
    return rows.map((r) => rowToHit(r));
  }
}

/**
 * Cache key for a facet set. Encodes everything that changes the counts — shop,
 * term, filters, scope, availability, and which merchandising rule is active —
 * and deliberately omits page and sort, which do not.
 */
function facetSignature(
  q: SearchQuery,
  normalized: string,
  rule: MerchRule | null,
): string {
  const filters = Object.entries(q.filters)
    .filter(([, v]) => v?.length)
    .map(([k, v]) => `${k}=${[...v].sort().join(",")}`)
    .sort()
    .join("&");
  const price = q.price ? `${q.price.min ?? ""}-${q.price.max ?? ""}` : "";
  // The rule id, not its triggers: two rules can share a trigger and priority
  // while hiding completely different products.
  const ruleKey = rule ? rule.id : "";
  return [
    q.shopId,
    normalized,
    q.collection ?? "",
    q.includeUnavailable ? "1" : "0",
    q.typoTolerance === false ? "0" : "1",
    // Semantic search adds a clause to the text predicate the facets are
    // computed over, so a shop that has it on must not share counts with the
    // same query served while the embeddings provider was unreachable.
    q.semantic === false ? "0" : "1",
    filters,
    price,
    ruleKey,
  ].join(":");
}

/**
 * Assemble the score breakdown for the admin's relevance tester.
 *
 * Reads the `x_*` columns the explain select added. Absent (no term, or explain
 * not requested) they simply come back as zeroes, which is the honest answer for
 * a browse query: nothing was ranked, the catalog was ordered.
 */
function buildExplain(
  normalized: string,
  expansions: string[],
  tsQueryStr: string,
  language: string,
  rule: MerchRule | null,
  rows: any[],
): SearchExplain {
  const scores: SearchExplain["scores"] = {};
  for (const r of rows) {
    const parts = {
      textRank: Number(r.x_textRank ?? 0),
      similarity: Number(r.x_similarity ?? 0),
      semantic: Number(r.x_semantic ?? 0),
      prefix: Number(r.x_prefix ?? 0),
      popularity: Number(r.x_popularity ?? 0),
      merchandising: Number(r.x_merchandising ?? 0),
    };
    scores[r.productId] = { total: Number(r.score ?? 0), ...parts };
  }
  return {
    normalizedTerm: normalized,
    expansions,
    tsQuery: tsQueryStr,
    language,
    rule: rule ? { id: rule.id, name: rule.name, priority: rule.priority } : null,
    scores,
  };
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
