// Who is allowed to change a shop's plan from inside the admin.
//
// This gate is not optional. The plan override grants paid tiers with no
// Shopify charge, so an unguarded field on the Plans page would let ANY
// merchant give themselves Pro for free — and would almost certainly be read as
// circumventing Shopify billing during App Store review.
//
// Set OPERATOR_SHOPS to a comma-separated list of myshopify domains that belong
// to you. Every other shop never sees the control, and the action refuses even
// if the request is forged.

function operatorShops(): Set<string> {
  return new Set(
    (process.env.OPERATOR_SHOPS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True when this shop domain is on the operator allowlist. */
export function isOperatorShop(shopDomain: string | null | undefined): boolean {
  if (!shopDomain) return false;
  const allow = operatorShops();
  // Empty allowlist means nobody, never everybody: an unset variable in
  // production must not silently open the control to every merchant.
  if (allow.size === 0) return false;
  return allow.has(shopDomain.trim().toLowerCase());
}
