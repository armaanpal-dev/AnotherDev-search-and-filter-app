-- Repairs drift between schema.prisma and the migration history.
--
-- `Collection`, `Page`, and SyncState's progress columns were added to the
-- Prisma schema and pushed straight to the development database (prisma db
-- push), so no migration ever created them. Every existing environment already
-- has them; a FRESH database built by `prisma migrate deploy` did not, which is
-- why CI failed on `prisma.collection.findMany()` and why a brand-new deploy
-- would have 500'd on every storefront search (loadShopConfig reads Collection
-- on the hot path) and crashed on the first catalog sync (SyncState.phase).
--
-- Every statement is IF NOT EXISTS / DO-guarded so this is a no-op against the
-- databases that were already db-pushed.

-- Collection -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Collection" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT,
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Collection_shopId_idx" ON "Collection"("shopId");
CREATE UNIQUE INDEX IF NOT EXISTS "Collection_shopId_collectionId_key" ON "Collection"("shopId", "collectionId");

-- Page -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Page" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Page_shopId_idx" ON "Page"("shopId");
CREATE UNIQUE INDEX IF NOT EXISTS "Page_shopId_pageId_key" ON "Page"("shopId", "pageId");

-- Foreign keys ---------------------------------------------------------------
-- ADD CONSTRAINT has no IF NOT EXISTS, so each is guarded by a catalog lookup.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Collection_shopId_fkey') THEN
    ALTER TABLE "Collection" ADD CONSTRAINT "Collection_shopId_fkey"
      FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Page_shopId_fkey') THEN
    ALTER TABLE "Page" ADD CONSTRAINT "Page_shopId_fkey"
      FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- SyncState progress ---------------------------------------------------------
-- Written by every sync heartbeat and read by the admin progress bar.
ALTER TABLE "SyncState" ADD COLUMN IF NOT EXISTS "phase" TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE "SyncState" ADD COLUMN IF NOT EXISTS "progressCurrent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SyncState" ADD COLUMN IF NOT EXISTS "progressTotal" INTEGER NOT NULL DEFAULT 0;
