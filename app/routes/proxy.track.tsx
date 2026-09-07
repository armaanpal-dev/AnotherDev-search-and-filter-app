import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../lib/shop.server";
import { normalizeQuery } from "../lib/search/normalize";
import { jsonCors, clientKey } from "../lib/proxy.server";
import { RateLimiter } from "../lib/cache.server";

// POST apps/anotherdev-search/track
//   { type: "click" | "add_to_cart" | "purchase", query, productId, st, … }
//
// CRO analytics beacon: attributes clicks, add-to-carts and completed orders
// back to the search that produced them, so the admin can report click-through,
// add-to-cart and search-driven revenue. Also feeds the `popularity` signal that
// powers the "Most popular" sort and the relevance tie-break.
//
// The storefront widget can only see as far as add-to-cart, because checkout
// runs on Shopify's own domain. `purchase` therefore comes from the Web Pixel
// extension in extensions/anotherdev-pixel, which Shopify runs inside checkout
// and which posts back through this same proxy with the same session token.

// How long after a search an action still counts as attributable to it.
const ATTRIBUTION_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

// Relative weight each action contributes to a product's popularity score.
// A purchase outranks an add-to-cart by as much as an add-to-cart outranks a
// click: it is the only signal that survives a shopper changing their mind.
const POPULARITY_WEIGHT: Record<string, number> = {
  click: 1,
  add_to_cart: 5,
  purchase: 25,
};

// A purchase can arrive long after the search that caused it — a shopper who
// browses, leaves and checks out an hour later is normal. Two hours is right for
// a click; a day is right for money.
const PURCHASE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * This endpoint accepts writes from anonymous storefront visitors, so it needs a
 * ceiling. Without one, a loop hitting `/track` inflates a product's popularity
 * (which feeds ranking and the "Most popular" sort) and writes to the database
 * as fast as the network allows.
 *
 * 60 events / minute / shopper is far above real browsing and far below abuse.
 */
const limiter = new RateLimiter(60, 60_000);

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return jsonCors({ ok: false }, 401);

  if (!limiter.allow(clientKey(request, session.shop))) {
    return jsonCors({ ok: false, error: "rate_limited" }, 429);
  }

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

  const sessionToken = String(payload.st ?? "").trim().slice(0, 64);
  const normalized = normalizeQuery(String(payload.query ?? ""));
  const isPurchase = type === "purchase";
  const since = new Date(
    Date.now() - (isPurchase ? PURCHASE_WINDOW_MS : ATTRIBUTION_WINDOW_MS),
  );

  const productId = String(payload.productId ?? "").trim() || null;

  // A completed order closes the loop from a search to money — the number the
  // subscription is actually justified by. It arrives from the Web Pixel
  // extension, which is the only surface that can see checkout: the storefront
  // JS cannot, because checkout runs on Shopify's own domain.
  //
  // Everything here is shopper-reported and therefore untrusted, so the amount
  // is clamped rather than believed: an unbounded value would let one forged
  // beacon invent an arbitrary "search revenue" figure in the merchant's
  // dashboard.
  if (isPurchase) {
    if (!sessionToken) return jsonCors({ ok: true });
    const orderId = String(payload.orderId ?? "").trim().slice(0, 64) || null;
    const revenue = Math.min(
      1_000_000,
      Math.max(0, Number(payload.revenue) || 0),
    );

    // One order attributes to one search, whatever the pixel retries.
    if (orderId) {
      const seen = await prisma.searchEvent.findFirst({
        where: { shopId: shop.id, orderId },
        select: { id: true },
      });
      if (seen) return jsonCors({ ok: true });
    }

    const target = await prisma.searchEvent.findFirst({
      where: { shopId: shop.id, sessionToken, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    // No search in the window means this order owes nothing to search. Recording
    // it anyway is how an app ends up claiming credit for the whole store.
    if (!target) return jsonCors({ ok: true });

    await prisma.searchEvent.update({
      where: { id: target.id },
      data: { purchased: true, converted: true, revenue, orderId },
    });

    // Purchased line items are the strongest ranking signal available.
    const purchasedIds = Array.isArray(payload.productIds)
      ? payload.productIds
          .map((v: unknown) => String(v).trim())
          .filter((v: string) => /^\d{1,20}$/.test(v))
          .slice(0, 50)
      : [];
    if (purchasedIds.length) {
      await prisma.product
        .updateMany({
          where: { shopId: shop.id, productId: { in: purchasedIds } },
          data: { popularity: { increment: POPULARITY_WEIGHT.purchase } },
        })
        .catch(() => {});
    }
    return jsonCors({ ok: true });
  }

  // Attribution requires a shopper session. Without one we cannot tell whose
  // search this action belongs to, and the previous code fell back to updating
  // EVERY event that shared the query string — which marked unrelated shoppers'
  // searches as converted and made the reported rate meaningless.
  if (sessionToken) {
    const target = await prisma.searchEvent.findFirst({
      where: {
        shopId: shop.id,
        sessionToken,
        createdAt: { gte: since },
        // A click belongs to the specific search it came from; an add-to-cart
        // attaches to whatever this shopper searched most recently.
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
          // `converted` records "this search led to an add to cart" — the
          // furthest down the funnel the storefront can see.
          ...(type === "click" ? {} : { converted: true }),
        },
      });
    } else if (type === "click" && normalized) {
      // No search to attach to.
      //
      // A shopper who types into the box and clicks a suggestion never hits
      // the results page, so nothing recorded their search — and the click,
      // which is the strongest signal this app collects, was being dropped on
      // the floor. Record the search and its click together instead.
      await prisma.searchEvent.create({
        data: {
          shopId: shop.id,
          query: String(payload.query ?? "").slice(0, 200),
          normalized,
          // Unknown from here, and a click proves it was not zero. Left at 0
          // would count this as a zero-result search, which is the opposite of
          // the truth, so record the one result we know about.
          resultsCount: 1,
          clickedProductId: productId,
          sessionToken,
        },
      });
    }
  }

  // Popularity is behavioural: what shoppers actually click and add to cart out
  // of search results. It drives the "Most popular" sort and the relevance
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

export async function loader() {
  return jsonCors({ ok: true });
}
