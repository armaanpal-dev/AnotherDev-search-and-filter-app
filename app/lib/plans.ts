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
    prioritySupport: false,
    dedicatedContact: false,
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
    prioritySupport: false,
    dedicatedContact: false,
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
    prioritySupport: false,
    dedicatedContact: false,
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
    // Not code-enforced: a support commitment, listed so the pricing
    // page and the App Store listing say the same thing.
    prioritySupport: true,
    dedicatedContact: true,
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

/** Lowercase, letters and digits only, so "Pro Plan" and "pro" compare equal. */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Which tier a Shopify subscription name means.
 *
 * Matching cannot be a strict equality test against this table. Under Shopify
 * App Pricing the subscription is named after the plan's Display name in the
 * Partner Dashboard, which is edited by a human and drifts: "Pro", "Pro Plan"
 * and "Pro (Annual)" are all the Pro tier, and an exact comparison reads every
 * one of them as an unknown plan — which is how a merchant who had just paid
 * kept seeing Free.
 *
 * Tiers are tried highest first so a looser rule on a cheaper tier can never
 * swallow a more expensive one. Returns null for a name that resembles no tier
 * at all, which callers treat as "paying for something", never as Free.
 */
export function planKeyFromSubscriptionName(name: string): PlanKey | null {
  const n = normalizeName(name);
  if (!n) return null;
  for (const key of [...PLAN_ORDER].reverse()) {
    const display = normalizeName(PLAN_LIMITS[key].name);
    if (n === key || n === display || n.startsWith(display) || n.startsWith(key)) {
      return key;
    }
  }
  return null;
}
