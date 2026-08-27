import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, PRO_PLAN } from "../shopify.server";
import { getPlanStatus, PLAN_LIMITS } from "../lib/billing.server";
import prisma from "../db.server";
import { getShopByDomain } from "../lib/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const status = await getPlanStatus(billing);
  const shop = await getShopByDomain(session.shop);
  const productCount = shop ? await prisma.product.count({ where: { shopId: shop.id } }) : 0;
  return { isPro: status.isPro, productCount, freeLimit: PLAN_LIMITS.free.productLimit };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const isTest = process.env.NODE_ENV !== "production";

  if (intent === "upgrade") {
    // Redirects the merchant to Shopify's managed charge-approval screen.
    await billing.request({
      plan: PRO_PLAN,
      isTest,
      returnUrl: `https://admin.shopify.com/store/${session.shop.replace(".myshopify.com", "")}/apps/${process.env.SHOPIFY_API_KEY}/app/plans`,
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
];
const PRO_FEATURES = [
  "Unlimited products",
  "Everything in Free, plus:",
  "Merchandising rules (pin / boost / hide)",
  "Search redirects",
  "Full analytics (90 days) + conversion tracking",
  "AI feed for shopping agents (AIO)",
  "Priority catalog sync",
];

export default function PlansPage() {
  const { isPro, productCount, freeLimit } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const overFreeLimit = productCount > freeLimit;

  return (
    <s-page heading="Plans & pricing">
      {overFreeLimit && !isPro && (
        <s-banner tone="warning" heading="You're over the Free plan limit">
          <s-paragraph>
            You have {productCount} products but Free indexes up to {freeLimit}.
            Upgrade to Pro to index your whole catalog.
          </s-paragraph>
        </s-banner>
      )}

      <s-stack direction="inline" gap="large">
        {/* Free */}
        <s-box padding="large" borderWidth="base" borderRadius="base" minInlineSize="300px">
          <s-stack direction="block" gap="base">
            <s-heading>Free</s-heading>
            <s-text type="strong">$0/month</s-text>
            {!isPro ? (
              <s-badge tone="success">Current plan</s-badge>
            ) : (
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
        </s-box>

        {/* Pro */}
        <s-box padding="large" borderWidth="base" borderRadius="base" minInlineSize="300px" background="subdued">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-heading>Pro</s-heading>
              <s-badge tone="info">14-day free trial</s-badge>
            </s-stack>
            <s-text type="strong">$9.99/month</s-text>
            {isPro ? (
              <s-badge tone="success">Current plan</s-badge>
            ) : (
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="upgrade" />
                <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
                  Start free trial
                </s-button>
              </fetcher.Form>
            )}
            <s-unordered-list>
              {PRO_FEATURES.map((f) => (
                <s-list-item key={f}>{f}</s-list-item>
              ))}
            </s-unordered-list>
          </s-stack>
        </s-box>
      </s-stack>

      <s-section slot="aside" heading="Why Pro?">
        <s-paragraph>
          <s-text color="subdued">
            Pro pays for itself the moment search-driven conversions rise. You get
            merchandising control, unlimited catalog size, and the AI feed that puts
            your products in front of AI shopping assistants — all for less than most
            competitors charge for their entry tier.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
