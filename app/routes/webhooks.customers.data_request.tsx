import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// GDPR: customers/data_request. This app stores no personal customer data —
// only aggregate, anonymous search analytics (no names, emails, or addresses).
// Nothing to export; acknowledge the request.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop} — no customer PII stored`);
  return new Response();
};
