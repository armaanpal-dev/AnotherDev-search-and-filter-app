import type { FilterSelection, PriceRange, SortKey } from "./search/types";

const VALID_SORTS: SortKey[] = [
  "relevance",
  "price_asc",
  "price_desc",
  "title_asc",
  "title_desc",
  "newest",
  "bestselling",
];

const MAX_PER_PAGE = 48;

/**
 * Parse storefront query params into a typed search request.
 * Filter params use the `f.<source>` convention, repeated for multi-select:
 *   f.vendor=Nike&f.vendor=Adidas&f.option:Color=Red&price.min=10&price.max=50
 */
export function parseSearchParams(sp: URLSearchParams): {
  term: string;
  page: number;
  perPage: number;
  sort: SortKey;
  filters: FilterSelection;
  price?: PriceRange;
  collection?: string;
} {
  const term = (sp.get("q") ?? sp.get("term") ?? "").slice(0, 200);
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const perPage = Math.min(
    MAX_PER_PAGE,
    Math.max(1, parseInt(sp.get("perPage") ?? "24", 10) || 24),
  );
  const sortRaw = sp.get("sort") ?? "relevance";
  const sort = (VALID_SORTS.includes(sortRaw as SortKey)
    ? sortRaw
    : "relevance") as SortKey;

  const filters: FilterSelection = {};
  for (const [key, value] of sp.entries()) {
    if (!key.startsWith("f.")) continue;
    const source = key.slice(2);
    if (!value) continue;
    (filters[source] ??= []).push(value);
  }

  let price: PriceRange | undefined;
  const pmin = sp.get("price.min");
  const pmax = sp.get("price.max");
  if (pmin != null || pmax != null) {
    price = {
      min: pmin != null ? Number(pmin) : undefined,
      max: pmax != null ? Number(pmax) : undefined,
    };
  }

  const collection = sp.get("collection") ?? undefined;

  return { term, page, perPage, sort, filters, price, collection };
}

export function jsonCors(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}
