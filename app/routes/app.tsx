import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../lib/shop.server";
import { getPlanStatus } from "../lib/billing.server";
import { invalidateShopConfig } from "../lib/search/config.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  // Make sure our internal Shop row exists on every admin visit (idempotent).
  const shop = await ensureShop(session.shop);

  // Keep the stored plan in sync so the storefront (App Proxy) can gate Pro
  // features without a billing round-trip. The app_subscriptions/update webhook
  // handles changes between visits; this covers the first visit and any webhook
  // that was missed.
  // planOverride wins over billing, and the sync below must not undo it.
  const { plan } = await getPlanStatus(billing, shop.planOverride);
  if (shop.planName !== plan) {
    await prisma.shop.update({ where: { id: shop.id }, data: { planName: plan } });
    invalidateShopConfig(shop.id);
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/sync">Index</s-link>
        <s-link href="/app/preview">Test search</s-link>
        <s-link href="/app/filters">Filters</s-link>
        <s-link href="/app/synonyms">Synonyms</s-link>
        <s-link href="/app/merchandising">Merchandising</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/plans">Plans</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
