import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import {
  upsertCollectionRow,
  reconcileCollectionMembership,
} from "../lib/sync/collections.server";
import { invalidateShopConfig } from "../lib/search/config.server";

/**
 * collections/create and collections/update.
 *
 * This topic was previously subscribed and routed to the product handler, which
 * ignored it — so a merchant editing a collection (or a smart collection's rules
 * re-evaluating) left collection-scoped search and the collection facet stale
 * until the next full catalog sync. Membership is recomputed here instead.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  if (!payload?.id) return new Response();

  const shopRow = (await getShopByDomain(shop)) ?? (await ensureShop(shop));
  const collectionId = String(payload.id);
  const handle = String(payload.handle ?? "");

  await upsertCollectionRow(shopRow.id, {
    collectionId,
    handle,
    title: String(payload.title ?? handle),
    imageUrl: payload.image?.src ?? null,
    productCount: Number(payload.products_count ?? 0),
  });

  // The webhook payload has no product list, so membership needs one query. The
  // offline session is what makes an admin call possible outside a request.
  if (handle) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      await reconcileCollectionMembership(
        shopRow.id,
        admin as any,
        `gid://shopify/Collection/${collectionId}`,
        handle,
      );
    } catch (e: any) {
      // A failed reconcile is recoverable — the next full sync fixes it — and
      // must not make Shopify retry this webhook forever.
      console.error(`collections/upsert reconcile failed for ${shop}:`, e?.message);
    }
  }

  invalidateShopConfig(shopRow.id);
  console.log(`Handled ${topic} for ${shop} (collection ${collectionId})`);
  return new Response();
};
