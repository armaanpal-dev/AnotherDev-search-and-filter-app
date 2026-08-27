import prisma from "../db.server";
import { DEFAULT_FILTERS } from "./search/config.server";

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

  const shop = await prisma.shop.create({ data: { domain } });
  await prisma.filterConfig.createMany({
    data: DEFAULT_FILTERS.map((f) => ({ ...f, shopId: shop.id })),
    skipDuplicates: true,
  });
  await prisma.syncState.create({
    data: { shopId: shop.id, status: "idle", message: "Not yet synced" },
  });
  return shop;
}

export async function markUninstalled(domain: string) {
  await prisma.shop.updateMany({
    where: { domain },
    data: { uninstalledAt: new Date() },
  });
}
