import { useEffect } from "react";
import type { CSSProperties } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { runFullSync } from "../lib/sync/bulk.server";
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
  const { limits } = await getPlanStatus(billing);

  // Kick the sync off in the background; the page polls SyncState for progress.
  runFullSync(shop.id, admin as any, {
    productLimit: limits.productLimit === Infinity ? undefined : limits.productLimit,
  }).catch((e) => {
    console.error("Full sync failed:", e);
  });

  return { started: true };
};

export default function SyncPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();

  const running = data.status === "running";
  const starting = fetcher.state !== "idle";
  const active = running || starting;

  // While a sync is running, poll for updated status frequently for a smooth bar.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => revalidator.revalidate(), 1000);
    return () => clearInterval(id);
  }, [active, revalidator]);

  const { progressCurrent, progressTotal, phase } = data;
  const indexing = phase === "indexing" && progressTotal > 0;
  const pct = indexing ? Math.min(100, Math.round((progressCurrent / progressTotal) * 100)) : 0;
  const left = indexing ? Math.max(0, progressTotal - progressCurrent) : 0;
  const isDone = phase === "done";
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

      <s-section heading="Sync status">
        {/* Animated sync panel */}
        <div style={panelStyle(isError)}>
          <style>{KEYFRAMES}</style>

          {/* Phase row */}
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
            <SyncIcon active={active && !isDone} done={isDone} error={isError} />
            <div>
              <div style={{ fontWeight: 600, fontSize: "1rem" }}>{phaseTitle(phase, active)}</div>
              <div style={{ color: "#6b7280", fontSize: "0.875rem" }}>{data.message}</div>
            </div>
          </div>

          {/* Progress bar */}
          {active && (
            <div style={{ marginTop: "0.5rem" }}>
              <div style={barTrackStyle}>
                {indexing ? (
                  <div style={{ ...barFillStyle, width: `${pct}%` }} />
                ) : (
                  // Export phase: total unknown → indeterminate shimmer bar.
                  <div style={barIndeterminateStyle} />
                )}
              </div>

              {indexing && (
                <div style={countsRowStyle}>
                  <span>
                    <strong style={{ color: "#111827", fontSize: "1.15rem" }}>
                      {progressCurrent.toLocaleString()}
                    </strong>{" "}
                    <span style={{ color: "#6b7280" }}>of {progressTotal.toLocaleString()} synced</span>
                  </span>
                  <span style={{ color: "#6b7280" }}>{left.toLocaleString()} left</span>
                  <span style={{ fontWeight: 600, color: "#111827" }}>{pct}%</span>
                </div>
              )}
            </div>
          )}

          {/* Idle / done summary */}
          {!active && (
            <div style={countsRowStyle}>
              <span>
                <strong style={{ color: "#111827", fontSize: "1.15rem" }}>
                  {data.productCount.toLocaleString()}
                </strong>{" "}
                <span style={{ color: "#6b7280" }}>products indexed</span>
              </span>
              {data.lastSyncAt && (
                <span style={{ color: "#6b7280" }}>
                  Last synced {new Date(data.lastSyncAt).toLocaleString()}
                </span>
              )}
            </div>
          )}
        </div>
      </s-section>

      <s-section heading="How indexing works">
        <s-paragraph>
          A sync pulls your entire catalog via Shopify’s Bulk Operations API and builds
          the full-text + fuzzy search index. After the first sync, product changes are
          kept up to date automatically through webhooks — you only need to re-sync
          manually if you suspect drift.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Next">
        <s-paragraph>
          Once products are indexed, add the storefront blocks in your theme editor and
          try a search. Configure <s-link href="/app/filters">filters</s-link> and{" "}
          <s-link href="/app/synonyms">synonyms</s-link> to refine relevance.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

/* ---------- presentational bits (inline styles keep it theme-agnostic) ---------- */

function phaseTitle(phase: string, active: boolean): string {
  if (phase === "exporting") return "Exporting from Shopify…";
  if (phase === "indexing") return "Building your search index…";
  if (phase === "done") return "Index up to date";
  if (phase === "error") return "Sync failed";
  return active ? "Starting…" : "Ready to sync";
}

function SyncIcon({ active, done, error }: { active: boolean; done: boolean; error: boolean }) {
  const color = error ? "#dc2626" : done ? "#059669" : "#4f46e5";
  return (
    <div
      style={{
        width: 40, height: 40, borderRadius: "50%", flex: "none",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: error ? "#fee2e2" : done ? "#d1fae5" : "#eef2ff",
      }}
    >
      {done ? (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M5 12.5l4 4 10-10" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : error ? (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M12 7v6M12 16.5v.5" stroke={color} strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          style={{ animation: active ? "adsf-spin 0.9s linear infinite" : "none" }}>
          <path d="M12 3a9 9 0 1 0 9 9" stroke={color} strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      )}
    </div>
  );
}

const KEYFRAMES = `
@keyframes adsf-spin { to { transform: rotate(360deg); } }
@keyframes adsf-shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
`;

function panelStyle(error: boolean): CSSProperties {
  return {
    border: `1px solid ${error ? "#fecaca" : "#e5e7eb"}`,
    borderRadius: 12,
    padding: "1.25rem",
    background: "#fff",
  };
}

const barTrackStyle: CSSProperties = {
  position: "relative",
  height: 12,
  borderRadius: 999,
  background: "#eef2ff",
  overflow: "hidden",
};

const barFillStyle: CSSProperties = {
  height: "100%",
  borderRadius: 999,
  background: "linear-gradient(90deg,#6366f1,#4f46e5)",
  transition: "width 0.6s cubic-bezier(0.4,0,0.2,1)",
};

const barIndeterminateStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  height: "100%",
  width: "30%",
  borderRadius: 999,
  background: "linear-gradient(90deg,rgba(99,102,241,0.2),#4f46e5,rgba(99,102,241,0.2))",
  animation: "adsf-shimmer 1.2s ease-in-out infinite",
};

const countsRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "1rem",
  marginTop: "0.85rem",
  fontSize: "0.9rem",
  flexWrap: "wrap",
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
