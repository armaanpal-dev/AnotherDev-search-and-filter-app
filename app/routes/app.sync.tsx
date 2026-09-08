import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useSaveToast } from "../components/ui";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { runFullSync, isSyncRunning } from "../lib/sync/bulk.server";
import { getPlanStatus } from "../lib/billing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const [syncState, productCount] = await Promise.all([
    prisma.syncState.findUnique({ where: { shopId: shop.id } }),
    prisma.product.count({ where: { shopId: shop.id } }),
  ]);
  return {
    status: syncState?.status ?? "idle",
    phase: syncState?.phase ?? "idle",
    message: syncState?.message ?? "Not yet synced",
    lastSyncAt: syncState?.lastSyncAt?.toISOString() ?? null,
    progressCurrent: syncState?.progressCurrent ?? 0,
    progressTotal: syncState?.progressTotal ?? 0,
    productCount,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin, billing } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const { limits } = await getPlanStatus(billing, shop.planOverride);

  // Double-clicking the button used to start a second sync that fought the first
  // for the same rows. `runFullSync` refuses when a live run exists, but check
  // here too so the UI can say so instead of silently doing nothing.
  if (await isSyncRunning(shop.id)) {
    return { started: false, alreadyRunning: true };
  }

  // Kick the sync off in the background; the page polls SyncState for progress.
  runFullSync(shop.id, admin as any, {
    productLimit: limits.productLimit === Infinity ? undefined : limits.productLimit,
  }).catch((e) => {
    console.error("Full sync failed:", e);
  });

  // ok drives the app-wide save toast. The alreadyRunning branch deliberately
  // does not set it: that path already has its own banner, and a "Sync started"
  // toast would be a lie.
  return { started: true, alreadyRunning: false, ok: true };
};

function phaseTitle(phase: string, active: boolean): string {
  if (phase === "exporting") return "Exporting from Shopify";
  if (phase === "indexing") return "Building your search index";
  if (phase === "done") return "Index up to date";
  if (phase === "error") return "Sync failed";
  return active ? "Starting" : "Ready to sync";
}

export default function SyncPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  useSaveToast(fetcher, "Sync started");
  const revalidator = useRevalidator();

  const running = data.status === "running";
  const starting = fetcher.state !== "idle";
  const active = running || starting;

  // While a sync is running, poll for updated status so the counts move.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => revalidator.revalidate(), 1000);
    return () => clearInterval(id);
  }, [active, revalidator]);

  const { progressCurrent, progressTotal, phase } = data;
  const indexing = phase === "indexing" && progressTotal > 0;
  const pct = indexing ? Math.min(100, Math.round((progressCurrent / progressTotal) * 100)) : 0;
  const left = indexing ? Math.max(0, progressTotal - progressCurrent) : 0;
  const isError = phase === "error";

  return (
    <s-page heading="Search index">
      <s-button
        slot="primary-action"
        variant="primary"
        {...(active ? { loading: true } : {})}
        onClick={() => fetcher.submit({}, { method: "POST" })}
      >
        {data.productCount ? "Re-sync catalog" : "Run first sync"}
      </s-button>

      {isError && !active && (
        <s-banner tone="critical" heading="The last sync did not finish">
          <s-paragraph>{data.message}</s-paragraph>
          <s-paragraph>
            Your previously indexed products are still searchable. Running the
            sync again is safe and picks up where the catalog stands now.
          </s-paragraph>
        </s-banner>
      )}

      {fetcher.data?.alreadyRunning && (
        <s-banner tone="info" heading="A sync is already running">
          <s-paragraph>
            Progress is shown below. Starting a second sync would only slow this
            one down.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Status">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            {active && <s-spinner size="base" accessibilityLabel="Sync in progress" />}
            <s-text type="strong">{phaseTitle(phase, active)}</s-text>
            {!active && phase === "done" && <s-badge tone="success">Up to date</s-badge>}
            {!active && isError && <s-badge tone="critical">Failed</s-badge>}
            {!active && phase === "idle" && <s-badge>Not synced</s-badge>}
          </s-stack>

          <s-text color="subdued">{data.message}</s-text>

          {active && indexing && (
            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
              <Metric
                label="Indexed"
                value={`${progressCurrent.toLocaleString()} of ${progressTotal.toLocaleString()}`}
              />
              <Metric label="Remaining" value={left.toLocaleString()} />
              <Metric label="Progress" value={`${pct}%`} />
            </s-grid>
          )}

          {!active && (
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <Metric label="Products indexed" value={data.productCount.toLocaleString()} />
              <Metric
                label="Last synced"
                value={data.lastSyncAt ? new Date(data.lastSyncAt).toLocaleString() : "Never"}
              />
            </s-grid>
          )}
        </s-stack>
      </s-section>

      <s-section heading="How indexing works">
        <s-paragraph>
          A sync pulls your entire catalog through Shopify&rsquo;s Bulk
          Operations API and builds the full-text and typo-tolerant search index.
          Only products published to the Online Store are indexed, so search
          results never link to a page a shopper cannot open.
        </s-paragraph>
        <s-paragraph>
          After the first sync, product changes stay current automatically
          through webhooks. Re-sync manually only if you suspect the index has
          drifted, or after changing your plan.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Next steps">
        <s-paragraph>
          <s-text color="subdued">
            Once products are indexed, tune relevance in{" "}
            <s-link href="/app/filters">Filters</s-link> and{" "}
            <s-link href="/app/synonyms">Synonyms</s-link>, then check{" "}
            <s-link href="/app/analytics">Analytics</s-link> for searches that
            returned nothing.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
