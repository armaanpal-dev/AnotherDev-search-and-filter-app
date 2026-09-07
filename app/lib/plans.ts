// The plan table.
//
// Deliberately NOT a `.server` module and deliberately free of imports: the
// pricing page renders these values in the browser, and anything reachable from
// a component cannot pull in Prisma or the Shopify server SDK. Billing logic
// that needs those lives in ./billing.server.ts and imports this file.

/**
 * The four tiers, and what each one actually unlocks.
 *
 * This is the ONLY source of truth for entitlements. Every gate in the app reads
 * a capability from here rather than comparing plan names, so adding a tier does
 * not mean hunting for `=== "pro"` checks scattered through the codebase.
 *
 * The boundary between Growth and Pro is a starting point, not a law: move a
 * capability between tiers by editing one line.
 */
export const PLAN_LIMITS = {
  free: {
    name: "Free",
    price: 0,
    productLimit: 100,
    analyticsDays: 7,
    merchandising: false,
    redirects: false,
    aiFeed: false,
    semantic: false,
  },
  growth: {
    name: "Growth",
    price: 21,
    productLimit: 5_000,
    analyticsDays: 30,
    merchandising: true,
    redirects: true,
    aiFeed: false,
    semantic: false,
  },
  pro: {
    name: "Pro",
    price: 49,
    productLimit: Infinity,
    analyticsDays: 90,
    merchandising: true,
    redirects: true,
    aiFeed: true,
    semantic: true,
  },
  custom: {
    name: "Custom",
    price: 70,
    productLimit: Infinity,
    // The only capability Custom adds over Pro that the code can enforce.
    // Everything else it sells (priority support, guided setup) happens
    // outside the app, so there is nothing here to gate on.
    analyticsDays: 365,
    merchandising: true,
    redirects: true,
    aiFeed: true,
    semantic: true,
  },
} as const;

export type PlanKey = keyof typeof PLAN_LIMITS;
export type PlanLimits = (typeof PLAN_LIMITS)[PlanKey];

/** Cheapest first. The order tiers are presented and compared in. */
export const PLAN_ORDER: PlanKey[] = ["free", "growth", "pro", "custom"];

export function isPlanKey(v: unknown): v is PlanKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(PLAN_LIMITS, v);
}

/** Capabilities for a stored plan name, for code paths with no billing context
 *  (the App Proxy, the search engine) that only have `Shop.planName`. */
export function limitsForPlanName(planName: string | null | undefined): PlanLimits {
  return isPlanKey(planName) ? PLAN_LIMITS[planName] : PLAN_LIMITS.free;
}
