# AnotherDev Search & Filters

A fast, self-hosted search & filters app for Shopify. Instant search-as-you-type,
typo tolerance, faceted filters, merchandising, synonyms, redirects, product
recommendations, optional semantic search, and real search analytics — with SEO-,
AIO- and CRO-optimized storefront delivery.

Built on **Postgres** as the single datastore (app config *and* the search index),
so there is no separate search service to run or pay per-query for.

## How it works

```
Shopify store ──bulk sync + webhooks──▶ Postgres index
                                          ├─ tsvector   (weighted full-text, incl. SKUs)
                                          ├─ pg_trgm    (typo tolerance / fuzzy)
                                          ├─ unaccent   (accent-insensitive)
                                          └─ pgvector   (semantic, optional)
                                              │
Storefront widget ◀── App Proxy (first-party domain) ─┘
Admin (Polaris)   ──▶ synonyms · filters · merchandising · analytics · settings
```

The search engine sits behind a single `SearchEngine` interface
([app/lib/search/types.ts](app/lib/search/types.ts)). Swapping to Meilisearch /
Typesense / Algolia later is one new class in
[app/lib/search/](app/lib/search/) — no route or UI changes.

## Feature map

| Area | Where |
|------|-------|
| Full-text + fuzzy ranking, SKU/variant search, facets, merchandising | [app/lib/search/postgres.server.ts](app/lib/search/postgres.server.ts) |
| Synonyms & query normalisation | [app/lib/search/normalize.ts](app/lib/search/normalize.ts) |
| Semantic search (optional, pgvector) | [app/lib/search/embeddings.server.ts](app/lib/search/embeddings.server.ts) |
| Catalog sync (Bulk Operations + webhooks) | [app/lib/sync/](app/lib/sync/) |
| Storefront JSON search API (App Proxy) | [app/routes/proxy.search.tsx](app/routes/proxy.search.tsx) |
| Autocomplete | [app/routes/proxy.autocomplete.tsx](app/routes/proxy.autocomplete.tsx) |
| Recommendations (related / personalised / trending / bestsellers) | [app/routes/proxy.recommend.tsx](app/routes/proxy.recommend.tsx) |
| **SEO** crawlable results page + JSON-LD | [app/routes/proxy.results.tsx](app/routes/proxy.results.tsx) |
| **AIO** machine-readable feed for AI shopping agents | [app/routes/proxy.ai.tsx](app/routes/proxy.ai.tsx) |
| **AIO** llms.txt pointing agents at the feed | [app/routes/proxy.llms.tsx](app/routes/proxy.llms.tsx) |
| **CRO** click / add-to-cart / purchase attribution beacon | [app/routes/proxy.track.tsx](app/routes/proxy.track.tsx) |
| Purchase attribution inside checkout (Web Pixel) | [extensions/anotherdev-pixel/](extensions/anotherdev-pixel/) |
| Relevance tester (why did that rank there?) | [app/routes/app.preview.tsx](app/routes/app.preview.tsx) |
| Per-shop stemming language | [app/lib/search/languages.ts](app/lib/search/languages.ts) |
| Nightly catalog reconciliation | [app/routes/cron.sync.tsx](app/routes/cron.sync.tsx) |
| Storefront widget (theme app extension) | [extensions/anotherdev-search/](extensions/anotherdev-search/) |
| Search analytics aggregation + retention | [app/lib/analytics.server.ts](app/lib/analytics.server.ts) |
| Admin UI | [app/routes/app.*.tsx](app/routes/) |

## Where the widget appears

Three surfaces, all driven by the app's Settings page:

- **The theme's own search box** — upgraded in place with the instant dropdown,
  and Enter goes to the app's results page rather than the theme's.
- **The theme's `/search` page** — taken over entirely, so shoppers who use the
  theme's search form still get faceted results.
- **Collection pages** — filters and instant results, with the collection handle
  read from the page, so one block covers every collection.

Merchants can still place the **Search Bar**, **Search Results** and
**Recommendations** app blocks explicitly; an explicit block always wins over
takeover.

## SEO / AIO / CRO notes

- **SEO** — `/apps/anotherdev-search/results` renders real HTML inside the store
  theme (via App Proxy Liquid), with `ItemList` JSON-LD, crawlable facet links,
  and `rel="prev/next"` pagination. Faceted permutations are `noindex,follow` so
  filter combinations don't eat crawl budget. Note that `<link rel="canonical">`
  and `<meta name="robots">` are moved into `<head>` by an inline script: an App
  Proxy response is injected into the theme's body, and Liquid cannot reach the
  head from there. Google renders JS and honours both; the JSON-LD in the body
  carries the same signals for parsers that don't.
- **AIO** — `/apps/anotherdev-search/ai` returns schema.org-typed products plus a
  self-describing `usage` block so LLM shopping agents can query and refine the
  catalog, and `/apps/anotherdev-search/llms` is the llms.txt that tells an agent
  the feed exists at all.
- **CRO** — mobile-first filter drawer with a focus trap, applied-filter chips,
  merchant-defined quick filters, swatches, per-facet search and "show more",
  skeleton loading (no layout shift), instant autocomplete, voice search, quick
  add-to-cart, zero-result "did you mean" recovery, and click → add-to-cart →
  **purchase** attribution surfaced in Analytics.

## Access scopes

Nothing in the catalog is ever written — the app mirrors it into its own index.

| Scope | Why |
|-------|-----|
| `read_products`, `read_product_listings`, `read_collection_listings`, `read_inventory`, `read_content` | mirror the catalog into the index |
| `write_pixels`, `read_customer_events` | install the checkout pixel that attributes completed orders back to a search |

### How far analytics can see

Click-through and add-to-cart come from the storefront widget. **Completed orders
come from a Web Pixel**, because checkout runs on Shopify's own domain where no
theme script is loaded — it is the only surface that can close the loop from a
search to money, which is the number the subscription is justified by.

The pixel reads the order total, its line-item product ids, and the anonymous
`adsf_st` cookie the search widget already sets. It reads no customer
identifiers, and a merchant switches it on per shop from Settings; nothing is
installed on a store that has not asked for it.

## Local setup

Prereqs: Node ≥ 20.19, a running Postgres, and a Shopify Partner account + dev store.

1. **Configure the database.** Copy `.env.example` to `.env` and set
   `DATABASE_URL` / `DIRECT_URL`.

2. **Create DB + schema + search index:**
   ```bash
   createdb anotherdev_search   # or: psql -c "CREATE DATABASE anotherdev_search;"
   npm run db:setup             # prisma migrate + apply tsvector/trgm/vector indexes
   ```

3. **Run the app** (fills Shopify keys automatically):
   ```bash
   npm run dev
   ```

4. In the Shopify admin: open the app → **Index** → *Run first sync*. Then, in the
   theme editor, enable the **AnotherDev Search** app embed. That alone activates
   instant search, `/search` takeover and collection filters.

## Semantic search (optional)

Off by default; keyword search is complete without it. To enable:

1. Make sure Postgres has `pgvector` (the migration adds the column only when the
   extension is installable, and search degrades to keyword-only when it isn't).
2. Set `SEMANTIC_SEARCH_ENABLED=true` and either `VOYAGE_API_KEY` or
   `OPENAI_API_KEY` (with `EMBEDDINGS_PROVIDER=openai`).
3. Run a catalog sync — it backfills embeddings for anything unembedded.
4. Turn it on per shop in **Settings → Relevance** (Pro plan).

Each new or changed product costs one embedding call, and each uncached query
costs one more. Query embeddings are LRU-cached in process.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Shopify app dev (tunnels + admin) |
| `npm run db:setup` | Migrate + build the search index (first time) |
| `npm run db:index` | (Re)apply the tsvector/pg_trgm/pgvector layer |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (query normalisation, settings) |
| `npm run test:integration` | Real engine against live Postgres |
| `npm run test:edge` | Edge-case suite against live Postgres |
| `npm run test:all` | All three |
| `npm run build` | Production build |

Unit tests bundle the real modules with esbuild rather than testing a copy, so
they cannot silently drift from the source. The integration and edge suites need
`DATABASE_URL`/`DIRECT_URL` pointing at a Postgres with `pg_trgm` and `unaccent`;
CI provisions one (see [.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Data & privacy

The app stores **no customer PII** — only the product index, merchant config, and
anonymous search analytics.

Shoppers get a random id (`adsf_st`) so a click, add-to-cart or completed order
can be joined back to the search that produced it. It is held in `localStorage`
**and** in a first-party cookie: the checkout pixel runs in Shopify's sandbox on a
different origin and cannot read `localStorage`, so the cookie is the only thing
both halves can see. It is generated in the browser, never linked to a customer
account, an email or anything Shopify identifies a person by, and is cleared from
stored analytics after `ANALYTICS_SESSION_TOKEN_RETENTION_HOURS` (default 24) —
long enough to attribute, short enough that the retained history carries no
per-shopper identifier at all.

"Recently viewed", which drives the personalised recommendation rail, lives only
in the shopper's own `localStorage` and is sent up as request input. No profile
is stored server-side.

Raw analytics rows are pruned after `ANALYTICS_RETENTION_DAYS` (default 180).
GDPR webhooks are implemented in [app/routes/webhooks.*.tsx](app/routes/).
