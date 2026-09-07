import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getSearchEngine } from "../lib/search/index.server";
import { PostgresSearchEngine } from "../lib/search/postgres.server";
import { embedImage, imageSearchReady } from "../lib/search/embeddings.server";
import { limitsForPlanName } from "../lib/plans";
import { jsonCors, loadProxyShop, clientKey } from "../lib/proxy.server";
import { RateLimiter } from "../lib/cache.server";

/**
 * POST apps/anotherdev-search/visual   { image: "<base64>", collection?, limit? }
 *
 * Search by photo. A shopper points their camera at something and gets the
 * nearest products in the catalog — the one query a keyword index can never
 * answer, and the reason someone leaves a store without buying the thing they
 * came for.
 *
 * Works by embedding the photo into the SAME vector space the product rows
 * already live in (see embeddings.server.ts), so it is a nearest-neighbour
 * lookup against the existing index rather than a second system.
 */

// Every request here is a paid call to an embeddings provider and a decode of
// attacker-supplied bytes, so the budget is much tighter than /track's.
const limiter = new RateLimiter(12, 60_000);

// Roughly 1.5 MB of base64, i.e. about a 1.1 MB image. Above this the shopper is
// uploading a photo far larger than the model will use anyway, and the storefront
// downscales before sending.
const MAX_BASE64 = 1_500_000;

// What the model will actually accept, and what a phone camera produces.
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return jsonCors({ error: "unauthorized" }, 401);

  if (!limiter.allow(clientKey(request, session.shop))) {
    return jsonCors({ error: "rate_limited" }, 429);
  }

  const shop = await loadProxyShop(session.shop);
  if (!shop) return jsonCors({ error: "shop_not_initialized" }, 404);

  // Same gate as the rest of semantic search: a Pro capability, a configured
  // provider, and the pgvector column. Anything missing is reported honestly so
  // the storefront can hide the camera button rather than offer a dead one.
  if (!limitsForPlanName(shop.planName).semantic) {
    return jsonCors(
      { error: "upgrade_required", message: "Image search requires the Pro plan." },
      402,
    );
  }
  if (!(await imageSearchReady())) {
    return jsonCors({ error: "unavailable", products: [] }, 503);
  }

  let payload: { image?: unknown; collection?: unknown; limit?: unknown };
  try {
    payload = await request.json();
  } catch {
    return jsonCors({ error: "bad_request" }, 400);
  }

  const raw = typeof payload.image === "string" ? payload.image : "";
  if (!raw) return jsonCors({ error: "no_image" }, 400);
  if (raw.length > MAX_BASE64) return jsonCors({ error: "image_too_large" }, 413);

  // Accept a data URL or bare base64, and verify the declared type — the value
  // is forwarded to a third-party API, so it must not be whatever the caller
  // felt like sending.
  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(raw);
  const mime = match ? match[1].toLowerCase() : "image/jpeg";
  const body = match ? match[2] : raw;
  if (!ALLOWED_MIME.has(mime)) return jsonCors({ error: "unsupported_type" }, 415);
  if (!/^[A-Za-z0-9+/=\s]+$/.test(body)) return jsonCors({ error: "bad_request" }, 400);

  const vector = await embedImage(`data:${mime};base64,${body.replace(/\s+/g, "")}`);
  // A provider hiccup is not the shopper's problem: an empty list lets the
  // storefront say "nothing matched" instead of showing an error.
  if (!vector) return jsonCors({ products: [], strategy: "semantic" });

  const limit = Math.min(
    24,
    Math.max(1, parseInt(String(payload.limit ?? "12"), 10) || 12),
  );
  const collection =
    typeof payload.collection === "string" ? payload.collection.slice(0, 200) : undefined;

  const engine = getSearchEngine();
  // The vector path is Postgres-specific, so it is not part of the SearchEngine
  // contract. A different backend would answer this endpoint its own way.
  if (!(engine instanceof PostgresSearchEngine)) {
    return jsonCors({ products: [], strategy: "semantic" });
  }

  const products = await engine.searchByVector(shop.shopId, vector, {
    limit,
    includeUnavailable: shop.settings.showOutOfStock,
    collection: collection || undefined,
  });

  return jsonCors(
    { products, strategy: "semantic", total: products.length },
    200,
    // A shopper's own photo. Never cached anywhere but their browser.
    { "Cache-Control": "no-store" },
  );
}

/** Lets the storefront ask whether to render the camera button at all. */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return jsonCors({ available: false }, 401);
  const shop = await loadProxyShop(session.shop);
  const available =
    !!shop && limitsForPlanName(shop.planName).semantic && (await imageSearchReady());
  return jsonCors({ available });
}
