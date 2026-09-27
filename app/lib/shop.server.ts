import prisma from "../db.server";
import { DEFAULT_FILTERS, invalidateShopConfig } from "./search/config.server";

/** Look up our internal Shop row by myshopify domain. */
export async function getShopByDomain(domain: string) {
  return prisma.shop.findUnique({ where: { domain } });
}

/** Ensure a Shop row exists for this domain, seeding default facet config on
 *  first install. Idempotent — safe to call on every admin request. */
export async function ensureShop(domain: string) {
  const existing = await prisma.shop.findUnique({ where: { domain } });
  if (existing) {
    if (existing.uninstalledAt) {
      return prisma.shop.update({
        where: { id: existing.id },
        data: { uninstalledAt: null },
      });
    }
    return existing;
  }

  // Two admin requests on first install (or an admin load racing a webhook)
  // both miss the lookup above, so the create has to tolerate losing that race
  // rather than throwing a unique-constraint error at whichever arrived second.
  const shop = await prisma.shop.create({ data: { domain } }).catch(async (e: any) => {
    if (e?.code !== "P2002") throw e;
    const won = await prisma.shop.findUnique({ where: { domain } });
    if (!won) throw e;
    return won;
  });

  // Seeding is idempotent, so it is safe to run on the losing request too —
  // which also self-heals a shop whose first seed was interrupted.
  await prisma.filterConfig.createMany({
    data: DEFAULT_FILTERS.map((f) => ({ ...f, shopId: shop.id })),
    skipDuplicates: true,
  });
  await prisma.syncState.upsert({
    where: { shopId: shop.id },
    create: { shopId: shop.id, status: "idle", message: "Not yet synced" },
    update: {},
  });
  return shop;
}

export async function markUninstalled(domain: string) {
  const shop = await prisma.shop.findUnique({ where: { domain }, select: { id: true } });
  await prisma.shop.updateMany({
    where: { domain },
    data: {
      uninstalledAt: new Date(),
      // Drop the entitlement with the install.
      //
      // Shopify cancels the subscription when an app is uninstalled, so a
      // reinstall starts unpaid until the merchant approves a charge again.
      // `planName` is what the storefront (App Proxy) gates Pro features on,
      // because it has no billing context to ask — so leaving it at "pro" meant
      // a reinstalled shop kept serving semantic search and the AI feed, for
      // free, until someone happened to open the admin and trigger a re-read.
      //
      // planOverride is deliberately untouched: it is set by an operator, not
      // bought, and it is how support grants a tier with no charge.
      planName: "free",
    },
  });
  // The storefront reads this through a 30-second cache, so drop it rather than
  // serving paid features for one more window after the app is gone.
  if (shop) invalidateShopConfig(shop.id);
}
