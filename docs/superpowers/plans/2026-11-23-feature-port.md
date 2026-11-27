# Feature Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port every feature of the source "AI Search & Filter" app into AnotherDev, keeping AnotherDev's UI and its better implementations.

**Architecture:** Postgres-only. New features are new Prisma models keyed by `shopId`, pure logic in `app/lib/<area>/*.ts`
(unit-tested with `node --test` via the repo's existing test harness), admin pages in `app/routes/app.*.tsx` using the existing
Polaris web-component style, storefront changes in `extensions/anotherdev-search/assets/anotherdev-search.js`.
Cache gets a Redis-ready interface; nothing requires Redis/Meili.

**Tech Stack:** React Router 7, Prisma 6, Postgres (tsvector, pg_trgm, pgvector), Shopify theme app extension, OpenAI embeddings.

**Spec:** `docs/superpowers/specs/2026-11-23-feature-port-design.md`

## Global Constraints
- No Redis, Meilisearch, BullMQ or worker service is required at runtime.
- `cardAction` default is `quick_add` (current behaviour unchanged for existing shops).
- All new tables are scoped by `shopId` with `onDelete: Cascade` from `Shop`.
- Redirect / banner / blacklist targets must be store-relative paths or https URLs on the shop (reuse existing redirect validation).
- Storefront JS stays a single dependency-free file; no build step added.

## Review Focus
- Banner/blacklist query matching must use the same normalisation as redirects (case, whitespace, accents) — test in Task 2/3.
- Merged filter values: selecting the merged target must filter by all source values, and counts must sum — test in Task 6.
- Quick View on a product whose variants are all sold out must disable add-to-cart, not throw — test in Task 9.
- Size mapping: unmapped sizes sort after mapped ones, stable by label — test in Task 5.
- CSV import with unknown product handles reports per-row errors and imports the rest — test in Task 8.

---

### Task 1: Cache interface (Redis-ready)
**Files:** Modify `app/lib/cache.server.ts`.
**Produces:** `interface SharedCache { get(k): Promise<string|null>; set(k, v, ttlMs): Promise<void>; del(k): Promise<void> }`, `getSharedCache(): SharedCache` (memory impl now; Redis impl when `REDIS_URL` set is a later task).
- [ ] Test memory impl get/set/expiry. - [ ] Implement. - [ ] Commit.

### Task 2: Search banners
**Files:** Prisma `SearchBanner` (shopId, query, placement `top|grid`, position, imageUrl, targetUrl, heading, content, buttonLabel, backgroundColor, textColor, active); `app/lib/search/banners.ts` (`validateBanner(form) -> BannerInput`, throws `ValidationError`); search result gets `banners?: Banner[]`; admin `app/routes/app.banners.tsx`; storefront renders top banner above grid and grid banners at `position` index.
- [ ] Test validateBanner (top requires imageUrl, grid position ≥1, colours default `#f4f4f5`/`#18181b`). - [ ] Implement model+migration, lib, engine hook, admin, storefront. - [ ] Commit.

### Task 3: Suggestion blacklist
**Files:** Prisma `SuggestionBlacklist` (shopId, term, operator `equals|contains|starts_with`, active); `app/lib/search/blacklist.ts` `isBlocked(suggestion, rules) -> boolean`; applied to `AutocompleteResult.suggestions`; admin section on Synonyms page.
- [ ] Test operators + normalisation. - [ ] Implement. - [ ] Commit.

### Task 4: Empty-search products + multi-query redirects
**Files:** setting `emptySearchProductIds: string[]` (autocomplete with empty term returns these first); redirect admin accepts comma/newline-separated queries → one `Redirect` row each.
- [ ] Test query list parsing (dedupe, trim, max 50). - [ ] Implement. - [ ] Commit.

### Task 5: Size mapping
**Files:** Prisma `SizeMapping` (shopId, value, rank Int); `app/lib/search/sizes.ts` `sortSizeValues(values, map) -> values` with built-in defaults (XXS..5XL, numeric); facet values for size options sorted by it; admin section on Filters page.
- [ ] Test ordering incl. unmapped last. - [ ] Implement. - [ ] Commit.

### Task 6: Merged filter values
**Files:** Prisma `MergedValue` (shopId, source, target, sourceValues String[], active); `app/lib/search/merge.ts` `expandSelection(filters, merges)` and `mergeFacetValues(facet, merges)`; wired into `buildFilterPredicates` and `computeFacets`; admin section on Filters page.
- [ ] Test expand + count summing. - [ ] Implement. - [ ] Commit.

### Task 7: Filter groups per collection
**Files:** Prisma `FilterGroup` (shopId, name, collections String[], sources String[] ordered, active); facet list for a collection request = matching group's sources, else default FilterConfig; admin section on Filters page.
- [ ] Test `facetSourcesFor(collection, groups, defaults)`. - [ ] Implement. - [ ] Commit.

### Task 8: Merchandising CSV import/export + best-selling from orders
**Files:** `app/lib/merch/csv.ts` (`exportRules(rules)->string`, `parseRulesCsv(text)->{rows, errors}`), merchandising page import/export; `orders/create` webhook adds line quantities to `Product.popularity` (+ scope `read_orders` in toml).
- [ ] Test CSV round-trip and bad-row errors. - [ ] Implement. - [ ] Commit.

### Task 9: Card action setting + Quick View
**Files:** `WidgetSettings.cardAction: "quick_add"|"quick_view"|"none"` default `quick_add`; Settings UI select; storefront Quick View modal fetching `/products/<handle>.js`, option pickers, quantity, add via existing `addToCartFromButton` path; pure helper `resolveVariant(product, selected)` tested.
- [ ] Test resolveVariant incl. all-sold-out. - [ ] Implement. - [ ] Commit.

### Task 10: Markets (country prices/availability)
**Files:** storefront passes `Shopify.country`; proxy search accepts `country`; prices for non-primary markets fetched live per page of hits via Storefront API `@inContext(country:)` and cached 10 min in SharedCache; setting `marketPricing: boolean`.
- [ ] Test hit price merge helper. - [ ] Implement. - [ ] Commit.

### Task 11: Analytics reports
**Files:** add source's reports missing from ours (zero-result terms, top clicked products, CSV export) to `app/lib/analytics.server.ts` + `app.analytics.tsx`.
- [ ] Implement + typecheck. - [ ] Commit.

### Final: `npm run typecheck`, `npm test`, `npm run build` pass.
