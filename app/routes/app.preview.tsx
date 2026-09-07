import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams, Form } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { getSearchEngine } from "../lib/search/index.server";
import { getShopConfig } from "../lib/search/config.server";
import { languageLabel } from "../lib/search/languages";
import { resolveSettings } from "../lib/settings";
import { Card, Empty, Row, Stat, TILES } from "../components/ui";
import type { SortKey } from "../lib/search/types";

/**
 * The relevance tester.
 *
 * Everything else in this admin lets a merchant CHANGE ranking; nothing let them
 * SEE it. Synonyms, merchandising rules and the stemming language were all
 * configured blind, then verified by opening the storefront in another tab and
 * squinting — which does not show which rule fired, whether a synonym expanded,
 * or why the product they expected is fourth.
 *
 * This runs the real engine, with the shop's real settings, and reports the
 * score breakdown behind the order. It is a read-only page: it changes nothing,
 * so a merchant can hammer it while tuning.
 */

const SORTS: { value: SortKey; label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "newest", label: "Newest" },
  { value: "bestselling", label: "Best selling" },
  { value: "title_asc", label: "Alphabetical" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));

  const url = new URL(request.url);
  const term = (url.searchParams.get("q") ?? "").slice(0, 200);
  const collection = (url.searchParams.get("collection") ?? "").slice(0, 200);
  const sortRaw = url.searchParams.get("sort") ?? "relevance";
  const sort = (SORTS.some((s) => s.value === sortRaw) ? sortRaw : "relevance") as SortKey;
  // A merchant debugging "why does nothing come back" needs to be able to see
  // the products the storefront is hiding, so this is an explicit toggle rather
  // than a mirror of the storefront setting.
  const includeUnavailable = url.searchParams.get("unavailable") === "1";

  const settings = resolveSettings(shop.settings);
  const cfg = await getShopConfig(shop.id);
  const submitted = url.searchParams.has("q");

  if (!submitted) {
    return {
      submitted: false as const,
      term: "",
      collection: "",
      sort,
      includeUnavailable,
      language: languageLabel(shop.searchLanguage),
      synonymCount: cfg.synonyms.length,
      ruleCount: cfg.rules.length,
      result: null,
    };
  }

  const result = await getSearchEngine().search({
    shopId: shop.id,
    term,
    page: 1,
    perPage: 20,
    sort,
    filters: {},
    collection: collection || undefined,
    includeUnavailable: includeUnavailable || settings.showOutOfStock,
    typoTolerance: settings.typoTolerance,
    semantic: settings.semanticSearch,
    explain: true,
  });

  return {
    submitted: true as const,
    term,
    collection,
    sort,
    includeUnavailable,
    language: languageLabel(shop.searchLanguage),
    synonymCount: cfg.synonyms.length,
    ruleCount: cfg.rules.length,
    result: {
      total: result.total,
      tookMs: result.tookMs,
      strategy: result.strategy,
      suggestion: result.suggestion ?? null,
      redirect: result.redirect ?? null,
      explain: result.explain ?? null,
      facets: result.facets.map((f) => ({
        label: f.label,
        source: f.source,
        count: f.values.length,
      })),
      hits: result.hits.map((h) => ({
        productId: h.productId,
        title: h.title,
        handle: h.handle,
        vendor: h.vendor,
        productType: h.productType,
        available: h.available,
        pinned: h.pinned,
        score: h.score,
      })),
    },
  };
};

export default function PreviewPage() {
  const d = useLoaderData<typeof loader>();
  const [sp] = useSearchParams();
  const r = d.result;
  const scores = r?.explain?.scores ?? {};

  return (
    <s-page heading="Test search">
      <s-section heading="Try a search">
        {/* A plain GET form: the query lives in the URL, so a merchant can
            bookmark a problem case or paste it to someone else. */}
        <Form method="get">
          <s-stack direction="block" gap="base">
            <s-grid gridTemplateColumns="2fr 1fr 1fr" gap="base" alignItems="end">
              <s-text-field
                name="q"
                label="What a shopper types"
                placeholder="winter jacket"
                defaultValue={d.term}
              />
              <s-text-field
                name="collection"
                label="Collection handle (optional)"
                placeholder="summer-sale"
                defaultValue={d.collection}
              />
              <s-select name="sort" label="Sort" value={d.sort}>
                {SORTS.map((s) => (
                  <s-option key={s.value} value={s.value}>{s.label}</s-option>
                ))}
              </s-select>
            </s-grid>
            <s-checkbox
              name="unavailable"
              value="1"
              label="Include out-of-stock products"
              {...(d.includeUnavailable ? { checked: true } : {})}
            />
            <s-button variant="primary" type="submit">Run search</s-button>
          </s-stack>
        </Form>
      </s-section>

      {!d.submitted && (
        <s-section heading="What this shows">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              <s-text color="subdued">
                This runs the real search engine with your real settings — the same
                code path a shopper hits. For every result it reports the score that
                put it there, broken into the parts that produced it, so
                &ldquo;why is that product fourth?&rdquo; has an answer.
              </s-text>
            </s-paragraph>
            <s-grid gridTemplateColumns={TILES} gap="large-100">
              <Stat label="Word matching" value={d.language} hint="Set in Settings" />
              <Stat label="Synonym groups" value={String(d.synonymCount)} href="/app/synonyms" />
              <Stat label="Merchandising rules" value={String(d.ruleCount)} href="/app/merchandising" />
            </s-grid>
          </s-stack>
        </s-section>
      )}

      {d.submitted && r && (
        <>
          {r.redirect && (
            <s-banner tone="info" heading="This search redirects">
              <s-paragraph>
                A redirect rule sends this term straight to <s-text type="strong">{r.redirect}</s-text>,
                so no results are shown. Manage it in{" "}
                <s-link href="/app/merchandising">Merchandising</s-link>.
              </s-paragraph>
            </s-banner>
          )}

          <s-section heading="What happened">
            <s-grid gridTemplateColumns={TILES} gap="large-100">
              <Stat label="Results" value={r.total.toLocaleString()} />
              <Stat label="Took" value={`${r.tookMs} ms`} />
              <Stat
                label="Strategy"
                value={strategyLabel(r.strategy)}
                hint={strategyHint(r.strategy)}
              />
              <Stat label="Filters offered" value={String(r.facets.length)} href="/app/filters" />
            </s-grid>

            {r.explain && (
              <s-grid gridTemplateColumns="repeat(auto-fit, minmax(260px, 1fr))" gap="large-100">
                <Card title="How the words were read">
                  <Detail label="Normalised" value={r.explain.normalizedTerm || "(empty)"} />
                  <Detail label="Word matching" value={languageOf(r.explain.language)} />
                  <Detail
                    label="Searched for"
                    value={r.explain.expansions.join("  •  ") || "(browse — no term)"}
                  />
                  {r.explain.expansions.length > 1 && (
                    <s-text color="subdued">
                      Extra terms came from your synonym groups.
                    </s-text>
                  )}
                </Card>
                <Card
                  title="Merchandising"
                  badge={r.explain.rule ? "Rule fired" : "None"}
                  tone={r.explain.rule ? "success" : undefined}
                >
                  {r.explain.rule ? (
                    <>
                      <Detail label="Rule" value={r.explain.rule.name} />
                      <Detail label="Priority" value={String(r.explain.rule.priority)} />
                      <s-link href="/app/merchandising">Edit rules</s-link>
                    </>
                  ) : (
                    <s-text color="subdued">
                      No rule matched this search, so the order below is purely
                      what the engine calculated.
                    </s-text>
                  )}
                </Card>
              </s-grid>
            )}
          </s-section>

          <s-section heading="Results, in order">
            {r.hits.length ? (
              <s-stack direction="block" gap="small-300">
                {r.hits.map((h, i) => {
                  const parts = scores[h.productId];
                  return (
                    <Row
                      key={h.productId}
                      actions={
                        <s-button
                          variant="secondary"
                          href={`shopify://admin/products/${h.productId}`}
                        >
                          Open product
                        </s-button>
                      }
                    >
                      <s-stack direction="inline" gap="small-500" alignItems="center">
                        <s-badge>{`#${i + 1}`}</s-badge>
                        <s-text type="strong">{h.title}</s-text>
                        {h.pinned && <s-badge tone="success">Pinned</s-badge>}
                        {!h.available && <s-badge tone="warning">Out of stock</s-badge>}
                      </s-stack>
                      <s-text color="subdued">
                        {[h.vendor, h.productType].filter(Boolean).join(" · ") || h.handle}
                      </s-text>
                      {parts ? (
                        <ScoreBreakdown parts={parts} />
                      ) : (
                        <s-text color="subdued">
                          Ordered by {SORTS.find((s) => s.value === d.sort)?.label ?? d.sort},
                          not by relevance — there is no score to break down.
                        </s-text>
                      )}
                    </Row>
                  );
                })}
              </s-stack>
            ) : (
              <Empty
                heading="Nothing matched"
                action={
                  <s-stack direction="inline" gap="base">
                    <s-button
                      variant="primary"
                      href={`/app/synonyms?prefill=${encodeURIComponent(d.term)}`}
                    >
                      Add a synonym
                    </s-button>
                    <s-button
                      variant="secondary"
                      href={`/app/merchandising?redirect=${encodeURIComponent(d.term)}`}
                    >
                      Redirect it
                    </s-button>
                  </s-stack>
                }
              >
                {r.suggestion
                  ? `Your catalog has nothing for "${d.term}". The closest word in it is "${r.suggestion}".`
                  : `Your catalog has nothing for "${d.term}". A synonym is usually the fix.`}
              </Empty>
            )}
          </s-section>
        </>
      )}

      <s-section slot="aside" heading="Reading the score">
        <s-paragraph>
          <s-text color="subdued">
            Every bar is one thing the engine rewarded. <s-text type="strong">Words</s-text> is
            how well the text matched. <s-text type="strong">Close spelling</s-text> catches
            typos. <s-text type="strong">Meaning</s-text> is semantic search, if you have it on.{" "}
            <s-text type="strong">Starts with</s-text> favours a title that opens with what
            was typed. <s-text type="strong">Popularity</s-text> is what shoppers actually
            click and buy. <s-text type="strong">Your rules</s-text> is everything you set in
            Merchandising.
          </s-text>
        </s-paragraph>
        {sp.get("q") && (
          <s-paragraph>
            <s-text color="subdued">
              This page changes nothing — run it as often as you like while tuning.
            </s-text>
          </s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

/** One labelled row inside a card. */
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <s-grid gridTemplateColumns="auto 1fr" gap="small-300" alignItems="start">
      <s-text color="subdued">{label}</s-text>
      <s-text>{value}</s-text>
    </s-grid>
  );
}

/**
 * The score, as parts rather than a number.
 *
 * A merchant cannot act on "score 4.82". They can act on "this ranked here
 * because of your rules, not because it matched the words" — so each component
 * gets its share of the bar, and anything contributing nothing is left out
 * rather than drawn as an empty row.
 */
function ScoreBreakdown({
  parts,
}: {
  parts: {
    total: number;
    textRank: number;
    similarity: number;
    semantic: number;
    prefix: number;
    popularity: number;
    merchandising: number;
  };
}) {
  const rows: { label: string; value: number }[] = [
    { label: "Words", value: parts.textRank },
    { label: "Close spelling", value: parts.similarity },
    { label: "Meaning", value: parts.semantic },
    { label: "Starts with", value: parts.prefix },
    { label: "Popularity", value: parts.popularity },
    { label: "Your rules", value: parts.merchandising },
  ].filter((r) => Math.abs(r.value) > 0.001);

  // Shares are of the total POSITIVE contribution, so a bury (a negative) does
  // not make the other bars meaningless by inflating the denominator.
  const positive = rows.reduce((sum, r) => sum + Math.max(0, r.value), 0) || 1;

  return (
    <s-stack direction="block" gap="small-500">
      <s-text color="subdued">
        Score {parts.total.toFixed(2)}
        {rows.length ? "" : " — nothing to attribute"}
      </s-text>
      {rows.map((r) => {
        const pct = Math.round((Math.max(0, r.value) / positive) * 100);
        return (
          <s-grid
            key={r.label}
            gridTemplateColumns="minmax(110px, auto) 3fr auto"
            gap="small-300"
            alignItems="center"
          >
            <s-text color="subdued">{r.label}</s-text>
            <s-box background="subdued" borderRadius="base" padding="none">
              <s-box
                background="strong"
                borderRadius="base"
                inlineSize={`${r.value < 0 ? 8 : Math.max(2, pct)}%`}
                minBlockSize="6px"
              />
            </s-box>
            {/* A negative contribution is a bury. The bar cannot render
                backwards, so the number carries the sign and the badge says
                what it means — width alone would read as a small positive. */}
            {r.value < 0 ? (
              <s-badge tone="critical">{r.value.toFixed(2)}</s-badge>
            ) : (
              <s-text type="strong">{r.value.toFixed(2)}</s-text>
            )}
          </s-grid>
        );
      })}
    </s-stack>
  );
}

function strategyLabel(s: string): string {
  const map: Record<string, string> = {
    fulltext: "Word match",
    fuzzy: "Typo tolerant",
    hybrid: "Words + typos",
    browse: "Browsing",
    sku: "Product code",
    semantic: "Words + meaning",
  };
  return map[s] ?? s;
}

function strategyHint(s: string): string | undefined {
  if (s === "sku") return "Matched a SKU exactly";
  if (s === "browse") return "No search term";
  if (s === "semantic") return "Semantic search is on";
  return undefined;
}

function languageOf(config: string): string {
  return config === "simple" ? "Exact words (no stemming)" : languageLabel(config);
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
