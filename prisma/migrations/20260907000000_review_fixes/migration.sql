-- Review follow-up: missing hot-path indexes, per-shop stemming, rule
-- scheduling and A/B buckets, purchase attribution, filter presets, and the
-- attribute cache that keeps the admin off full table scans.
--
-- Every statement is IF NOT EXISTS / IF EXISTS so re-running is a no-op.

-- 1. Per-shop search configuration + scheduled reconciliation -----------------
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "searchLanguage" TEXT NOT NULL DEFAULT 'simple';
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "autoSyncEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "lastAutoSyncAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "onboardedAt" TIMESTAMP(3);

-- 2. Product: the config its searchVector was generated with -----------------
-- Mirrored from Shop.searchLanguage. It has to live on the row because
-- searchVector is a STORED generated column, whose inputs must be immutable.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "tsConfig" TEXT NOT NULL DEFAULT 'simple';

-- Browse ordering. `popularity DESC` / `publishedAt DESC` with no text
-- predicate to narrow the set was sorting the whole catalog per request.
CREATE INDEX IF NOT EXISTS "Product_shopId_popularity_idx" ON "Product"("shopId", "popularity");
CREATE INDEX IF NOT EXISTS "Product_shopId_publishedAt_idx" ON "Product"("shopId", "publishedAt");

-- 3. Merchandising: scheduling window + A/B bucket ---------------------------
ALTER TABLE "MerchandisingRule" ADD COLUMN IF NOT EXISTS "startsAt" TIMESTAMP(3);
ALTER TABLE "MerchandisingRule" ADD COLUMN IF NOT EXISTS "endsAt" TIMESTAMP(3);
ALTER TABLE "MerchandisingRule" ADD COLUMN IF NOT EXISTS "variant" TEXT NOT NULL DEFAULT 'all';

-- 4. Purchase attribution (Web Pixel) + experiment bucket --------------------
ALTER TABLE "SearchEvent" ADD COLUMN IF NOT EXISTS "purchased" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SearchEvent" ADD COLUMN IF NOT EXISTS "revenue" DOUBLE PRECISION;
ALTER TABLE "SearchEvent" ADD COLUMN IF NOT EXISTS "orderId" TEXT;
ALTER TABLE "SearchEvent" ADD COLUMN IF NOT EXISTS "bucket" TEXT;

-- The attribution lookup in proxy/track filters (shopId, sessionToken) and
-- orders by createdAt. Without this it scanned every event the shop ever had.
CREATE INDEX IF NOT EXISTS "SearchEvent_shopId_sessionToken_createdAt_idx"
  ON "SearchEvent"("shopId", "sessionToken", "createdAt");

-- 5. Sync attribute cache ----------------------------------------------------
ALTER TABLE "SyncState" ADD COLUMN IF NOT EXISTS "optionNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SyncState" ADD COLUMN IF NOT EXISTS "metafieldKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- 6. Filter presets ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS "FilterPreset" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "params" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "FilterPreset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FilterPreset_shopId_enabled_idx" ON "FilterPreset"("shopId", "enabled");

DO $$
BEGIN
  ALTER TABLE "FilterPreset" ADD CONSTRAINT "FilterPreset_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;
