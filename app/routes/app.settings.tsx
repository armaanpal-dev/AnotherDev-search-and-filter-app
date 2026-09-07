import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { Prisma } from "@prisma/client";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { resolveSettings, mergeSettings, WEIGHTS, type WidgetSettings } from "../lib/settings";
import { getPlanStatus } from "../lib/billing.server";
import { semanticReady } from "../lib/search/embeddings.server";
import { invalidateShopConfig } from "../lib/search/config.server";
import { SEARCH_LANGUAGES, toTsConfig } from "../lib/search/languages";
import { ensureWebPixel, removeWebPixel, getPixelState } from "../lib/pixel.server";
import { TILES } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing, admin } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const { limits } = await getPlanStatus(billing, shop.planOverride);
  const isPro = limits.semantic;
  return {
    settings: resolveSettings(shop.settings),
    domain: shop.domain,
    isPro,
    searchLanguage: toTsConfig(shop.searchLanguage),
    autoSyncEnabled: shop.autoSyncEnabled,
    // Semantic search needs BOTH an embeddings provider configured on the server
    // and the pgvector column in Postgres; without either the toggle would be a
    // switch wired to nothing.
    semanticAvailable: await semanticReady(),
    pixel: await getPixelState(admin),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const f = await request.formData();

  // Purchase tracking is its own action: installing or removing a Web Pixel is a
  // call to Shopify, not a column, and it must not be silently coupled to
  // pressing Save on an unrelated colour change.
  const intent = String(f.get("intent") ?? "");
  if (intent === "pixelOn" || intent === "pixelOff") {
    const result =
      intent === "pixelOn" ? await ensureWebPixel(admin) : await removeWebPixel(admin);
    return result.ok
      ? { ok: true, pixelChanged: intent === "pixelOn" ? "on" : "off" }
      : { ok: false, error: result.error };
  }

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
    mode: field("mode"),
    autoAttach: checkbox("autoAttach"),
    searchTakeover: checkbox("searchTakeover"),
    showRecommendations: checkbox("showRecommendations"),
    recentSearches: checkbox("recentSearches"),
    typoTolerance: checkbox("typoTolerance"),
    voiceSearch: checkbox("voiceSearch"),
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
    filterLayout: field("filterLayout"),
    productCards: field("productCards"),
    cardRatio: field("cardRatio"),
    cardImageFit: field("cardImageFit"),
    cardRadius: numeric("cardRadius"),
    cardBorder: field("cardBorder"),
    cardBg: field("cardBg"),
    cardPadding: numeric("cardPadding"),
    cardGap: numeric("cardGap"),
    cardAlign: field("cardAlign"),
    cardHover: field("cardHover"),
    cardTitleSize: numeric("cardTitleSize"),
    cardTitleWeight: field("cardTitleWeight"),
    cardTitleColor: field("cardTitleColor"),
    cardTitleLines: numeric("cardTitleLines"),
    cardPriceSize: numeric("cardPriceSize"),
    cardPriceWeight: field("cardPriceWeight"),
    cardPriceColor: field("cardPriceColor"),
    cardButtonLabel: field("cardButtonLabel"),
    cardButtonBg: field("cardButtonBg"),
    cardButtonText: field("cardButtonText"),
    cardButtonRadius: numeric("cardButtonRadius"),
    cardButtonFullWidth: checkbox("cardButtonFullWidth"),
    filterButtonShape: field("filterButtonShape"),
    filterButtonBg: field("filterButtonBg"),
    filterButtonText: field("filterButtonText"),
    filterActiveBg: field("filterActiveBg"),
    filterActiveText: field("filterActiveText"),
    showFacetCounts: checkbox("showFacetCounts"),
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

  // Stemming language and auto-sync are columns on Shop, not widget settings:
  // the engine reads them without loading the settings blob, and the language
  // has to be mirrored onto every product row.
  const language = toTsConfig(field("searchLanguage") ?? shop.searchLanguage);
  const autoSync = present("autoSyncEnabled")
    ? f.get("autoSyncEnabled") === "on"
    : shop.autoSyncEnabled;

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      settings: settings as unknown as Prisma.InputJsonObject,
      searchLanguage: language,
      autoSyncEnabled: autoSync,
    },
  });

  // Changing the language rewrites every product's `tsConfig`, which is an input
  // to the generated `searchVector` — so Postgres recomputes the index entries
  // itself. Done in SQL rather than row by row: this is one statement over the
  // catalog, not a re-sync, and search stays correct throughout because the
  // query side reads the same value.
  if (language !== toTsConfig(shop.searchLanguage)) {
    await prisma.$executeRaw`
      UPDATE "Product" SET "tsConfig" = ${language} WHERE "shopId" = ${shop.id}`;
  }

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
  const { settings, domain, isPro, semanticAvailable, searchLanguage, autoSyncEnabled, pixel } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const pixelFetcher = useFetcher<typeof action>();
  const s = settings;
  const busy = fetcher.state !== "idle";
  // Only after a completed submit: fetcher.data survives, so checking it alone
  // would leave the banner up while a second save is in flight.
  const saved = fetcher.state === "idle" && Boolean(fetcher.data?.ok);
  const error =
    (fetcher.data && "error" in fetcher.data && fetcher.data.error) ||
    (pixelFetcher.data && "error" in pixelFetcher.data && pixelFetcher.data.error) ||
    null;

  // Live preview state.
  //
  // Editing eight colours and four layout switches with no way to see the result
  // meant saving, opening the storefront in another tab, and going back — for an
  // app whose whole pitch is how the search looks. This mirrors the form into
  // state so the preview redraws as it is edited, without a save.
  const formRef = useRef<HTMLFormElement | null>(null);
  const [draft, setDraft] = useState<WidgetSettings>(settings);

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    // Native listeners, not React's onChange: these are form-associated custom
    // elements, and React's synthetic events do not reliably see their `input`.
    const read = () => {
      const data = new FormData(form);
      const patch: Record<string, unknown> = {};
      for (const [key, value] of data.entries()) {
        if (key.startsWith("_present.") || key === "intent") continue;
        patch[key] = value === "on" ? true : value;
      }
      // A checkbox that is off submits nothing, so the presence markers are what
      // distinguish "unticked" from "not on the form" — same rule the action uses.
      for (const [key] of data.entries()) {
        if (!key.startsWith("_present.")) continue;
        const name = key.slice("_present.".length);
        if (!(name in patch)) patch[name] = false;
      }
      if (typeof patch.swatchText === "string") {
        patch.swatches = parseSwatchText(patch.swatchText) ?? {};
        delete patch.swatchText;
      }
      setDraft(mergeSettings(settings, patch));
    };
    form.addEventListener("input", read);
    form.addEventListener("change", read);
    return () => {
      form.removeEventListener("input", read);
      form.removeEventListener("change", read);
    };
  }, [settings]);

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

      {error && <s-banner tone="critical">{String(error)}</s-banner>}

      {saved && (
        <s-banner tone="success" heading="Settings saved" dismissible>
          <s-paragraph>
            Your storefront picks these up within about 30 seconds, because the
            widget caches settings briefly.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Currently live">
        <s-grid gridTemplateColumns={TILES} gap="large-100">
          <Live label="Instant search" on={s.autoAttach} />
          <Live label="Search page" on={s.searchTakeover} />
          <Live label="Collection filters" on={s.collectionFilters} />
          <Live label="Typo tolerance" on={s.typoTolerance} />
          <Live label="Quick add to cart" on={s.quickAdd} />
          <Live label="Revenue tracking" on={pixel === "active"} />
        </s-grid>
        <s-text color="subdued">Storefront: {domain}</s-text>
      </s-section>

      {/* The preview sits above the form so it stays in view while the controls
          below it are edited. */}
      <s-section heading="Preview">
        <s-paragraph>
          <s-text color="subdued">
            This is your search, drawn with the settings below. It updates as you
            edit — nothing is saved until you press Save.
          </s-text>
        </s-paragraph>
        <WidgetPreview settings={draft} />
      </s-section>

      <fetcher.Form method="post" id="adsf-settings" ref={formRef}>
        {/* s-page only spaces its DIRECT s-section children. With the form in
            between, every section card stacked flush against the next, so the
            gap has to be supplied here. */}
        <s-stack direction="block" gap="large-500">
        <s-section heading="Behaviour">
          <s-stack direction="block" gap="base">
            <s-select name="mode" label="What this app runs on your storefront" value={s.mode}>
              <s-option value="both">Search and filters</s-option>
              <s-option value="search">Search only</s-option>
              <s-option value="filters">Filters only</s-option>
            </s-select>
            <s-text color="subdued">
              The switches below only apply to the half you have turned on. A
              block you placed by hand in the theme editor keeps working either
              way, since placing it is already an explicit choice.
            </s-text>
            <Check name="autoAttach" checked={s.autoAttach} label="Upgrade my theme's search box with instant results" />
            <Check name="searchTakeover" checked={s.searchTakeover} label="Use our results on the theme's /search page (recommended)" />
            <Check name="collectionFilters" checked={s.collectionFilters} label="Show filters and instant results on collection pages" />
            <Check name="showRecommendations" checked={s.showRecommendations} label="Show recommendations when the search box is empty" />
            <Check name="recentSearches" checked={s.recentSearches} label="Remember each shopper's recent searches" />
            <Check name="typoTolerance" checked={s.typoTolerance} label="Typo tolerance (fuzzy matching)" />
            <Check
              name="voiceSearch"
              checked={s.voiceSearch}
              label="Let shoppers search by voice (where their browser supports it)"
            />
            <Check name="showOutOfStock" checked={s.showOutOfStock} label="Include out-of-stock products in results" />
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-number-field name="minChars" label="Min characters to trigger" min={1} max={4} defaultValue={String(s.minChars)} />
              <s-number-field name="maxSuggestions" label="Max product suggestions" min={3} max={12} defaultValue={String(s.maxSuggestions)} />
            </s-grid>
          </s-stack>
        </s-section>

        <s-section heading="Results page">
          <s-stack direction="block" gap="base">
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-number-field name="resultsPerPage" label="Products per page" min={12} max={48} defaultValue={String(s.resultsPerPage)} />
              <s-number-field name="gridColumns" label="Grid columns (desktop)" min={2} max={5} defaultValue={String(s.gridColumns)} />
            </s-grid>
            <s-select name="filterLayout" label="Filter layout" value={s.filterLayout}>
              <s-option value="sidebar">Sidebar beside the grid, drawer on mobile</s-option>
              <s-option value="topbar">Toolbar in one row above the grid</s-option>
              <s-option value="drawer">Always behind a Filters button</s-option>
              <s-option value="inline">Always open, stacked above the grid</s-option>
            </s-select>
            <Check name="showVendor" checked={s.showVendor} label="Show the brand name on result cards" />
            <Check name="quickAdd" checked={s.quickAdd} label="Add to cart directly from results (single-variant products)" />
          </s-stack>
        </s-section>

        <s-section heading="Collection pages">
          <s-stack direction="block" gap="base">
            <s-select
              name="productCards"
              label="Who draws the product cards"
              value={s.productCards}
            >
              <s-option value="auto">Automatic - theme cards when every filter works</s-option>
              <s-option value="theme">Always my theme’s product cards</s-option>
              <s-option value="app">Always this app’s product cards</s-option>
            </s-select>
            <s-text color="subdued">
              Your theme’s cards are re-rendered by Shopify, which can only apply
              the filters you enabled in Search &amp; Discovery. This app’s cards are
              filtered by its own index, so every filter you configure works.
              Automatic keeps your theme’s cards whenever that is possible and
              switches to this app’s only when a filter would otherwise do nothing.
            </s-text>
            {s.productCards === "theme" && (
              <s-banner tone="info">
                <s-paragraph>
                  Filters your theme cannot apply are hidden rather than shown
                  broken. Enable them under Search &amp; Discovery to see them here.
                </s-paragraph>
              </s-banner>
            )}
          </s-stack>
        </s-section>

        {s.productCards !== "theme" && (
          <s-section heading="Product card appearance">
            <s-stack direction="block" gap="base">
              <s-text color="subdued">
                These apply to the cards this app draws. Font family always comes
                from your theme, so cards keep your storefront’s typeface.
              </s-text>

              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-select name="cardRatio" label="Image shape" value={s.cardRatio}>
                  <s-option value="square">Square (1:1)</s-option>
                  <s-option value="portrait">Portrait (3:4)</s-option>
                  <s-option value="landscape">Landscape (4:3)</s-option>
                  <s-option value="wide">Wide (16:9)</s-option>
                  <s-option value="natural">Natural, uncropped</s-option>
                </s-select>
                <s-select name="cardImageFit" label="Image fill" value={s.cardImageFit}>
                  <s-option value="cover">Crop to fill the shape</s-option>
                  <s-option value="contain">Fit the whole image in</s-option>
                </s-select>
              </s-grid>

              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-select name="cardBorder" label="Card outline" value={s.cardBorder}>
                  <s-option value="none">None, straight on the page</s-option>
                  <s-option value="line">Thin border</s-option>
                  <s-option value="shadow">Soft shadow</s-option>
                </s-select>
                <s-select name="cardHover" label="Hover effect" value={s.cardHover}>
                  <s-option value="none">None</s-option>
                  <s-option value="zoom">Zoom the image</s-option>
                  <s-option value="lift">Lift the card</s-option>
                </s-select>
              </s-grid>

              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <ColorField name="cardBg" label="Card background" value={s.cardBg} />
                <s-select name="cardAlign" label="Text alignment" value={s.cardAlign}>
                  <s-option value="left">Left</s-option>
                  <s-option value="center">Centred</s-option>
                </s-select>
              </s-grid>

              <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
                <s-number-field name="cardRadius" label="Corner radius (px)" min={0} max={32} defaultValue={String(s.cardRadius)} />
                <s-number-field name="cardPadding" label="Inner padding (px)" min={0} max={24} defaultValue={String(s.cardPadding)} />
                <s-number-field name="cardGap" label="Space between cards (px)" min={4} max={48} defaultValue={String(s.cardGap)} />
              </s-grid>

              <s-divider />
              <s-text type="strong">Product title</s-text>
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-number-field name="cardTitleSize" label="Size (px)" min={11} max={24} defaultValue={String(s.cardTitleSize)} />
                <s-select name="cardTitleWeight" label="Weight" value={s.cardTitleWeight}>
                  {WEIGHTS.map((w) => (
                    <s-option key={w} value={w}>{w}</s-option>
                  ))}
                </s-select>
              </s-grid>
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <ColorField name="cardTitleColor" label="Colour" value={s.cardTitleColor} />
                <s-number-field name="cardTitleLines" label="Maximum lines" min={1} max={4} defaultValue={String(s.cardTitleLines)} />
              </s-grid>

              <s-divider />
              <s-text type="strong">Price</s-text>
              <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
                <s-number-field name="cardPriceSize" label="Size (px)" min={11} max={24} defaultValue={String(s.cardPriceSize)} />
                <s-select name="cardPriceWeight" label="Weight" value={s.cardPriceWeight}>
                  {WEIGHTS.map((w) => (
                    <s-option key={w} value={w}>{w}</s-option>
                  ))}
                </s-select>
                <ColorField name="cardPriceColor" label="Colour" value={s.cardPriceColor} />
              </s-grid>

              <s-divider />
              <s-text type="strong">Add to cart button</s-text>
              <s-text color="subdued">
                Only drawn when “Add to cart directly from results” is on, above.
              </s-text>
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-text-field name="cardButtonLabel" label="Button text" maxLength={24} defaultValue={s.cardButtonLabel} />
                <s-number-field name="cardButtonRadius" label="Corner radius (px)" min={0} max={32} defaultValue={String(s.cardButtonRadius)} />
              </s-grid>
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <ColorField name="cardButtonBg" label="Background" value={s.cardButtonBg} />
                <ColorField name="cardButtonText" label="Text colour" value={s.cardButtonText} />
              </s-grid>
              <Check name="cardButtonFullWidth" checked={s.cardButtonFullWidth} label="Stretch the button to the full card width" />
            </s-stack>
          </s-section>
        )}

        <s-section heading="Filter appearance">
          <s-stack direction="block" gap="base">
            <s-select name="filterButtonShape" label="Filter button shape" value={s.filterButtonShape}>
              <s-option value="pill">Pill</s-option>
              <s-option value="rounded">Rounded corners</s-option>
              <s-option value="square">Square</s-option>
            </s-select>
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <ColorField name="filterButtonBg" label="Button background" value={s.filterButtonBg} />
              <ColorField name="filterButtonText" label="Button text" value={s.filterButtonText} />
            </s-grid>
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <ColorField name="filterActiveBg" label="Selected background" value={s.filterActiveBg} />
              <ColorField name="filterActiveText" label="Selected text" value={s.filterActiveText} />
            </s-grid>
            <Check name="showFacetCounts" checked={s.showFacetCounts} label="Show the number of products beside each filter value" />
          </s-stack>
        </s-section>

        <s-section heading="Relevance">
          <s-stack direction="block" gap="base">
            {/* Stemming. "simple" matches words exactly, which is right for a
                catalog of product codes and brand names and wrong for prose:
                without it "boots" never finds "boot". Changing this rewrites the
                index for this store, which Postgres does itself. */}
            <s-select
              name="searchLanguage"
              label="Match word endings as"
              value={searchLanguage}
              details="Lets “boots” find “boot”, and “running” find “run”. Pick the language most of your product text is written in."
            >
              {SEARCH_LANGUAGES.map((l) => (
                <s-option key={l.value} value={l.value}>{l.label}</s-option>
              ))}
            </s-select>
            <s-text color="subdued">
              Changing this re-indexes your catalog in the background. Search keeps
              working throughout, and you can check the result in{" "}
              <s-link href="/app/preview">Test search</s-link>.
            </s-text>

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
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-number-field name="fontSize" label="Font size (px)" min={12} max={22} defaultValue={String(s.fontSize)} />
              <s-select name="fontWeight" label="Font weight" value={s.fontWeight}>
                <s-option value="300">Light</s-option>
                <s-option value="400">Regular</s-option>
                <s-option value="500">Medium</s-option>
                <s-option value="600">Semibold</s-option>
                {/* resolveSettings has always accepted 700; leaving it out of the
                    picker meant a shop set to Bold silently dropped to Regular
                    the first time anyone saved this form. */}
                <s-option value="700">Bold</s-option>
              </s-select>
            </s-grid>
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
        </s-section>
        <s-section heading="Keeping the index current">
          <s-stack direction="block" gap="base">
            <Check
              name="autoSyncEnabled"
              checked={autoSyncEnabled}
              label="Re-check my catalog once a day"
            />
            <s-text color="subdued">
              Product changes reach the index through webhooks within seconds. A
              nightly pass catches what webhooks cannot: a dropped delivery, a bulk
              edit through the API, or a very large collection whose membership was
              deferred. It costs you nothing and runs while the store is quiet.
            </s-text>
          </s-stack>
        </s-section>
        </s-stack>
      </fetcher.Form>

      {/* Outside the settings form on purpose: this installs or removes a Web
          Pixel through Shopify, which is a different kind of action from saving
          a colour and should not ride along with it. */}
      <s-section heading="Revenue tracking">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-500" alignItems="center">
            <s-text type="strong">Search-driven revenue</s-text>
            <s-badge tone={pixel === "active" ? "success" : undefined}>
              {pixel === "active" ? "On" : pixel === "unavailable" ? "Needs permission" : "Off"}
            </s-badge>
          </s-stack>
          <s-text color="subdued">
            Your storefront can see a shopper click a result and add it to the cart,
            and then it goes blind — checkout runs on Shopify&rsquo;s own domain, not
            yours. Turning this on adds a small pixel that Shopify runs inside
            checkout and that reports completed orders back to the search that
            produced them. It reads no customer details: only the order total, its
            line items, and the anonymous session id the search widget already uses.
          </s-text>
          {pixel === "unavailable" ? (
            <s-banner tone="warning" heading="Reinstall needed">
              <s-paragraph>
                This store was installed before revenue tracking existed, so it has
                not approved the permission the pixel needs. Reinstall the app from
                your Apps page to approve it.
              </s-paragraph>
            </s-banner>
          ) : (
            <pixelFetcher.Form method="post">
              <input
                type="hidden"
                name="intent"
                value={pixel === "active" ? "pixelOff" : "pixelOn"}
              />
              <s-button
                type="submit"
                variant={pixel === "active" ? "secondary" : "primary"}
                {...(pixelFetcher.state !== "idle" ? { loading: true } : {})}
              >
                {pixel === "active" ? "Turn off revenue tracking" : "Turn on revenue tracking"}
              </s-button>
            </pixelFetcher.Form>
          )}
          <s-text color="subdued">
            Results appear in <s-link href="/app/analytics">Analytics</s-link> as orders
            come in.
          </s-text>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="How to turn it on">
        <s-paragraph>
          <s-text color="subdued">
            These settings control the storefront search everywhere. Just make sure the
            app is enabled once, from Online Store, then Themes, then Customize,
            then App embeds, then <s-text type="strong">AnotherDev Search</s-text>.
            All appearance and behaviour is set here; nothing else to configure in
            the theme.
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

// s-color-field pairs a swatch picker with a validated hex input, replacing a
// raw <input type="color"> that had to be wired to a text field by hand and
// carried inline styles Polaris cannot theme.
function Live({ label, on }: { label: string; on: boolean }) {
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small-500">
        <s-text color="subdued">{label}</s-text>
        <s-badge tone={on ? "success" : undefined}>{on ? "On" : "Off"}</s-badge>
      </s-stack>
    </s-box>
  );
}

function ColorField({ name, label, value }: { name: string; label: string; value: string }) {
  return <s-color-field name={name} label={label} defaultValue={value} />;
}

/**
 * A drawing of the storefront widget, using the settings currently in the form.
 *
 * Deliberately inline-styled, which is the one place in this admin that is the
 * right call: this is a rendering of STOREFRONT css, driven by merchant-chosen
 * values, and every one of those values is validated by `resolveSettings` before
 * it gets here — the colour regex there is what makes putting them in a style
 * attribute safe. Using Polaris tokens instead would show the merchant the
 * admin's colours, which is the opposite of the point.
 *
 * It is a static drawing, not a live widget: no requests, no interactivity, no
 * chance of it disagreeing with the real thing because it drifted its own logic.
 */
const RATIO_CSS: Record<WidgetSettings["cardRatio"], string> = {
  square: "1 / 1",
  portrait: "3 / 4",
  landscape: "4 / 3",
  wide: "16 / 9",
  natural: "auto",
};

function WidgetPreview({ settings: p }: { settings: WidgetSettings }) {
  // "auto" can go either way per collection, so the preview shows our cards
  // for it: that is the case worth previewing, since the theme’s cards are
  // whatever the theme already looks like.
  const themeCards = p.productCards === "theme";
  const rich = p.layout === "rich";
  const radius =
    p.filterButtonShape === "square" ? "0" : p.filterButtonShape === "rounded" ? "8px" : "999px";

  const panel: React.CSSProperties = {
    background: p.backgroundColor,
    color: p.textColor,
    fontSize: `${p.fontSize}px`,
    fontWeight: Number(p.fontWeight),
    border: "1px solid rgba(0,0,0,.12)",
    borderRadius: "12px",
    boxShadow: "0 10px 30px rgba(0,0,0,.12)",
    overflow: "hidden",
  };

  const label: React.CSSProperties = {
    textTransform: "uppercase",
    letterSpacing: ".06em",
    fontSize: "0.68em",
    fontWeight: 600,
    opacity: 0.55,
    padding: "0.5em 0.7em 0.25em",
  };

  const swatchFor = (name: string) =>
    p.swatches[name.toLowerCase()] ??
    ({ red: "#d33", blue: "#26c", black: "#111" } as Record<string, string>)[name.toLowerCase()] ??
    "#ccc";

  const products = [
    { title: "Merino Wool Crew Neck", vendor: "Northbound", price: "£89.00" },
    { title: "Merino Beanie", vendor: "Northbound", price: "£24.00" },
    { title: "Lambswool Scarf", vendor: "Harlow", price: "£38.00" },
  ].slice(0, Math.max(2, Math.min(3, p.maxSuggestions)));

  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <div style={{ display: "grid", gap: "1.25rem" }}>
        {/* --- Search panel --- */}
        <div style={{ maxWidth: rich ? 620 : 380 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              border: "1px solid rgba(0,0,0,.18)",
              borderRadius: 8,
              overflow: "hidden",
              background: "#fff",
              marginBottom: 6,
            }}
          >
            <span style={{ flex: 1, padding: "0.5rem 0.75rem", fontSize: 14, color: "#555" }}>
              merino
            </span>
            <span
              style={{
                background: p.accentColor,
                color: "#fff",
                padding: "0.5rem 0.85rem",
                fontSize: 13,
              }}
            >
              Search
            </span>
          </div>

          <div style={panel}>
            <div
              style={{
                display: rich ? "grid" : "block",
                gridTemplateColumns: rich ? "200px 1fr" : undefined,
                direction: rich && p.previewSide === "right" ? "rtl" : "ltr",
              }}
            >
              {rich && (
                <div
                  style={{
                    direction: "ltr",
                    padding: "0.75em",
                    borderInlineEnd: "1px solid rgba(0,0,0,.08)",
                    display: "grid",
                    gap: 6,
                    alignContent: "start",
                  }}
                >
                  <div style={{ aspectRatio: "1/1", background: "rgba(0,0,0,.06)", borderRadius: 8 }} />
                  <div style={{ fontWeight: 600 }}>{products[0].title}</div>
                  <div style={{ fontWeight: 700 }}>{products[0].price}</div>
                  <span style={{ color: p.accentColor, fontWeight: 600, fontSize: "0.85em" }}>
                    See details
                  </span>
                </div>
              )}

              <div style={{ direction: "ltr", padding: "0.25em" }}>
                <div style={label}>Products</div>
                {products.map((prod) => (
                  <div
                    key={prod.title}
                    style={{
                      display: "flex",
                      gap: "0.6em",
                      alignItems: "center",
                      padding: "0.45em 0.6em",
                      borderRadius: 8,
                    }}
                  >
                    <span
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 6,
                        background: "rgba(0,0,0,.07)",
                        flex: "none",
                      }}
                    />
                    <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                      <span>
                        <mark
                          style={{
                            background: "transparent",
                            color: p.highlightColor,
                            fontWeight: 700,
                          }}
                        >
                          Merino
                        </mark>
                        {prod.title.replace(/^Merino/, "")}
                      </span>
                      {p.showVendor && (
                        <span style={{ opacity: 0.6, fontSize: "0.85em" }}>{prod.vendor}</span>
                      )}
                      <span style={{ fontWeight: 600 }}>{prod.price}</span>
                    </span>
                  </div>
                ))}
                <div
                  style={{
                    borderTop: "1px solid rgba(0,0,0,.08)",
                    padding: "0.55em 0.6em",
                    color: p.accentColor,
                    fontWeight: 600,
                  }}
                >
                  See all results
                </div>
              </div>
            </div>
          </div>
          <s-text color="subdued">
            {p.panelStyle === "spotlight" ? "Spotlight panel" : "Dropdown panel"} ·{" "}
            {rich ? `Rich, preview on the ${p.previewSide}` : "Simple list"}
          </s-text>
        </div>

        {/* --- Filters + grid --- */}
        <div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            {["Price", "Brand", "Size"].map((f, i) => (
              <span
                key={f}
                style={{
                  padding: "0.4em 0.85em",
                  fontSize: 13,
                  borderRadius: radius,
                  border: "1px solid rgba(0,0,0,.2)",
                  background: i === 0 ? p.filterActiveBg : p.filterButtonBg,
                  color: i === 0 ? p.filterActiveText : p.filterButtonText,
                }}
              >
                {f}
                {p.showFacetCounts ? ` (12)` : ""}
              </span>
            ))}
            {["Red", "Blue", "Black"].map((c) => (
              <span
                key={c}
                title={c}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: swatchFor(c),
                  border: "1px solid rgba(0,0,0,.2)",
                }}
              />
            ))}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${p.gridColumns}, 1fr)`,
              gap: themeCards ? 12 : p.cardGap,
            }}
          >
            {Array.from({ length: p.gridColumns }).map((_, i) => (
              <div
                key={i}
                style={{
                  fontSize: `${p.fontSize}px`,
                  color: p.textColor,
                  // Under "theme" the cards are not ours to style, so the preview
                  // stops pretending otherwise: dashed outline, none of our card
                  // chrome. Showing our card here is what made the preview
                  // disagree with the live storefront.
                  ...(themeCards
                    ? {
                        border: "1px dashed rgba(0,0,0,.25)",
                        borderRadius: 8,
                        padding: 8,
                        opacity: 0.75,
                      }
                    : {
                        background: p.cardBg,
                        padding: p.cardPadding,
                        borderRadius: p.cardRadius,
                        textAlign: p.cardAlign,
                        border:
                          p.cardBorder === "line" ? "1px solid rgba(0,0,0,.12)" : undefined,
                        boxShadow:
                          p.cardBorder === "shadow"
                            ? "0 1px 3px rgba(0,0,0,.12), 0 6px 16px rgba(0,0,0,.06)"
                            : undefined,
                      }),
                }}
              >
                <div
                  style={{
                    aspectRatio: themeCards ? "1/1" : RATIO_CSS[p.cardRatio],
                    minHeight: !themeCards && p.cardRatio === "natural" ? 96 : undefined,
                    background: "rgba(0,0,0,.07)",
                    borderRadius: themeCards ? 8 : p.cardRadius,
                  }}
                />
                <div
                  style={{
                    marginTop: 6,
                    fontSize: themeCards ? undefined : p.cardTitleSize,
                    fontWeight: themeCards ? 400 : Number(p.cardTitleWeight),
                    color: themeCards ? undefined : p.cardTitleColor,
                    lineHeight: 1.35,
                  }}
                >
                  {themeCards ? "Your theme’s card" : "Product name"}
                </div>
                {p.showVendor && !themeCards && (
                  <div style={{ opacity: 0.6, fontSize: "0.85em" }}>Brand</div>
                )}
                <div
                  style={{
                    fontSize: themeCards ? undefined : p.cardPriceSize,
                    fontWeight: themeCards ? 600 : Number(p.cardPriceWeight),
                    color: themeCards ? undefined : p.cardPriceColor,
                  }}
                >
                  £00.00
                </div>
                {p.quickAdd && !themeCards && (
                  <div
                    style={{
                      marginTop: 6,
                      padding: "0.5em 0.75em",
                      textAlign: "center",
                      borderRadius: p.cardButtonRadius,
                      background: p.cardButtonBg,
                      color: p.cardButtonText,
                      fontSize: "0.9em",
                      display: p.cardButtonFullWidth ? "block" : "inline-block",
                    }}
                  >
                    {p.cardButtonLabel}
                  </div>
                )}
              </div>
            ))}
          </div>
          <s-text color="subdued">
            {themeCards
              ? `Your theme draws these cards · filters as a ${p.filterLayout}`
              : `${
                  p.productCards === "app"
                    ? "This app draws these cards"
                    : "This app draws these cards when a filter needs it"
                } · ${p.gridColumns} columns · filters as a ${p.filterLayout} · ${p.resultsPerPage} per page`}
          </s-text>
        </div>
      </div>
    </s-box>
  );
}


export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
