# AnotherDev Search and Filters — complete reference

Everything the app is, in one document: what it does, how it is built, every
route, every one of the 65 storefront settings, every environment variable, and
the constraints that shaped the design.

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
- **Faceted filters** — on the search results page and on collection pages, in
  four selectable layouts
- **Merchandising** — pin, boost, bury or hide products per search term or
  collection; redirect a term to any page
- **Analytics** — top searches, zero-result searches, click-through, add-to-cart
  and optional purchase attribution
- **Recommendations** — related-product rails driven by the same index
- **Add to cart from results** — matching the theme's own cart behaviour

The app holds **read-only** catalog scopes. It never writes to a merchant's
store. (`write_pixels` + `read_customer_events` are the two exceptions, and they
exist only for the optional revenue-tracking pixel.)

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

Full-text search, trigram fuzzy matching, faceting and optional vector
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
| `app._index` | Dashboard — storefront mode, 7-day metrics, setup steps, links |
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
presentation: where they sit and how they look. Deliberately separate.

Every page saves through a fetcher returning `{ ok: true }` or `{ error }`, and
the shared `useSaveToast` hook in `app/components/ui.tsx` turns that into an App
Bridge toast — a toast rather than a banner because on a long form you are
usually scrolled away from the top when you press Save.

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

65 settings, all validated on the way in — colours against a strict pattern,
numbers clamped to a range, text stripped of angle brackets. Nothing unvalidated
ever reaches a CSS declaration. Stored as JSON on `Shop`, read by the storefront
through `proxy.config`. `app/lib/settings.ts` is the single source of truth.

### Storefront mode — its own section, above the tabs

**What this app runs on your storefront**: **Search and filters** · **Search
only** · **Filters only**.

Deliberately not one of the tabs. It is the switch every other setting is
conditional on — a merchant running "Filters only" would otherwise be reading a
Search tab full of controls that do nothing — so it sits in its own highlighted
card above the tab strip on Settings, and again at the top of the Dashboard.

It saves on its own, with its own `intent`, rather than waiting for the page's
Save button: it lives outside the main settings form (HTML forms cannot nest,
and the tab panels are one large form), and changing it is one action rather
than "change, scroll, Save". `app/components/mode.tsx` is the shared component;
both routes render it and handle the same intent.

Everything else only applies to the half that is turned on. A block placed by
hand in the theme editor keeps working either way, since placing it is already
an explicit choice.

### The four tabs

Panels are hidden with CSS rather than unmounted, so edits made on one tab
survive a save made from another. Each tab has its own live preview showing only
what that tab controls.

### Search tab

**Behaviour**

| Setting | Values |
|---|---|
| Upgrade my theme's search box with instant results | on/off |
| Use our results on the theme's `/search` page | on/off |
| Show filters and instant results on collection pages | on/off |
| Show recommendations when the search box is empty | on/off |
| Remember each shopper's recent searches | on/off |
| Typo tolerance (fuzzy matching) | on/off |
| Let shoppers search by voice | on/off |
| Min characters to trigger | 1–4 |
| Max product suggestions | 3–12 |

**Relevance** — search language (stemming dictionary), semantic search (Pro,
where configured), include out-of-stock products.

**Layout** — panel style (spotlight / dropdown), results layout (rich two-pane
or simple list), preview side.

**Appearance** — accent, panel background, text, highlight colours; font size and
weight. These paint the search panel.

### Filters tab

**Collection pages**

| Setting | Values |
|---|---|
| Who draws the product cards | **Automatic** · Always my theme's · Always this app's |
| Set my own page width | on/off, max width 600–2400px, side padding 0–120px |
| Set how many products fit in a row | on/off, desktop 1–6, mobile 1–4 |

**Filter appearance**

| Setting | Values |
|---|---|
| Where filters appear | sidebar · toolbar · drawer · always open |
| Filter button shape | pill · rounded · square |
| Button background / text | colour |
| Selected background / text | colour |
| Hover background / text | colour |
| Show product counts beside values | on/off |

**Colour swatches** — a `value = colour` map so swatch facets render real
colours. Accepts a colour token or an `https` image URL, capped at 300 entries.

### Product cards tab

**Results page** — products per page (12–48), cards per row on desktop (2–5) and
mobile (1–4), show brand name, add to cart from results.

**Product card appearance** (only when this app draws the cards)

| Group | Settings |
|---|---|
| Image | shape (square / portrait / landscape / wide / natural), fixed height 0–600px, fill (crop or fit) |
| Card | outline (none / border / shadow), hover (none / zoom / lift), background, text alignment, corner radius, inner padding, gap between cards |
| Title | size, weight, colour, maximum lines (1–4) |
| Price | size, weight, colour |
| Button | label text, corner radius, background, text colour, full-width |

Font *family* always comes from the theme — that is what stops a card reading as
a widget dropped onto the page.

### Advanced tab

**Keeping the index current** — nightly catalog re-check.
**Revenue tracking** — install or remove the Web Pixel, and diagnose exactly why
it is unavailable when it is (missing scopes vs. a granted-but-failing call).

---

## 7. The four filter layouts

Genuinely distinct behaviours, not four names for one thing.

| Layout | Behaviour |
|---|---|
| **Sidebar** (default) | A column beside the grid with a **FILTERS** heading level with the product count and sort control. Groups start **collapsed**; several can be open at once. Becomes a drawer on phones. |
| **Toolbar** | A row of dropdown buttons above the grid. Closed by default; the open panel **floats over the products** rather than pushing them down. One open at a time; closes on outside click or Escape. |
| **Drawer** | Behind a Filters button at every width. Title bar, close button, backdrop, focus trap, Escape, and outside-click all handled. |
| **Always open** | Facets permanently expanded, stacked above the grid. |

Both the results page and the collection page implement all four, and both
render the same appearance settings.

---

## 8. The theme-cards trade-off

The most important design constraint in the app.

Shopify's Section Rendering API can only be filtered by Shopify's **native**
filter parameters (`filter.p.vendor`, `filter.v.option.<name>`, …), and those are
ignored unless the merchant enabled the matching filter in Search & Discovery. So
a theme-rendered grid can only honour filters Shopify already knows about. The
app's own grid is filtered by the app's index, so every facet works — but the
cards are the app's, not the theme's.

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

---

## 9. Add to cart

Shared with AnotherDev Shoppable Video, so both apps behave identically inside a
merchant's theme. Two rules the implementation is built around:

1. **Once `/cart/add.js` resolves, the add is committed and irreversible.**
   Nothing after that point may surface as an error — a shopper told "Error"
   after a successful add will click again and buy two.
2. **The theme's `renderContents()` is not a black box.** Dawn removes
   `is-empty` from `.drawer__inner`, but Liquid stamps that class on the
   `<cart-drawer>` host, so on the 0→1 add the drawer opens with line items
   hidden. Hand off to the theme, then repair what it misses.

Four tiers, by capability detection and never theme-name sniffing:

1. **Native** — `<cart-notification>` / `<cart-drawer>` exposing
   `renderContents()`. Which element exists already mirrors the merchant's
   `cart_type` setting.
2. **Section-rendered** — a `<cart-drawer>` inside a Shopify section with no
   `renderContents` (Symmetry / Clean Canvas family): re-render that section,
   inject the fresh HTML, open it.
3. **Legacy** — the theme's own ajax cart, only where we can populate it.
4. **Fallback** — our own confirmation toast, so feedback is never absent.

Other details that matter: requests go through the official `/cart/add.js`
endpoint so third-party carts (GoKwik, Shiprocket, Rebuy, Swym) that patch
`fetch` keep working; every request is locale-aware via `Shopify.routes.root`;
there is a 15s timeout so a patched `fetch` can never strand the button on
"Adding…"; adds are serialised so two clicks cannot paint a stale drawer; and
after a handoff the app **verifies** a cart actually opened before deciding
whether to show its own confirmation.

---

## 10. Theme app extension

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

## 11. Plans

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

Every gate reads a **capability** from this table, never a plan name, so adding a
tier does not mean hunting for `=== "pro"` checks. Plan-name strings in
`shopify.server.ts` must match the Display name of the matching plan in the
Developer Dashboard **exactly** — managed pricing names a subscription after the
display name, and `billing.check()` matches on that name.

`Shop.planOverride` pins a plan with no Shopify charge, for support and testing.
Set it from the admin (operator shops only) or with `npm run plan`.

---

## 12. Environment variables

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

## 13. Development

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

A change under `extensions/**` needs the second one. Pushing alone will not
update the storefront — this is the single most common reason a change "did not
appear".

### Schema changes

`prisma db push` does not create migration files. A schema change applied that
way works locally and then fails CI and production with "relation does not
exist". Always generate a migration.

---

## 14. Things that will bite you

**Storefront**

- **A `<script>` in Section Rendering HTML does not execute** when inserted with
  `innerHTML`. Themes rely on custom elements re-running `connectedCallback`.
- **Bundled section rendering is capped at five sections.**
- **CSS specificity in the extension.** A layout override written as `.a.b .btn`
  (0,3,0) silently beat both the base rule and `.btn.is-active` (0,2,0), which
  made every filter-appearance setting appear to do nothing in the default
  sidebar layout. Put shared colours on the *base* rule; let layout rules change
  geometry only.
- **`display: block` beats `[hidden]`.** Forcing it on a facet panel made every
  group permanently open.
- **Function declarations inside a block** fail `no-inner-declarations`, and an
  empty `catch {}` fails `no-empty`. Both are errors in CI.
- **`/collections/all` is virtual.** No product is a member of it, so scoping a
  search to the handle `all` returns nothing.
- **Locale-prefixed storefronts.** Never hardcode `/cart/add.js` or `/products/…`
  — use `Shopify.routes.root`, and never parse a handle by path segment index.
- **The two card renderers are separate code paths.** The results page and the
  collection page do not share their layout CSS, so a change to one does not
  reach the other.

**Server / admin**

- **Bulk JSONL only contains fields you selected.** A nested connection without
  `id` produces lines the parser cannot route, and they are dropped silently.
- **Server-only modules must not be reachable from a component**, or the build
  fails with "Server-only module referenced by client".
- **`s-page` and `s-stack` only space their DIRECT children.** Every wrapper you
  add between them and an `s-section` kills the gaps, and the wrapper has to
  supply them itself.
- **A Polaris component can typecheck and still render nothing.**
  `s-button-group` passes both `tsc` and Shopify's own validator, and renders its
  children as nothing in the live admin.

---

## 15. Compliance and data

Read-only catalog scopes; no customer identifiers stored; the only per-shopper
value is a random browser-generated token, nulled after 24 hours. All three
Shopify compliance webhooks are implemented, and `shop/redact` purges everything
for the store. Full detail in [PRIVACY.md](PRIVACY.md).

---

## 16. Known gaps

- `DEPLOY.md` documents Fly.io; the app runs on Railway.
- `parseBulkJsonl` has no unit test — it lives in a Prisma-importing module and
  would need extracting first.
- The cart integration is reasoned from Shopify's documentation and theme
  conventions plus live testing on Dawn and Symmetry, not verified across a large
  sample of themes. A theme exposing its drawer only through a class toggle will
  update the cart but not slide open.
- Annual billing is only purchasable through the App Store pricing page; the
  in-app upgrade button always creates a monthly charge.
- The results page and collection page duplicate their filter-layout CSS rather
  than sharing it.
