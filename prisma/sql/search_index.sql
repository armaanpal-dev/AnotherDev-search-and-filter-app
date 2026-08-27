-- AnotherDev Search — full-text / fuzzy / accent-insensitive search layer.
-- Applied AFTER `prisma migrate` creates the base tables.
-- Idempotent: safe to run repeatedly (used by `npm run db:setup`).

-- 1. Extensions ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy / typo-tolerant matching
CREATE EXTENSION IF NOT EXISTS unaccent;     -- café == cafe
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch; -- levenshtein for "did you mean"

-- unaccent is not IMMUTABLE by default, which blocks its use in generated
-- columns / expression indexes. Wrap it in an immutable helper.
CREATE OR REPLACE FUNCTION ad_immutable_unaccent(text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS
$$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- array_to_string is only STABLE (its element output functions could in theory
-- be non-immutable), which also blocks generated columns. Assert immutability
-- for our text[] tags via a wrapper.
CREATE OR REPLACE FUNCTION ad_immutable_array_to_string(text[])
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT array_to_string($1, ' ') $$;

-- 2. Full-text search vector ----------------------------------------------
-- Weighted: title (A) > tags/type/vendor (B) > description (C).
-- Generated column keeps it always in sync with no app-side maintenance.
ALTER TABLE "Product" DROP COLUMN IF EXISTS "searchVector";
ALTER TABLE "Product" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', ad_immutable_unaccent(coalesce("title", ''))), 'A') ||
    setweight(to_tsvector('simple', ad_immutable_unaccent(coalesce("vendor", ''))), 'B') ||
    setweight(to_tsvector('simple', ad_immutable_unaccent(coalesce("productType", ''))), 'B') ||
    setweight(to_tsvector('simple', ad_immutable_unaccent(ad_immutable_array_to_string("tags"))), 'B') ||
    setweight(to_tsvector('simple', ad_immutable_unaccent(coalesce("description", ''))), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS product_search_vector_idx
  ON "Product" USING GIN ("searchVector");

-- 3. Trigram indexes for typo tolerance & substring/autocomplete ----------
-- Accent-insensitive lowercased title, used for similarity() and ILIKE.
CREATE INDEX IF NOT EXISTS product_title_trgm_idx
  ON "Product" USING GIN (lower(ad_immutable_unaccent("title")) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS product_vendor_trgm_idx
  ON "Product" USING GIN (lower(ad_immutable_unaccent("vendor")) gin_trgm_ops);

-- 4. Faceting helpers ------------------------------------------------------
CREATE INDEX IF NOT EXISTS product_tags_gin_idx  ON "Product" USING GIN ("tags");
CREATE INDEX IF NOT EXISTS product_collections_gin_idx ON "Product" USING GIN ("collections");
CREATE INDEX IF NOT EXISTS product_options_gin_idx ON "Product" USING GIN ("options" jsonb_path_ops);
CREATE INDEX IF NOT EXISTS product_price_idx ON "Product" ("shopId", "priceMin");
