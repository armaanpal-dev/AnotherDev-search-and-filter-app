// Unit tests for app/lib/plans.ts — reading a Shopify subscription name back
// into a tier.
//
// This is the join between the Partner Dashboard, where a human types each
// plan's Display name, and this app's plan table. It broke in production twice:
// a paying merchant kept seeing Free, and a merchant who downgraded to Free was
// read as Growth. Both were name comparisons that were stricter than reality.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleModule } from "./_bundle.mjs";

const { planKeyFromSubscriptionName, PLAN_LIMITS, PLAN_ORDER } = await bundleModule(
  "../app/lib/plans",
  "plans",
);

test("every tier's own display name resolves back to that tier", () => {
  // The table is the source of truth, so a tier added later is covered here
  // without anyone remembering to add a case.
  for (const key of PLAN_ORDER) {
    assert.equal(planKeyFromSubscriptionName(PLAN_LIMITS[key].name), key);
    assert.equal(planKeyFromSubscriptionName(key), key);
  }
});

test("display names as merchants' dashboards actually spell them", () => {
  // Nobody types the plan name into the dashboard exactly as the code spells
  // it. These are the shapes an exact comparison used to miss.
  assert.equal(planKeyFromSubscriptionName("Pro Plan"), "pro");
  assert.equal(planKeyFromSubscriptionName("pro"), "pro");
  assert.equal(planKeyFromSubscriptionName("PRO"), "pro");
  assert.equal(planKeyFromSubscriptionName("Pro (Annual)"), "pro");
  assert.equal(planKeyFromSubscriptionName("Growth plan - monthly"), "growth");
  assert.equal(planKeyFromSubscriptionName("  Custom  "), "custom");
});

test("the Free plan is recognised, not treated as an unknown paid plan", () => {
  // Under Shopify App Pricing, Free is a real subscription with a name. Reading
  // it as unrecognised upgraded a merchant who had just downgraded.
  assert.equal(planKeyFromSubscriptionName("Free"), "free");
  assert.equal(planKeyFromSubscriptionName("Free Plan"), "free");
});

test("a cheaper tier never swallows a more expensive one", () => {
  // Tiers are matched highest first for this reason.
  assert.equal(planKeyFromSubscriptionName("Pro"), "pro");
  assert.equal(planKeyFromSubscriptionName("Custom"), "custom");
  assert.notEqual(planKeyFromSubscriptionName("Pro"), "growth");
});

test("a name matching no tier returns null rather than guessing", () => {
  // Callers turn null into the entry tier, because an unrecognised
  // subscription still means the shop is paying for something. That decision
  // belongs to them, not here.
  assert.equal(planKeyFromSubscriptionName("Enterprise Annual"), null);
  assert.equal(planKeyFromSubscriptionName(""), null);
  assert.equal(planKeyFromSubscriptionName("   "), null);
  assert.equal(planKeyFromSubscriptionName("!!!"), null);
});
