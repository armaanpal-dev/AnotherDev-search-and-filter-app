-- AnotherDev Search — full-text / fuzzy / accent-insensitive / semantic layer.
-- Applied AFTER `prisma migrate` creates the base tables.
-- Idempotent: safe to run repeatedly (used by `npm run db:setup`).

-- 1. Extensions ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy / typo-tolerant matching
CREATE EXTENSION IF NOT EXISTS unaccent;     -- café == cafe
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch; -- levenshtein for "did you mean"

-- pgvector powers optional semantic search. Not every managed Postgres ships it,
-- and it is not required for the app to run — so a missing extension degrades to
-- keyword-only search instead of failing the whole migration.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector unavailable — semantic search disabled (%).', SQLERRM;
END
$$;

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
-- Weighted: title + SKU (A) > variant names/tags/type/vendor (B) > description (C).
-- SKUs sit at weight A deliberately: someone typing a SKU wants that exact
-- product first, and staff searching the storefront use SKUs constantly.
-- Generated column keeps it always in sync with no app-side maintenance.
ALTER TABLE "Product" DROP COLUMN IF EXISTS "searchVector";
ALTER TABLE "Product" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', ad_immutable_unaccent(coalesce("title", ''))), 'A') ||
    setweight(to_tsvector('simple', ad_immutable_unaccent(ad_immutable_array_to_string("skus"))), 'A') ||
    setweight(to_tsvector('simple', ad_immutable_unaccent(coalesce("vendor", ''))), 'B') ||
    setweight(to_tsvector('simple', ad_immutable_unaccent(coalesce("productType", ''))), 'B') ||
    setweight(to_tsvector('simple', ad_immutable_unaccent(ad_immutable_array_to_string("tags"))), 'B') ||
    setweight(to_tsvector('simple', ad_immutable_unaccent(coalesce("variantText", ''))), 'B') ||
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

-- Exact-SKU lookup: a shopper pasting a SKU should hit an index, not a scan.
CREATE INDEX IF NOT EXISTS product_skus_gin_idx ON "Product" USING GIN ("skus");

-- 4. Faceting helpers ------------------------------------------------------
CREATE INDEX IF NOT EXISTS product_tags_gin_idx  ON "Product" USING GIN ("tags");
CREATE INDEX IF NOT EXISTS product_collections_gin_idx ON "Product" USING GIN ("collections");
CREATE INDEX IF NOT EXISTS product_options_gin_idx ON "Product" USING GIN ("options" jsonb_path_ops);
CREATE INDEX IF NOT EXISTS product_metafields_gin_idx ON "Product" USING GIN ("metafields" jsonb_path_ops);
CREATE INDEX IF NOT EXISTS product_price_idx ON "Product" ("shopId", "priceMin");

-- 5. Semantic search column (optional) ------------------------------------
-- 1024 dimensions: voyage-3.5 / voyage-3 natively, and OpenAI text-embedding-3-*
-- truncated via the `dimensions` parameter. Whole block is a no-op without pgvector.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'Product' AND column_name = 'embedding'
    ) THEN
      EXECUTE 'ALTER TABLE "Product" ADD COLUMN "embedding" vector(1024)';
    END IF;
    -- HNSW gives good recall at low latency and, unlike ivfflat, needs no
    -- training pass over pre-existing rows.
    EXECUTE 'CREATE INDEX IF NOT EXISTS product_embedding_hnsw_idx
             ON "Product" USING hnsw ("embedding" vector_cosine_ops)';
  END IF;
END
$$;

-- 6. Analytics --------------------------------------------------------------
-- Retention pruning deletes by (shopId, createdAt); the existing composite index
-- covers it. Zero-result reporting groups by normalized — already indexed.
