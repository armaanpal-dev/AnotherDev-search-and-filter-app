import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../lib/shop.server";
import { removeCollection } from "../lib/sync/collections.server";
import { invalidateShopConfig } from "../lib/search/config.server";

// collections/delete — drop the mirror row and strip the handle from every
// product that referenced it, so the collection facet stops offering a
// collection that no longer exists.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const shopRow = await getShopByDomain(shop);
  if (shopRow && payload?.id) {
    await removeCollection(shopRow.id, String(payload.id));
    invalidateShopConfig(shopRow.id);
  }
  console.log(`Handled ${topic} for ${shop}`);
  return new Response();
};
