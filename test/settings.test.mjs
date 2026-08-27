// Unit tests for app/lib/settings.ts — merge semantics and input hardening.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleModule } from "./_bundle.mjs";

const { resolveSettings, mergeSettings, DEFAULT_SETTINGS } = await bundleModule(
  "../app/lib/settings",
  "settings",
);

/* ------------------------------------------------------------ merge safety */

test("mergeSettings preserves settings the form did not submit", () => {
  // The regression this pins: the Settings form renders ~13 of the fields, and
  // rebuilding the whole object from the form reset every other one to its
  // default on each save.
  const stored = {
    ...DEFAULT_SETTINGS,
    resultsPerPage: 48,
    gridColumns: 2,
    showVendor: true,
    recentSearches: false,
    collectionFilters: false,
  };
  const next = mergeSettings(stored, { accentColor: "#ff0000" });

  assert.equal(next.accentColor, "#ff0000");
  assert.equal(next.resultsPerPage, 48);
  assert.equal(next.gridColumns, 2);
  assert.equal(next.showVendor, true);
  assert.equal(next.recentSearches, false);
  assert.equal(next.collectionFilters, false);
});

test("mergeSettings ignores undefined but honours false", () => {
  const stored = { ...DEFAULT_SETTINGS, typoTolerance: true };
  assert.equal(mergeSettings(stored, { typoTolerance: undefined }).typoTolerance, true);
  // Unticking a checkbox must actually turn the setting off.
  assert.equal(mergeSettings(stored, { typoTolerance: false }).typoTolerance, false);
});

/* ---------------------------------------------------------------- coercion */

test("numeric settings are clamped to their allowed range", () => {
  const s = resolveSettings({ minChars: 99, gridColumns: 0, resultsPerPage: 9999 });
  assert.equal(s.minChars, 4);
  assert.equal(s.gridColumns, 2);
  assert.equal(s.resultsPerPage, 48);
});

test("unknown enum values fall back to the default", () => {
  assert.equal(resolveSettings({ panelStyle: "wat" }).panelStyle, DEFAULT_SETTINGS.panelStyle);
  assert.equal(resolveSettings({ layout: "grid" }).layout, DEFAULT_SETTINGS.layout);
});

test("resolveSettings survives junk input", () => {
  assert.equal(resolveSettings(null).minChars, DEFAULT_SETTINGS.minChars);
  assert.equal(resolveSettings("nonsense").accentColor, DEFAULT_SETTINGS.accentColor);
  assert.equal(resolveSettings(42).layout, DEFAULT_SETTINGS.layout);
});

/* ------------------------------------------------------------ colour safety */

test("colours that could escape the CSS declaration are rejected", () => {
  // These land in a CSS custom property on the storefront, so anything that can
  // close the declaration must not survive.
  const bad = resolveSettings({ accentColor: "red;} body{display:none}" });
  assert.equal(bad.accentColor, DEFAULT_SETTINGS.accentColor);

  const urlish = resolveSettings({ accentColor: "url(javascript:alert(1))" });
  assert.equal(urlish.accentColor, DEFAULT_SETTINGS.accentColor);
});

test("valid colour shapes are kept", () => {
  assert.equal(resolveSettings({ accentColor: "#abc" }).accentColor, "#abc");
  assert.equal(resolveSettings({ accentColor: "#a1b2c3" }).accentColor, "#a1b2c3");
  assert.equal(resolveSettings({ accentColor: "rebeccapurple" }).accentColor, "rebeccapurple");
  assert.equal(
    resolveSettings({ accentColor: "rgba(1, 2, 3, 0.5)" }).accentColor,
    "rgba(1, 2, 3, 0.5)",
  );
});

/* ---------------------------------------------------------------- swatches */

test("swatch map accepts colours and https images, rejects the rest", () => {
  const s = resolveSettings({
    swatches: {
      "Royal Blue": "#4169e1",
      camo: "https://cdn.example.com/camo.png",
      evil: "url(javascript:alert(1))",
      insecure: "http://cdn.example.com/x.png",
      notAString: 5,
    },
  });
  assert.equal(s.swatches["royal blue"], "#4169e1", "keys are lowercased for lookup");
  assert.equal(s.swatches.camo, "https://cdn.example.com/camo.png");
  assert.ok(!("evil" in s.swatches));
  assert.ok(!("insecure" in s.swatches), "http images would break the padlock");
  assert.ok(!("notAString" in s.swatches));
});

test("swatch map is bounded", () => {
  const huge = {};
  for (let i = 0; i < 1000; i++) huge[`c${i}`] = "#123456";
  assert.ok(Object.keys(resolveSettings({ swatches: huge }).swatches).length <= 300);
});
