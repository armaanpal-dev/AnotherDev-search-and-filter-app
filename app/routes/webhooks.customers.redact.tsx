import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// GDPR: customers/redact.
//
// Same basis as customers/data_request: nothing stored here is keyed to a
// customer. Search analytics carry query text, result counts and a clicked
// product id; the only per-shopper value, `SearchEvent.sessionToken`, is a
// browser-generated random string with no link to a Shopify customer and is
// nulled out 24h after the event by `pruneAnalytics`.
//
// There is therefore no row this request could select, and nothing to redact.
// (Deleting the shop's data wholesale happens on shop/redact.) Acknowledge.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(
    `Received ${topic} webhook for ${shop} — no customer-identifiable data to redact`,
  );
  return new Response();
};
