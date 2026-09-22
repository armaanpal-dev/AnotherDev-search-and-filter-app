// CSV downloads, as a resource route.
//
// Every export in this admin used to be a branch inside the page's own loader,
// reached by a link to `?export=csv`. That shape is wrong twice over: a route
// with a default export is a UI route, and returning a `text/csv` body from one
// hands the router something it cannot render, which surfaces to the merchant
// as an error rather than a download. It is what App Store review 2.1.1 caught
// on the Analytics page, and three more pages had the same bug.
//
// This route has NO default export, so it is a resource route: whatever it
// returns is what the browser receives. ExportCsvButton fetches it and turns the
// response into a download, which keeps the merchant on the page they were on.
//
// One route rather than four so the auth, the plan clamp and the CSV headers
// are written once.

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { getPlanStatus } from "../lib/billing.server";
import {
  getAnalytics,
  getSearchActivity,
  analyticsToCsv,
  termsToCsv,
  csvCell,
} from "../lib/analytics.server";
import { RANGE_DAYS, isActivityRange } from "../components/search-activity";
import prisma from "../db.server";

/** Rows to CSV. CRLF because that is what Excel expects. */
function toCsv(rows: string[][]): string {
  // csvCell, always: these values are merchant- and shopper-supplied, and a
  // term beginning with = + - or @ is a formula the moment it is opened in a
  // spreadsheet.
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Nothing here is worth a stale copy; a merchant exporting twice expects
      // the second file to reflect what they just changed.
      "Cache-Control": "no-store",
    },
  });
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const { limits } = await getPlanStatus(billing, shop.planOverride);
  const url = new URL(request.url);

  switch (params.kind) {
    case "analytics": {
      // The same clamp the Analytics page applies. Without it, a Free shop
      // could ask this route directly for a year of history it is not sold.
      const requested = parseInt(url.searchParams.get("days") ?? "", 10);
      const days =
        Number.isFinite(requested) && requested > 0
          ? Math.min(requested, limits.analyticsDays)
          : limits.analyticsDays;
      const summary = await getAnalytics(shop.id, days);
      return csvResponse(analyticsToCsv(summary), `search-analytics-${days}d.csv`);
    }

    case "activity": {
      const rangeParam = url.searchParams.get("range");
      const range = isActivityRange(rangeParam) ? rangeParam : "month";
      const days = Math.min(RANGE_DAYS[range], limits.analyticsDays);
      const list = url.searchParams.get("list") === "zero" ? "zero" : "top";
      const activity = await getSearchActivity(shop.id, days, 500);
      const rows = list === "zero" ? activity.zero : activity.top;
      const name = list === "zero" ? "no-results" : "top-searches";
      return csvResponse(termsToCsv(rows), `${name}-${range}.csv`);
    }

    case "synonyms": {
      const synonyms = await prisma.synonym.findMany({
        where: { shopId: shop.id },
        orderBy: { createdAt: "desc" },
      });
      const rows = [["type", "input", "terms"]].concat(
        synonyms.map((s) => [s.type, s.input ?? "", s.terms.join("|")]),
      );
      return csvResponse(toCsv(rows), "synonyms.csv");
    }

    case "redirects": {
      const redirects = await prisma.redirect.findMany({
        where: { shopId: shop.id },
        orderBy: { createdAt: "desc" },
      });
      const rows = [["query", "url", "active"]].concat(
        redirects.map((r) => [r.query, r.url, String(r.active)]),
      );
      return csvResponse(toCsv(rows), "redirects.csv");
    }

    default:
      // A plain 404 rather than an empty CSV: a typo'd export URL should not
      // hand the merchant a file that looks like their data went missing.
      return new Response("Unknown export", { status: 404 });
  }
};
