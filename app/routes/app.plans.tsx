import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getPlanStatus, isTestBilling, BILLING_PLAN_BY_KEY } from "../lib/billing.server";
import { PLAN_LIMITS, PLAN_ORDER, isPlanKey, type PlanKey } from "../lib/plans";
import { semanticReady } from "../lib/search/embeddings.server";
import prisma from "../db.server";
import { invalidateShopConfig } from "../lib/search/config.server";
import { getShopByDomain } from "../lib/shop.server";
import { isOperatorShop } from "../lib/operator.server";
import { Stat, TILES, WIDE, useSaveToast } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  const status = await getPlanStatus(billing, shop?.planOverride);
  const productCount = shop ? await prisma.product.count({ where: { shopId: shop.id } }) : 0;

  // Shopify sends the merchant back here after the charge-approval screen. If
  // they return without an active payment they declined it (or it is still
  // pending) — say so, rather than silently rendering the same page again.
  const returned = new URL(request.url).searchParams.get("billing") === "return";

  // Only advertise semantic search when this deployment can actually run it:
  // it needs an embeddings provider key AND pgvector in Postgres.
  const semantic = await semanticReady();

  return {
    plan: status.plan,
    overridden: status.overridden,
    isOperator: isOperatorShop(session.shop),
    currentOverride: shop?.planOverride ?? "",
    productCount,
    declined: returned && !status.isPaid,
    semantic,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const isTest = isTestBilling();

  if (intent === "subscribe") {
    const target = String(form.get("plan") ?? "");
    const billingPlan = isPlanKey(target) ? BILLING_PLAN_BY_KEY[target] : undefined;
    if (!billingPlan) return { error: "Unknown plan." };
    // Redirects the merchant to Shopify's managed charge-approval screen. The
    // `billing=return` marker lets the loader tell "came back from approval and
    // still has no charge" (declined) apart from a plain visit to this page.
    await billing.request({
      plan: billingPlan as never,
      isTest,
      returnUrl: `https://admin.shopify.com/store/${session.shop.replace(".myshopify.com", "")}/apps/${process.env.SHOPIFY_API_KEY}/app/plans?billing=return`,
    });
  }

  if (intent === "override") {
    // Checked here as well as in the loader: hiding a control is not a
    // permission check, and this action can be POSTed directly.
    if (!isOperatorShop(session.shop)) {
      return { error: "Not permitted on this shop." };
    }
    const shop = await getShopByDomain(session.shop);
    if (!shop) return { error: "Shop not initialised." };

    const raw = String(form.get("planOverride") ?? "").trim().toLowerCase();
    if (raw === "" || raw === "clear") {
      await prisma.shop.update({
        where: { id: shop.id },
        data: { planOverride: null },
      });
      invalidateShopConfig(shop.id);
      return { overrideCleared: true };
    }
    if (!isPlanKey(raw)) {
      return { error: `"${raw}" is not a plan. Use ${PLAN_ORDER.join(", ")}, or clear.` };
    }
    // planName is written too so storefront gates, which read it without a
    // billing context, take effect immediately rather than on the next visit.
    await prisma.shop.update({
      where: { id: shop.id },
      data: { planOverride: raw, planName: raw },
    });
    invalidateShopConfig(shop.id);
    return { overrideSet: raw };
  }

  if (intent === "cancel") {
    const { appSubscriptions } = (await billing.check({
      plans: Object.values(BILLING_PLAN_BY_KEY) as never,
      isTest,
    })) as { appSubscriptions?: { id: string }[] };
    for (const sub of appSubscriptions ?? []) {
      await billing.cancel({ subscriptionId: sub.id, isTest, prorate: true });
    }
    return { cancelled: true };
  }

  return null;
};

/** What each tier includes, in the order a merchant reads them. */
const FEATURES: { label: string; on: (k: PlanKey) => boolean | string }[] = [
  {
    label: "Products indexed",
    on: (k) =>
      PLAN_LIMITS[k].productLimit === Infinity
        ? "Unlimited"
        : PLAN_LIMITS[k].productLimit.toLocaleString(),
  },
  { label: "Instant search and filters", on: () => true },
  { label: "Typo tolerance and synonyms", on: () => true },
  { label: "SKU and variant search", on: () => true },
  { label: "Voice search", on: () => true },
  { label: "Recommendation rails", on: () => true },
  { label: "Crawlable results page", on: () => true },
  { label: "Revenue attribution", on: () => true },
  { label: "Relevance tester", on: () => true },
  { label: "Analytics history", on: (k) => `${PLAN_LIMITS[k].analyticsDays} days` },
  { label: "Merchandising rules", on: (k) => PLAN_LIMITS[k].merchandising },
  { label: "Rule scheduling and A/B tests", on: (k) => PLAN_LIMITS[k].merchandising },
  { label: "Search redirects", on: (k) => PLAN_LIMITS[k].redirects },
  { label: "AI product feed", on: (k) => PLAN_LIMITS[k].aiFeed },
];

// Order comes from the plan table so a new tier appears here automatically.

export default function PlansPage() {
  const { plan, overridden, productCount, declined, semantic, isOperator, currentOverride } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  useSaveToast(fetcher, "Plan updated");
  const busy = fetcher.state !== "idle";
  const current = PLAN_LIMITS[plan];
  const overLimit = productCount > current.productLimit;

  // Only advertise what this deployment can actually run. A pricing table
  // listing a capability the server has no provider for is a promise the app
  // cannot keep.
  const features = semantic
    ? [
        ...FEATURES,
        { label: "Semantic search", on: (k: PlanKey) => PLAN_LIMITS[k].semantic },
        { label: "Search by photo", on: (k: PlanKey) => PLAN_LIMITS[k].semantic },
      ]
    : FEATURES;

  return (
    <s-page heading="Plans and pricing">
      {declined && (
        <s-banner tone="warning" heading="The charge was not approved">
          <s-paragraph>
            Nothing has been billed and your plan is unchanged. Start again
            whenever you are ready.
          </s-paragraph>
        </s-banner>
      )}

      {overLimit && (
        <s-banner tone="warning" heading="Your catalog is larger than this plan indexes">
          <s-paragraph>
            {productCount.toLocaleString()} products, and {current.name} indexes{" "}
            {current.productLimit.toLocaleString()}. The rest are not searchable.
          </s-paragraph>
        </s-banner>
      )}

      {overridden && (
        <s-banner tone="info" heading="This plan was set manually">
          <s-paragraph>
            {current.name} is active without a Shopify charge because an operator
            pinned it. Billing changes here will not take effect until the
            override is cleared.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Your usage">
        <s-grid gridTemplateColumns={TILES} gap="large-100">
          <Stat label="Current plan" value={current.name} />
          <Stat
            label="Products indexed"
            value={productCount.toLocaleString()}
            tone={overLimit ? "critical" : undefined}
            hint={overLimit ? "Over limit" : undefined}
          />
          <Stat
            label="Indexing limit"
            value={
              current.productLimit === Infinity
                ? "Unlimited"
                : current.productLimit.toLocaleString()
            }
          />
          <Stat label="Analytics history" value={`${current.analyticsDays} days`} />
        </s-grid>
      </s-section>

      <s-grid gridTemplateColumns={WIDE} gap="large-100">
        {PLAN_ORDER.map((key) => {
          const p = PLAN_LIMITS[key];
          const isCurrent = key === plan;
          return (
            <s-grid-item key={key}>
              <s-section heading={p.name}>
                <s-stack direction="block" gap="large-100">
                  <s-stack direction="inline" gap="small-500" alignItems="center">
                    <s-heading>{p.price === 0 ? "Free" : `$${p.price}`}</s-heading>
                    {p.price > 0 && <s-text color="subdued">per month</s-text>}
                    {isCurrent && <s-badge tone="success">Current</s-badge>}
                  </s-stack>

                  {isCurrent ? (
                    <s-button variant="secondary" disabled>
                      Current plan
                    </s-button>
                  ) : key === "free" ? (
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="cancel" />
                      <s-button
                        type="submit"
                        variant="secondary"
                        {...(busy ? { loading: true } : {})}
                      >
                        Downgrade to Free
                      </s-button>
                    </fetcher.Form>
                  ) : (
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="subscribe" />
                      <input type="hidden" name="plan" value={key} />
                      <s-button
                        type="submit"
                        variant="primary"
                        {...(busy ? { loading: true } : {})}
                      >
                        {plan === "free" ? "Start 14-day trial" : `Switch to ${p.name}`}
                      </s-button>
                    </fetcher.Form>
                  )}

                  <s-stack direction="block" gap="small-300">
                    {features.map((f) => {
                      const v = f.on(key);
                      if (v === false) return null;
                      return (
                        <s-stack
                          key={f.label}
                          direction="inline"
                          gap="small-500"
                          alignItems="center"
                        >
                          <s-badge tone="success">Yes</s-badge>
                          <s-text>
                            {f.label}
                            {typeof v === "string" ? `: ${v}` : ""}
                          </s-text>
                        </s-stack>
                      );
                    })}
                  </s-stack>
                </s-stack>
              </s-section>
            </s-grid-item>
          );
        })}
      </s-grid>

      {isOperator && (
        <s-section heading="Operator override">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Sets this shop&rsquo;s plan with no Shopify charge. Visible only on
              shops listed in OPERATOR_SHOPS. Leave the field empty, or type
              clear, to hand control back to billing.
            </s-text>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="override" />
              <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
                <s-select
                  name="planOverride"
                  label="Plan"
                  value={currentOverride || "clear"}
                >
                  <s-option value="clear">No override, use billing</s-option>
                  {PLAN_ORDER.map((k) => (
                    <s-option key={k} value={k}>
                      {PLAN_LIMITS[k].name}
                    </s-option>
                  ))}
                </s-select>
                <s-button
                  type="submit"
                  variant="primary"
                  {...(busy ? { loading: true } : {})}
                >
                  Apply
                </s-button>
              </s-grid>
            </fetcher.Form>
            {fetcher.data?.error && (
              <s-text tone="critical">{fetcher.data.error}</s-text>
            )}
            {fetcher.data?.overrideSet && (
              <s-text tone="success">
                Pinned to {PLAN_LIMITS[fetcher.data.overrideSet as PlanKey].name}.
              </s-text>
            )}
            {fetcher.data?.overrideCleared && (
              <s-text tone="success">Override cleared. Billing decides again.</s-text>
            )}
            <s-text color="subdued">
              The same thing from a terminal: npm run plan &lt;domain&gt; &lt;plan&gt;
            </s-text>
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="Billing">
        <s-paragraph>
          <s-text color="subdued">
            Charges are handled by Shopify and appear on your normal Shopify
            invoice. Every paid plan starts with a 14-day trial. Cancelling is
            immediate and prorated, and your index stays in place, capped back to
            the Free limit.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
