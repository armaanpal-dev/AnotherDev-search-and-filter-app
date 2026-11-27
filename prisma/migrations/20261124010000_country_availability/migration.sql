-- Country availability: per-country list of products not for sale there.
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "storefrontToken" TEXT;

CREATE TABLE "CountryAvailability" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shopId" TEXT NOT NULL REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "country" TEXT NOT NULL,
  "unavailable" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "CountryAvailability_shopId_country_key" ON "CountryAvailability"("shopId", "country");
