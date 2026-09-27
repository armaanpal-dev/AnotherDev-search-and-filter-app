# AnotherDev Search & Filters

A fast, self-hosted search & filters app for Shopify. Instant search-as-you-type,
typo tolerance, faceted filters, merchandising, synonyms, redirects, product
recommendations, optional semantic search, and real search analytics — with SEO-,
AIO- and CRO-optimized storefront delivery.

Built on **Postgres** as the single datastore (app config *and* the search index),
so there is no separate search service to run or pay per-query for.

---

## For reviewers: SoBooster machine test

Instead of a mock over a static dataset, I'm submitting the **production
Shopify app I built for this exact problem**: search, faceted filters, dynamic
counts, sorting and URL state. It runs on a real store, over a real catalog
synced from Shopify. This section maps every test requirement to the code that
implements it.

### See it running

| | |
|---|---|
| Live storefront | `https://<STORE>.myshopify.com/collections/all` (password: `<PASSWORD>`) |
| Search results page | `https://<STORE>.myshopify.com/search?q=dress` |
| Walkthrough video | `<VIDEO LINK>` (2 minutes) |
| App backend | `https://search.anotherdev.in`, deployed on Railway with Supabase Postgres |

Running it locally takes a Shopify Partner account and a dev store (see
[Local setup](#local-setup)). The live store is the quickest way to evaluate it.

### Requirement → implementation

| Test requirement | Where it lives | Notes |
|---|---|---|
| **Search**: title, vendor, product type, tags | [postgres.server.ts `search()`](app/lib/search/postgres.server.ts#L269), index in [search_index.sql:110](prisma/sql/search_index.sql#L110) | Weighted `tsvector`: title and SKU rank highest, then vendor, type and tags, then description. `pg_trgm` catches typos. This goes beyond the substring match the test asks for |
| Search without a page reload, debounced | [anotherdev-search.js:676](extensions/anotherdev-search/assets/anotherdev-search.js#L676) | 150 ms debounce ([helper at :95](extensions/anotherdev-search/assets/anotherdev-search.js#L95)) |
| "No products found" state | [anotherdev-search.js:1455](extensions/anotherdev-search/assets/anotherdev-search.js#L1455) | Also offers a "did you mean" suggestion ([`suggestSpelling`](app/lib/search/postgres.server.ts#L726)) |
| **Filters**: collection, vendor, colour, size, price, availability | [`buildFilterPredicates`](app/lib/search/postgres.server.ts#L105) | Merchants pick which filters appear in [app.filters.tsx](app/routes/app.filters.tsx). Colour and size come from Shopify variant options |
| AND across filters, OR within a filter | [`buildFilterPredicates`](app/lib/search/postgres.server.ts#L105) | Black **or** Red, **and** size M |
| **Dynamic filter counts** | [`computeFacets`](app/lib/search/postgres.server.ts#L583), `whereExcept()` at [:596](app/lib/search/postgres.server.ts#L596) | See [the facet counting rule](#the-facet-counting-rule) below |
| Clear all and removable chips | [`renderChips`](extensions/anotherdev-search/assets/anotherdev-search.js#L1569) | |
| **Sorting**: price ↑↓, name A→Z and Z→A | [`orderByClause`](app/lib/search/postgres.server.ts#L246) | Also relevance, newest and best-selling. Every sort ends in a stable tiebreaker, so results never reshuffle between pages |
| **URL state**, shareable and safe to refresh | [`syncUrl`](extensions/anotherdev-search/assets/anotherdev-search.js#L1403), [`readState`](extensions/anotherdev-search/assets/anotherdev-search.js#L1368) | `pushState` on filter and sort changes, `replaceState` while typing |
| Back and Forward | [popstate handler :1939](extensions/anotherdev-search/assets/anotherdev-search.js#L1939) | |
| **Responsive** layout, mobile drawer | [`openDrawer`](extensions/anotherdev-search/assets/anotherdev-search.js#L1895) | Traps focus, and closes on Escape or a backdrop click. Merchants choose from four desktop layouts in Settings |
| *Optional:* autocomplete | [`attachAutocomplete`](extensions/anotherdev-search/assets/anotherdev-search.js#L2003) → [`autocomplete()`](app/lib/search/postgres.server.ts#L760) | Suggests products, collections, pages and queries |
| *Optional:* recent searches | [`recentSearches`](extensions/anotherdev-search/assets/anotherdev-search.js#L227) | Stored in `localStorage`, and each entry can be removed |
| *Optional:* pagination | [`search()`](app/lib/search/postgres.server.ts#L269) | Page numbers with a stable order. Page depth is capped, so crawlers can't force full-table scans |

### The facet counting rule

A facet's counts come from the results filtered by **every other facet, but
not by its own selection**:

```
counts(colour) = products matching the search + all active filters EXCEPT colour
```

If the colour facet counted only the current results, selecting Black would
show `Black: 125` and `0` for every other colour, and the shopper couldn't
widen their selection. `whereExcept(source)` in
[`computeFacets`](app/lib/search/postgres.server.ts#L583) builds that WHERE
clause for each facet. Availability needs one more step: its counts also ignore
the store-wide "hide out of stock" setting. Otherwise "Out of stock" would
always show zero.

Counts are built from **the same predicates as the results**, so a count never
disagrees with what the shopper sees after clicking it. The facets are computed
in parallel and cached per filter signature
([`facetSignature`](app/lib/search/postgres.server.ts#L1089)).

### How a search request flows

```
Shopper types in the theme's search box
  │  anotherdev-search.js: debounce 150 ms, read state from the URL
  ▼
GET /apps/anotherdev-search/search?q=…&filter.color=…     (Shopify App Proxy,
  │                                                         same domain as the store)
  ▼
app/routes/proxy.search.tsx      verify the App Proxy signature, parse params
  │  app/lib/proxy.server.ts     parseSearchParams()
  ▼
app/lib/search/index.server.ts   chooses the engine behind the SearchEngine interface
  ▼
app/lib/search/postgres.server.ts
  │  normalise query → synonyms → redirects → tsvector + trigram match
  │  → merchandising (pin / boost / bury) → sort → page
  │  → computeFacets() with the exclude-own rule
  ▼
JSON → anotherdev-search.js renders the grid, facets and chips, then updates the URL
```

### Codebase tour: which file does what

**Storefront (runs in the shopper's browser)**

| File | Responsibility |
|---|---|
| [extensions/anotherdev-search/assets/anotherdev-search.js](extensions/anotherdev-search/assets/anotherdev-search.js) | The entire storefront UI: instant search dropdown, results page, facets, chips, sort, URL state, mobile drawer, add to cart, recent searches and voice search. Written in plain JS with no framework, to keep the theme fast |
| [extensions/anotherdev-search/assets/anotherdev-search.css](extensions/anotherdev-search/assets/anotherdev-search.css) | Widget styles, driven by CSS variables set from the merchant's Settings |
| [extensions/anotherdev-search/blocks/app-embed.liquid](extensions/anotherdev-search/blocks/app-embed.liquid) | The single toggle a merchant switches on in the theme editor. It loads the JS and passes in the config |
| [extensions/anotherdev-search/blocks/](extensions/anotherdev-search/blocks/) | Optional blocks for merchants who want to place the search bar, results or recommendations by hand |
| [extensions/anotherdev-pixel/src/index.js](extensions/anotherdev-pixel/src/index.js) | A Web Pixel that runs inside checkout and links completed orders back to the search that led to them |

**Storefront API (App Proxy routes, called by the JS above)**

| File | Responsibility |
|---|---|
| [app/routes/proxy.search.tsx](app/routes/proxy.search.tsx) | Main search and filter endpoint. Returns results, facets and counts |
| [app/routes/proxy.autocomplete.tsx](app/routes/proxy.autocomplete.tsx) | Suggestions as the shopper types |
| [app/routes/proxy.results.tsx](app/routes/proxy.results.tsx) | A server-rendered results page search engines can crawl (SEO) |
| [app/routes/proxy.recommend.tsx](app/routes/proxy.recommend.tsx) | Related, trending and best-seller product rails |
| [app/routes/proxy.track.tsx](app/routes/proxy.track.tsx) | Beacon that records clicks and add-to-carts |
| [app/routes/proxy.config.tsx](app/routes/proxy.config.tsx) | Serves the shop's widget settings |
| [app/routes/proxy.visual.tsx](app/routes/proxy.visual.tsx) | Search by photo, using image embeddings |
| [app/routes/proxy.ai.tsx](app/routes/proxy.ai.tsx), [proxy.llms.tsx](app/routes/proxy.llms.tsx) | Product feed and llms.txt for AI shopping agents |
| [app/lib/proxy.server.ts](app/lib/proxy.server.ts) | Shared helpers: parameter parsing, CORS, HTML escaping |

**Search engine**

| File | Responsibility |
|---|---|
| [app/lib/search/types.ts](app/lib/search/types.ts) | The `SearchEngine` interface. All other code depends on this, not on Postgres |
| [app/lib/search/postgres.server.ts](app/lib/search/postgres.server.ts) | The engine: matching, ranking, filters, facet counts, sorting, merchandising, autocomplete and recommendations |
| [app/lib/search/index.server.ts](app/lib/search/index.server.ts) | Picks the engine. Moving to Algolia or Meilisearch would mean adding one class |
| [app/lib/search/normalize.ts](app/lib/search/normalize.ts) | Query cleanup: case, accents and escaping |
| [app/lib/search/config.server.ts](app/lib/search/config.server.ts) | Loads each shop's synonyms, redirects and filter config, with caching |
| [app/lib/search/embeddings.server.ts](app/lib/search/embeddings.server.ts) | Semantic search, using Voyage AI vectors stored in pgvector |
| [app/lib/search/languages.ts](app/lib/search/languages.ts) | Stemming language, set per shop |
| [prisma/sql/search_index.sql](prisma/sql/search_index.sql) | The `tsvector` column, GIN and trigram indexes, and Postgres extensions |

**Catalog sync (Shopify → Postgres)**

| File | Responsibility |
|---|---|
| [app/lib/sync/bulk.server.ts](app/lib/sync/bulk.server.ts) | Full sync through the **Bulk Operations API**: one async job, with the JSONL result streamed back and regrouped by `__parentId` |
| [app/lib/sync/normalize-product.ts](app/lib/sync/normalize-product.ts) | Converts Shopify's product shape into the index shape. Options become colour and size, and variants give availability and the price range |
| [app/lib/sync/upsert.server.ts](app/lib/sync/upsert.server.ts) | Batched writes into the index |
| [app/lib/sync/collections.server.ts](app/lib/sync/collections.server.ts) | Collections, pages, and which products belong to each collection |
| [app/routes/webhooks.products.upsert.tsx](app/routes/webhooks.products.upsert.tsx), [webhooks.products.delete.tsx](app/routes/webhooks.products.delete.tsx) | Incremental updates when a product changes |
| [app/routes/cron.sync.tsx](app/routes/cron.sync.tsx) | A nightly reconcile, since Shopify doesn't guarantee webhook delivery |

**Merchant admin (inside the Shopify admin)**

| File | Responsibility |
|---|---|
| [app/routes/app._index.tsx](app/routes/app._index.tsx) | Dashboard: index health and search activity |
| [app/routes/app.settings.tsx](app/routes/app.settings.tsx) | Four settings tabs, each with a live preview |
| [app/routes/app.filters.tsx](app/routes/app.filters.tsx) | Choose, reorder and rename facets |
| [app/routes/app.synonyms.tsx](app/routes/app.synonyms.tsx), [app.merchandising.tsx](app/routes/app.merchandising.tsx) | Synonyms, redirects, and pin, boost and bury rules |
| [app/routes/app.analytics.tsx](app/routes/app.analytics.tsx) | Top searches, searches with no results, and conversions |
| [app/routes/app.preview.tsx](app/routes/app.preview.tsx) | Relevance tester that explains why each result ranked where it did |
| [app/routes/app.sync.tsx](app/routes/app.sync.tsx) | Starts a catalog sync and shows its progress |
| [app/routes/app.plans.tsx](app/routes/app.plans.tsx), [app/lib/plans.ts](app/lib/plans.ts), [app/lib/billing.server.ts](app/lib/billing.server.ts) | Plans and Shopify billing |
| [app/lib/settings.ts](app/lib/settings.ts) | Every widget setting, with defaults and validation |
| [app/lib/analytics.server.ts](app/lib/analytics.server.ts) | Analytics aggregation and data retention |

**Data and tests**

| File | Responsibility |
|---|---|
| [prisma/schema.prisma](prisma/schema.prisma) | Tables: `Shop`, `Product`, `ProductVariant`, `Collection`, `Synonym`, `Redirect`, `MerchandisingRule`, `FilterConfig`, `SearchEvent`, `SyncState` |
| [test/](test/) | Unit tests, plus integration and edge-case suites that run against real Postgres in CI |

### At 150,000 products

The test's last question asks what changes at scale. This app is already built
for it:

- **Initial index.** The Bulk Operations API runs one async job, where
  paginated GraphQL would take about 1,500 calls against the rate limit. The
  JSONL comes back flat, and each child row is regrouped onto its parent by
  `__parentId` ([bulk.server.ts](app/lib/sync/bulk.server.ts)).
- **Keeping the index fresh.** Product and collection webhooks apply changes as
  they happen. A nightly reconcile catches anything a dropped webhook missed.
- **Engine.** Postgres `tsvector`, `pg_trgm` and GIN indexes keep a single
  source of truth, with no second datastore to fall out of sync. When query
  volume or catalog size calls for it, the `SearchEngine` interface lets the
  read path move to Elasticsearch or Algolia without touching any routes or UI.
- **Facet counts.** Each count is a grouped query that shares the results'
  WHERE clause, cached per filter signature. Beyond a few hundred thousand
  products, the next step would be pre-computed counts for unfiltered
  collection pages, where most traffic lands.
- **Storefront speed.** A theme app extension instead of script tags, and an
  App Proxy that keeps requests on the store's own domain. No render-blocking
  JS, and skeleton loading avoids layout shift.

Filtering a static JSON file in memory, as the test describes, is the right
call at 1,000 products. At 150,000 it isn't, which is why this app indexes in
Postgres.

### Libraries and AI tools used

- **Framework:** React Router 7, `@shopify/shopify-app-react-router`, Polaris web
  components, App Bridge
- **Data:** Prisma, PostgreSQL (Supabase) with `pg_trgm`, `unaccent`,
  `fuzzystrmatch` and `pgvector`
- **Embeddings:** Voyage AI, for the optional semantic and photo search
- **Hosting:** Railway
- **AI tools:** Claude (Anthropic), through Claude Code, for code generation,
  review and documentation. I set the architecture, and reviewed and tested
  the output.

---

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
