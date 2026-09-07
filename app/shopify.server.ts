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
// listed here. These strings are what appear on the merchant invoice and in
// billing.check(), so renaming one orphans existing subscriptions.
// Entitlements live in app/lib/billing.server.ts; this file only sets price.
// These strings must match the Display name of the matching plan in the
// Developer Dashboard exactly: managed pricing names a subscription after the
// display name, and billing.check() matches on that name. A mismatch reads a
// paying merchant as Free.
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
