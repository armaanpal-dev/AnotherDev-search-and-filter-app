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

-- Per-shop stemming.
--
-- `simple` does no stemming, so "boots" never finds "boot" and "running" never
-- finds "run" — fine for SKUs and mixed-language catalogs, poor for prose in a
-- known language. The config therefore has to vary per shop, but searchVector is
-- a STORED generated column, so it cannot read Shop at generation time and every
-- input must be IMMUTABLE. `text::regconfig` is only STABLE (it depends on
-- search_path), which is exactly what a generated column rejects.
--
-- Mapping the row's own `tsConfig` through a CASE of regconfig LITERALS sidesteps
-- both problems: each branch is a constant, so the whole expression is immutable,
-- and the value still varies per row. Anything unrecognised falls back to
-- `simple` rather than erroring, so a bad value degrades instead of breaking the
-- column. Keep this list in sync with SEARCH_LANGUAGES in app/lib/search/languages.ts.
CREATE OR REPLACE FUNCTION ad_ts_config(text)
RETURNS regconfig
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT CASE lower(coalesce($1, 'simple'))
     WHEN 'english'    THEN 'english'::regconfig
     WHEN 'french'     THEN 'french'::regconfig
     WHEN 'german'     THEN 'german'::regconfig
     WHEN 'spanish'    THEN 'spanish'::regconfig
     WHEN 'italian'    THEN 'italian'::regconfig
     WHEN 'portuguese' THEN 'portuguese'::regconfig
     WHEN 'dutch'      THEN 'dutch'::regconfig
     WHEN 'danish'     THEN 'danish'::regconfig
     WHEN 'swedish'    THEN 'swedish'::regconfig
     WHEN 'norwegian'  THEN 'norwegian'::regconfig
     WHEN 'finnish'    THEN 'finnish'::regconfig
     WHEN 'russian'    THEN 'russian'::regconfig
     WHEN 'turkish'    THEN 'turkish'::regconfig
     WHEN 'hungarian'  THEN 'hungarian'::regconfig
     ELSE 'simple'::regconfig
   END $$;

-- 2. Full-text search vector ----------------------------------------------
-- Weighted: title + SKU (A) > variant names/tags/type/vendor (B) > description (C).
-- SKUs sit at weight A deliberately: someone typing a SKU wants that exact
-- product first, and staff searching the storefront use SKUs constantly.
-- Generated column keeps it always in sync with no app-side maintenance.
-- Rebuilt ONLY when it is missing or out of date. Dropping and re-adding a
-- STORED generated column rewrites the whole table and reindexes the GIN index,
-- so doing it unconditionally made every run of this script an O(catalog)
-- operation — fine once, painful on a large catalog and unacceptable if this
-- were ever wired into a deploy's release command.
DO $$
DECLARE
  expr text;
  -- Every column the vector must reference. A stored definition missing any of
  -- them predates the current schema and has to be rebuilt.
  markers text[] := ARRAY['title', 'skus', 'vendor', 'productType',
                          'tags', 'variantText', 'description', 'ad_ts_config'];
  marker text;
  stale boolean := false;
BEGIN
  SELECT generation_expression INTO expr
  FROM information_schema.columns
  WHERE table_name = 'Product' AND column_name = 'searchVector';

  IF expr IS NULL THEN
    stale := true;                       -- column absent entirely
  ELSE
    FOREACH marker IN ARRAY markers LOOP
      IF position(marker IN expr) = 0 THEN
        stale := true;
      END IF;
    END LOOP;
  END IF;

  IF stale THEN
    RAISE NOTICE 'Rebuilding Product.searchVector (missing or out of date).';
    ALTER TABLE "Product" DROP COLUMN IF EXISTS "searchVector";
    ALTER TABLE "Product" ADD COLUMN "searchVector" tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector(ad_ts_config("tsConfig"), ad_immutable_unaccent(coalesce("title", ''))), 'A') ||
        -- SKUs stay on 'simple' whatever the shop's language: a stemmer would
        -- happily mangle "TSH-RED-M" into something that no longer matches what
        -- was typed, and a product code is never prose.
        setweight(to_tsvector('simple', ad_immutable_unaccent(ad_immutable_array_to_string("skus"))), 'A') ||
        setweight(to_tsvector(ad_ts_config("tsConfig"), ad_immutable_unaccent(coalesce("vendor", ''))), 'B') ||
        setweight(to_tsvector(ad_ts_config("tsConfig"), ad_immutable_unaccent(coalesce("productType", ''))), 'B') ||
        setweight(to_tsvector(ad_ts_config("tsConfig"), ad_immutable_unaccent(ad_immutable_array_to_string("tags"))), 'B') ||
        setweight(to_tsvector(ad_ts_config("tsConfig"), ad_immutable_unaccent(coalesce("variantText", ''))), 'B') ||
        setweight(to_tsvector(ad_ts_config("tsConfig"), ad_immutable_unaccent(coalesce("description", ''))), 'C')
      ) STORED;
  END IF;
END
$$;

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

-- Autocomplete runs `"normalized" LIKE 'typed%'` on EVERY keystroke. A default
-- btree cannot serve a prefix LIKE unless the database is in the C collation, so
-- that lookup was scanning every event the shop had ever recorded. text_pattern_ops
-- indexes the value for pattern matching specifically, which is what makes the
-- prefix scan an index range scan.
CREATE INDEX IF NOT EXISTS search_event_normalized_pattern_idx
  ON "SearchEvent" ("shopId", "normalized" text_pattern_ops);

-- Trending searches and the suggestion list both filter on resultsCount > 0
-- inside a recent window; this keeps that from touching pruned-but-present rows.
CREATE INDEX IF NOT EXISTS search_event_trending_idx
  ON "SearchEvent" ("shopId", "createdAt" DESC)
  WHERE "resultsCount" > 0;
