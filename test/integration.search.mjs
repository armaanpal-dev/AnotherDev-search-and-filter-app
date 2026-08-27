// End-to-end integration test of the REAL production search engine against the
// live Postgres DB. Bundles app/lib/search with esbuild (so it runs the actual
// postgres.server.ts / config.server.ts / normalize.ts), seeds a throwaway shop,
// and asserts on search, synonyms, typo tolerance, facets, and merchandising.
//
// Run with: node test/integration.search.mjs   (needs DATABASE_URL/DIRECT_URL)
import { build } from "esbuild";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

try { process.loadEnvFile(); } catch {}

// db.server.ts reads DATABASE_URL; force the reachable pooler URL for both.
process.env.DATABASE_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;

// 1. Generate a bundle entry INSIDE the project so ../app/* imports resolve,
//    then bundle it with esbuild to run the real engine code.
const testDir = dirname(fileURLToPath(import.meta.url));
const entry = join(testDir, "_entry.generated.ts");
writeFileSync(
  entry,
  `import prisma from "../app/db.server";\n` +
  `import { getSearchEngine } from "../app/lib/search/index.server";\n` +
  `import { invalidateShopConfig } from "../app/lib/search/config.server";\n` +
  `export { prisma, getSearchEngine, invalidateShopConfig };\n`,
);

// Output inside the project so external deps (@prisma/client) resolve via node_modules.
const outfile = join(testDir, "_bundle.generated.mjs");
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external", // keep @prisma/client, etc. as runtime deps
  absWorkingDir: process.cwd(),
});
rmSync(entry, { force: true });

const { prisma, getSearchEngine, invalidateShopConfig } = await import(
  pathToFileURL(outfile).href
);
rmSync(outfile, { force: true });

const engine = getSearchEngine();
let pass = 0;
const ok = (name) => { console.log(`  ✔ ${name}`); pass++; };

const DOMAIN = "adsf-integration-test.myshopify.com";

async function cleanup() {
  const s = await prisma.shop.findUnique({ where: { domain: DOMAIN } });
  if (s) await prisma.shop.delete({ where: { id: s.id } });
}

try {
  await cleanup();

  // 2. Seed a shop with products, a synonym, a filter, and a merch rule.
  const shop = await prisma.shop.create({ data: { domain: DOMAIN } });
  const products = [
    { productId: "101", handle: "red-running-shoes", title: "Red Running Shoes", vendor: "Nike", productType: "Shoes", tags: ["running", "red"], priceMin: 99, priceMax: 99, options: { Color: ["Red"], Size: ["M", "L"] } },
    { productId: "102", handle: "blue-sneakers", title: "Blue Sneakers", vendor: "Adidas", productType: "Shoes", tags: ["casual", "blue"], priceMin: 79, priceMax: 79, options: { Color: ["Blue"], Size: ["M"] } },
    { productId: "103", handle: "trail-trainers", title: "Trail Trainers", vendor: "Nike", productType: "Shoes", tags: ["running", "trail"], priceMin: 129, priceMax: 129, options: { Color: ["Green"], Size: ["L"] } },
    { productId: "104", handle: "leather-jacket", title: "Leather Jacket", vendor: "Zara", productType: "Outerwear", tags: ["winter"], priceMin: 199, priceMax: 199, options: { Color: ["Black"] } },
  ];
  for (const p of products) {
    await prisma.product.create({ data: { ...p, shopId: shop.id, available: true, currencyCode: "USD", status: "ACTIVE" } });
  }
  // "trainer" == "sneaker" == "running shoe"
  await prisma.synonym.create({ data: { shopId: shop.id, type: "multiway", terms: ["trainer", "sneaker", "running shoe"] } });
  await prisma.filterConfig.createMany({ data: [
    { shopId: shop.id, source: "vendor", label: "Brand", displayAs: "checkbox", position: 0, enabled: true },
    { shopId: shop.id, source: "price", label: "Price", displayAs: "range", position: 1, enabled: true },
    { shopId: shop.id, source: "option:Color", label: "Color", displayAs: "swatch", position: 2, enabled: true },
  ]});
  // Pin the leather jacket to the top for the query "shoes".
  await prisma.merchandisingRule.create({ data: { shopId: shop.id, name: "pin jacket", triggerQuery: "shoes", pinnedProductIds: ["104"], active: true } });
  invalidateShopConfig(shop.id);
  console.log("Seeded shop", shop.id.slice(0, 8), "with", products.length, "products\n");

  const S = (opts) => engine.search({ shopId: shop.id, term: "", page: 1, perPage: 24, sort: "relevance", filters: {}, ...opts });

  // 3a. Full-text relevance
  let r = await S({ term: "running shoes" });
  assert.ok(r.hits.length >= 1, "expected running-shoes hits");
  assert.equal(r.hits[0].handle, "red-running-shoes");
  ok("full-text: 'running shoes' ranks Red Running Shoes first");

  // 3b. Typo tolerance
  r = await S({ term: "runing shoos" });
  assert.ok(r.hits.some((h) => h.handle === "red-running-shoes"), "typo should still match");
  ok("typo tolerance: 'runing shoos' finds Red Running Shoes");

  // 3c. Synonym expansion — "trainer" should surface sneakers via the synonym group
  r = await S({ term: "trainer" });
  const handles = r.hits.map((h) => h.handle);
  assert.ok(handles.includes("blue-sneakers") || handles.includes("trail-trainers"), "synonym expansion failed");
  ok("synonyms: 'trainer' expands to sneakers/trainers");

  // 3d. Facets present with counts
  r = await S({ term: "shoes" });
  const vendorFacet = r.facets.find((f) => f.source === "vendor");
  assert.ok(vendorFacet && vendorFacet.values.length >= 2, "vendor facet missing");
  const nike = vendorFacet.values.find((v) => v.value === "Nike");
  assert.ok(nike && nike.count === 2, "Nike should have 2 shoes");
  ok("facets: vendor facet counts correct (Nike=2)");

  // 3e. Filtering by facet
  r = await S({ term: "shoes", filters: { vendor: ["Nike"] } });
  const nonPinned = r.hits.filter((h) => !h.pinned);
  assert.ok(nonPinned.every((h) => h.vendor === "Nike"), "vendor filter leaked non-Nike");
  ok("filtering: vendor=Nike returns only Nike products");

  // 3f. Price range facet has min/max
  const priceFacet = r.facets.find((f) => f.source === "price");
  assert.ok(priceFacet && priceFacet.min != null && priceFacet.max != null, "price facet missing range");
  ok("facets: price range facet exposes min/max");

  // 3g. Merchandising pin — jacket pinned to top for "shoes"
  r = await S({ term: "shoes" });
  assert.equal(r.hits[0].handle, "leather-jacket", "pinned product not first");
  assert.equal(r.hits[0].pinned, true, "pin flag not set");
  ok("merchandising: pinned Leather Jacket appears first for 'shoes'");

  // 3h. Autocomplete
  const ac = await engine.autocomplete({ shopId: shop.id, term: "red", limit: 5 });
  assert.ok(ac.products.some((p) => p.handle === "red-running-shoes"), "autocomplete miss");
  ok("autocomplete: 'red' suggests Red Running Shoes");

  // 3i. Browse mode (empty term) returns all, sorted
  r = await S({ term: "", sort: "price_asc", perPage: 10 });
  assert.equal(r.hits.length, 4, "browse should return all 4");
  assert.ok(r.hits[0].priceMin <= r.hits[1].priceMin, "price_asc not sorted");
  ok("browse: empty term returns all products, price_asc sorted");

  console.log(`\nAll ${pass} integration checks passed against live Postgres.`);
} catch (e) {
  console.error("\n✖ Integration test FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await cleanup();
  await prisma.$disconnect();
}
