import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../lib/shop.server";
import { jsonCors } from "../lib/proxy.server";

// POST apps/anotherdev-search/track  { type: "click"|"convert", query, productId, st }
// CRO analytics beacon: attributes clicks/conversions back to a search so the
// admin can report CTR and search-driven revenue.
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

  const { type, query, productId, st } = payload;
  const normalized = String(query ?? "").toLowerCase().trim();
  if (!normalized) return jsonCors({ ok: true });

  if (type === "click") {
    // Attach the click to the most recent matching search event for this session.
    const recent = await prisma.searchEvent.findFirst({
      where: { shopId: shop.id, normalized, sessionToken: st ?? undefined },
      orderBy: { createdAt: "desc" },
    });
    if (recent) {
      await prisma.searchEvent.update({
        where: { id: recent.id },
        data: { clickedProductId: String(productId ?? "") || null },
      });
    }
  } else if (type === "convert") {
    await prisma.searchEvent.updateMany({
      where: { shopId: shop.id, normalized, sessionToken: st ?? undefined },
      data: { converted: true },
    });
  }

  return jsonCors({ ok: true });
}

export async function loader(_: LoaderFunctionArgs) {
  return jsonCors({ ok: true });
}
