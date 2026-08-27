-- Search v2: variant/SKU indexing, publication state, rule-based merchandising,
-- popularity decay bookkeeping, sync heartbeats, web-pixel id.

-- Shop
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "pixelId" TEXT;
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "analyticsPrunedAt" TIMESTAMP(3);

-- Product
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "variantText" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "skus" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "publishedOnline" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "popularityDecayedAt" TIMESTAMP(3);
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "embeddedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Product_shopId_status_publishedOnline_available_idx"
  ON "Product" ("shopId", "status", "publishedOnline", "available");
CREATE INDEX IF NOT EXISTS "Product_shopId_embeddedAt_idx"
  ON "Product" ("shopId", "embeddedAt");

-- MerchandisingRule
ALTER TABLE "MerchandisingRule" ADD COLUMN IF NOT EXISTS "conditions" JSONB NOT NULL DEFAULT '[]';

-- SyncState
ALTER TABLE "SyncState" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3);
ALTER TABLE "SyncState" ADD COLUMN IF NOT EXISTS "heartbeatAt" TIMESTAMP(3);
