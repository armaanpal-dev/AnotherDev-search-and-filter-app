import { GROWTH_PLAN, PRO_PLAN, CUSTOM_PLAN } from "../shopify.server";
import {
  PLAN_LIMITS,
  PLAN_ORDER,
  isPlanKey,
  limitsForPlanName,
  type PlanKey,
  type PlanLimits,
} from "./plans";

// The plan table itself lives in ./plans.ts, which has no server imports, so the
// pricing page can render it in the browser. This module is the half that needs
// the Shopify server SDK. Re-exported so server code keeps one import site.
export { PLAN_LIMITS, PLAN_ORDER, isPlanKey, limitsForPlanName };
export type { PlanKey, PlanLimits };

/** Highest tier first: used when resolving which subscription a shop holds. */
const PAID_ORDER: { key: PlanKey; billingPlan: string }[] = [
  { key: "custom", billingPlan: CUSTOM_PLAN },
  { key: "pro", billingPlan: PRO_PLAN },
  { key: "growth", billingPlan: GROWTH_PLAN },
];

/** The Shopify-side plan name for each paid tier. Free has no subscription. */
export const BILLING_PLAN_BY_KEY: Partial<Record<PlanKey, string>> = {
  growth: GROWTH_PLAN,
  pro: PRO_PLAN,
  custom: CUSTOM_PLAN,
};

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
    const res = (await billing.check({
      plans: PAID_ORDER.map((p) => p.billingPlan),
      isTest: isTestBilling(),
    })) as BillingCheckResult;
    if (res.hasActivePayment) {
      // A shop could hold more than one subscription mid-upgrade; the highest
      // tier it is actually paying for is the one it should get.
      const held = new Set((res.appSubscriptions ?? []).map((s) => s?.name));
      const match = PAID_ORDER.find((p) => held.has(p.billingPlan));
      // Fall back to the entry tier when Shopify confirms a payment but does not
      // name it, rather than silently downgrading a paying merchant to Free.
      plan = match ? match.key : "growth";
    }
  } catch {
    plan = "free";
  }

  return { plan, isPaid: plan !== "free", overridden: false, limits: PLAN_LIMITS[plan] };
}

export { GROWTH_PLAN, PRO_PLAN, CUSTOM_PLAN };
