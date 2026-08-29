import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// GDPR: customers/data_request.
//
// This app holds no customer identifiers. It stores the merchant's catalog
// (products, variants, collections) plus search analytics: the query text, the
// result count, and which product was clicked. The only per-shopper value ever
// written is `SearchEvent.sessionToken` — a random string the storefront widget
// generates in the browser, never linked to a Shopify customer id, email, or
// order, and cleared 24h later by `pruneAnalytics`.
//
// The payload identifies a customer by id/email, and there is no column that
// value could be matched against, so there is nothing to export. Acknowledge.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(
    `Received ${topic} webhook for ${shop} — no customer-identifiable data stored`,
  );
  return new Response();
};
