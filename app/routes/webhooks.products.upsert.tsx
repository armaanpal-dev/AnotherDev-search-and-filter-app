import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { upsertProduct, deleteProduct } from "../lib/sync/upsert.server";
import { normalizeRestProduct } from "../lib/sync/normalize-product";
import { invalidateShopConfig } from "../lib/search/config.server";

// Handles products/create and products/update.
// Keeps the Postgres index in sync in near-real-time.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const shopRow = (await getShopByDomain(shop)) ?? (await ensureShop(shop));

  const p = normalizeRestProduct(payload);
  if (!p) return new Response();

  // Removing it from the index is the right response to a product leaving the
  // storefront — unpublished from the Online Store, or moved to draft/archived.
  // Leaving it indexed puts a 404 in the search results.
  if (!p.publishedOnline || p.status !== "ACTIVE") {
    await deleteProduct(shopRow.id, p.productId);
    invalidateShopConfig(shopRow.id);
    return new Response();
  }

  // "webhook" source: the payload carries no collection membership, no
  // metafields and no currency, so those columns keep whatever the last full
  // sync wrote instead of being blanked on every product edit.
  await upsertProduct(shopRow.id, p, "webhook");
  invalidateShopConfig(shopRow.id);

  console.log(`Indexed ${topic} for ${shop} (product ${p.productId})`);
  return new Response();
};
