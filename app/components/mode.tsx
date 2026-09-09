// The storefront mode: what this app runs on the storefront at all.
//
// Deliberately NOT one of the settings tabs. It is the switch every other
// setting is conditional on — a merchant running "Filters only" is looking at a
// Search tab full of controls that do nothing — so it sits above the tabs on
// Settings, and again on the Dashboard, rather than being the first row of one
// section among eleven.
//
// It submits on its own, with its own intent, because it lives outside the main
// settings form (HTML forms cannot nest, and the panels below it are one big
// form). That also means changing it is one action rather than "change, scroll,
// Save".

import type { useFetcher } from "react-router";
import type { WidgetSettings } from "../lib/settings";

export type StorefrontMode = WidgetSettings["mode"];

export const MODE_LABELS: Record<StorefrontMode, string> = {
  both: "Search and filters",
  search: "Search only",
  filters: "Filters only",
};

const MODE_BLURBS: Record<StorefrontMode, string> = {
  both: "Instant search and collection filters are both live.",
  search: "Instant search only. Collection pages are left to your theme.",
  filters: "Collection filters only. Your theme keeps its own search.",
};

/**
 * The mode control, highlighted and self-contained.
 *
 * `fetcher` is passed in rather than created here so the page owns the pending
 * state and the save toast, exactly like every other form in this admin.
 */
export function ModeCard({
  mode,
  fetcher,
  heading = "What this app runs on your storefront",
}: {
  mode: StorefrontMode;
  fetcher: ReturnType<typeof useFetcher>;
  heading?: string;
}) {
  const busy = fetcher.state !== "idle";

  return (
    <s-section heading={heading}>
      <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-500" alignItems="center">
            <s-text type="strong">Currently</s-text>
            <s-badge tone="success">{MODE_LABELS[mode]}</s-badge>
          </s-stack>
          <s-text color="subdued">{MODE_BLURBS[mode]}</s-text>

          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="mode" />
            <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
              {/* Option labels are LITERAL text, not {MODE_LABELS.x}.
                  s-option takes its label from its text content when it
                  registers with the select, and a JSX expression child is
                  committed as a separate text-node insertion — which rendered
                  the whole select blank. Every other s-select in this app uses
                  literal children, and every one of them works. MODE_LABELS
                  still drives the badge above, where a dynamic child is fine. */}
              <s-select name="mode" label="Change this" value={mode}>
                <s-option value="both">Search and filters</s-option>
                <s-option value="search">Search only</s-option>
                <s-option value="filters">Filters only</s-option>
              </s-select>
              <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
                Apply
              </s-button>
            </s-grid>
          </fetcher.Form>

          <s-text color="subdued">
            Everything else in Settings only applies to the half you have turned
            on. A block you placed by hand in the theme editor keeps working
            either way, since placing it is already an explicit choice.
          </s-text>
        </s-stack>
      </s-box>
    </s-section>
  );
}
