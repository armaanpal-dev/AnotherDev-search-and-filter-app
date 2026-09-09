import prisma from "../db.server";
import { normalizeQuery } from "./search/normalize";

// Raw events are kept a little beyond the longest plan window so a merchant
// upgrading from Free to Pro immediately sees history rather than a blank chart.
// Without this the table grows forever — it is the highest-volume table in the
// app by an order of magnitude.
const RETENTION_DAYS = Number(process.env.ANALYTICS_RETENTION_DAYS ?? 180);

// `sessionToken` is the one pseudonymous per-shopper value this app stores, and
// it earns its keep for exactly one thing: joining a click or add-to-cart back
// to the search that produced it, inside a 2-hour attribution window. Reports
// never group by it. So it is cleared a day later — long enough to absorb clock
// skew and late beacons, short enough that the retained analytics carry no
// per-shopper identifier at all.
const SESSION_TOKEN_RETENTION_HOURS = Number(
  process.env.ANALYTICS_SESSION_TOKEN_RETENTION_HOURS ?? 24,
);

// Pruning is cheap but pointless to repeat constantly; once a day per shop.
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Delete analytics beyond the retention window, and strip session tokens from
 * events past the attribution window. Called opportunistically after a catalog
 * sync (the one recurring, already-backgrounded job this app has), and safe to
 * call as often as you like — it no-ops until the interval elapses.
 */
export async function pruneAnalytics(shopId: string): Promise<number> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { analyticsPrunedAt: true },
  });
  const last = shop?.analyticsPrunedAt;
  if (last && Date.now() - last.getTime() < PRUNE_INTERVAL_MS) return 0;

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.searchEvent.deleteMany({
    where: { shopId, createdAt: { lt: cutoff } },
  });

  const tokenCutoff = new Date(
    Date.now() - SESSION_TOKEN_RETENTION_HOURS * 60 * 60 * 1000,
  );
  await prisma.searchEvent.updateMany({
    where: { shopId, createdAt: { lt: tokenCutoff }, sessionToken: { not: null } },
    data: { sessionToken: null },
  });

  await prisma.shop.update({
    where: { id: shopId },
    data: { analyticsPrunedAt: new Date() },
  });
  return count;
}

/**
 * Record one committed search.
 *
 * Lives here rather than in a route because more than one surface is a real
 * search: the JSON API the storefront widget calls, and the crawlable results
 * page a shopper reaches by pressing Enter. Only the first of those used to
 * record anything, which is why Analytics stayed empty no matter how much
 * searching happened.
 *
 * Never throws: analytics must not be able to break search.
 */
export async function recordSearchEvent(input: {
  shopId: string;
  term: string;
  resultsCount: number;
  sessionToken?: string;
  bucket?: string;
}): Promise<void> {
  try {
    const normalized = normalizeQuery(input.term);
    if (!normalized) return;

    // Collapse repeats. A type-ahead submit can fire twice for one intent,
    // and the results page is a plain URL that gets reloaded and crawled.
    // With a session token this is per shopper; without one (the server
    // rendered page has no token) it is per shop, which slightly under-counts
    // two people searching the same word inside a minute but stops a refresh
    // loop inventing traffic.
    const since = new Date(Date.now() - 60_000);
    const duplicate = await prisma.searchEvent.findFirst({
      where: {
        shopId: input.shopId,
        normalized,
        createdAt: { gte: since },
        ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
      },
      select: { id: true },
    });
    if (duplicate) return;

    await prisma.searchEvent.create({
      data: {
        shopId: input.shopId,
        query: input.term,
        normalized,
        resultsCount: input.resultsCount,
        sessionToken: input.sessionToken,
        bucket: input.bucket,
      },
    });
  } catch {
    // Analytics must never break search.
  }
}

export interface TopSearch {
  term: string;
  count: number;
  avgResults: number;
  clicks: number;
  ctr: number;
}

/** One side of a period-over-period comparison. */
export interface PeriodTotals {
  total: number;
  ctr: number;
  cartRate: number;
  purchaseRate: number;
  revenue: number;
  zeroRate: number;
}

/** One arm of the merchandising A/B test. */
export interface BucketStats {
  bucket: string;
  searches: number;
  ctr: number;
  cartRate: number;
  purchaseRate: number;
  revenue: number;
}

export interface AnalyticsSummary {
  windowDays: number;
  total: number;
  ctr: number;
  /**
   * Share of searches that led to an add-to-cart. Until the Web Pixel existed
   * this was the furthest down the funnel the storefront could see, because
   * checkout runs on Shopify's own domain.
   */
  cartRate: number;
  /**
   * Share of searches that ended in a completed order, and the money those
   * orders were worth. This is the number that answers "is search earning its
   * subscription", and it is why the pixel extension exists.
   */
  purchaseRate: number;
  revenue: number;
  currency: string;
  zeroRate: number;
  noClickRate: number;
  /** The same headline numbers for the immediately preceding window. */
  previous: PeriodTotals;
  top: TopSearch[];
  zero: { term: string; count: number }[];
  /** Searches that returned results but that nobody clicked — the relevance gap. */
  noClick: { term: string; count: number; avgResults: number }[];
  topProducts: { productId: string; title: string; handle: string; clicks: number }[];
  daily: {
    day: string;
    searches: number;
    clicks: number;
    carts: number;
    purchases: number;
    revenue: number;
  }[];
  /** Populated only when bucketed merchandising rules are actually running. */
  buckets: BucketStats[];
}

/**
 * One pass of aggregates for the Analytics page.
 *
 * `windowDays` comes from the merchant's plan, not from a constant: the page
 * previously hardcoded 30 days, so Free saw more history than it was sold and
 * Pro saw less.
 */
/** One ranked list: the term as shoppers typed it, and how often. */
export interface TermCount {
  term: string;
  count: number;
}

/**
 * The two lists the dashboard shows, and nothing else.
 *
 * getAnalytics() answers nine questions in nine queries; the dashboard needs
 * two of them. Running the full summary to render one panel would put eight
 * unused aggregates on the critical path of the page merchants open most.
 */
export async function getSearchActivity(
  shopId: string,
  windowDays: number,
  limit = 25,
): Promise<{ top: TermCount[]; zero: TermCount[] }> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [top, zero] = await Promise.all([
    prisma.$queryRaw<{ term: string; count: bigint }[]>`
      SELECT "normalized" AS term, COUNT(*)::bigint AS count
      FROM "SearchEvent"
      WHERE "shopId" = ${shopId} AND "createdAt" >= ${since} AND "normalized" <> ''
      GROUP BY "normalized"
      ORDER BY count DESC
      LIMIT ${limit}`,

    prisma.$queryRaw<{ term: string; count: bigint }[]>`
      SELECT "normalized" AS term, COUNT(*)::bigint AS count
      FROM "SearchEvent"
      WHERE "shopId" = ${shopId} AND "createdAt" >= ${since}
        AND "resultsCount" = 0 AND "normalized" <> ''
      GROUP BY "normalized"
      ORDER BY count DESC
      LIMIT ${limit}`,
  ]);

  const rows = (r: { term: string; count: bigint }[]) =>
    r.map((x) => ({ term: x.term, count: Number(x.count) }));

  return { top: rows(top), zero: rows(zero) };
}

/** Two columns of term counts as a CSV, for the dashboard's Export buttons. */
export function termsToCsv(rows: TermCount[]): string {
  // csvCell, NOT a local quote-escaper. Search terms are typed by anonymous
  // shoppers, and Excel and Sheets execute any cell beginning with = + - @ as a
  // formula — so a search for =HYPERLINK("http://…") would become a live link in
  // the merchant's spreadsheet. csvCell prefixes those with an apostrophe as
  // well as doubling quotes; a plain quote-escaper leaves the hole wide open.
  // CRLF for the same reason analyticsToCsv uses it: Excel expects it.
  return [["term", "searches"]]
    .concat(rows.map((r) => [r.term, String(r.count)]))
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

export async function getAnalytics(
  shopId: string,
  windowDays: number,
): Promise<AnalyticsSummary> {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const since = new Date(now - windowDays * dayMs);
  // The window immediately before this one, so every headline number can be
  // shown as a movement rather than a bare figure. "412 searches" tells a
  // merchant nothing; "412, up 38%" tells them whether to act.
  const prevSince = new Date(now - windowDays * 2 * dayMs);

  const [totals, prevTotals, top, zero, noClick, topProducts, daily, buckets, currencyRow] =
    await Promise.all([
    prisma.$queryRaw<
      {
        total: bigint; clicks: bigint; conversions: bigint;
        purchases: bigint; revenue: number | null; zero: bigint;
      }[]
    >`
      SELECT COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE "clickedProductId" IS NOT NULL)::bigint AS clicks,
             COUNT(*) FILTER (WHERE "converted")::bigint AS conversions,
             COUNT(*) FILTER (WHERE "purchased")::bigint AS purchases,
             COALESCE(SUM("revenue") FILTER (WHERE "purchased"), 0)::float AS revenue,
             COUNT(*) FILTER (WHERE "resultsCount" = 0)::bigint AS zero
      FROM "SearchEvent"
      WHERE "shopId" = ${shopId} AND "createdAt" >= ${since}`,

    prisma.$queryRaw<
      {
        total: bigint; clicks: bigint; conversions: bigint;
        purchases: bigint; revenue: number | null; zero: bigint;
      }[]
    >`
      SELECT COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE "clickedProductId" IS NOT NULL)::bigint AS clicks,
             COUNT(*) FILTER (WHERE "converted")::bigint AS conversions,
             COUNT(*) FILTER (WHERE "purchased")::bigint AS purchases,
             COALESCE(SUM("revenue") FILTER (WHERE "purchased"), 0)::float AS revenue,
             COUNT(*) FILTER (WHERE "resultsCount" = 0)::bigint AS zero
      FROM "SearchEvent"
      WHERE "shopId" = ${shopId}
        AND "createdAt" >= ${prevSince} AND "createdAt" < ${since}`,

    // Top searches, each with its own click-through rate — an average CTR hides
    // the terms that are actually failing.
    prisma.$queryRaw<
      { term: string; count: bigint; avgresults: number; clicks: bigint }[]
    >`
      SELECT "normalized" AS term,
             COUNT(*)::bigint AS count,
             AVG("resultsCount")::float AS avgresults,
             COUNT(*) FILTER (WHERE "clickedProductId" IS NOT NULL)::bigint AS clicks
      FROM "SearchEvent"
      WHERE "shopId" = ${shopId} AND "createdAt" >= ${since} AND "normalized" <> ''
      GROUP BY "normalized"
      ORDER BY count DESC
      LIMIT 25`,

    prisma.$queryRaw<{ term: string; count: bigint }[]>`
      SELECT "normalized" AS term, COUNT(*)::bigint AS count
      FROM "SearchEvent"
      WHERE "shopId" = ${shopId} AND "createdAt" >= ${since}
        AND "resultsCount" = 0 AND "normalized" <> ''
      GROUP BY "normalized"
      ORDER BY count DESC
      LIMIT 25`,

    // Results came back, nobody clicked: the results were wrong, not missing.
    // This is the list that actually tells a merchant what to merchandise.
    prisma.$queryRaw<{ term: string; count: bigint; avgresults: number }[]>`
      SELECT "normalized" AS term,
             COUNT(*)::bigint AS count,
             AVG("resultsCount")::float AS avgresults
      FROM "SearchEvent"
      WHERE "shopId" = ${shopId} AND "createdAt" >= ${since}
        AND "resultsCount" > 0 AND "normalized" <> ''
      GROUP BY "normalized"
      HAVING COUNT(*) FILTER (WHERE "clickedProductId" IS NOT NULL) = 0
         AND COUNT(*) >= 3
      ORDER BY count DESC
      LIMIT 25`,

    prisma.$queryRaw<
      { productId: string; title: string; handle: string; clicks: bigint }[]
    >`
      SELECT e."clickedProductId" AS "productId",
             COALESCE(p."title", '(removed product)') AS title,
             COALESCE(p."handle", '') AS handle,
             COUNT(*)::bigint AS clicks
      FROM "SearchEvent" e
      LEFT JOIN "Product" p
        ON p."shopId" = e."shopId" AND p."productId" = e."clickedProductId"
      WHERE e."shopId" = ${shopId} AND e."createdAt" >= ${since}
        AND e."clickedProductId" IS NOT NULL
      GROUP BY e."clickedProductId", p."title", p."handle"
      ORDER BY clicks DESC
      LIMIT 15`,

    // Zero-filled in SQL with generate_series.
    //
    // Grouping alone returns only days that had events, and the chart plots by
    // array index — so a quiet week collapsed to nothing and the surviving bars
    // sat next to each other, which made the trend line say something that never
    // happened. A LEFT JOIN over the full range is the fix, and it also means
    // the caller never has to know the window length to reconstruct it.
    prisma.$queryRaw<
      {
        day: Date; searches: bigint; clicks: bigint;
        conversions: bigint; purchases: bigint; revenue: number | null;
      }[]
    >`
      SELECT d.day::date AS day,
             COUNT(e."id")::bigint AS searches,
             COUNT(e."id") FILTER (WHERE e."clickedProductId" IS NOT NULL)::bigint AS clicks,
             COUNT(e."id") FILTER (WHERE e."converted")::bigint AS conversions,
             COUNT(e."id") FILTER (WHERE e."purchased")::bigint AS purchases,
             COALESCE(SUM(e."revenue") FILTER (WHERE e."purchased"), 0)::float AS revenue
      FROM generate_series(
             date_trunc('day', ${since}::timestamp),
             date_trunc('day', NOW()),
             INTERVAL '1 day'
           ) AS d(day)
      LEFT JOIN "SearchEvent" e
        ON e."shopId" = ${shopId}
       AND e."createdAt" >= d.day
       AND e."createdAt" < d.day + INTERVAL '1 day'
      GROUP BY 1
      ORDER BY 1 ASC`,

    // A/B arms. Only rows that actually carry a bucket, so a shop running no
    // experiment gets an empty list and the section stays hidden.
    prisma.$queryRaw<
      {
        bucket: string; searches: bigint; clicks: bigint;
        conversions: bigint; purchases: bigint; revenue: number | null;
      }[]
    >`
      SELECT "bucket",
             COUNT(*)::bigint AS searches,
             COUNT(*) FILTER (WHERE "clickedProductId" IS NOT NULL)::bigint AS clicks,
             COUNT(*) FILTER (WHERE "converted")::bigint AS conversions,
             COUNT(*) FILTER (WHERE "purchased")::bigint AS purchases,
             COALESCE(SUM("revenue") FILTER (WHERE "purchased"), 0)::float AS revenue
      FROM "SearchEvent"
      WHERE "shopId" = ${shopId} AND "createdAt" >= ${since}
        AND "bucket" IS NOT NULL AND "bucket" <> ''
      GROUP BY "bucket"
      ORDER BY "bucket" ASC`,

    prisma.shop.findUnique({
      where: { id: shopId },
      select: { currencyCode: true },
    }),
  ]);

  const t = totals[0];
  const total = Number(t?.total ?? 0);
  const clicks = Number(t?.clicks ?? 0);
  const carts = Number(t?.conversions ?? 0);
  const purchases = Number(t?.purchases ?? 0);
  const revenue = Number(t?.revenue ?? 0);
  const zeroCount = Number(t?.zero ?? 0);
  const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

  /** The same shape for the preceding window, so the UI can diff them. */
  const periodTotals = (row?: {
    total: bigint; clicks: bigint; conversions: bigint;
    purchases: bigint; revenue: number | null; zero: bigint;
  }): PeriodTotals => {
    const n = Number(row?.total ?? 0);
    const share = (v: number) => (n ? Math.round((v / n) * 1000) / 10 : 0);
    return {
      total: n,
      ctr: share(Number(row?.clicks ?? 0)),
      cartRate: share(Number(row?.conversions ?? 0)),
      purchaseRate: share(Number(row?.purchases ?? 0)),
      revenue: Number(row?.revenue ?? 0),
      zeroRate: share(Number(row?.zero ?? 0)),
    };
  };

  return {
    windowDays,
    total,
    ctr: pct(clicks),
    cartRate: pct(carts),
    purchaseRate: pct(purchases),
    revenue,
    currency: currencyRow?.currencyCode ?? "",
    zeroRate: pct(zeroCount),
    noClickRate: pct(total - clicks),
    previous: periodTotals(prevTotals[0]),
    buckets: buckets.map((b) => {
      const n = Number(b.searches);
      const share = (v: number) => (n ? Math.round((v / n) * 1000) / 10 : 0);
      return {
        bucket: b.bucket,
        searches: n,
        ctr: share(Number(b.clicks)),
        cartRate: share(Number(b.conversions)),
        purchaseRate: share(Number(b.purchases)),
        revenue: Number(b.revenue ?? 0),
      };
    }),
    top: top.map((r) => ({
      term: r.term,
      count: Number(r.count),
      avgResults: Math.round(r.avgresults ?? 0),
      clicks: Number(r.clicks),
      ctr: Number(r.count)
        ? Math.round((Number(r.clicks) / Number(r.count)) * 1000) / 10
        : 0,
    })),
    zero: zero.map((r) => ({ term: r.term, count: Number(r.count) })),
    noClick: noClick.map((r) => ({
      term: r.term,
      count: Number(r.count),
      avgResults: Math.round(r.avgresults ?? 0),
    })),
    topProducts: topProducts.map((r) => ({
      productId: r.productId,
      title: r.title,
      handle: r.handle,
      clicks: Number(r.clicks),
    })),
    daily: daily.map((r) => ({
      day: new Date(r.day).toISOString().slice(0, 10),
      searches: Number(r.searches),
      clicks: Number(r.clicks),
      carts: Number(r.conversions),
      purchases: Number(r.purchases),
      revenue: Number(r.revenue ?? 0),
    })),
  };
}

/**
 * CSV export of the top/zero/no-click tables — merchants live in spreadsheets.
 *
 * Every cell goes through `csvCell`, which does two separate jobs. Quote-doubling
 * keeps the CSV well-formed. The leading apostrophe on `= + - @` and friends is
 * the one that matters for safety: these terms are typed by anonymous shoppers,
 * and Excel and Sheets treat a cell starting with any of them as a FORMULA. A
 * search for `=HYPERLINK("http://…","Click")` would otherwise become a live link
 * in the merchant's spreadsheet — the classic CSV-injection path out of an
 * analytics export.
 */
export function analyticsToCsv(summary: AnalyticsSummary): string {
  const rows: string[][] = [["section", "term", "searches", "clicks", "ctr_pct", "avg_results"]];
  for (const r of summary.top) {
    rows.push(["top", r.term, String(r.count), String(r.clicks), String(r.ctr), String(r.avgResults)]);
  }
  for (const r of summary.zero) {
    rows.push(["zero_results", r.term, String(r.count), "0", "0", "0"]);
  }
  for (const r of summary.noClick) {
    rows.push(["no_clicks", r.term, String(r.count), "0", "0", String(r.avgResults)]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/** Leading tab and CR count too: both are stripped by the parser, exposing the
 *  operator behind them. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(value: string): string {
  const s = String(value ?? "");
  const safe = FORMULA_LEAD.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * Synonym candidates, derived from searches that found nothing.
 *
 * A zero-result term is a word a shopper used that the catalog does not. Most of
 * the time there IS a product for it under another name, and the merchant just
 * has to be told which — so for each failing term this finds the closest word in
 * the catalog by trigram similarity. That turns the Analytics dead-end list from
 * a list of problems into a list of one-click fixes.
 *
 * Terms that already have a synonym rule are excluded, so accepting a suggestion
 * makes it disappear.
 */
export async function suggestSynonyms(
  shopId: string,
  windowDays: number,
  limit = 10,
): Promise<{ term: string; count: number; suggestion: string }[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await prisma.$queryRaw<
    { term: string; count: bigint; suggestion: string | null }[]
  >`
    WITH failing AS (
      SELECT "normalized" AS term, COUNT(*)::bigint AS count
      FROM "SearchEvent"
      WHERE "shopId" = ${shopId} AND "createdAt" >= ${since}
        AND "resultsCount" = 0 AND "normalized" <> ''
        AND length("normalized") >= 3
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 40
    )
    SELECT f.term,
           f.count,
           -- The closest catalog title, by trigram similarity. The % operator
           -- uses the GIN index, so this stays a lookup rather than a scan of
           -- the catalog per failing term.
           (SELECT p."title"
              FROM "Product" p
             WHERE p."shopId" = ${shopId}
               AND p."status" = 'ACTIVE' AND p."publishedOnline" = TRUE
               AND lower(ad_immutable_unaccent(p."title")) % f.term
             ORDER BY similarity(lower(ad_immutable_unaccent(p."title")), f.term) DESC
             LIMIT 1) AS suggestion
    FROM failing f`;

  const existing = await prisma.synonym.findMany({
    where: { shopId },
    select: { input: true, terms: true },
  });
  const covered = new Set<string>();
  for (const s of existing) {
    if (s.input) covered.add(normalizeQuery(s.input));
    for (const t of s.terms) covered.add(normalizeQuery(t));
  }

  return rows
    .filter((r) => r.suggestion && !covered.has(r.term))
    .map((r) => ({
      term: r.term,
      count: Number(r.count),
      // A title is not a synonym. Offer the single closest WORD from it, which
      // is what a merchant would actually type into the rule.
      suggestion: closestWord(r.term, r.suggestion as string),
    }))
    .filter((r) => r.suggestion && r.suggestion !== r.term)
    .slice(0, limit);
}

/** The word in `title` most like `term`, by shared character trigrams. */
function closestWord(term: string, title: string): string {
  const grams = (s: string) => {
    const padded = `  ${s} `;
    const out = new Set<string>();
    for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
    return out;
  };
  const target = grams(term);
  let best = "";
  let bestScore = 0;
  for (const word of normalizeQuery(title).split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 3) continue;
    const g = grams(word);
    let shared = 0;
    g.forEach((x) => {
      if (target.has(x)) shared++;
    });
    const score = shared / (g.size + target.size - shared);
    if (score > bestScore) {
      bestScore = score;
      best = word;
    }
  }
  // Below this the "suggestion" is a different word that happens to share a few
  // letters, which is worse than offering nothing.
  return bestScore > 0.3 ? best : "";
}
