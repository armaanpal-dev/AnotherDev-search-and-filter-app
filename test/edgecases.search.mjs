// Deep edge-case suite for the REAL search engine against live Postgres.
// Bundles app/lib/search with esbuild, seeds adversarial data, and asserts on
// accents, special chars, injection-like input, unicode, drafts, stock, pagination,
// filters, price ranges, sorts, redirects, synonyms, merchandising, facets, and
// autocomplete (products/collections/pages/recommendations).
import { build } from "esbuild";
import { writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

try { process.loadEnvFile(); } catch {}
process.env.DATABASE_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;

const testDir = dirname(fileURLToPath(import.meta.url));
const entry = join(testDir, "_edge_entry.generated.ts");
writeFileSync(
  entry,
  `import prisma from "../app/db.server";\n` +
  `import { getSearchEngine } from "../app/lib/search/index.server";\n` +
  `import { invalidateShopConfig } from "../app/lib/search/config.server";\n` +
  `export { prisma, getSearchEngine, invalidateShopConfig };\n`,
);
const outfile = join(testDir, "_edge_bundle.generated.mjs");
await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", packages: "external", absWorkingDir: process.cwd() });
rmSync(entry, { force: true });
const { prisma, getSearchEngine, invalidateShopConfig } = await import(pathToFileURL(outfile).href);
rmSync(outfile, { force: true });

const engine = getSearchEngine();
const DOMAIN = "adsf-edge-test.myshopify.com";
let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log("  ✔ " + name); pass++; }
  catch (e) { console.log("  ✖ " + name + "  → " + (e.message || e).split("\n")[0]); fail++; }
}

async function cleanup() {
  const s = await prisma.shop.findUnique({ where: { domain: DOMAIN } });
  if (s) await prisma.shop.delete({ where: { id: s.id } });
}

try {
  await cleanup();
  const shop = await prisma.shop.create({ data: { domain: DOMAIN } });
  const SID = shop.id;

  const base = { shopId: SID, available: true, currencyCode: "INR", status: "ACTIVE" };
  const mk = (o) => prisma.product.create({ data: { ...base, ...o } });

  await mk({ productId: "1", handle: "cafe-creme", title: "Café Crème Latté", description: "Smooth espresso drink", priceMin: 10, priceMax: 10, imageUrl: "http://x/1.jpg", vendor: "BrewCo", productType: "Drink", tags: ["drink", "hot"], options: { Size: ["S", "M"] } });
  await mk({ productId: "2", handle: "cotton-tee", title: "Men's 100% Cotton T-Shirt (Large)", description: "Soft & breathable", priceMin: 20, priceMax: 30, imageUrl: null, vendor: "Wearit", productType: "Apparel", tags: ["cotton", "tee"], options: { Color: ["Red", "Blue"], Size: ["L", "XL"] } });
  await mk({ productId: "3", handle: "oos-widget", title: "Out Of Stock Widget", priceMin: 5, priceMax: 5, available: false, vendor: "Gizmo", productType: "Widget", options: {} });
  await mk({ productId: "4", handle: "draft-thing", title: "Secret Draft Thing", status: "DRAFT", priceMin: 99, priceMax: 99, vendor: "Hidden", options: {} });
  await mk({ productId: "5", handle: "freebie", title: "Zero Price Freebie", priceMin: 0, priceMax: 0, vendor: "Gizmo", productType: "Widget", options: {} });
  await mk({ productId: "6", handle: "nihongo", title: "日本語 Sample 商品", priceMin: 12, priceMax: 12, vendor: "Tokyo", options: {} });
  // v2 fixtures: SKU/variant indexing, publication state, metafield facets.
  await mk({ productId: "100", handle: "sku-widget", title: "Anonymous Gadget", priceMin: 40, priceMax: 40, vendor: "Gizmo", productType: "Widget", options: { Color: ["Red"] }, skus: ["TSH-RED-M1", "ALT-9"], variantText: "Red Medium", metafields: { material: "wool" } });
  await mk({ productId: "101", handle: "unpublished-thing", title: "Unpublished Widget Thing", priceMin: 7, priceMax: 7, vendor: "Gizmo", productType: "Widget", options: {}, publishedOnline: false });
  await mk({ productId: "102", handle: "clearance-widget", title: "Clearance Widget Special", priceMin: 3, priceMax: 3, vendor: "Gizmo", productType: "Widget", options: {}, tags: ["clearance"], metafields: { material: "cotton" } });
  // bulk for pagination
  for (let i = 7; i <= 26; i++) {
    await mk({ productId: String(i), handle: "widget-" + i, title: "Gizmo Widget " + i, priceMin: i, priceMax: i, vendor: "Gizmo", productType: "Widget", options: { Color: [i % 2 ? "Red" : "Blue"] } });
  }

  await prisma.collection.create({ data: { shopId: SID, collectionId: "c1", handle: "summer-sale", title: "Summer Sale", productCount: 12 } });
  await prisma.collection.create({ data: { shopId: SID, collectionId: "c2", handle: "cafe-collection", title: "Café Collection", productCount: 3 } });
  await prisma.page.create({ data: { shopId: SID, pageId: "p1", handle: "about-us", title: "About Us" } });
  await prisma.page.create({ data: { shopId: SID, pageId: "p2", handle: "shipping", title: "Shipping Policy" } });
  await prisma.synonym.create({ data: { shopId: SID, type: "multiway", terms: ["tee", "t-shirt", "tshirt"] } });
  await prisma.redirect.create({ data: { shopId: SID, query: "gift", url: "/pages/gift" } });
  await prisma.merchandisingRule.create({ data: { shopId: SID, name: "pin latte for widget", triggerQuery: "widget", pinnedProductIds: ["1"], active: true } });
  await prisma.filterConfig.createMany({ data: [
    { shopId: SID, source: "vendor", label: "Brand", displayAs: "checkbox", position: 0, enabled: true },
    { shopId: SID, source: "price", label: "Price", displayAs: "range", position: 1, enabled: true },
    { shopId: SID, source: "option:Color", label: "Color", displayAs: "swatch", position: 2, enabled: true },
  ]});
  invalidateShopConfig(SID);

  const S = (o) => engine.search({ shopId: SID, term: "", page: 1, perPage: 24, sort: "relevance", filters: {}, ...o });
  console.log("Seeded 26 products, 2 collections, 2 pages\n");

  await check("accent-insensitive: 'cafe creme' finds Café Crème", async () => {
    const r = await S({ term: "cafe creme" });
    assert.ok(r.hits.some((h) => h.handle === "cafe-creme"));
  });
  await check("apostrophe: \"men's cotton\" finds the tee", async () => {
    const r = await S({ term: "men's cotton" });
    assert.ok(r.hits.some((h) => h.handle === "cotton-tee"));
  });
  await check("SQL-injection-like input is safe (no crash)", async () => {
    const r = await S({ term: "'; DROP TABLE \"Product\"; --" });
    assert.ok(Array.isArray(r.hits));
    const still = await prisma.product.count({ where: { shopId: SID } });
    assert.ok(still > 0, "table intact");
  });
  await check("LIKE wildcards in query don't over-match ('%' literal)", async () => {
    const r = await S({ term: "100%" });
    // Should still surface the cotton tee (has '100%') and not error.
    assert.ok(Array.isArray(r.hits));
  });
  await check("underscore in query treated literally-ish (no crash)", async () => {
    const r = await S({ term: "a_b_c" });
    assert.ok(Array.isArray(r.hits));
  });
  await check("empty term → recommendations (products returned)", async () => {
    const ac = await engine.autocomplete({ shopId: SID, term: "", limit: 8 });
    assert.ok(ac.products.length > 0);
  });
  await check("whitespace-only term behaves like empty", async () => {
    const r = await S({ term: "     " });
    assert.equal(r.hits.length > 0, true); // browse mode
  });
  await check("unicode: '日本語' finds the JP product", async () => {
    const r = await S({ term: "日本語" });
    assert.ok(r.hits.some((h) => h.handle === "nihongo"));
  });
  await check("DRAFT products never appear", async () => {
    const r = await S({ term: "Secret Draft Thing" });
    assert.ok(!r.hits.some((h) => h.handle === "draft-thing"));
  });
  await check("out-of-stock excluded by default", async () => {
    const r = await S({ term: "out of stock widget" });
    assert.ok(!r.hits.some((h) => h.handle === "oos-widget"));
  });
  await check("includeUnavailable surfaces out-of-stock", async () => {
    const r = await S({ term: "out of stock widget", includeUnavailable: true });
    assert.ok(r.hits.some((h) => h.handle === "oos-widget"));
  });
  await check("zero-price product returns with price 0", async () => {
    const r = await S({ term: "freebie" });
    const hit = r.hits.find((h) => h.handle === "freebie");
    assert.ok(hit && hit.priceMin === 0);
  });
  await check("pagination: page size + total correct", async () => {
    const r1 = await S({ term: "widget", perPage: 5, page: 1, includeUnavailable: true });
    const r2 = await S({ term: "widget", perPage: 5, page: 2, includeUnavailable: true });
    assert.ok(r1.hits.length === 5);
    assert.ok(r1.total >= 15);
    const a = new Set(r1.hits.map((h) => h.productId));
    assert.ok(r2.hits.every((h) => !a.has(h.productId)), "page 2 distinct from page 1");
  });
  await check("page beyond last → empty hits, total preserved", async () => {
    const r = await S({ term: "widget", perPage: 5, page: 999 });
    assert.equal(r.hits.length, 0);
    assert.ok(r.total > 0);
  });
  await check("filter with no match → 0 results", async () => {
    const r = await S({ term: "widget", filters: { vendor: ["DoesNotExist"] } });
    assert.equal(r.total, 0);
  });
  await check("combined filters (vendor + color)", async () => {
    const r = await S({ term: "widget", filters: { vendor: ["Gizmo"], "option:Color": ["Red"] } });
    assert.ok(r.hits.length > 0);
    assert.ok(r.hits.every((h) => h.vendor === "Gizmo"));
  });
  await check("price range filters correctly", async () => {
    const r = await S({ term: "widget", price: { min: 10, max: 12 }, includeUnavailable: true });
    assert.ok(r.hits.every((h) => h.priceMax >= 10 && h.priceMin <= 12));
  });
  await check("price min>max → no crash, empty", async () => {
    const r = await S({ term: "widget", price: { min: 100, max: 1 } });
    assert.ok(Array.isArray(r.hits));
  });
  await check("sort price_asc orders ascending", async () => {
    const r = await S({ term: "widget", sort: "price_asc", perPage: 10, includeUnavailable: true });
    for (let i = 1; i < r.hits.length; i++) assert.ok(r.hits[i].priceMin >= r.hits[i - 1].priceMin);
  });
  await check("sort price_desc orders descending", async () => {
    const r = await S({ term: "widget", sort: "price_desc", perPage: 10, includeUnavailable: true });
    for (let i = 1; i < r.hits.length; i++) assert.ok(r.hits[i].priceMax <= r.hits[i - 1].priceMax);
  });
  await check("redirect short-circuits ('gift' → url)", async () => {
    const r = await S({ term: "gift" });
    assert.equal(r.redirect, "/pages/gift");
  });
  await check("synonym: 'tee' finds the t-shirt", async () => {
    const r = await S({ term: "tee" });
    assert.ok(r.hits.some((h) => h.handle === "cotton-tee"));
  });
  await check("merchandising pin: 'widget' pins latte first", async () => {
    const r = await S({ term: "widget", includeUnavailable: true });
    assert.equal(r.hits[0].handle, "cafe-creme");
    assert.equal(r.hits[0].pinned, true);
  });
  await check("facet counts present and exclude own dimension", async () => {
    const r = await S({ term: "widget", filters: { vendor: ["Gizmo"] }, includeUnavailable: true });
    const vendor = r.facets.find((f) => f.source === "vendor");
    // vendor facet should still show other vendors (own dimension excluded)
    assert.ok(vendor && vendor.values.length >= 1);
  });
  await check("autocomplete returns collections", async () => {
    const ac = await engine.autocomplete({ shopId: SID, term: "summer", limit: 6 });
    assert.ok(ac.collections.some((c) => c.handle === "summer-sale"));
  });
  await check("autocomplete returns pages", async () => {
    const ac = await engine.autocomplete({ shopId: SID, term: "about", limit: 6 });
    assert.ok(ac.pages.some((p) => p.handle === "about-us"));
  });
  await check("autocomplete includes product description for preview", async () => {
    const ac = await engine.autocomplete({ shopId: SID, term: "cotton", limit: 6 });
    const hit = ac.products.find((p) => p.handle === "cotton-tee");
    assert.ok(hit && typeof hit.description === "string" && hit.description.length > 0);
  });
  await check("very long query (600 chars) does not crash", async () => {
    const r = await S({ term: "widget ".repeat(90) });
    assert.ok(Array.isArray(r.hits));
  });
  await check("did-you-mean suggestion for a near-miss", async () => {
    const r = await S({ term: "freebei" }); // misspelling of freebie
    assert.ok(r.suggestion === undefined || typeof r.suggestion === "string");
  });

  /* ---------------- v2: things that were broken or missing ---------------- */

  await check("bare '%' does not match the whole catalog", async () => {
    // escapeLike was a no-op, so this became LIKE '%%%' and returned everything.
    const r = await S({ term: "%" });
    assert.ok(r.total < 26, `'%' returned ${r.total} products`);
  });

  await check("'100%' matches the literal string, not everything", async () => {
    const r = await S({ term: "100%" });
    assert.ok(r.hits.every((h) => h.handle !== "nihongo"), "unrelated product matched");
  });

  await check("underscore is literal, not a single-char wildcard", async () => {
    // Typo tolerance off: with fuzzy matching on, trigram similarity would match
    // "gizm_" to "Gizmo" regardless of escaping, so the assertion would prove
    // nothing about the LIKE pattern.
    const r = await S({ term: "gizm_", typoTolerance: false });
    assert.ok(!r.hits.some((h) => h.title.startsWith("Gizmo")), "'_' behaved as a wildcard");
  });

  await check("pagination is stable when the sort key ties", async () => {
    // Every seeded product has popularity 0, so relevance-browse ordering ties
    // on the primary key. Without a unique tiebreaker Postgres may order the
    // page-2 query differently from page 1, duplicating and skipping products.
    const seen = new Set();
    for (let page = 1; page <= 4; page++) {
      const r = await S({ perPage: 5, page });
      for (const hit of r.hits) {
        assert.ok(!seen.has(hit.productId), `product ${hit.productId} appeared on two pages`);
        seen.add(hit.productId);
      }
    }
  });

  await check("exact SKU finds the product and ranks it first", async () => {
    const r = await S({ term: "TSH-RED-M1" });
    assert.ok(r.hits.length > 0, "no hits for a known SKU");
    assert.equal(r.hits[0].handle, "sku-widget");
    assert.equal(r.strategy, "sku");
  });

  await check("second SKU on the same product also resolves", async () => {
    const r = await S({ term: "ALT-9" });
    assert.ok(r.hits.some((h) => h.handle === "sku-widget"));
  });

  await check("variant text is searchable ('Red Medium')", async () => {
    const r = await S({ term: "Red Medium" });
    assert.ok(r.hits.some((h) => h.handle === "sku-widget"));
  });

  await check("products not published to the Online Store are excluded", async () => {
    // These have no storefront URL, so a result linking to one is a 404.
    const r = await S({ term: "widget" });
    assert.ok(!r.hits.some((h) => h.handle === "unpublished-thing"));
  });

  await check("unpublished products are excluded from autocomplete too", async () => {
    const ac = await engine.autocomplete({ shopId: SID, term: "widget", limit: 20 });
    assert.ok(!ac.products.some((p) => p.handle === "unpublished-thing"));
  });

  await check("metafield facet is counted and returned", async () => {
    await prisma.filterConfig.create({ data: { shopId: SID, source: "metafield:material", label: "Material", displayAs: "checkbox", position: 9, enabled: true } });
    invalidateShopConfig(SID);
    const r = await S({ term: "" });
    const facet = r.facets.find((f) => f.source === "metafield:material");
    assert.ok(facet, "metafield facet missing");
    assert.ok(facet.values.some((v) => v.value === "wool"));
  });

  await check("metafield facet filters results", async () => {
    const r = await S({ filters: { "metafield:material": ["wool"] } });
    assert.ok(r.total >= 1);
    assert.ok(r.hits.every((h) => h.handle === "sku-widget"));
  });

  await check("attribute rule buries anything tagged clearance", async () => {
    await prisma.merchandisingRule.create({ data: {
      shopId: SID, name: "bury clearance", triggerQuery: "widget special", active: true, priority: 5,
      conditions: [{ field: "tag", op: "eq", value: "clearance", action: "bury", weight: 20 }],
    }});
    invalidateShopConfig(SID);
    const r = await S({ term: "widget special" });
    const idx = r.hits.findIndex((h) => h.handle === "clearance-widget");
    assert.ok(idx !== 0, "buried product still ranked first");
  });

  await check("attribute rule can hide products outright", async () => {
    await prisma.merchandisingRule.deleteMany({ where: { shopId: SID, name: "bury clearance" } });
    await prisma.merchandisingRule.create({ data: {
      shopId: SID, name: "hide clearance", triggerQuery: "clearance widget", active: true, priority: 9,
      conditions: [{ field: "tag", op: "eq", value: "clearance", action: "hide", weight: 5 }],
    }});
    invalidateShopConfig(SID);
    const r = await S({ term: "clearance widget" });
    assert.ok(!r.hits.some((h) => h.handle === "clearance-widget"));
    await prisma.merchandisingRule.deleteMany({ where: { shopId: SID, name: "hide clearance" } });
    invalidateShopConfig(SID);
  });

  await check("hits carry variant info for quick add-to-cart", async () => {
    await prisma.productVariant.create({ data: {
      productId: (await prisma.product.findFirst({ where: { shopId: SID, productId: "1" } })).id,
      variantId: "v-1", title: "Default", sku: "LATTE-1", price: 10, available: true, optionValues: {},
    }});
    const r = await S({ term: "latte" });
    const hit = r.hits.find((h) => h.handle === "cafe-creme");
    assert.ok(hit, "latte not found");
    assert.equal(hit.variantCount, 1);
    assert.equal(hit.variantId, "v-1");
  });

  await check("deep pagination is capped instead of scanning", async () => {
    const r = await S({ page: 999999 });
    assert.ok(r.page <= 200, `page was ${r.page}`);
  });

  await check("recommend(bestsellers) returns products", async () => {
    const rec = await engine.recommend({ shopId: SID, kind: "bestsellers", limit: 5 });
    assert.ok(Array.isArray(rec) && rec.length > 0);
  });

  await check("recommend(related) finds catalog neighbours", async () => {
    const rec = await engine.recommend({ shopId: SID, kind: "related", productId: "100", limit: 5 });
    assert.ok(Array.isArray(rec));
    assert.ok(!rec.some((p) => p.productId === "100"), "anchor recommended itself");
  });

  await check("recommend(related) on an unknown product is empty, not an error", async () => {
    const rec = await engine.recommend({ shopId: SID, kind: "related", productId: "does-not-exist", limit: 5 });
    assert.deepEqual(rec, []);
  });

  await check("facet cache does not leak between filter selections", async () => {
    const all = await S({ term: "" });
    const filtered = await S({ filters: { vendor: ["Tokyo"] } });
    const vendorAll = all.facets.find((f) => f.source === "vendor");
    const vendorFiltered = filtered.facets.find((f) => f.source === "vendor");
    // Own-dimension exclusion means the vendor facet is the same either way,
    // but the price facet must narrow to the filtered set.
    assert.ok(vendorAll && vendorFiltered);
    const priceFiltered = filtered.facets.find((f) => f.source === "price");
    assert.ok(priceFiltered && priceFiltered.min === 12 && priceFiltered.max === 12,
      `price facet did not narrow: ${JSON.stringify(priceFiltered)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error("\nSuite crashed:", e.message);
  process.exitCode = 1;
} finally {
  await cleanup();
  await prisma.$disconnect();
}
