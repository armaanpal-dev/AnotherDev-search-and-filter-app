import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../lib/shop.server";
import { deleteProduct } from "../lib/sync/upsert.server";
import { invalidateShopConfig } from "../lib/search/config.server";

// products/delete — remove the product from the index.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const shopRow = await getShopByDomain(shop);
  if (shopRow && payload?.id) {
    await deleteProduct(shopRow.id, String(payload.id));
    invalidateShopConfig(shopRow.id);
  }

  return new Response();
};
