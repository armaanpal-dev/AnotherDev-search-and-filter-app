// Unit tests for app/lib/sync/normalize-product.ts — the shape every source is
// mapped into before it reaches the index.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleModule } from "./_bundle.mjs";

const {
  gidId,
  optionsFromVariants,
  variantIndexFields,
  stripHtml,
  normalizeRestProduct,
} = await bundleModule("../app/lib/sync/normalize-product", "normalizeproduct");

/* -------------------------------------------------------------------- gids */

test("gidId extracts the numeric id", () => {
  assert.equal(gidId("gid://shopify/Product/81234567890"), "81234567890");
  assert.equal(gidId("gid://shopify/ProductVariant/42?foo=1"), "42");
});

test("gidId passes through anything that isn't a gid", () => {
  assert.equal(gidId("already-plain"), "already-plain");
});

/* ---------------------------------------------------------------- stripHtml */

test("stripHtml removes markup", () => {
  assert.equal(stripHtml("<p>Soft <b>cotton</b> tee</p>"), "Soft cotton tee");
});

test("stripHtml drops script and style content entirely", () => {
  // Indexing script bodies makes products match on JavaScript keywords.
  const out = stripHtml("<style>.a{color:red}</style><script>alert(1)</script>Real text");
  assert.equal(out, "Real text");
});

test("stripHtml decodes entities instead of blanking them", () => {
  // Numeric entities used to become spaces, so every description written with a
  // curly apostrophe lost the word boundary around it.
  assert.equal(stripHtml("Men&#39;s tee"), "Men's tee");
  assert.equal(stripHtml("Tea &amp; Coffee"), "Tea & Coffee");
  assert.equal(stripHtml("caf&#xe9;"), "café");
});

test("stripHtml is bounded and whitespace-collapsed", () => {
  assert.ok(stripHtml("<p>" + "x".repeat(9000) + "</p>").length <= 5000);
  assert.equal(stripHtml("a\n\n   b"), "a b");
});

/* ------------------------------------------------------------------ options */

test("optionsFromVariants collects distinct values per option", () => {
  const opts = optionsFromVariants([
    { optionValues: { Color: "Red", Size: "S" } },
    { optionValues: { Color: "Blue", Size: "S" } },
  ]);
  assert.deepEqual(opts.Color.sort(), ["Blue", "Red"]);
  assert.deepEqual(opts.Size, ["S"]);
});

test("optionsFromVariants ignores Shopify's placeholder option", () => {
  // Single-variant products carry "Default Title"; surfacing it as a facet value
  // puts a meaningless filter in front of every shopper.
  const opts = optionsFromVariants([{ optionValues: { Title: "Default Title" } }]);
  assert.deepEqual(opts, {});
});

/* ------------------------------------------------------------- variant index */

test("variantIndexFields collects SKUs and variant names", () => {
  const out = variantIndexFields({
    variants: [
      { sku: "TSH-RED-M", title: "Red / M" },
      { sku: "TSH-RED-L", title: "Red / L" },
      { sku: "", title: "Default Title" },
    ],
  });
  assert.deepEqual(out.skus, ["TSH-RED-M", "TSH-RED-L"]);
  assert.ok(out.variantText.includes("Red / M"));
  assert.ok(!out.variantText.includes("Default Title"));
});

test("variantIndexFields de-duplicates and bounds", () => {
  const variants = Array.from({ length: 500 }, () => ({ sku: "SAME", title: "T" }));
  const out = variantIndexFields({ variants });
  assert.deepEqual(out.skus, ["SAME"]);
  assert.ok(out.variantText.length <= 2000);
});

/* ------------------------------------------------------- REST webhook shape */

const REST_PRODUCT = {
  id: 900,
  handle: "cotton-tee",
  title: "Cotton Tee",
  body_html: "<p>Soft &amp; breathable</p>",
  vendor: "Wearit",
  product_type: "Apparel",
  tags: "cotton, tee",
  status: "active",
  published_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
  options: [{ name: "Color" }, { name: "Size" }],
  images: [{ src: "https://cdn/x.jpg", alt: "tee" }],
  variants: [
    { id: 1, title: "Red / M", sku: "T-R-M", price: "20.00", option1: "Red", option2: "M", inventory_quantity: 3, inventory_management: "shopify" },
    { id: 2, title: "Blue / L", sku: "T-B-L", price: "30.00", option1: "Blue", option2: "L", inventory_quantity: 0, inventory_management: "shopify" },
  ],
};

test("normalizeRestProduct maps the payload", () => {
  const p = normalizeRestProduct(REST_PRODUCT);
  assert.equal(p.productId, "900");
  assert.equal(p.title, "Cotton Tee");
  assert.equal(p.description, "Soft & breathable");
  assert.deepEqual(p.tags, ["cotton", "tee"]);
  assert.equal(p.priceMin, 20);
  assert.equal(p.priceMax, 30);
  assert.equal(p.imageUrl, "https://cdn/x.jpg");
  assert.deepEqual(p.options.Color.sort(), ["Blue", "Red"]);
  assert.equal(p.available, true, "one variant has stock");
});

test("normalizeRestProduct leaves full-sync-only fields empty", () => {
  // These are what upsert.server refuses to write on the webhook path. If this
  // ever stops being empty, that guard silently starts blanking real data.
  const p = normalizeRestProduct(REST_PRODUCT);
  assert.deepEqual(p.collections, []);
  assert.deepEqual(p.metafields, {});
  assert.equal(p.currencyCode, "");
});

test("publishedOnline follows published_at", () => {
  assert.equal(normalizeRestProduct(REST_PRODUCT).publishedOnline, true);
  const unpublished = normalizeRestProduct({ ...REST_PRODUCT, published_at: null });
  assert.equal(unpublished.publishedOnline, false);
});

test("zero-priced products keep a real price range", () => {
  // Free samples and gift wrap are real products; filtering price 0 out of the
  // range indexed them as 0–0 and dropped them from every price filter.
  const p = normalizeRestProduct({
    ...REST_PRODUCT,
    variants: [{ id: 1, title: "Free", sku: "F", price: "0.00", inventory_management: null }],
  });
  assert.equal(p.priceMin, 0);
  assert.equal(p.priceMax, 0);
  assert.equal(p.available, true, "untracked inventory is available");
});

test("availability follows inventory policy", () => {
  const oversell = normalizeRestProduct({
    ...REST_PRODUCT,
    variants: [{ id: 1, title: "X", price: "5", inventory_quantity: 0, inventory_management: "shopify", inventory_policy: "continue" }],
  });
  assert.equal(oversell.available, true, "continue-selling variants are available");

  const soldOut = normalizeRestProduct({
    ...REST_PRODUCT,
    variants: [{ id: 1, title: "X", price: "5", inventory_quantity: 0, inventory_management: "shopify", inventory_policy: "deny" }],
  });
  assert.equal(soldOut.available, false);
});

test("normalizeRestProduct tolerates array tags and missing fields", () => {
  const p = normalizeRestProduct({ id: 1, tags: ["a", "b"] });
  assert.deepEqual(p.tags, ["a", "b"]);
  assert.equal(p.title, "");
  assert.equal(p.imageUrl, null);
  assert.deepEqual(p.variants, []);
  assert.equal(p.available, false);
});

test("normalizeRestProduct returns null without an id", () => {
  assert.equal(normalizeRestProduct({}), null);
  assert.equal(normalizeRestProduct(null), null);
});

test("status is upper-cased for the index", () => {
  assert.equal(normalizeRestProduct({ id: 1, status: "draft" }).status, "DRAFT");
  assert.equal(normalizeRestProduct({ id: 1 }).status, "ACTIVE");
});
