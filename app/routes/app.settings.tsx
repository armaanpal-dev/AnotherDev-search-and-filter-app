import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { Prisma } from "@prisma/client";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { resolveSettings, mergeSettings } from "../lib/settings";
import { getPlanStatus } from "../lib/billing.server";
import { semanticReady } from "../lib/search/embeddings.server";
import { invalidateShopConfig } from "../lib/search/config.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const { isPro } = await getPlanStatus(billing);
  return {
    settings: resolveSettings(shop.settings),
    domain: shop.domain,
    isPro,
    // Semantic search needs BOTH an embeddings provider configured on the server
    // and the pgvector column in Postgres; without either the toggle would be a
    // switch wired to nothing.
    semanticAvailable: await semanticReady(),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const f = await request.formData();

  // A checkbox that is off submits nothing, so "was this field on the form?" is
  // answered by a hidden companion field rather than by the checkbox's absence.
  const present = (name: string) => f.get(`_present.${name}`) === "1";
  const checkbox = (name: string) =>
    present(name) ? f.get(name) === "on" : undefined;
  const field = (name: string) => {
    const v = f.get(name);
    return v == null || v === "" ? undefined : String(v);
  };
  const numeric = (name: string) => {
    const v = field(name);
    return v == null ? undefined : Number(v);
  };

  // Merge over what is stored instead of rebuilding from the form.
  // The form does not render every setting, and rebuilding wholesale silently
  // reset the missing ones (resultsPerPage, gridColumns, showVendor,
  // recentSearches, collectionFilters) to their defaults on every save.
  const settings = mergeSettings(shop.settings, {
    autoAttach: checkbox("autoAttach"),
    searchTakeover: checkbox("searchTakeover"),
    showRecommendations: checkbox("showRecommendations"),
    recentSearches: checkbox("recentSearches"),
    typoTolerance: checkbox("typoTolerance"),
    semanticSearch: checkbox("semanticSearch"),
    showOutOfStock: checkbox("showOutOfStock"),
    collectionFilters: checkbox("collectionFilters"),
    showVendor: checkbox("showVendor"),
    quickAdd: checkbox("quickAdd"),
    minChars: numeric("minChars"),
    maxSuggestions: numeric("maxSuggestions"),
    resultsPerPage: numeric("resultsPerPage"),
    gridColumns: numeric("gridColumns"),
    fontSize: numeric("fontSize"),
    panelStyle: field("panelStyle"),
    layout: field("layout"),
    previewSide: field("previewSide"),
    accentColor: field("accentColor"),
    backgroundColor: field("backgroundColor"),
    textColor: field("textColor"),
    highlightColor: field("highlightColor"),
    fontWeight: field("fontWeight"),
    swatches: parseSwatchText(field("swatchText")),
  });

  await prisma.shop.update({
    where: { id: shop.id },
    data: { settings: settings as unknown as Prisma.InputJsonObject },
  });
  invalidateShopConfig(shop.id);
  return { ok: true };
};

/** "royal blue = #4169e1" per line — the least fiddly way to type a colour map. */
function parseSwatchText(text?: string): Record<string, string> | undefined {
  if (text == null) return undefined;
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const [rawKey, ...rest] = line.split(/[=:]/);
    if (!rawKey || !rest.length) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key && value) out[key] = value;
  }
  return out;
}

function swatchesToText(swatches: Record<string, string>): string {
  return Object.entries(swatches)
    .map(([k, v]) => `${k} = ${v}`)
    .join("\n");
}

export default function SettingsPage() {
  const { settings, domain, isPro, semanticAvailable } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const s = settings;
  const busy = fetcher.state !== "idle";

  return (
    <s-page heading="Settings">
      <s-button
        slot="primary-action"
        variant="primary"
        {...(busy ? { loading: true } : {})}
        onClick={() => {
          const form = document.getElementById("adsf-settings") as HTMLFormElement;
          if (form) fetcher.submit(form);
        }}
      >
        Save
      </s-button>

      <fetcher.Form method="post" id="adsf-settings">
        <s-section heading="Behaviour">
          <s-stack direction="block" gap="base">
            <Check name="autoAttach" checked={s.autoAttach} label="Upgrade my theme's search box with instant results" />
            <Check name="searchTakeover" checked={s.searchTakeover} label="Use our results on the theme's /search page (recommended)" />
            <Check name="collectionFilters" checked={s.collectionFilters} label="Show filters and instant results on collection pages" />
            <Check name="showRecommendations" checked={s.showRecommendations} label="Show recommendations when the search box is empty" />
            <Check name="recentSearches" checked={s.recentSearches} label="Remember each shopper's recent searches" />
            <Check name="typoTolerance" checked={s.typoTolerance} label="Typo tolerance (fuzzy matching)" />
            <Check name="showOutOfStock" checked={s.showOutOfStock} label="Include out-of-stock products in results" />
            <s-stack direction="inline" gap="base">
              <s-number-field name="minChars" label="Min characters to trigger" min={1} max={4} defaultValue={String(s.minChars)} />
              <s-number-field name="maxSuggestions" label="Max product suggestions" min={3} max={12} defaultValue={String(s.maxSuggestions)} />
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading="Results page">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <s-number-field name="resultsPerPage" label="Products per page" min={12} max={48} defaultValue={String(s.resultsPerPage)} />
              <s-number-field name="gridColumns" label="Grid columns (desktop)" min={2} max={5} defaultValue={String(s.gridColumns)} />
            </s-stack>
            <Check name="showVendor" checked={s.showVendor} label="Show the brand name on result cards" />
            <Check name="quickAdd" checked={s.quickAdd} label="Add to cart directly from results (single-variant products)" />
          </s-stack>
        </s-section>

        <s-section heading="Relevance">
          <s-stack direction="block" gap="base">
            {semanticAvailable ? (
              <>
                <Check
                  name="semanticSearch"
                  checked={s.semanticSearch && isPro}
                  label="Semantic search — understand meaning, not just keywords (Pro)"
                  disabled={!isPro}
                />
                <s-text color="subdued">
                  Finds “something warm for winter” even when no product says those
                  words. Runs alongside keyword search, never instead of it.
                </s-text>
              </>
            ) : (
              <s-text color="subdued">
                Semantic search is not configured on this deployment. Set
                SEMANTIC_SEARCH_ENABLED and an embeddings API key to enable it.
              </s-text>
            )}
          </s-stack>
        </s-section>

        <s-section heading="Layout">
          <s-stack direction="block" gap="base">
            <s-select name="panelStyle" label="Panel style" value={s.panelStyle}>
              <s-option value="spotlight">Spotlight — dims the page behind (recommended)</s-option>
              <s-option value="dropdown">Dropdown — attached to the search box</s-option>
            </s-select>
            <s-select name="layout" label="Results layout" value={s.layout}>
              <s-option value="rich">Rich — hover preview + list (no scrolling for details)</s-option>
              <s-option value="list">List — simple single column</s-option>
            </s-select>
            <s-select name="previewSide" label="Preview side (rich layout)" value={s.previewSide}>
              <s-option value="left">Left</s-option>
              <s-option value="right">Right</s-option>
            </s-select>
          </s-stack>
        </s-section>

        <s-section heading="Appearance">
          <s-stack direction="block" gap="base">
            <ColorField name="accentColor" label="Accent color (links, buttons)" value={s.accentColor} />
            <ColorField name="backgroundColor" label="Panel background" value={s.backgroundColor} />
            <ColorField name="textColor" label="Text color" value={s.textColor} />
            <ColorField name="highlightColor" label="Highlight color (matched text)" value={s.highlightColor} />
            <s-stack direction="inline" gap="base">
              <s-number-field name="fontSize" label="Font size (px)" min={12} max={22} defaultValue={String(s.fontSize)} />
              <s-select name="fontWeight" label="Font weight" value={s.fontWeight}>
                <s-option value="300">Light</s-option>
                <s-option value="400">Regular</s-option>
                <s-option value="500">Medium</s-option>
                <s-option value="600">Semibold</s-option>
              </s-select>
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading="Colour swatches">
          <s-paragraph>
            <s-text color="subdued">
              One per line, <s-text type="strong">option value = colour</s-text>. Use a hex
              code or an image URL. Anything not listed falls back to a built-in list of
              common colour names, then to grey.
            </s-text>
          </s-paragraph>
          <s-text-area
            name="swatchText"
            label="Swatch map"
            rows={6}
            defaultValue={swatchesToText(s.swatches)}
            placeholder={"royal blue = #4169e1\nheather grey = #b0b0b0\ncamo = https://cdn.example.com/camo.png"}
          />
          {fetcher.data && <s-text tone="success">Saved. Changes appear on your storefront within ~30 seconds.</s-text>}
        </s-section>
      </fetcher.Form>

      <s-section slot="aside" heading="How to turn it on">
        <s-paragraph>
          <s-text color="subdued">
            These settings control the storefront search everywhere. Just make sure the
            app is enabled once: <s-text type="strong">Online Store → Themes → Customize →
            App embeds → AnotherDev Search</s-text>. All appearance and behaviour is set
            here — nothing else to configure in the theme.
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Store">
        <s-paragraph><s-text color="subdued">{domain}</s-text></s-paragraph>
      </s-section>
    </s-page>
  );
}

/**
 * A checkbox plus a hidden marker.
 *
 * An unchecked HTML checkbox submits nothing at all, which is indistinguishable
 * from "this form does not include that field" — and the merge logic has to tell
 * those two apart, or unticking a box would be read as "leave it as it was".
 */
function Check({
  name,
  checked,
  label,
  disabled,
}: {
  name: string;
  checked: boolean;
  label: string;
  disabled?: boolean;
}) {
  return (
    <>
      <input type="hidden" name={`_present.${name}`} value="1" />
      <s-checkbox
        name={name}
        label={label}
        {...(checked ? { checked: true } : {})}
        {...(disabled ? { disabled: true } : {})}
      />
    </>
  );
}

function ColorField({ name, label, value }: { name: string; label: string; value: string }) {
  return (
    <s-stack direction="inline" gap="base" alignItems="end">
      <s-text-field name={name} label={label} defaultValue={value} />
      <input type="color" defaultValue={value} onChange={(e) => {
        const tf = document.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
        if (tf) tf.value = (e.target as HTMLInputElement).value;
      }} style={{ width: 44, height: 36, border: "none", background: "none", cursor: "pointer" }} />
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
