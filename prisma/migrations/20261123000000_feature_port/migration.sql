-- Features ported from the source app: banners, suggestion blacklist,
-- size mapping, merged filter values, per-collection filter groups.
CREATE TABLE "SearchBanner" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shopId" TEXT NOT NULL REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "query" TEXT NOT NULL,
  "placement" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 1,
  "imageUrl" TEXT NOT NULL DEFAULT '',
  "targetUrl" TEXT NOT NULL DEFAULT '',
  "heading" TEXT NOT NULL DEFAULT '',
  "content" TEXT NOT NULL DEFAULT '',
  "buttonLabel" TEXT NOT NULL DEFAULT '',
  "backgroundColor" TEXT NOT NULL DEFAULT '#f4f4f5',
  "textColor" TEXT NOT NULL DEFAULT '#18181b',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "SearchBanner_shopId_query_active_idx" ON "SearchBanner"("shopId", "query", "active");

CREATE TABLE "SuggestionBlacklist" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shopId" TEXT NOT NULL REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "term" TEXT NOT NULL,
  "operator" TEXT NOT NULL DEFAULT 'contains',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "SuggestionBlacklist_shopId_term_operator_key" ON "SuggestionBlacklist"("shopId", "term", "operator");
CREATE INDEX "SuggestionBlacklist_shopId_active_idx" ON "SuggestionBlacklist"("shopId", "active");

CREATE TABLE "SizeMapping" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shopId" TEXT NOT NULL REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "value" TEXT NOT NULL,
  "rank" INTEGER NOT NULL
);
CREATE UNIQUE INDEX "SizeMapping_shopId_value_key" ON "SizeMapping"("shopId", "value");

CREATE TABLE "MergedValue" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shopId" TEXT NOT NULL REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "source" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "sourceValues" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MergedValue_shopId_active_idx" ON "MergedValue"("shopId", "active");

CREATE TABLE "FilterGroup" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shopId" TEXT NOT NULL REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "collections" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "sources" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "FilterGroup_shopId_active_idx" ON "FilterGroup"("shopId", "active");
