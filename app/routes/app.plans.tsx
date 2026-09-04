import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, PRO_PLAN } from "../shopify.server";
import { getPlanStatus, PLAN_LIMITS, isTestBilling } from "../lib/billing.server";
import { semanticReady } from "../lib/search/embeddings.server";
import prisma from "../db.server";
import { getShopByDomain } from "../lib/shop.server";
import { Stat, TILES, WIDE } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const status = await getPlanStatus(billing);
  const shop = await getShopByDomain(session.shop);
  const productCount = shop ? await prisma.product.count({ where: { shopId: shop.id } }) : 0;

  // Shopify sends the merchant back here after the charge-approval screen. If
  // they return without an active payment they declined it (or it is still
  // pending) — say so, rather than silently rendering the Free plan again.
  const returned = new URL(request.url).searchParams.get("billing") === "return";

  // Only advertise the semantic features when this deployment can actually run
  // them: they need an embeddings provider key AND pgvector in Postgres.
  const semantic = await semanticReady();

  return {
    isPro: status.isPro,
    productCount,
    freeLimit: PLAN_LIMITS.free.productLimit,
    declined: returned && !status.isPro,
    semantic,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const isTest = isTestBilling();

  if (intent === "upgrade") {
    // Redirects the merchant to Shopify's managed charge-approval screen. The
    // `billing=return` marker lets the loader tell "came back from approval and
    // still has no charge" (declined) apart from a plain visit to this page.
    await billing.request({
      plan: PRO_PLAN,
      isTest,
      returnUrl: `https://admin.shopify.com/store/${session.shop.replace(".myshopify.com", "")}/apps/${process.env.SHOPIFY_API_KEY}/app/plans?billing=return`,
    });
  }

  if (intent === "downgrade") {
    const { appSubscriptions } = await billing.check({ plans: [PRO_PLAN], isTest }) as any;
    // Cancel any active Pro subscription.
    const subs = appSubscriptions ?? [];
    for (const sub of subs) {
      await billing.cancel({ subscriptionId: sub.id, isTest, prorate: true });
    }
    return { downgraded: true };
  }
  return null;
};

const FREE_FEATURES = [
  "Up to 100 products indexed",
  "Instant search-as-you-type",
  "Typo tolerance & synonyms",
  "Faceted filters (price, brand, type, color, size)",
  "Basic analytics (7 days)",
  "SKU and variant search",
  "Product recommendation rails",
];
// Always true of Pro, on every deployment.
const PRO_FEATURES = [
  "Unlimited products",
  "Everything in Free, plus:",
  "Merchandising rules (pin / boost / hide)",
  "Search redirects",
  "Full analytics (90 days) + add-to-cart attribution",
  "AI feed for shopping agents (AIO)",
  "Rule-based merchandising (boost anything tagged X)",
  "Priority catalog sync",
];

// Listed only when this deployment can actually deliver them — semantic search
// needs an embeddings provider key and pgvector. Advertising a feature that is
// switched off would be selling something the merchant cannot get.
const PRO_SEMANTIC_FEATURES = [
  "Semantic search — understands meaning, not just keywords",
];

export default function PlansPage() {
  const { isPro, productCount, freeLimit, declined, semantic } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const overFreeLimit = productCount > freeLimit;
  const proFeatures = semantic
    ? [...PRO_FEATURES, ...PRO_SEMANTIC_FEATURES]
    : PRO_FEATURES;

  return (
    <s-page heading="Plans and pricing">
      {declined && (
        <s-banner tone="warning" heading="The charge was not approved">
          <s-paragraph>
            You are still on Free and nothing has been billed. Start the trial
            again whenever you are ready.
          </s-paragraph>
        </s-banner>
      )}

      {overFreeLimit && !isPro && (
        <s-banner tone="warning" heading="Your catalog is larger than Free indexes">
          <s-paragraph>
            {productCount.toLocaleString()} products, and Free indexes{" "}
            {freeLimit.toLocaleString()}. The rest are not searchable.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Your usage">
        <s-grid gridTemplateColumns={TILES} gap="base">
          <Stat label="Current plan" value={isPro ? "Pro" : "Free"} />
          <Stat
            label="Products indexed"
            value={productCount.toLocaleString()}
            tone={overFreeLimit && !isPro ? "critical" : undefined}
            hint={overFreeLimit && !isPro ? "Over limit" : undefined}
          />
          <Stat
            label="Indexing limit"
            value={isPro ? "Unlimited" : freeLimit.toLocaleString()}
          />
        </s-grid>
      </s-section>

      <s-grid gridTemplateColumns={WIDE} gap="base">
        <s-grid-item>
          <s-section heading="Free">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="small-500" alignItems="center">
                <s-heading>$0</s-heading>
                <s-text color="subdued">per month</s-text>
                {!isPro && <s-badge tone="success">Current</s-badge>}
              </s-stack>
              {isPro && (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="downgrade" />
                  <s-button type="submit" variant="tertiary" {...(busy ? { loading: true } : {})}>
                    Downgrade to Free
                  </s-button>
                </fetcher.Form>
              )}
              <s-unordered-list>
                {FREE_FEATURES.map((f) => (
                  <s-list-item key={f}>{f}</s-list-item>
                ))}
              </s-unordered-list>
            </s-stack>
          </s-section>
        </s-grid-item>

        <s-grid-item>
          <s-section heading="Pro">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="small-500" alignItems="center">
                <s-heading>$9.99</s-heading>
                <s-text color="subdued">per month</s-text>
                {isPro ? (
                  <s-badge tone="success">Current</s-badge>
                ) : (
                  <s-badge tone="info">14-day trial</s-badge>
                )}
              </s-stack>
              {!isPro && (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="upgrade" />
                  <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
                    Start free trial
                  </s-button>
                </fetcher.Form>
              )}
              <s-unordered-list>
                {proFeatures.map((f) => (
                  <s-list-item key={f}>{f}</s-list-item>
                ))}
              </s-unordered-list>
            </s-stack>
          </s-section>
        </s-grid-item>
      </s-grid>

      <s-section slot="aside" heading="Billing">
        <s-paragraph>
          <s-text color="subdued">
            Charges are handled by Shopify and appear on your normal Shopify
            invoice. Cancelling is immediate and prorated, and your index stays
            in place, capped back to the Free limit.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
