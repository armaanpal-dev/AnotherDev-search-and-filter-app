-- Filters and Locations analytics reports.
ALTER TABLE "SearchEvent" ADD COLUMN IF NOT EXISTS "country" TEXT;

CREATE TABLE "FilterUsage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shopId" TEXT NOT NULL REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "day" DATE NOT NULL,
  "source" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "FilterUsage_shopId_day_source_value_key" ON "FilterUsage"("shopId", "day", "source", "value");
CREATE INDEX "FilterUsage_shopId_day_idx" ON "FilterUsage"("shopId", "day");
