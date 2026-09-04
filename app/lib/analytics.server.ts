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

export interface AnalyticsSummary {
  windowDays: number;
  total: number;
  ctr: number;
  /**
   * Share of searches that led to an add-to-cart. This is the furthest down the
   * funnel the storefront can observe: checkout runs on Shopify's own domain,
   * so measuring completed orders would require a Web Pixel extension.
   */
  cartRate: number;
  zeroRate: number;
  noClickRate: number;
  top: TopSearch[];
  zero: { term: string; count: number }[];
  /** Searches that returned results but that nobody clicked — the relevance gap. */
  noClick: { term: string; count: number; avgResults: number }[];
  topProducts: { productId: string; title: string; handle: string; clicks: number }[];
  daily: { day: string; searches: number; clicks: number; carts: number }[];
}

/**
 * One pass of aggregates for the Analytics page.
 *
 * `windowDays` comes from the merchant's plan, not from a constant: the page
 * previously hardcoded 30 days, so Free saw more history than it was sold and
 * Pro saw less.
 */
export async function getAnalytics(
  shopId: string,
  windowDays: number,
): Promise<AnalyticsSummary> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [totals, top, zero, noClick, topProducts, daily] = await Promise.all([
    prisma.$queryRaw<
      { total: bigint; clicks: bigint; conversions: bigint; zero: bigint }[]
    >`
      SELECT COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE "clickedProductId" IS NOT NULL)::bigint AS clicks,
             COUNT(*) FILTER (WHERE "converted")::bigint AS conversions,
             COUNT(*) FILTER (WHERE "resultsCount" = 0)::bigint AS zero
      FROM "SearchEvent"
      WHERE "shopId" = ${shopId} AND "createdAt" >= ${since}`,

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

    prisma.$queryRaw<
      { day: Date; searches: bigint; clicks: bigint; conversions: bigint }[]
    >`
      SELECT date_trunc('day', "createdAt") AS day,
             COUNT(*)::bigint AS searches,
             COUNT(*) FILTER (WHERE "clickedProductId" IS NOT NULL)::bigint AS clicks,
             COUNT(*) FILTER (WHERE "converted")::bigint AS conversions
      FROM "SearchEvent"
      WHERE "shopId" = ${shopId} AND "createdAt" >= ${since}
      GROUP BY 1
      ORDER BY 1 ASC`,
  ]);

  const t = totals[0];
  const total = Number(t?.total ?? 0);
  const clicks = Number(t?.clicks ?? 0);
  const carts = Number(t?.conversions ?? 0);
  const zeroCount = Number(t?.zero ?? 0);
  const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

  return {
    windowDays,
    total,
    ctr: pct(clicks),
    cartRate: pct(carts),
    zeroRate: pct(zeroCount),
    noClickRate: pct(total - clicks),
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
    })),
  };
}

/** CSV export of the top/zero/no-click tables — merchants live in spreadsheets. */
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
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(esc).join(",")).join("\r\n");
}
