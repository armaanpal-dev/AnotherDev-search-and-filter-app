// The Search activity panel: what shoppers looked for, and what they looked for
// and did not find.
//
// Two ranked lists side by side, each row a bar whose width is the term's share
// of the top term. A bare "cocomelon ×4235 / pokemon ×535" list makes the reader
// do that comparison in their head; the bar does it for them, and the shape of
// the column tells you at a glance whether search is dominated by one term or
// spread evenly.
//
// Inline styles, deliberately: these are proportional data bars, not admin
// chrome, and their width is computed per row. Polaris has no primitive for it.

import type { ReactNode } from "react";

export type ActivityRange = "day" | "week" | "month";

export const RANGE_DAYS: Record<ActivityRange, number> = {
  day: 1,
  week: 7,
  month: 30,
};

export const RANGE_LABELS: Record<ActivityRange, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
};

export function isActivityRange(v: unknown): v is ActivityRange {
  return v === "day" || v === "week" || v === "month";
}

export interface TermRow {
  term: string;
  count: number;
}

/** One ranked column: heading, scrollable rows, export link. */
function Column({
  heading,
  rows,
  tone,
  exportHref,
  exportName,
  empty,
}: {
  heading: string;
  rows: TermRow[];
  tone: "positive" | "neutral";
  exportHref: string;
  exportName: string;
  empty: string;
}) {
  // Bars are relative to the top row, not to the total: the question a merchant
  // is asking is "how does this compare with the biggest", and against a total
  // every bar in a long tail collapses to invisible.
  const max = rows.length ? Math.max(...rows.map((r) => r.count)) : 0;
  const fill = tone === "positive" ? "rgba(29,138,86,.16)" : "rgba(128,128,128,.16)";

  return (
    <s-stack direction="block" gap="small-300">
      <s-text type="strong">{heading}</s-text>

      {rows.length ? (
        <div
          style={{
            maxHeight: 340,
            overflowY: "auto",
            border: "1px solid rgba(128,128,128,.22)",
            borderRadius: 10,
          }}
        >
          {rows.map((r, i) => (
            <div
              key={r.term}
              style={{
                display: "grid",
                gridTemplateColumns: "28px minmax(0, 1fr)",
                alignItems: "center",
                gap: 8,
                padding: "2px 8px 2px 4px",
                borderBottom:
                  i === rows.length - 1
                    ? "none"
                    : "1px solid rgba(128,128,128,.14)",
              }}
            >
              <div style={{ textAlign: "right", opacity: 0.5, fontSize: "0.85em" }}>
                {i + 1}
              </div>
              {/* The bar is the row's background, so the term always sits on top
                  of it and never gets clipped by a short bar. */}
              <div
                style={{
                  position: "relative",
                  borderRadius: 6,
                  padding: "7px 10px",
                  minWidth: 0,
                }}
              >
                <div
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: max ? `${Math.max(4, (r.count / max) * 100)}%` : "0%",
                    background: fill,
                    borderRadius: 6,
                  }}
                />
                <div style={{ position: "relative", wordBreak: "break-word" }}>
                  {r.term}{" "}
                  <span style={{ opacity: 0.55, fontSize: "0.85em" }}>
                    &times;{r.count.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <s-box padding="base" background="subdued" borderRadius="base">
          <s-text color="subdued">{empty}</s-text>
        </s-box>
      )}

      {/* Same shape as the Analytics page's export, which is proven to work
          inside the embedded iframe: a plain link with `download`, pointing at
          the loader with an ?export= param. No icon name is passed, because an
          icon that does not exist renders as nothing and there is no way to
          verify the name from here. */}
      <s-button variant="secondary" href={exportHref} download={exportName}>
        Export
      </s-button>
    </s-stack>
  );
}

export function SearchActivity({
  range,
  top,
  zero,
  rangeHref,
  exportHref,
}: {
  range: ActivityRange;
  top: TermRow[];
  zero: TermRow[];
  /** Where a range tab points. */
  rangeHref: (r: ActivityRange) => string;
  /** Where an Export button points, per list. */
  exportHref: (list: "top" | "zero") => string;
}) {
  const tabs: ReactNode = (
    <div
      role="tablist"
      aria-label="Search activity range"
      style={{ display: "flex", gap: 4 }}
    >
      {(Object.keys(RANGE_LABELS) as ActivityRange[]).map((r) => {
        const on = r === range;
        return (
          <a
            key={r}
            role="tab"
            aria-selected={on}
            href={rangeHref(r)}
            style={{
              textDecoration: "none",
              color: "inherit",
              font: "inherit",
              fontWeight: on ? 600 : 450,
              padding: "0.35rem 0.8rem",
              borderRadius: 8,
              background: on ? "rgba(128,128,128,.18)" : "transparent",
            }}
          >
            {RANGE_LABELS[r]}
          </a>
        );
      })}
    </div>
  );

  return (
    <s-section heading="Search activity">
      <s-stack direction="block" gap="base">
        {tabs}
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(280px, 1fr))" gap="large-100">
          <Column
            heading="Top searches"
            rows={top}
            tone="positive"
            exportHref={exportHref("top")}
            exportName={`top-searches-${range}.csv`}
            empty="No searches recorded in this period yet."
          />
          <Column
            heading="Top searches with no results"
            rows={zero}
            tone="neutral"
            exportHref={exportHref("zero")}
            exportName={`no-results-${range}.csv`}
            empty="Nothing came up empty in this period."
          />
        </s-grid>
      </s-stack>
    </s-section>
  );
}
