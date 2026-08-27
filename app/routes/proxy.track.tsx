import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../lib/shop.server";
import { normalizeQuery } from "../lib/search/normalize";
import { jsonCors } from "../lib/proxy.server";

// POST apps/anotherdev-search/track
//   { type: "click" | "add_to_cart" | "purchase", query, productId, st }
//
// CRO analytics beacon: attributes clicks, add-to-carts and purchases back to
// the search that produced them, so the admin can report CTR and search-driven
// conversion. Also feeds the `popularity` signal that powers the "Most popular"
// sort and the relevance tie-break.

// How long after a search an action still counts as attributable to it.
const ATTRIBUTION_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

// Relative weight each action contributes to a product's popularity score.
const POPULARITY_WEIGHT: Record<string, number> = {
  click: 1,
  add_to_cart: 5,
  purchase: 12,
};

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return jsonCors({ ok: false }, 401);

  const shop = await getShopByDomain(session.shop);
  if (!shop) return jsonCors({ ok: false }, 404);

  let payload: any = {};
  try {
    payload = await request.json();
  } catch {
    return jsonCors({ ok: false }, 400);
  }

  const type = String(payload.type ?? "");
  if (!POPULARITY_WEIGHT[type]) return jsonCors({ ok: true });

  const productId = String(payload.productId ?? "").trim() || null;
  const sessionToken = String(payload.st ?? "").trim();
  const normalized = normalizeQuery(String(payload.query ?? ""));
  const since = new Date(Date.now() - ATTRIBUTION_WINDOW_MS);

  // Attribution requires a shopper session. Without one we cannot tell whose
  // search this action belongs to, and the previous code fell back to updating
  // EVERY event that shared the query string — which marked unrelated shoppers'
  // searches as converted and made the reported conversion rate meaningless.
  if (sessionToken) {
    const target = await prisma.searchEvent.findFirst({
      where: {
        shopId: shop.id,
        sessionToken,
        createdAt: { gte: since },
        // A click belongs to the specific search it came from; an add-to-cart
        // or purchase attaches to whatever this shopper searched most recently.
        ...(type === "click" && normalized ? { normalized } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, clickedProductId: true },
    });

    if (target) {
      await prisma.searchEvent.update({
        where: { id: target.id },
        data: {
          ...(productId && !target.clickedProductId
            ? { clickedProductId: productId }
            : {}),
          ...(type === "click" ? {} : { converted: true }),
        },
      });
    }
  }

  // Popularity is behavioural: what shoppers actually click and buy out of
  // search results. It drives the "Most popular" sort and the relevance
  // tie-break, both of which ranked every product equally before this existed.
  if (productId) {
    await prisma.product
      .updateMany({
        where: { shopId: shop.id, productId },
        data: { popularity: { increment: POPULARITY_WEIGHT[type] } },
      })
      .catch(() => {});
  }

  return jsonCors({ ok: true });
}

export async function loader(_: LoaderFunctionArgs) {
  return jsonCors({ ok: true });
}
