import { PRO_PLAN } from "../shopify.server";

// Feature limits per plan. Free mirrors the category's entry tier (XCloud = 100
// products free); Pro unlocks everything. One place to tune the offering.
export const PLAN_LIMITS = {
  free: {
    name: "Free",
    productLimit: 100,
    merchandising: false,
    redirects: false,
    analyticsDays: 7,
    aiFeed: false,
  },
  pro: {
    name: "Pro",
    productLimit: Infinity,
    merchandising: true,
    redirects: true,
    analyticsDays: 90,
    aiFeed: true,
  },
} as const;

export type PlanKey = keyof typeof PLAN_LIMITS;

/**
 * Whether charges are created in Shopify's test mode (approved in the admin but
 * never billed). Inferring this from NODE_ENV alone is fragile: a production
 * deploy that forgets to set NODE_ENV=production would quietly issue test
 * charges and never take a payment. SHOPIFY_BILLING_TEST is the explicit
 * override — set it to "false" in production and "true" on a dev store.
 */
export function isTestBilling(): boolean {
  const explicit = process.env.SHOPIFY_BILLING_TEST;
  if (explicit != null && explicit !== "") return explicit !== "false";
  return process.env.NODE_ENV !== "production";
}


export interface PlanStatus {
  plan: PlanKey;
  isPro: boolean;
  limits: (typeof PLAN_LIMITS)[PlanKey];
}

/** Resolve the current plan from Shopify's billing state. Free is the fallback.
 *  `billing` is the BillingContext from authenticate.admin(); typed loosely to
 *  avoid coupling to its deep generic shape. */
export async function getPlanStatus(billing: {
  check: (opts: { plans: [typeof PRO_PLAN]; isTest?: boolean }) => Promise<{ hasActivePayment: boolean }>;
}): Promise<PlanStatus> {
  let isPro = false;
  try {
    const { hasActivePayment } = await billing.check({
      plans: [PRO_PLAN] as [typeof PRO_PLAN],
      isTest: isTestBilling(),
    });
    isPro = hasActivePayment;
  } catch {
    isPro = false;
  }
  const plan: PlanKey = isPro ? "pro" : "free";
  return { plan, isPro, limits: PLAN_LIMITS[plan] };
}

export { PRO_PLAN };
