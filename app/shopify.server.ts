import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// Plan names as Shopify knows them. Free needs no subscription, so it is not
// listed here.
//
// These strings must match each plan's Display name in the Partner Dashboard
// EXACTLY. This app uses Shopify App Pricing, which names a subscription after
// the display name, and billing.check() matches on that name — so a mismatch
// reads a paying merchant as Free.
//
// Entitlements live in app/lib/plans.ts; this file only mirrors what Shopify
// charges.
export const GROWTH_PLAN = "Growth";
export const PRO_PLAN = "Pro";
export const CUSTOM_PLAN = "Custom";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // Read-only billing configuration.
  //
  // Shopify App Pricing owns the plans, prices and trials — they are set in the
  // Partner Dashboard, and Shopify creates the subscription when the merchant
  // approves it on its hosted plan page. Nothing here creates a charge, and
  // nothing in this app may call billing.request(): for an app on App Pricing
  // that call fails, which is how an upgrade button ends up doing nothing.
  // See planSelectionUrl() in app/lib/billing.server.ts.
  //
  // This block stays only because billing.check() — which is how the app reads
  // the shop's current tier — refuses to run without a billing config. Only the
  // plan NAMES are used; the amounts below must be kept in step with the
  // dashboard so this file doesn't mislead the next reader.
  billing: {
    [GROWTH_PLAN]: {
      lineItems: [
        {
          amount: 21,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
      trialDays: 7,
    },
    [PRO_PLAN]: {
      lineItems: [
        {
          amount: 49,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
      trialDays: 7,
    },
    // Annual ($777) is sold only through the App Store pricing page: the
    // in-app upgrade button creates a monthly charge, because nothing in the
    // UI asks the merchant to choose a billing cycle.
    [CUSTOM_PLAN]: {
      lineItems: [
        {
          amount: 70,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
      trialDays: 7,
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
