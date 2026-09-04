// Shared admin UI primitives.
//
// One place for the app's visual language so seven pages cannot drift into
// seven different looks. Everything here is Polaris web components; there are
// no raw elements and no inline styles, which is what previously produced
// one-off spacing hacks like `style={{ marginInlineStart: "auto" }}`.

import type { ReactNode } from "react";

/** Responsive column templates. Tiles wrap on their own, without media queries. */
export const TILES = "repeat(auto-fit, minmax(170px, 1fr))";
export const CARDS = "repeat(auto-fit, minmax(260px, 1fr))";
export const WIDE = "repeat(auto-fit, minmax(320px, 1fr))";

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
      {tone ? <s-badge tone={tone}>{hint ?? ""}</s-badge> : hint ? <s-text color="subdued">{hint}</s-text> : null}
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
      <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
        <s-stack direction="block" gap="small-500">
          {children}
        </s-stack>
        {actions ? (
          <s-stack direction="inline" gap="small-500" alignItems="center">
            {actions}
          </s-stack>
        ) : (
          <s-text> </s-text>
        )}
      </s-grid>
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
    <s-box padding="large-100" borderWidth="base" borderRadius="base">
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
