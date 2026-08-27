import { test } from "node:test";
import assert from "node:assert/strict";

// These mirror app/lib/search/normalize.ts. Kept as a plain JS copy so tests run
// without a TS build step. If you change normalize.ts, update here too.
function normalizeQuery(raw) {
  return raw.toLowerCase().replace(/[ -]/g, " ").replace(/\s+/g, " ").trim();
}
function tokenize(term) {
  return normalizeQuery(term).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
function phraseInQuery(phrase, normalizedQuery, words) {
  const p = normalizeQuery(phrase);
  if (!p) return false;
  if (!p.includes(" ")) return words.has(p);
  return ` ${normalizedQuery} `.includes(` ${p} `);
}
function expandSynonyms(term, rules) {
  const normalized = normalizeQuery(term);
  const words = new Set(tokenize(normalized));
  const expansions = new Set([normalized]);
  for (const rule of rules) {
    if (rule.type === "oneway") {
      if (rule.input && phraseInQuery(rule.input, normalized, words))
        rule.terms.forEach((t) => expansions.add(normalizeQuery(t)));
    } else {
      const hit = rule.terms.some((t) => phraseInQuery(t, normalized, words));
      if (hit) rule.terms.forEach((t) => expansions.add(normalizeQuery(t)));
    }
  }
  return [...expansions].filter(Boolean);
}

test("normalizeQuery lowercases and collapses whitespace", () => {
  assert.equal(normalizeQuery("  Red   SHOES "), "red shoes");
});

test("multiway synonyms expand both directions", () => {
  const rules = [{ type: "multiway", input: null, terms: ["sneaker", "trainer", "running shoe"] }];
  const out = expandSynonyms("trainer", rules);
  assert.ok(out.includes("sneaker"));
  assert.ok(out.includes("running shoe"));
  assert.ok(out.includes("trainer"));
});

test("oneway synonyms only expand from input", () => {
  const rules = [{ type: "oneway", input: "tv", terms: ["television"] }];
  assert.ok(expandSynonyms("tv", rules).includes("television"));
  // reverse direction should NOT expand
  assert.deepEqual(expandSynonyms("television", rules), ["television"]);
});

test("no matching synonym leaves query untouched", () => {
  const out = expandSynonyms("hat", [{ type: "multiway", input: null, terms: ["a", "b"] }]);
  assert.deepEqual(out, ["hat"]);
});
