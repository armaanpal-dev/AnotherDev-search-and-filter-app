// Regression tests for the fixes and features added after the code review.
//
// Every one of these covers a defect that shipped, or a new pure function that
// something security- or money-relevant depends on. They import the REAL modules
// through esbuild, same as the other suites, so a hand-copied duplicate cannot
// drift away from what actually runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleModule } from "./_bundle.mjs";

const { stripLiquidJson, defuseLiquidDeep } = await bundleModule(
  "../app/lib/search/normalize",
  "normalize-liquid",
);

const { toTsConfig, languageLabel, SEARCH_LANGUAGES } = await bundleModule(
  "../app/lib/search/languages",
  "languages",
);

const { bucketFor, DEFAULT_PROXY_BASE } = await bundleModule(
  "../app/lib/proxy.server",
  "proxy-server",
);

/* ------------------------------------------------- Liquid injection (JSON-LD) */

test("stripLiquidJson breaks every Liquid delimiter pair", () => {
  assert.equal(stripLiquidJson("{{ shop.email }}"), "{ { shop.email } }");
  assert.equal(stripLiquidJson("{% assign x = 1 %}"), "{ % assign x = 1 % }");
  assert.equal(stripLiquidJson("plain text"), "plain text");
});

test("stripLiquidJson leaves no zero-width characters in structured data", () => {
  // stripLiquid (the HTML variant) uses U+200B, which is invisible in a page but
  // a real character inside a product name a crawler reads.
  const out = stripLiquidJson("{{ x }}");
  assert.ok(!out.includes("​"), "JSON variant must not insert zero-width spaces");
});

test("defuseLiquidDeep neutralises a shopper-supplied search term", () => {
  // The exact shape of the bug: `?q={{ shop.email }}` reached the JSON-LD block
  // unescaped and Shopify executed it server-side in the merchant's context.
  const payload = {
    "@type": "ItemList",
    name: "Search results for {{ shop.email }}",
    itemListElement: [{ item: { name: "Tee {% assign a = shop %}" } }],
  };
  const safe = defuseLiquidDeep(payload);
  const json = JSON.stringify(safe);
  assert.ok(!json.includes("{{"), "no Liquid output tag may survive");
  assert.ok(!json.includes("%}"), "no Liquid statement tag may survive");
  assert.equal(safe.name, "Search results for { { shop.email } }");
});

test("defuseLiquidDeep keeps JSON structure intact", () => {
  // The reason this operates on values and not on the serialised string: JSON's
  // own braces are structural, so a blanket replace would corrupt the document.
  const safe = defuseLiquidDeep({ a: [1, 2], b: { c: true }, d: null });
  assert.deepEqual(safe, { a: [1, 2], b: { c: true }, d: null });
  assert.equal(JSON.parse(JSON.stringify(safe)).b.c, true);
});

test("defuseLiquidDeep defuses object keys too", () => {
  const safe = defuseLiquidDeep({ "{{ evil }}": "x" });
  assert.deepEqual(Object.keys(safe), ["{ { evil } }"]);
});

/* --------------------------------------------------------- search language */

test("toTsConfig only ever returns an allowlisted configuration", () => {
  // This value is interpolated into SQL as an identifier, so the allowlist is
  // the entire defence.
  assert.equal(toTsConfig("english"), "english");
  assert.equal(toTsConfig("ENGLISH"), "english");
  assert.equal(toTsConfig("klingon"), "simple");
  assert.equal(toTsConfig(null), "simple");
  assert.equal(toTsConfig(undefined), "simple");
  assert.equal(toTsConfig("'; DROP TABLE \"Product\"; --"), "simple");
});

test("every offered language is one toTsConfig accepts", () => {
  for (const lang of SEARCH_LANGUAGES) {
    assert.equal(toTsConfig(lang.value), lang.value, `${lang.value} must round-trip`);
    assert.ok(languageLabel(lang.value).length > 0);
  }
});

/* ---------------------------------------------------------------- A/B buckets */

test("bucketFor is stable for one shopper", () => {
  const token = "abc123xyz";
  assert.equal(bucketFor(token), bucketFor(token));
});

test("bucketFor gives no bucket without a session token", () => {
  // A shopper with storage disabled must fall through to the unbucketed rules
  // rather than being silently pinned to one arm.
  assert.equal(bucketFor(""), undefined);
  assert.equal(bucketFor(null), undefined);
  assert.equal(bucketFor(undefined), undefined);
});

test("bucketFor splits roughly evenly", () => {
  let a = 0;
  for (let i = 0; i < 2000; i++) {
    if (bucketFor(`session-${i}-${i * 7}`) === "a") a++;
  }
  // A character sum would clump; anything inside 45–55% is a usable split.
  assert.ok(a > 900 && a < 1100, `expected a near-even split, got ${a}/2000 in A`);
});

test("the proxy base is a same-origin path", () => {
  assert.ok(DEFAULT_PROXY_BASE.startsWith("/"));
  assert.ok(!DEFAULT_PROXY_BASE.startsWith("//"));
});

/* --------------------------------------------------------- CSV injection */

// analytics.server imports prisma, so it cannot be bundled the way the pure
// modules are. `csvCell` is re-declared nowhere — this pulls the real one out by
// bundling only that module with the db import stubbed, which keeps the test
// honest about the shipped implementation.
const { csvCell } = await bundleModule("../app/lib/analytics.server", "analytics-csv").catch(
  async () => {
    // Prisma's client is generated, so if it is unavailable the suite should say
    // so loudly rather than silently skipping a security regression test.
    throw new Error("could not bundle analytics.server — run `npx prisma generate`");
  },
);

test("csvCell defuses spreadsheet formulas", () => {
  // Search terms are typed by anonymous shoppers and land in a CSV the merchant
  // opens in Excel, where a leading =, +, - or @ is executed as a formula.
  assert.equal(csvCell('=HYPERLINK("http://evil","x")'), `"'=HYPERLINK(""http://evil"",""x"")"`);
  assert.equal(csvCell("+1+1"), `"'+1+1"`);
  assert.equal(csvCell("-2"), `"'-2"`);
  assert.equal(csvCell("@SUM(A1)"), `"'@SUM(A1)"`);
  assert.equal(csvCell("\tcmd"), `"'\tcmd"`);
});

test("csvCell leaves ordinary values alone", () => {
  assert.equal(csvCell("winter jacket"), '"winter jacket"');
  assert.equal(csvCell("10% off"), '"10% off"');
  assert.equal(csvCell(""), '""');
});

test("csvCell still escapes embedded quotes", () => {
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
});

/* ------------------------------------------------- streaming bulk JSONL */

const { streamBulkJsonl, parseBulkJsonl } = await bundleModule(
  "../app/lib/sync/bulk.server",
  "bulk-stream",
);

/** A ReadableStream of `text`, chopped at arbitrary byte boundaries so the
 *  reader's line reassembly is actually exercised. */
function chunkedStream(text, size = 7) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

const JSONL = [
  JSON.stringify({
    id: "gid://shopify/Product/1", handle: "tee", title: "Tee", status: "ACTIVE",
    tags: ["new"], priceRangeV2: { minVariantPrice: { amount: "10.0", currencyCode: "GBP" } },
  }),
  JSON.stringify({
    id: "gid://shopify/ProductVariant/11", title: "Red / M", sku: "TEE-RED-M",
    price: "10.0", availableForSale: true,
    selectedOptions: [{ name: "Colour", value: "Red" }],
    __parentId: "gid://shopify/Product/1",
  }),
  JSON.stringify({ id: "gid://shopify/Collection/99", handle: "summer", __parentId: "gid://shopify/Product/1" }),
  JSON.stringify({
    id: "gid://shopify/Product/2", handle: "cap", title: "Cap", status: "ACTIVE",
    priceRangeV2: { minVariantPrice: { amount: "5.0", currencyCode: "GBP" } },
  }),
  JSON.stringify({
    id: "gid://shopify/ProductVariant/21", title: "One size", sku: "CAP-1",
    price: "5.0", availableForSale: false, __parentId: "gid://shopify/Product/2",
  }),
].join("\n");

test("streamBulkJsonl groups children under their parent across chunk boundaries", async () => {
  const seen = [];
  const total = await streamBulkJsonl(chunkedStream(JSONL), 10, async (batch) => {
    seen.push(...batch);
  });
  assert.equal(total, 2);
  assert.equal(seen.length, 2);

  const tee = seen.find((p) => p.productId === "1");
  assert.equal(tee.title, "Tee");
  assert.equal(tee.variants.length, 1);
  assert.deepEqual(tee.collections, ["summer"]);
  assert.deepEqual(tee.options, { Colour: ["Red"] });
  assert.equal(tee.available, true);

  const cap = seen.find((p) => p.productId === "2");
  assert.equal(cap.available, false, "no available variant means the product is not available");
});

test("streamBulkJsonl agrees with the whole-string parser", async () => {
  const streamed = [];
  await streamBulkJsonl(chunkedStream(JSONL), 1, async (b) => { streamed.push(...b); });
  const parsed = parseBulkJsonl(JSONL);
  const key = (p) => p.productId;
  assert.deepEqual(streamed.map(key).sort(), parsed.map(key).sort());
});

test("streamBulkJsonl stops when the callback says to", async () => {
  // This is how the Free plan's product limit avoids parsing a catalog it will
  // not index — and it has to stop, not just discard.
  let batches = 0;
  const total = await streamBulkJsonl(chunkedStream(JSONL), 1, async () => {
    batches++;
    return false;
  });
  assert.equal(batches, 1, "must not keep reading after a false return");
  assert.equal(total, 1);
});

test("streamBulkJsonl tolerates a child arriving before its parent", async () => {
  // Shopify emits parents first, but nothing in the format guarantees it, and a
  // silently dropped product is the worst possible failure for an index.
  const reordered = [
    JSON.stringify({
      id: "gid://shopify/ProductVariant/31", title: "S", sku: "X-S", price: "1.0",
      availableForSale: true, __parentId: "gid://shopify/Product/3",
    }),
    JSON.stringify({
      id: "gid://shopify/Product/3", handle: "x", title: "X", status: "ACTIVE",
      priceRangeV2: { minVariantPrice: { amount: "1.0", currencyCode: "GBP" } },
    }),
  ].join("\n");
  const seen = [];
  await streamBulkJsonl(chunkedStream(reordered), 10, async (b) => { seen.push(...b); });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].variants.length, 1);
});

test("streamBulkJsonl skips malformed lines instead of aborting", async () => {
  const withJunk = `not json\n${JSONL}\n{"broken":`;
  const seen = [];
  await streamBulkJsonl(chunkedStream(withJunk), 10, async (b) => { seen.push(...b); });
  assert.equal(seen.length, 2);
});
