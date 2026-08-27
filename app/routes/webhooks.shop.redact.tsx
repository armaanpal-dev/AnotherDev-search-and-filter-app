import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// GDPR: shop/redact (48h after uninstall). Purge ALL data for the shop —
// index, config, analytics — via the Shop cascade.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop} — purging all shop data`);

  await prisma.shop.deleteMany({ where: { domain: shop } });
  await prisma.session.deleteMany({ where: { shop } });

  return new Response();
};
