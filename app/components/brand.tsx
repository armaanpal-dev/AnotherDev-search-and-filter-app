// Brand layer for the admin.
//
// Polaris web components take no custom colours, so the few places that carry
// the AnotherDev brand (the dashboard hero, metric accents, hub icons, setup
// progress) are styled here and nowhere else. Colours come from the app icon
// (public/icon.svg): navy #101336 and the pink-to-violet gradient.

export const BRAND = {
  navy: "#101336",
  pink: "#FF4B8F",
  violet: "#8C5CFF",
  gradient: "linear-gradient(135deg, #FF4B8F 0%, #8C5CFF 100%)",
  tint: "linear-gradient(135deg, rgba(255,75,143,.12) 0%, rgba(140,92,255,.16) 100%)",
};

/** One accent per metric, so a row of numbers is scannable at a glance. */
export const ACCENTS = {
  pink: { fg: "#D6286E", bg: "rgba(255,75,143,.12)" },
  violet: { fg: "#6B3FE0", bg: "rgba(140,92,255,.14)" },
  teal: { fg: "#0E8A7E", bg: "rgba(20,184,166,.14)" },
  amber: { fg: "#B45309", bg: "rgba(245,158,11,.16)" },
  red: { fg: "#C5221F", bg: "rgba(229,57,53,.12)" },
  navy: { fg: "#101336", bg: "rgba(16,19,54,.08)" },
} as const;
export type Accent = keyof typeof ACCENTS;

/** The AnotherDev mark, same shape as the app icon. */
export function BrandMark({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      <defs>
        <linearGradient id="adsf-brand-g" gradientUnits="userSpaceOnUse" x1="260" y1="260" x2="800" y2="800">
          <stop offset="0" stopColor={BRAND.pink} />
          <stop offset="1" stopColor={BRAND.violet} />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="228" fill="#1B1F4B" />
      <circle cx="452" cy="452" r="172" fill="none" stroke="url(#adsf-brand-g)" strokeWidth="110" />
      <path d="M598 598 L772 772" fill="none" stroke="url(#adsf-brand-g)" strokeWidth="110" strokeLinecap="round" />
    </svg>
  );
}

/** Dashboard header band: brand, status chips and the next action. */
export function BrandHero({
  title,
  subtitle,
  chips,
  action,
}: {
  title: string;
  subtitle: string;
  chips: { label: string; ok: boolean }[];
  action?: { label: string; href: string };
}) {
  return (
    <div
      style={{
        background: `radial-gradient(120% 160% at 100% 0%, rgba(140,92,255,.55) 0%, rgba(255,75,143,.22) 38%, ${BRAND.navy} 72%)`,
        color: "#fff",
        borderRadius: 16,
        padding: "22px 24px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 18,
        boxShadow: "0 8px 24px rgba(16,19,54,.18)",
      }}
    >
      <BrandMark />
      <div style={{ flex: "1 1 260px", minWidth: 0 }}>
        <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.25 }}>{title}</div>
        <div style={{ opacity: 0.8, marginTop: 4, fontSize: 13.5 }}>{subtitle}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          {chips.map((c) => (
            <span
              key={c.label}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                background: c.ok ? "rgba(52,211,153,.18)" : "rgba(255,255,255,.10)",
                border: `1px solid ${c.ok ? "rgba(52,211,153,.55)" : "rgba(255,255,255,.24)"}`,
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: c.ok ? "#34D399" : "#FBBF24" }} />
              {c.label}
            </span>
          ))}
        </div>
      </div>
      {action && (
        // s-button cannot take a custom background; the hero's one action does.
        <s-clickable href={action.href} borderRadius="base">
          <span
            style={{
              display: "inline-block",
              background: BRAND.gradient,
              color: "#fff",
              fontWeight: 700,
              fontSize: 14,
              padding: "10px 18px",
              borderRadius: 10,
              boxShadow: "0 4px 14px rgba(255,75,143,.35)",
              whiteSpace: "nowrap",
            }}
          >
            {action.label}
          </span>
        </s-clickable>
      )}
    </div>
  );
}

/** A metric tile with a coloured accent: top bar, tinted icon, big number. */
export function ColorStat({
  label,
  value,
  icon,
  accent = "violet",
  hint,
  href,
}: {
  label: string;
  value: string;
  icon: string;
  accent?: Accent;
  hint?: string;
  href?: string;
}) {
  const a = ACCENTS[accent];
  const body = (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: 12,
        border: "1px solid rgba(16,19,54,.08)",
        background: "#fff",
        padding: "16px 16px 14px",
        height: "100%",
        boxSizing: "border-box",
      }}
    >
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: a.fg }} />
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 32,
            height: 32,
            borderRadius: 9,
            background: a.bg,
            color: a.fg,
          }}
        >
          <s-icon type={icon as any} />
        </span>
        <s-text color="subdued">{label}</s-text>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 10, color: "#1a1a1a", lineHeight: 1.1 }}>{value}</div>
      {hint && <div style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color: a.fg }}>{hint}</div>}
    </div>
  );
  return href ? (
    <s-clickable href={href} borderRadius="base">
      {body}
    </s-clickable>
  ) : (
    body
  );
}

/** Thin brand-gradient progress bar with an "n of m done" label. */
export function Progress({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <s-text type="strong">{label}</s-text>
        <s-text color="subdued">{`${done} of ${total} done`}</s-text>
      </div>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ height: 8, borderRadius: 999, background: "rgba(16,19,54,.08)", overflow: "hidden" }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: BRAND.gradient, borderRadius: 999 }} />
      </div>
    </div>
  );
}

/** Tinted brand icon tile, used on hub cards and the dashboard page map. */
export function BrandIcon({ type }: { type: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 40,
        height: 40,
        borderRadius: 11,
        background: BRAND.tint,
        color: BRAND.violet,
        flexShrink: 0,
      }}
    >
      <s-icon type={type as any} />
    </span>
  );
}
