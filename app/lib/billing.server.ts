import { GROWTH_PLAN, PRO_PLAN, CUSTOM_PLAN } from "../shopify.server";
import {
  PLAN_LIMITS,
  PLAN_ORDER,
  isPlanKey,
  limitsForPlanName,
  planKeyFromSubscriptionName,
  type PlanKey,
  type PlanLimits,
} from "./plans";

// The plan table itself lives in ./plans.ts, which has no server imports, so the
// pricing page can render it in the browser. This module is the half that needs
// the Shopify server SDK. Re-exported so server code keeps one import site.
export { PLAN_LIMITS, PLAN_ORDER, isPlanKey, limitsForPlanName, planKeyFromSubscriptionName };
export type { PlanKey, PlanLimits };

/** The Shopify-side plan name for each paid tier. Free has no subscription. */
export const BILLING_PLAN_BY_KEY: Partial<Record<PlanKey, string>> = {
  growth: GROWTH_PLAN,
  pro: PRO_PLAN,
  custom: CUSTOM_PLAN,
};

/**
 * The app handle, which must match `handle` in shopify.app.toml. It is part of
 * the plan selection page URL, so a mismatch sends merchants to a 404.
 */
const APP_HANDLE = process.env.SHOPIFY_APP_HANDLE || "anotherdev-search";

/**
 * Shopify's hosted plan selection page for this app.
 *
 * Under Shopify App Pricing, plans, prices and trials live in the Partner
 * Dashboard and Shopify — not this app — creates the subscription once the
 * merchant approves. Charging from code (`billing.request`, or the
 * `appSubscriptionCreate` mutation underneath it) is not supported for an app
 * configured this way: the call fails, and the upgrade button silently does
 * nothing. That is what App Store review 1.2.2 flagged. Sending the merchant
 * here instead is the supported path, and it is Shopify that then asks them to
 * accept or decline the charge.
 *
 * Must be opened at the top level: the page lives outside this app's iframe.
 */
export function planSelectionUrl(shopDomain: string): string {
  const store = shopDomain.replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${store}/charges/${APP_HANDLE}/pricing_plans`;
}

// There is no isTestBilling() any more, and SHOPIFY_BILLING_TEST no longer does
// anything. It only ever decided how THIS app created charges, and this app no
// longer creates any: Shopify App Pricing does, and Shopify decides whether a
// given store's subscription is a test one. Reading the shop's tier accepts
// test and live subscriptions alike — see getPlanStatus.

export interface PlanStatus {
  plan: PlanKey;
  /** True for any paid tier, for call sites that only care "is it paid". */
  isPaid: boolean;
  /** Set when an operator pinned the plan, so the UI can say the charge is waived. */
  overridden: boolean;
  limits: PlanLimits;
}

// Loosely typed on purpose: BillingContext.check() is generic over the plan
// names declared in shopifyApp(), so a structural type naming string[] is not
// assignable to it. Only two fields off the result are needed.
type BillingCheckResult = {
  hasActivePayment: boolean;
  appSubscriptions?: { name?: string }[];
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BillingCheck = { check: (opts: any) => Promise<any> };

/**
 * Resolve the shop's tier.
 *
 * An operator override short-circuits the billing call entirely: the whole point
 * is to grant a tier Shopify has no charge for, so asking Shopify first would
 * only produce the wrong answer more slowly.
 */
export async function getPlanStatus(
  billing: BillingCheck,
  planOverride?: string | null,
): Promise<PlanStatus> {
  if (isPlanKey(planOverride)) {
    return {
      plan: planOverride,
      isPaid: planOverride !== "free",
      overridden: true,
      limits: PLAN_LIMITS[planOverride],
    };
  }

  let plan: PlanKey = "free";
  try {
    // Deliberately unfiltered, and deliberately isTest: true.
    //
    // `plans` would make Shopify drop any subscription whose name is not
    // spelled exactly as this code spells it, and `isTest: false` would drop
    // every test subscription — which is what a development store gets. Either
    // one turns a merchant who has just approved a charge back into Free, with
    // no error anywhere. Read everything that is active, then decide here.
    //
    // Nothing is granted loosely by reading test subscriptions: only Shopify
    // creates these, this app no longer creates charges at all, and a merchant
    // cannot issue themselves a test subscription.
    const res = (await billing.check({ isTest: true })) as BillingCheckResult;
    const subscriptions = res.appSubscriptions ?? [];

    // A shop can hold more than one subscription mid-upgrade, so take the
    // highest tier it holds rather than the first one Shopify happens to list.
    let unrecognised = false;
    for (const sub of subscriptions) {
      const key = planKeyFromSubscriptionName(String(sub?.name ?? ""));
      if (!key) {
        unrecognised = true;
        continue;
      }
      if (PLAN_ORDER.indexOf(key) > PLAN_ORDER.indexOf(plan)) plan = key;
    }

    // Shopify confirms a subscription but its name matches no tier: the shop is
    // paying for something, so give it the entry tier rather than silently
    // downgrading a paying merchant to Free.
    if (plan === "free" && unrecognised) plan = "growth";
  } catch (error) {
    // Logged, not swallowed. This used to fail to Free in silence, so a broken
    // billing read looked exactly like a merchant who had never upgraded.
    console.error("[billing] could not read the shop's subscriptions", error);
    plan = "free";
  }

  return { plan, isPaid: plan !== "free", overridden: false, limits: PLAN_LIMITS[plan] };
}

export { GROWTH_PLAN, PRO_PLAN, CUSTOM_PLAN };
