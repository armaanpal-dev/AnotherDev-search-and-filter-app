# Feature port from "AI Search & Filter" — design

Date: 2026-11-23
Source app: `D:\New folder\ai-filter-search-app\shopify-filter-app` (owner confirmed rights to reuse its code)

## Intent
Bring every feature and behaviour of the source app into AnotherDev Search & Filters, one phase at a time,
keeping AnotherDev's admin and storefront UI, and keeping AnotherDev's implementation wherever it is already
better. Hosting stays on Railway, database stays Supabase Postgres.

## Goals
- Feature parity with the source app, delivered phase by phase; each phase ships and works on its own.
- Infrastructure that can take Redis, BullMQ and Meilisearch later by setting env vars, with no rewrites.
- OpenAI for semantic search (key supplied later; feature stays off until `OPENAI_API_KEY` is set).

## Non-goals (for now)
- No Redis, Meilisearch, BullMQ or separate worker service yet.
- No AWS / ECR / EC2 deployment pieces.
- No SoBooster-compatibility specifics unless a merchant needs them.

## Anti-goals
- Replacing AnotherDev's UI with the source app's screens.
- Regressing current storefront speed, SEO delivery or the facet-count correctness rule.

## Constraints
- Stack: React Router 7, Prisma, Postgres (`tsvector` + `pg_trgm`), Shopify theme extension `anotherdev-search`.
- Schema keyed by `shopId` (AnotherDev convention), not the source's `shop` string.
- Source code is JavaScript; ported code becomes TypeScript in `app/lib/...`.

## Approaches considered
1. **Postgres-only with swap-in adapters (chosen).** Cache, job queue and search engine each sit behind a small
   interface. Today: in-memory cache, Postgres jobs table (`FOR UPDATE SKIP LOCKED`), Postgres search.
   Later: `REDIS_URL` → Redis cache, BullMQ queue; `MEILI_HOST` → Meilisearch with Postgres fallback.
   Cheapest now, no rework later.
2. Full source architecture now (Redis + BullMQ + Meili + worker). Rejected for now by owner — added later.
3. Postgres-only with no adapters. Rejected: adding Redis/Meili later would mean touching every call site.

## Phases
0. **Foundations:** cache / queue / search-engine adapter interfaces; `pgvector` + OpenAI embedding provider
   (inactive without key).
1. **Search tools:** search banners (per query, placement + position), suggestion blacklist, search-term
   product pinning (upgrade our existing merchandising pins to the source's rules), empty-search content,
   redirect upgrade (one target, many queries — source model).
2. **Filter tools:** size mapping, merged filter values, filter groups per collection, saved filter views.
3. **Collection merchandising:** collection pinning, merchandising rules + conditions, CSV import/export,
   best-selling ranking from order data (orders webhook + sync).
4. **Storefront:** Quick View (see below), faster collection page loading / prepared pages.
5. **Markets:** country prices and availability.
6. **Analytics:** source's search analytics reports on top of our `SearchEvent`.

Each phase gets its own short plan before code. Order may be changed by the owner.

## Decided: card action setting (Phase 4)
New setting `cardAction`, chosen by the merchant in Settings:
- `quick_add` — current AnotherDev behaviour (add-to-cart button, variant handling as today). **Default**, so
  existing shops see no change.
- `quick_view` — source app's Quick View modal: variant picker, quantity, Ajax add-to-cart using the same
  cart-drawer handling AnotherDev already has (`addToCartFromButton` / section drawer).
- `none` — card links to the product only.

## Left to the builder
- Exact table/column names in the Prisma migrations for each phase.
- How each source admin screen maps onto existing AnotherDev pages/tabs.
- Choosing which behaviour is "better" per feature, noting the call in that phase's plan for owner review.
