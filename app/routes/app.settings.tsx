import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
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
import {
  ensureWebPixel,
  removeWebPixel,
  getPixelState,
  missingPixelScopes,
  PIXEL_SCOPES,
} from "../lib/pixel.server";
import { TILES, useSaveToast } from "../components/ui";
import { ModeCard } from "../components/mode";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing, admin } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const { limits } = await getPlanStatus(billing, shop.planOverride);
  const isPro = limits.semantic;
  const pixel = await getPixelState(admin);
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
    pixel: pixel.state,
    // Why it is unavailable, rather than one catch-all "reinstall" message:
    // a stale SCOPES variable and an app version that never declared the
    // pixel scopes both look identical from here, and neither is fixed by
    // reinstalling.
    pixelReason: pixel.reason ?? null,
    missingScopes: missingPixelScopes(session.scope),
    requiredScopes: PIXEL_SCOPES,
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

  // The storefront mode saves on its own: it lives outside the settings form
  // (see components/mode.tsx), so it arrives as its own submission.
  if (intent === "mode") {
    const settings = mergeSettings(shop.settings, { mode: String(f.get("mode") ?? "") });
    await prisma.shop.update({
      where: { id: shop.id },
      data: { settings: settings as unknown as Prisma.InputJsonObject },
    });
    invalidateShopConfig(shop.id);
    return { ok: true };
  }

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
    // mode is deliberately absent: it saves through its own intent above, and
    // this form no longer renders the field. Listing it here would read as if
    // the main Save still carried it.
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
    gridColumnsMobile: numeric("gridColumnsMobile"),
    fontSize: numeric("fontSize"),
    filterLayout: field("filterLayout"),
    productCards: field("productCards"),
    collectionWidthEnabled: checkbox("collectionWidthEnabled"),
    collectionMaxWidth: numeric("collectionMaxWidth"),
    collectionSidePadding: numeric("collectionSidePadding"),
    collectionColumnsEnabled: checkbox("collectionColumnsEnabled"),
    collectionColumns: numeric("collectionColumns"),
    collectionColumnsMobile: numeric("collectionColumnsMobile"),
    cardRatio: field("cardRatio"),
    cardImageHeight: numeric("cardImageHeight"),
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
    filterHoverText: field("filterHoverText"),
    filterHoverBg: field("filterHoverBg"),
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

type TabKey = "search" | "filters" | "cards" | "advanced";

const TABS: { key: TabKey; label: string; blurb: string }[] = [
  { key: "search", label: "Search", blurb: "Behaviour, relevance, panel layout, colours and fonts" },
  { key: "filters", label: "Filters", blurb: "Collection pages, filter appearance and colour swatches" },
  { key: "cards", label: "Product cards", blurb: "Grid size, image shape and card appearance" },
  { key: "advanced", label: "Advanced", blurb: "Indexing, search language and revenue tracking" },
];

const PREVIEW_HEADING: Record<TabKey, string> = {
  search: "Search preview",
  filters: "Filter preview",
  cards: "Product card preview",
  advanced: "",
};

/**
 * The tab strip: which group of settings is on screen.
 *
 * Native buttons, because this sits OUTSIDE the settings form (so there is no
 * submit to guard against) and because the active tab needs to sit on the
 * baseline rule with its underline joining it — which is what makes a strip
 * read as tabs rather than as a toolbar. The -1px margin pulls each button over
 * the container rule so the active underline replaces it rather than stacking
 * beneath it.
 */
function TabStrip({
  active,
  onSelect,
}: {
  active: TabKey;
  onSelect: (key: TabKey) => void;
}) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <div
        role="tablist"
        aria-label="Settings sections"
        style={{
          display: "flex",
          gap: "0.25rem",
          borderBottom: "1px solid rgba(128,128,128,.3)",
          overflowX: "auto",
        }}
      >
        {TABS.map((t) => {
          const on = t.key === active;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onSelect(t.key)}
              style={{
                appearance: "none",
                background: "none",
                border: 0,
                borderBottom: on
                  ? "2px solid currentColor"
                  : "2px solid transparent",
                marginBottom: -1,
                padding: "0.7rem 0.85rem",
                font: "inherit",
                fontWeight: on ? 600 : 450,
                opacity: on ? 1 : 0.6,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div style={{ padding: "0.6rem 0.1rem 0", opacity: 0.65, fontSize: "0.85em" }}>
        {TABS.find((t) => t.key === active)?.blurb}
      </div>
    </div>
  );
}

/**
 * One tab’s worth of sections, hidden rather than unmounted.
 *
 * `display: none` on a wrapper, not the `hidden` attribute: these are custom
 * elements that set their own display, which would beat the browser’s
 * `[hidden] { display: none }` rule.
 */
function Panel({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <div
      style={{
        display: show ? "block" : "none",
        // A tab is built from more than one panel, because some sections live
        // inside the settings form and some outside it (they submit on their
        // own). The stack below spaces sections WITHIN a panel; two panels are
        // plain siblings, so without this their cards sat flush together.
        marginBlockEnd: show ? "var(--s-space-large-500, 1.25rem)" : undefined,
      }}
    >
      <s-stack direction="block" gap="large-500">{children}</s-stack>
    </div>
  );
}

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
  const {
    settings,
    domain,
    isPro,
    semanticAvailable,
    searchLanguage,
    autoSyncEnabled,
    pixel,
    pixelReason,
    missingScopes,
    requiredScopes,
  } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const pixelFetcher = useFetcher<typeof action>();
  const s = settings;
  const busy = fetcher.state !== "idle";
  useSaveToast(fetcher, "Settings saved");
  const modeFetcher = useFetcher<typeof action>();
  useSaveToast(pixelFetcher, "Revenue tracking updated");
  useSaveToast(modeFetcher, "Storefront mode updated");

  /* Four tabs rather than eleven stacked cards. Every panel stays MOUNTED and
     is hidden with CSS: unmounting one would drop its inputs from the form,
     so edits made on one tab would be silently lost by a save made on
     another. The cost is a slightly larger DOM, which is nothing next to
     losing a merchant’s work. */
  const [tab, setTab] = useState<TabKey>("search");

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

      <ModeCard mode={s.mode} fetcher={modeFetcher} />

      {/* Tabs and everything they switch live inside ONE bordered container, so
          it is visually obvious that the cards below belong to the selected tab.
          A detached row of buttons above loose cards read as four unrelated
          actions rather than as a tab strip.

          Built from native <button> elements rather than Polaris components:
          s-button-group rendered its children as nothing at all here, and a tab
          needs an underline-and-baseline treatment that a button variant cannot
          express anyway. Colours are neutral rgba and opacity so the strip works
          on a light or dark admin without hardcoding either palette. */}
      <div
        style={{
          border: "1px solid rgba(128,128,128,.28)",
          borderRadius: 14,
          padding: "0.25rem 0.75rem 0.75rem",
          background: "rgba(128,128,128,.05)",
          // A column with its own gap. The container's children are the tab
          // strip, the preview card, the settings form and the panels that
          // submit separately — none of which s-page is spacing any more, since
          // they are no longer its direct children. Without this the preview
          // card sat flush against the first settings card.
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <TabStrip active={tab} onSelect={setTab} />


      {/* One preview per tab, showing only what that tab controls. A single
          combined preview meant someone editing filter colours was watching a
          search panel and a product grid that had nothing to do with the
          controls under their cursor. */}
      {tab !== "advanced" && (
        <s-section heading={PREVIEW_HEADING[tab]}>
          <s-paragraph>
            <s-text color="subdued">
              Drawn with the settings on this tab. It updates as you edit —
              nothing is saved until you press Save.
            </s-text>
          </s-paragraph>
          <WidgetPreview settings={draft} part={tab} />
        </s-section>
      )}

      <fetcher.Form method="post" id="adsf-settings" ref={formRef}>
        {/* s-page only spaces its DIRECT s-section children. With the form in
            between, every section card stacked flush against the next, so the
            gap has to be supplied here. Each tab panel carries its own stack,
            because the hidden wrapper in between breaks that adjacency again. */}
        <Panel show={tab === "search"}>
        <s-section heading="Behaviour">
          <s-stack direction="block" gap="base">
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

        </Panel>

        <Panel show={tab === "cards"}>
        <s-section heading="Results page">
          <s-stack direction="block" gap="base">
            <s-number-field name="resultsPerPage" label="Products per page" min={12} max={48} defaultValue={String(s.resultsPerPage)} />
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-number-field name="gridColumns" label="Cards per row on desktop" min={2} max={5} defaultValue={String(s.gridColumns)} />
              <s-number-field name="gridColumnsMobile" label="Cards per row on mobile" min={1} max={4} defaultValue={String(s.gridColumnsMobile)} />
            </s-grid>
            <Check name="showVendor" checked={s.showVendor} label="Show the brand name on result cards" />
            <Check name="quickAdd" checked={s.quickAdd} label="Add to cart directly from results (single-variant products)" />
          </s-stack>
        </s-section>

        </Panel>

        <Panel show={tab === "filters"}>
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
            <s-divider />
            <Check
              name="collectionWidthEnabled"
              checked={s.collectionWidthEnabled}
              label="Set my own page width for collection pages"
            />
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-number-field
                name="collectionMaxWidth"
                label="Maximum width (px)"
                min={600}
                max={2400}
                defaultValue={String(s.collectionMaxWidth)}
                {...(s.collectionWidthEnabled ? {} : { disabled: true })}
              />
              <s-number-field
                name="collectionSidePadding"
                label="Space at the sides (px)"
                min={0}
                max={120}
                defaultValue={String(s.collectionSidePadding)}
                {...(s.collectionWidthEnabled ? {} : { disabled: true })}
              />
            </s-grid>
            <s-text color="subdued">
              Leave this off to sit inside your theme&rsquo;s own page container.
            </s-text>

            <s-divider />
            <Check
              name="collectionColumnsEnabled"
              checked={s.collectionColumnsEnabled}
              label="Set how many products fit in a row on collection pages"
            />
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-number-field
                name="collectionColumns"
                label="Per row on desktop"
                min={1}
                max={6}
                defaultValue={String(s.collectionColumns)}
                {...(s.collectionColumnsEnabled ? {} : { disabled: true })}
              />
              <s-number-field
                name="collectionColumnsMobile"
                label="Per row on mobile"
                min={1}
                max={4}
                defaultValue={String(s.collectionColumnsMobile)}
                {...(s.collectionColumnsEnabled ? {} : { disabled: true })}
              />
            </s-grid>
            <s-text color="subdued">
              Leave this off to keep your theme’s own layout, including any
              in-between sizes it uses on tablets.
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

        </Panel>

        <Panel show={tab === "cards"}>
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

              <s-number-field
                name="cardImageHeight"
                label="Fixed image height in pixels (0 to use the shape above)"
                min={0}
                max={600}
                defaultValue={String(s.cardImageHeight)}
              />
              {s.cardImageHeight > 0 && (
                <s-text color="subdued">
                  A fixed height overrides Image shape. Set it back to 0 to use
                  the shape again.
                </s-text>
              )}

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

        </Panel>

        <Panel show={tab === "filters"}>
        <s-section heading="Filter appearance">
          <s-stack direction="block" gap="base">
            {/* Where the filters sit. This lived under "Results page" on the
                Product cards tab, so it could not be found from the Filters tab
                where anyone would look for it. */}
            <s-select name="filterLayout" label="Where filters appear" value={s.filterLayout}>
              <s-option value="sidebar">Sidebar beside the grid, drawer on mobile</s-option>
              <s-option value="topbar">Toolbar in one row above the grid</s-option>
              <s-option value="drawer">Always behind a Filters button</s-option>
              <s-option value="inline">Always open, stacked above the grid</s-option>
            </s-select>
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
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <ColorField name="filterHoverBg" label="Hover background" value={s.filterHoverBg} />
              <ColorField name="filterHoverText" label="Hover text" value={s.filterHoverText} />
            </s-grid>
            <Check name="showFacetCounts" checked={s.showFacetCounts} label="Show the number of products beside each filter value" />
          </s-stack>
        </s-section>

        </Panel>

        <Panel show={tab === "search"}>
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

        </Panel>

        <Panel show={tab === "filters"}>
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
        </Panel>

        <Panel show={tab === "advanced"}>
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
        </Panel>
      </fetcher.Form>

      {/* Outside the settings form on purpose: this installs or removes a Web
          Pixel through Shopify, which is a different kind of action from saving
          a colour and should not ride along with it. */}
      <Panel show={tab === "advanced"}>
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
            <s-banner
              tone="warning"
              heading={
                missingScopes.length
                  ? "Permission not granted yet"
                  : "Revenue tracking is unavailable"
              }
            >
              {missingScopes.length ? (
                <>
                  <s-paragraph>
                    This store has not approved {missingScopes.join(" and ")}, which
                    the pixel needs.
                  </s-paragraph>
                  <s-paragraph>
                    If reinstalling has not fixed this, the app version Shopify holds
                    does not ask for these scopes yet. Run shopify app deploy, check
                    that the SCOPES variable on the server matches shopify.app.toml,
                    then reinstall. Reinstalling only ever re-approves the scopes the
                    deployed version asks for, so on its own it cannot fix this.
                  </s-paragraph>
                </>
              ) : (
                <>
                  <s-paragraph>
                    This store has already granted {requiredScopes.join(" and ")}, so
                    this is not a permissions problem and reinstalling will not help.
                  </s-paragraph>
                  {pixelReason && <s-paragraph>Shopify said: {pixelReason}</s-paragraph>}
                </>
              )}
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
      </Panel>
      </div>

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

function WidgetPreview({
  settings: p,
  part,
}: {
  settings: WidgetSettings;
  part: Exclude<TabKey, "advanced">;
}) {
  // "auto" can go either way per collection, so the preview shows our cards
  // for it: that is the case worth previewing, since the theme’s cards are
  // whatever the theme already looks like.
  const themeCards = p.productCards === "theme";
  const fixedImage = !themeCards && p.cardImageHeight > 0;
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
        {part === "search" && (
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
        )}

        {/* --- Filter bar --- */}
        {part === "filters" && (
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
          <s-text color="subdued">
            {`${p.filterButtonShape} buttons · ${p.filterLayout} layout · counts ${
              p.showFacetCounts ? "on" : "off"
            }`}
          </s-text>
        </div>
        )}

        {/* --- Product cards --- */}
        {part === "cards" && (
        <div>
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
                    aspectRatio:
                      themeCards || fixedImage ? undefined : RATIO_CSS[p.cardRatio],
                    height: fixedImage ? p.cardImageHeight : undefined,
                    minHeight:
                      !themeCards && !fixedImage && p.cardRatio === "natural" ? 96 : undefined,
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
                } · ${p.gridColumns} per row on desktop, ${p.gridColumnsMobile} on mobile · ${p.resultsPerPage} per page`}
          </s-text>
        </div>
        )}
      </div>
    </s-box>
  );
}


export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
