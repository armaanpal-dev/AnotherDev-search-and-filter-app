// Unit tests for the features ported from the source app (banners, blacklist,
// size mapping, merged values, filter groups, CSV, quick view variant logic).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleModule } from "./_bundle.mjs";

const f = await bundleModule("../app/lib/search/features", "features");
const csv = await bundleModule("../app/lib/merch/csv", "merchcsv");
const sharedCache = await bundleModule("../app/lib/shared-cache", "sharedcache");

/* ---------------------------------------------------------------- banners */
const form = (o) => ({ get: (k) => (k in o ? o[k] : null) });

test("validateBanner: top banners need an image", () => {
  assert.throws(() => f.validateBanner(form({ query: "shoes", placement: "top" })), /image/i);
});

test("validateBanner: grid defaults colours and clamps position", () => {
  const b = f.validateBanner(form({ query: "  Shoes ", placement: "grid", position: "0", heading: "Hi" }));
  assert.equal(b.query, "shoes");
  assert.equal(b.position, 1);
  assert.equal(b.backgroundColor, "#f4f4f5");
  assert.equal(b.textColor, "#18181b");
});

test("validateBanner: rejects off-site and protocol-relative links", () => {
  assert.throws(() => f.validateBanner(form({ query: "x", placement: "grid", heading: "h", targetUrl: "//evil.com" })), /link/i);
  assert.throws(() => f.validateBanner(form({ query: "x", placement: "grid", heading: "h", targetUrl: "javascript:alert(1)" })), /link/i);
  assert.equal(f.validateBanner(form({ query: "x", placement: "grid", heading: "h", targetUrl: "/collections/sale" })).targetUrl, "/collections/sale");
});

test("validateBanner: rejects a bad colour", () => {
  assert.throws(() => f.validateBanner(form({ query: "x", placement: "grid", heading: "h", backgroundColor: "red;}" })), /colour/i);
});

test("placeGridBanners inserts at 1-based positions", () => {
  const out = f.placeGridBanners(["a", "b", "c"], [{ position: 2, id: "B" }]);
  assert.deepEqual(out.map((x) => (typeof x === "string" ? x : x.banner.id)), ["a", "B", "b", "c"]);
});

/* -------------------------------------------------------------- blacklist */
test("isSuggestionBlocked: operators and normalisation", () => {
  const rules = [
    { term: "free", operator: "contains" },
    { term: "Cheap", operator: "starts_with" },
    { term: "test", operator: "equals" },
  ];
  assert.equal(f.isSuggestionBlocked("Totally FREE stuff", rules), true);
  assert.equal(f.isSuggestionBlocked("cheap shoes", rules), true);
  assert.equal(f.isSuggestionBlocked("shoes cheap", rules), false);
  assert.equal(f.isSuggestionBlocked("  TEST ", rules), true);
  assert.equal(f.isSuggestionBlocked("testing", rules), false);
  assert.equal(f.isSuggestionBlocked("café", [{ term: "cafe", operator: "equals" }]), true);
});

/* ------------------------------------------------------------ query lists */
test("parseQueryList trims, normalises, dedupes, caps at 50", () => {
  assert.deepEqual(f.parseQueryList(" Shoes, shoes\nBoots ,, "), ["shoes", "boots"]);
  const many = Array.from({ length: 80 }, (_, i) => "q" + i).join(",");
  assert.equal(f.parseQueryList(many).length, 50);
});

/* ----------------------------------------------------------- size mapping */
test("sortSizeValues: built-in order, numeric, merchant map, unmapped last", () => {
  assert.deepEqual(f.sortSizeValues(["L", "XS", "M", "XXL", "S"], new Map()), ["XS", "S", "M", "L", "XXL"]);
  assert.deepEqual(f.sortSizeValues(["10", "8", "9.5"], new Map()), ["8", "9.5", "10"]);
  assert.deepEqual(f.sortSizeValues(["Tall", "Petite", "M"], new Map([["petite", 1]])), ["Petite", "M", "Tall"]);
  assert.deepEqual(f.sortSizeValues(["Zeta", "Alpha", "S"], new Map()), ["S", "Alpha", "Zeta"]);
});

/* ---------------------------------------------------------- merged values */
const merges = [{ source: "option:Color", target: "Red", sourceValues: ["Crimson", "red", "Scarlet"] }];

test("expandMergedSelection adds every source value of a selected target", () => {
  const out = f.expandMergedSelection({ "option:Color": ["Red", "Blue"], vendor: ["Nike"] }, merges);
  assert.deepEqual(new Set(out["option:Color"]), new Set(["Red", "Blue", "Crimson", "red", "Scarlet"]));
  assert.deepEqual(out.vendor, ["Nike"]);
});

test("mergeFacetValues folds sources into the target and sums counts", () => {
  const out = f.mergeFacetValues("option:Color", [
    { value: "Crimson", label: "Crimson", count: 3 },
    { value: "Red", label: "Red", count: 2 },
    { value: "Blue", label: "Blue", count: 4 },
    { value: "Scarlet", label: "Scarlet", count: 1 },
  ], merges);
  assert.deepEqual(out, [
    { value: "Red", label: "Red", count: 6 },
    { value: "Blue", label: "Blue", count: 4 },
  ]);
});

/* ---------------------------------------------------------- filter groups */
test("facetSourcesFor picks the group for the collection, else null", () => {
  const groups = [
    { collections: ["shoes"], sources: ["option:Size", "price"] },
    { collections: [], sources: ["vendor"] },
  ];
  assert.deepEqual(f.facetSourcesFor("shoes", groups), ["option:Size", "price"]);
  assert.equal(f.facetSourcesFor("hats", groups), null);
  assert.equal(f.facetSourcesFor(undefined, groups), null);
});

/* ------------------------------------------------------------- quick view */
const product = {
  options: [{ name: "Size" }, { name: "Color" }],
  variants: [
    { id: 1, options: ["S", "Red"], available: false },
    { id: 2, options: ["M", "Red"], available: true },
    { id: 3, options: ["M", "Blue"], available: true },
  ],
};

test("resolveVariant matches selected options", () => {
  assert.equal(f.resolveVariant(product, ["M", "Blue"]).id, 3);
  assert.equal(f.resolveVariant(product, ["S", "Blue"]), null);
});

test("firstAvailableVariant falls back to the first variant when all are sold out", () => {
  assert.equal(f.firstAvailableVariant(product).id, 2);
  const soldOut = { ...product, variants: product.variants.map((v) => ({ ...v, available: false })) };
  const v = f.firstAvailableVariant(soldOut);
  assert.equal(v.id, 1);
  assert.equal(v.available, false);
  assert.equal(f.firstAvailableVariant({ options: [], variants: [] }), null);
});

/* -------------------------------------------------------------------- CSV */
test("merch CSV round-trips rules", () => {
  const rules = [{ name: 'Sale, "big"', triggerQuery: "shoes", triggerCollection: null, pinnedProductIds: ["1", "2"],
    boostedProductIds: [], buriedProductIds: ["3"], hiddenProductIds: [], priority: 5, active: true }];
  const { rows, errors } = csv.parseRulesCsv(csv.exportRulesCsv(rules));
  assert.deepEqual(errors, []);
  assert.equal(rows[0].name, 'Sale, "big"');
  assert.deepEqual(rows[0].pinnedProductIds, ["1", "2"]);
  assert.deepEqual(rows[0].buriedProductIds, ["3"]);
  assert.equal(rows[0].priority, 5);
});

test("merch CSV reports bad rows and keeps good ones", () => {
  const text = "name,trigger_query,trigger_collection,pinned,boosted,buried,hidden,priority,active\n" +
    ",shoes,,1,,,,0,true\n" +
    "Good,,,abc,,,,0,true\n" +
    "Ok,boots,,1,,,,x,true\n";
  const { rows, errors } = csv.parseRulesCsv(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Ok");
  assert.equal(rows[0].priority, 0);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /row 2/i);
});

/* ----------------------------------------------------------- shared cache */
test("memory shared cache get/set/expiry/del", async () => {
  const c = new sharedCache.MemorySharedCache();
  await c.set("a", "1", 1000);
  assert.equal(await c.get("a"), "1");
  await c.set("b", "2", -1);
  assert.equal(await c.get("b"), null);
  await c.del("a");
  assert.equal(await c.get("a"), null);
});

/* ------------------------------------------------------- card action setting */
const settingsMod = await bundleModule("../app/lib/settings", "settings2");
test("cardAction derives from legacy quickAdd and keeps quickAdd in step", () => {
  assert.equal(settingsMod.resolveSettings({}).cardAction, "none");
  assert.equal(settingsMod.resolveSettings({ quickAdd: true }).cardAction, "quick_add");
  const qv = settingsMod.resolveSettings({ quickAdd: true, cardAction: "quick_view" });
  assert.equal(qv.cardAction, "quick_view");
  assert.equal(qv.quickAdd, false);
  assert.equal(settingsMod.resolveSettings({ cardAction: "bogus" }).cardAction, "none");
});

test("emptySearchProductIds keeps numeric ids only", () => {
  assert.deepEqual(settingsMod.resolveSettings({ emptySearchProductIds: ["1", "1", "x", 22] }).emptySearchProductIds, ["1", "22"]);
});
