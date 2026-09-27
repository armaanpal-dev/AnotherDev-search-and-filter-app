// Shared admin UI primitives.
//
// One place for the app's visual language so seven pages cannot drift into
// seven different looks. Everything here is Polaris web components; there are
// no raw elements and no inline styles, which is what previously produced
// one-off spacing hacks like `style={{ marginInlineStart: "auto" }}`.

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

/** Responsive column templates. Tiles wrap on their own, without media queries. */
export const TILES = "repeat(auto-fit, minmax(170px, 1fr))";
export const CARDS = "repeat(auto-fit, minmax(260px, 1fr))";
export const WIDE = "repeat(auto-fit, minmax(240px, 1fr))";

export type Tone = "success" | "info" | "warning" | "critical";

/** A single number with its label. The unit of every metric row in the app. */
export function Stat({
  label,
  value,
  hint,
  tone,
  href,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
  href?: string;
}) {
  const body = (
    <s-stack direction="block" gap="small-500">
      <s-text color="subdued">{label}</s-text>
      <s-heading>{value}</s-heading>
      {hint ? (
        tone ? <s-badge tone={tone}>{hint}</s-badge> : <s-text color="subdued">{hint}</s-text>
      ) : null}
    </s-stack>
  );
  return href ? (
    <s-clickable href={href} padding="base" background="subdued" borderRadius="base">
      {body}
    </s-clickable>
  ) : (
    <s-box padding="base" background="subdued" borderRadius="base">
      {body}
    </s-box>
  );
}

/** A bordered card: title, optional badge, body. */
export function Card({
  title,
  badge,
  tone,
  children,
}: {
  title?: string;
  badge?: string;
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        {title && (
          <s-stack direction="inline" gap="small-500" alignItems="center">
            <s-text type="strong">{title}</s-text>
            {badge && <s-badge tone={tone}>{badge}</s-badge>}
          </s-stack>
        )}
        {children}
      </s-stack>
    </s-box>
  );
}

/**
 * A list row: content on the left, actions pinned right.
 *
 * The columns are explicit so the actions cannot be pushed onto their own line,
 * which is what `s-stack direction="inline"` plus an auto margin used to do.
 */
export function Row({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      {actions ? (
        /* auto-fit, NOT "1fr auto": inside a narrow column the actions took
           their max-content width and squeezed the text to about 60px, so a
           term like "show me some shirt" broke one word per line. auto-fit
           drops the actions onto their own row when there is no space for
           both, and the term gets the full width. */
        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
          gap="base"
          alignItems="center"
        >
          <s-stack direction="block" gap="small-500">{children}</s-stack>
          <s-stack direction="inline" gap="small-500" alignItems="center">
            {actions}
          </s-stack>
        </s-grid>
      ) : (
        <s-stack direction="block" gap="small-500">{children}</s-stack>
      )}
    </s-box>
  );
}

/** Nothing here yet: say what will appear, and offer the one action that starts it. */
export function Empty({
  heading,
  children,
  action,
}: {
  heading: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="base" alignItems="center">
        <s-heading>{heading}</s-heading>
        {children && <s-text color="subdued">{children}</s-text>}
        {action}
      </s-stack>
    </s-box>
  );
}

/**
 * A horizontal bar for one row of a distribution.
 *
 * Polaris has no progress or bar-chart component, so this is built from a
 * `s-box` whose inline size is the percentage. Kept here rather than repeated
 * per page, and deliberately paired with the number it represents so the value
 * is never conveyed by width alone.
 */
export function Bar({ label, value, max, suffix }: { label: string; value: number; max: number; suffix?: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  // Nothing to compare yet: one bar at 100% beside another at 100% reads as
  // a chart while carrying no information.
  if (max <= 1) {
    return (
      <s-grid gridTemplateColumns="1fr auto" gap="small-200" alignItems="center">
        <s-text>{label}</s-text>
        <s-text type="strong">
          {value.toLocaleString()}
          {suffix ?? ""}
        </s-text>
      </s-grid>
    );
  }
  return (
    <s-grid gridTemplateColumns="minmax(90px, 1fr) 3fr auto" gap="small-200" alignItems="center">
      <s-text color="subdued">{label}</s-text>
      <s-box background="subdued" borderRadius="base" padding="none">
        <s-box background="strong" borderRadius="base" inlineSize={`${pct}%`} minBlockSize="8px" />
      </s-box>
      <s-text type="strong">
        {value.toLocaleString()}
        {suffix ?? ""}
      </s-text>
    </s-grid>
  );
}

/**
 * Announce the result of a fetcher submission as an App Bridge toast.
 *
 * Every page in this admin saves through a fetcher and answers with either
 * `{ ok: true }` or `{ error }`, so one hook covers all of them and no page
 * has to grow its own banner. A toast rather than a banner because a save can
 * happen while the merchant is scrolled somewhere else on a long form — a
 * banner at the top of the page is feedback they never see.
 *
 * Keyed on the identity of `fetcher.data`, which React Router replaces on each
 * submission: `state === "idle" && data` alone would re-announce the last save
 * on every unrelated re-render.
 */
export function useSaveToast(
  fetcher: { state: string; data?: unknown },
  message = "Saved",
) {
  const announced = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data === announced.current) return;
    announced.current = fetcher.data;

    // App Bridge publishes this on window once its script has loaded. Guarded
    // rather than assumed so a non-embedded render (a test, a local page)
    // degrades to silence instead of throwing.
    const bridge = (globalThis as { shopify?: { toast?: { show: (m: string, o?: object) => void } } })
      .shopify;
    if (!bridge?.toast) return;

    const data = fetcher.data as { ok?: boolean; error?: unknown };
    if (data.error) {
      bridge.toast.show(String(data.error), { isError: true, duration: 5000 });
    } else if (data.ok) {
      bridge.toast.show(message);
    }
  }, [fetcher.state, fetcher.data, message]);
}
