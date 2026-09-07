import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { runFullSync, isSyncRunning } from "../lib/sync/bulk.server";
import { limitsForPlanName } from "../lib/plans";

/**
 * Nightly catalog reconciliation.
 *
 * Webhooks keep the index close to live, but they are not a guarantee: a
 * delivery can be dropped, a bulk edit through the API can fire hundreds at once
 * and be throttled, and `collections/update` on a very large collection
 * deliberately defers its removals (see reconcileCollectionMembership). Every
 * one of those leaves the index quietly wrong, and no merchant is going to open
 * the app and press Re-sync on the off chance.
 *
 * Called by whatever scheduler the host provides — Fly machines with a schedule,
 * a Railway cron, a GitHub Actions workflow, anything that can issue one HTTP
 * request a day:
 *
 *   curl -X POST https://<app>/cron/sync -H "Authorization: Bearer $CRON_SECRET"
 *
 * Authorised by a shared secret rather than a Shopify session, because there is
 * no merchant in the loop. With CRON_SECRET unset the endpoint refuses every
 * request: an unset variable in production must never mean "open to anyone".
 */

// A shop is due once its last automatic run is this old. Slightly under 24h so a
// scheduler that fires at a fixed time each day never skips a shop for being a
// few minutes early.
const DUE_AFTER_MS = 23 * 60 * 60 * 1000;

// How many shops one invocation will start. A single machine syncing every shop
// it owns at once would fight itself for the database; the next run picks up
// where this one stopped, because the ones it did are no longer due.
const MAX_PER_RUN = Number(process.env.CRON_SYNC_BATCH ?? 5);

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  // Length check first so the comparison below cannot leak the length, then a
  // constant-time-ish comparison. Node's timingSafeEqual would need equal-length
  // buffers anyway, which is what the guard establishes.
  if (bearer.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) {
    diff |= bearer.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return diff === 0;
}

async function run(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const due = new Date(Date.now() - DUE_AFTER_MS);
  const shops = await prisma.shop.findMany({
    where: {
      // Never touch a shop that has removed the app: its token is gone and the
      // Admin call would only produce noise in the logs.
      uninstalledAt: null,
      autoSyncEnabled: true,
      OR: [{ lastAutoSyncAt: null }, { lastAutoSyncAt: { lt: due } }],
    },
    orderBy: { lastAutoSyncAt: { sort: "asc", nulls: "first" } },
    take: MAX_PER_RUN,
    select: { id: true, domain: true, planName: true, planOverride: true },
  });

  const started: string[] = [];
  const skipped: { domain: string; reason: string }[] = [];

  for (const shop of shops) {
    if (await isSyncRunning(shop.id)) {
      skipped.push({ domain: shop.domain, reason: "already running" });
      continue;
    }
    try {
      const { admin } = await unauthenticated.admin(shop.domain);

      // No billing context outside a merchant request, so the plan comes from
      // the columns the admin visit and the subscriptions webhook keep current.
      // An operator override outranks billing everywhere else, so it does here.
      const limits = limitsForPlanName(shop.planOverride ?? shop.planName);

      // Stamped BEFORE the run, not after: a sync that crashes half way must
      // not make this shop due again on the very next tick and loop forever.
      await prisma.shop.update({
        where: { id: shop.id },
        data: { lastAutoSyncAt: new Date() },
      });

      // Deliberately not awaited. A catalog sync takes minutes and the
      // scheduler's request should not hold open for it; SyncState is where
      // progress and failure are recorded, and the stale-heartbeat check
      // recovers a run the process did not survive.
      void runFullSync(shop.id, admin as never, {
        productLimit:
          limits.productLimit === Infinity ? undefined : limits.productLimit,
      }).catch((e) => {
        console.error(`[cron] sync failed for ${shop.domain}:`, e?.message);
      });

      started.push(shop.domain);
    } catch (e: unknown) {
      // A revoked token is the usual cause. One bad shop must not stop the rest.
      const message = e instanceof Error ? e.message : String(e);
      skipped.push({ domain: shop.domain, reason: message.slice(0, 200) });
    }
  }

  return new Response(
    JSON.stringify({ ok: true, started, skipped, checked: shops.length }),
    { headers: { "Content-Type": "application/json" } },
  );
}

export async function action({ request }: ActionFunctionArgs) {
  return run(request);
}

// GET as well, because plenty of schedulers can only issue one. Still requires
// the secret, so it is not a side effect anyone can trigger by browsing.
export async function loader({ request }: LoaderFunctionArgs) {
  return run(request);
}
