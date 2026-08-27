import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// GDPR: customers/redact. No per-customer PII is stored (search analytics are
// anonymous), so there is nothing to redact. Acknowledge.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop} — no customer PII to redact`);
  return new Response();
};
