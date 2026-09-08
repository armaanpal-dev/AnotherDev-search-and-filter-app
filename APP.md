# AnotherDev Search and Filters — complete reference

Everything the app is, in one document: what it does, how it is built, every
route, every setting, every environment variable, and the constraints that
shaped the design.

Companion documents: [README.md](README.md) is the short introduction,
[DEPLOY.md](DEPLOY.md) covers deployment (**note: still written for Fly.io — the
app now runs on Railway**), and [PRIVACY.md](PRIVACY.md) is the data-practices
reference behind the published privacy policy.

---

## 1. What it does

Replaces a Shopify theme's built-in product search with an index the app owns,
and adds faceted filtering to search and collection pages.

- **Instant search** — results as the shopper types, with typo tolerance and
  merchant-defined synonyms
- **Searches more than titles** — descriptions, vendors, product types, tags,
  SKUs, variant names, options and metafields
- **Faceted filters** — on both the search results page and collection pages
- **Merchandising** — pin, boost, bury or hide products per search term or
  collection; redirect a term to any page
- **Analytics** — top searches, zero-result searches, click-through, add-to-cart
  and (optionally) purchase attribution
- **Recommendations** — related-product rails driven by the same index

The app holds **read-only** Shopify scopes. It never writes to a merchant's
store.

---

## 2. Architecture

```
Shopify Admin (embedded)          Storefront (theme app extension)
   React Router 7 SSR                anotherdev-search.js + .css
   Polaris web components            app embed + 3 optional blocks
          |                                    |
          |  session token auth                |  App Proxy (HMAC verified)
          v                                    v
   ┌─────────────────────────────────────────────────────┐
   │  React Router server  (Node, Docker, Railway)       │
   │   app/routes/*        admin pages, proxy, webhooks  │
   │   app/lib/search/*    the engine                    │
   │   app/lib/sync/*      catalog ingestion             │
   └─────────────────────────────────────────────────────┘
                          |
                          v
        PostgreSQL (Supabase, ap-southeast-1)
          tsvector + pg_trgm + unaccent [+ pgvector]
```

**Stack:** React Router 7 (SSR), `@shopify/shopify-app-react-router` v1, App
Bridge v4, Polaris web components, Prisma, PostgreSQL, Docker on Railway.

### Why Postgres rather than a hosted search service

Full-text search, trigram fuzzy matching, faceting, and optional vector
similarity all live in one database that already holds the catalog mirror. No
second system to keep in sync, no per-query cost, and a facet count is a
`GROUP BY` rather than a second network round trip.

---

## 3. The search engine

`app/lib/search/postgres.server.ts` is the whole query layer.

| Concern | Mechanism |
|---|---|
| Full-text | A generated `tsvector` column over title, description, vendor, type, tags, SKUs and variant text |
| Language | Per-shop `tsConfig` (stemming dictionary), mirrored onto every product row |
| Typo tolerance | `pg_trgm` similarity with a floor of `0.2` |
| Accents | `unaccent`, so "café" matches "cafe" |
| Semantic (optional) | `pgvector` cosine similarity blended into the score |
| Synonyms | Expanded into the query before it reaches Postgres |
| Ranking | `ts_rank` + popularity + merchandising weights |
| Merchandising | Boost/bury add a signed weight; **pin** adds `weight + 50` so it clears the field without breaking pagination |
| Stability | Every sort ends with a stable tiebreaker, so equal scores never reshuffle between pages |

Facets are computed in the same request as the results, so counts always agree
with what the grid shows.

### Ingestion

`app/lib/sync/bulk.server.ts` runs a Shopify **Bulk Operation**, downloads the
JSONL, and groups child rows to their parents by `__parentId`. Incremental
updates arrive by webhook; `cron.sync` reconciles on a schedule.

---

## 4. Admin routes (`/app/*`)

| Route | Purpose |
|---|---|
| `app._index` | Dashboard — 7-day metrics, setup steps, links |
| `app.sync` | Index: run and monitor the catalog sync, auto-sync toggle |
| `app.filters` | **Facet configuration** — which filters exist, their order, display type, and quick-filter chips |
| `app.synonyms` | Synonym groups (multiway and one-way), CSV import |
| `app.merchandising` | Pin/boost/bury/hide rules, search redirects, A/B variants |
| `app.analytics` | Top searches, zero-result terms, CTR, add-to-cart, revenue |
| `app.plans` | Plan comparison, upgrade, cancel, operator plan override |
| `app.settings` | **Appearance and behaviour**, in four tabs (section 6) |
| `app.preview` | Test search against the live index from the admin |

**Filters page vs Settings → Filters tab.** The Filters *page* is configuration:
which facets exist and in what order. The Filters *tab* in Settings is
appearance: how they look. They are deliberately separate.

## 5. Storefront routes (App Proxy, `/apps/anotherdev-search/*`)

Every one is HMAC-verified by Shopify before it reaches the app.

| Endpoint | Purpose |
|---|---|
| `search` | Full search with filters, sort, pagination, facet counts |
| `autocomplete` | Typeahead suggestions for the dropdown |
| `config` | Settings and facet definitions for the widget to render itself |
| `results` | Server-rendered, crawlable HTML results page |
| `recommend` | Related-product rails |
| `track` | Click, add-to-cart and purchase events |
| `ai` | Structured product answers for AI crawlers |
| `llms` | An `llms.txt` describing the store to LLM agents |
| `visual` | Image-based product search (multimodal embeddings) |

### Webhooks

`app/uninstalled` · `app/scopes_update` · `app_subscriptions/update` ·
`products/create|update|delete` · `collections/create|update|delete` ·
`customers/data_request` · `customers/redact` · `shop/redact`

---

## 6. Settings

`app/lib/settings.ts` is the single source of truth. Stored as JSON on `Shop`,
read by the storefront through `proxy.config`, and validated on the way in —
colours against a strict pattern, numbers clamped to a range, text stripped of
angle brackets. Nothing unvalidated reaches a CSS declaration.

The Settings page has four tabs. Panels are hidden with CSS rather than
unmounted, so edits on one tab survive a save made from another.

### Search tab

Mode (search / filters / both), theme search-box takeover, search-page
takeover, recommendations, recent searches, voice search, typo tolerance,
semantic search, out-of-stock visibility, minimum characters, maximum
suggestions, panel style, results layout, preview side, and the panel's
colours, font size and weight.

### Filters tab

Who draws collection product cards (section 7), filter layout (sidebar /
toolbar / drawer / inline), button shape, button and active colours, facet
counts, and the colour-swatch map.

### Product cards tab

Products per page, cards per row on **desktop and mobile**, and — when the app
draws the cards — image shape, fixed image height, image fill, card outline,
hover effect, background, alignment, radius, padding, gap, title size/weight/
colour/line clamp, price size/weight/colour, and the add-to-cart button's
label, colours, radius and full-width toggle.

Each tab has its own live preview showing only what that tab controls.

### Advanced tab

Search language (stemming dictionary), auto-sync, and revenue tracking (Web
Pixel install/removal).

---

## 7. The theme-cards trade-off

The most important design constraint in the app.

Shopify's Section Rendering API can only be filtered by Shopify's **native**
filter parameters (`filter.p.vendor`, `filter.v.option.<name>`, …), and those
are ignored unless the merchant has enabled the matching filter in Search &
Discovery. So a theme-rendered grid can only honour filters Shopify already
knows about. The app's own grid is filtered by the app's index, so every facet
works — but the cards are the app's, not the theme's.

These are mutually exclusive, so the merchant chooses:

| Setting | Behaviour |
|---|---|
| **Automatic** (default) | Theme's cards when every configured facet is natively supported; the app's grid when one is not, so no filter is ever shown broken |
| **Always my theme's cards** | Theme always renders. Facets Shopify cannot apply are hidden rather than shown dead. If the theme exposes no addressable section, the page is left completely untouched |
| **Always this app's cards** | The app's grid every time, regardless of theme |

### Theme compatibility

Grid detection is **structural**, not a list of theme class names: the app walks
up from product links and picks the element with the most direct children that
each contain one. A named-selector list only ever covers themes someone thought
to add.

Add to cart mirrors the theme's own product form — it copies the hidden fields
from `form[action*="/cart/add"]`, posts `FormData` (not JSON) to the
locale-aware cart route, requests bundled section rendering so the theme
re-renders its own drawer and count bubble, then opens the drawer via the custom
element's `open()`, an attribute-based toggle, or a broad set of events cart apps
listen for. It never clicks an `<a href="/cart">` — that would navigate the
shopper away from their results.

---

## 8. Theme app extension

`extensions/anotherdev-search/`

| Block | Type | Notes |
|---|---|---|
| `AnotherDev Search` | App embed | The one that has to be on. Enables everything automatic |
| `AnotherDev Search Bar` | Section block | Optional, hand-placed |
| `AnotherDev Search Results` | Section block | Optional, hand-placed |
| `AnotherDev Recommended` | Section block | Recommendation rail |

Hand-placed blocks take priority over the automatic behaviour. Block schema
names are capped at 25 characters by Shopify — exceeding it breaks
`shopify app dev` with a confusing error.

A second extension, `anotherdev-pixel`, is the Web Pixel used for purchase
attribution.

---

## 9. Plans

Defined in `app/lib/plans.ts` — deliberately free of server imports so the
pricing page can render it in the browser.

| | Free | Growth $21 | Pro $49 | Custom $70 |
|---|---|---|---|---|
| Products indexed | 100 | 5,000 | Unlimited | Unlimited |
| Analytics history | 7 days | 30 days | 90 days | 365 days |
| Merchandising | — | Yes | Yes | Yes |
| Search redirects | — | Yes | Yes | Yes |
| AI product feed | — | — | Yes | Yes |
| Semantic search | — | — | Yes | Yes |

Every gate reads a **capability** from this table, never a plan name, so adding
a tier does not mean hunting for `=== "pro"` checks. Plan-name strings in
`shopify.server.ts` must match the Display name of the matching plan in the
Developer Dashboard exactly — managed pricing names a subscription after the
display name, and `billing.check()` matches on that name.

`Shop.planOverride` pins a plan with no Shopify charge, for support and
testing. Set it from the admin (operator shops only) or with `npm run plan`.

---

## 10. Environment variables

**Required**

| Variable | Purpose |
|---|---|
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | App credentials |
| `SHOPIFY_APP_URL` | Public HTTPS URL of the deployment |
| `SCOPES` | Must match `shopify.app.toml` |
| `DATABASE_URL` | Postgres, pooled connection |
| `DIRECT_URL` | Postgres, direct connection for migrations |
| `NODE_ENV` | `production` in production |

**Optional**

| Variable | Default | Purpose |
|---|---|---|
| `SHOPIFY_BILLING_TEST` | inferred from `NODE_ENV` | Force test charges on or off |
| `OPERATOR_SHOPS` | empty | Shops allowed to use the plan override. **Empty means nobody, never everybody** |
| `ANALYTICS_RETENTION_DAYS` | 180 | Search-event retention |
| `ANALYTICS_SESSION_TOKEN_RETENTION_HOURS` | 24 | How long a session token stays attached to an event |
| `SEMANTIC_SEARCH_ENABLED` | off | Master switch for vector search |
| `EMBEDDINGS_PROVIDER` | `voyage` | `voyage` or `openai` |
| `VOYAGE_API_KEY` / `OPENAI_API_KEY` | — | Provider credential |
| `EMBEDDINGS_MODEL` / `EMBEDDINGS_MULTIMODAL` | — | Model selection, image search |
| `SEARCH_BACKEND` | `postgres` | Engine selection |
| `FACET_CACHE_TTL_MS` | — | Facet cache lifetime |
| `CRON_SECRET` / `CRON_SYNC_BATCH` | — | Scheduled reconciliation |
| `APP_PROXY_BASE` | — | Override when the proxy subpath is changed |
| `SHOP_CUSTOM_DOMAIN` | — | Local development against a custom domain |

---

## 11. Development

```bash
npm install
npm run db:setup     # migrate + create the search index objects
npm run dev          # shopify app dev

npm run typecheck    # react-router typegen && tsc --noEmit
npm run lint         # what CI runs — must be 0 errors
npm test             # unit tests
npm run test:all     # unit + integration (real Postgres) + edge cases
npm run build
```

Deploying is **two** steps, and they are independent:

```bash
git push                 # server → Railway
npx shopify app deploy   # theme extension + app config → Shopify
```

A change to `extensions/**` needs the second one. Pushing alone will not update
the storefront.

### Schema changes

`prisma db push` does not create migration files. A schema change applied that
way works locally and then fails CI and production with "relation does not
exist". Always generate a migration.

---

## 12. Things that will bite you

- **A `<script>` in Section Rendering HTML does not execute** when inserted with
  `innerHTML`. Themes rely on custom elements re-running `connectedCallback`
  instead.
- **Bundled section rendering is capped at five sections.**
- **CSS specificity in the extension.** A layout override written as
  `.a.b .btn` (0,3,0) silently beat both the base rule and `.btn.is-active`
  (0,2,0), which made every filter-appearance setting appear to do nothing in
  the default sidebar layout.
- **Function declarations inside a block** fail `no-inner-declarations` in CI.
  Use function expressions in the extension's ES5 code.
- **`/collections/all` is virtual.** No product is a member of it, so scoping a
  search to the handle `all` returns nothing. Treat it as an unscoped browse.
- **Locale-prefixed storefronts.** Never hardcode `/cart/add.js` or parse a
  handle by path segment index — use `Shopify.routes.root` and a regex.
- **Bulk JSONL only contains fields you selected.** A nested connection without
  `id` produces lines the parser cannot route, and they are dropped silently.
- **Server-only modules must not be reachable from a component**, or the build
  fails with "Server-only module referenced by client".
- **`s-page` only spaces its direct `s-section` children.** A wrapper in between
  collapses the gaps.

---

## 13. Compliance and data

Read-only scopes; no customer identifiers stored; the only per-shopper value is
a random browser-generated token, nulled after 24 hours. All three Shopify
compliance webhooks are implemented, and `shop/redact` purges everything for the
store. Full detail in [PRIVACY.md](PRIVACY.md).

---

## 14. Known gaps

- `DEPLOY.md` documents Fly.io; the app runs on Railway.
- `parseBulkJsonl` has no unit test — it lives in a Prisma-importing module and
  would need extracting first.
- The cart integration is reasoned from Shopify's documentation and theme
  conventions, not verified against a large sample of live themes. Themes that
  expose a drawer only through a class toggle will update the cart but not open.
- Annual billing is only purchasable through the App Store pricing page; the
  in-app upgrade button always creates a monthly charge.
