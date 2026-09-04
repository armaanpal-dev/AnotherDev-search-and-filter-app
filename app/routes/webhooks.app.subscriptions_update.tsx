import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../lib/shop.server";
import { invalidateShopConfig } from "../lib/search/config.server";
import { GROWTH_PLAN, PRO_PLAN } from "../lib/billing.server";

/**
 * app_subscriptions/update — the merchant's plan changed.
 *
 * `Shop.planName` gates Pro features on the storefront (the AI feed, semantic
 * ranking) where there is no billing context to check against. Without this
 * webhook that column only refreshed when someone opened the admin, so a
 * cancelled or expired subscription kept serving Pro features indefinitely —
 * and a merchant who upgraded had to open the app before it took effect.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const sub = (payload as any)?.app_subscription;
  const status = String(sub?.status ?? "").toUpperCase();
  // ACTIVE is the only status that entitles anything. PENDING (awaiting
  // merchant approval), CANCELLED, EXPIRED, FROZEN and DECLINED all mean the
  // shop drops to Free. The subscription NAME decides which paid tier it is.
  const named = String(sub?.name ?? "");
  const paid = named === PRO_PLAN ? "pro" : named === GROWTH_PLAN ? "growth" : "growth";
  const plan = status === "ACTIVE" ? paid : "free";

  const shopRow = await getShopByDomain(shop);
  // An operator override outranks billing; leave it alone.
  if (shopRow?.planOverride) return new Response();
  if (shopRow && shopRow.planName !== plan) {
    await prisma.shop.update({ where: { id: shopRow.id }, data: { planName: plan } });
    invalidateShopConfig(shopRow.id);
    console.log(`${topic}: ${shop} is now on the ${plan} plan (${status})`);
  }

  return new Response();
};
