import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getPlanStatus, planSelectionUrl } from "../lib/billing.server";
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

  // Shown when the merchant comes back from the charge-approval screen without
  // an active payment, which means they declined it (or it is still pending).
  // It relies on each plan's Welcome link in the Partner Dashboard pointing at
  // /app/plans?billing=return; without that the merchant simply lands back on
  // the app home, which is harmless — this banner just never appears.
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
    // Every plan change — up or down — happens on Shopify's hosted plan page,
    // the only supported way to charge under Shopify App Pricing. See
    // planSelectionUrl() for why creating the charge here instead cannot work.
    planPageUrl: planSelectionUrl(session.shop),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

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
  { label: "Priority support", on: (k) => PLAN_LIMITS[k].prioritySupport },
  { label: "Dedicated point of contact", on: (k) => PLAN_LIMITS[k].dedicatedContact },
];

// Order comes from the plan table so a new tier appears here automatically.

export default function PlansPage() {
  const {
    plan,
    overridden,
    productCount,
    declined,
    semantic,
    isOperator,
    currentOverride,
    planPageUrl,
  } = useLoaderData<typeof loader>();
  // Only the operator override posts back to this route now; plan changes are
  // links to Shopify's own page.
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
                  ) : (
                    /* A plain link, opened at the top level, rather than a form
                       that posts back here first.
                       Shopify's plan page lives outside this app's iframe, so
                       the browser refuses to navigate to it from inside the
                       frame — target="_top" is what makes the click land. Going
                       straight there also means no server round-trip that can
                       fail without the merchant seeing anything, which is how
                       the old billing.request() button ended up doing nothing.
                       Trial length is deliberately not named on the button: it
                       is set per plan in the Partner Dashboard, and a number
                       hard-coded here becomes a promise the app cannot keep. */
                    <s-button
                      href={planPageUrl}
                      target="_top"
                      variant={key === "free" ? "secondary" : "primary"}
                    >
                      {key === "free" ? "Downgrade to Free" : `Choose ${p.name}`}
                    </s-button>
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
            Choosing a plan takes you to Shopify&rsquo;s plan page, where you
            approve or decline the charge. Prices, free trials and billing
            frequency are shown there, and charges appear on your normal Shopify
            invoice. Downgrading keeps your index in place, capped back to the
            Free limit.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
