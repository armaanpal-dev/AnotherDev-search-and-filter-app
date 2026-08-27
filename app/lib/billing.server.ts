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
      isTest: process.env.NODE_ENV !== "production",
    });
    isPro = hasActivePayment;
  } catch {
    isPro = false;
  }
  const plan: PlanKey = isPro ? "pro" : "free";
  return { plan, isPro, limits: PLAN_LIMITS[plan] };
}

export { PRO_PLAN };
