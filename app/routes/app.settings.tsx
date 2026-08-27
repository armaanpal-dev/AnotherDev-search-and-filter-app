import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { Prisma } from "@prisma/client";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { resolveSettings, type WidgetSettings } from "../lib/settings";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  return { settings: resolveSettings(shop.settings), domain: shop.domain };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const f = await request.formData();

  const settings: WidgetSettings = resolveSettings({
    autoAttach: f.get("autoAttach") === "on",
    showRecommendations: f.get("showRecommendations") === "on",
    typoTolerance: f.get("typoTolerance") === "on",
    showOutOfStock: f.get("showOutOfStock") === "on",
    minChars: Number(f.get("minChars")),
    maxSuggestions: Number(f.get("maxSuggestions")),
    panelStyle: String(f.get("panelStyle")),
    layout: String(f.get("layout")),
    previewSide: String(f.get("previewSide")),
    accentColor: String(f.get("accentColor")),
    backgroundColor: String(f.get("backgroundColor")),
    textColor: String(f.get("textColor")),
    highlightColor: String(f.get("highlightColor")),
    fontSize: Number(f.get("fontSize")),
    fontWeight: String(f.get("fontWeight")),
  });

  await prisma.shop.update({
    where: { id: shop.id },
    data: { settings: settings as unknown as Prisma.InputJsonObject },
  });
  return { ok: true };
};

export default function SettingsPage() {
  const { settings, domain } = useLoaderData<typeof loader>();
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
            <s-checkbox name="autoAttach" label="Upgrade my theme's search box with instant results" {...(s.autoAttach ? { checked: true } : {})} />
            <s-checkbox name="showRecommendations" label="Show recommendations when the search box is empty" {...(s.showRecommendations ? { checked: true } : {})} />
            <s-checkbox name="typoTolerance" label="Typo tolerance (fuzzy matching)" {...(s.typoTolerance ? { checked: true } : {})} />
            <s-checkbox name="showOutOfStock" label="Include out-of-stock products in results" {...(s.showOutOfStock ? { checked: true } : {})} />
            <s-stack direction="inline" gap="base">
              <s-number-field name="minChars" label="Min characters to trigger" min={1} max={4} defaultValue={String(s.minChars)} />
              <s-number-field name="maxSuggestions" label="Max product suggestions" min={3} max={12} defaultValue={String(s.maxSuggestions)} />
            </s-stack>
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
