// CSV import/export for merchandising rules. Pure; tested in test/features.test.mjs.

export interface RuleCsvRow {
  name: string;
  triggerQuery: string | null;
  triggerCollection: string | null;
  pinnedProductIds: string[];
  boostedProductIds: string[];
  buriedProductIds: string[];
  hiddenProductIds: string[];
  priority: number;
  active: boolean;
}

export const RULE_CSV_HEADER = [
  "name", "trigger_query", "trigger_collection", "pinned", "boosted", "buried", "hidden", "priority", "active",
];

function cell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function exportRulesCsv(rules: RuleCsvRow[]): string {
  const lines = [RULE_CSV_HEADER.join(",")];
  for (const r of rules) {
    lines.push(
      [
        r.name, r.triggerQuery ?? "", r.triggerCollection ?? "",
        r.pinnedProductIds.join(" "), r.boostedProductIds.join(" "),
        r.buriedProductIds.join(" "), r.hiddenProductIds.join(" "),
        String(r.priority), r.active ? "true" : "false",
      ].map(cell).join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/** RFC 4180-ish parser: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

const ids = (v: string) => v.split(/[\s;|]+/).map((s) => s.trim()).filter(Boolean);

export function parseRulesCsv(text: string): { rows: RuleCsvRow[]; errors: string[] } {
  const all = parseCsv(text.replace(/^\uFEFF/, ""));
  const errors: string[] = [];
  const rows: RuleCsvRow[] = [];
  if (!all.length) return { rows, errors: ["The file is empty."] };
  const header = all[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  if (col("name") < 0) return { rows, errors: ["Missing the 'name' column."] };

  all.slice(1, 1001).forEach((r, i) => {
    const line = i + 2;
    const get = (name: string) => (col(name) >= 0 ? (r[col(name)] ?? "").trim() : "");
    const name = get("name").slice(0, 120);
    if (!name) return errors.push(`Row ${line}: name is required.`);
    const lists = {
      pinnedProductIds: ids(get("pinned")),
      boostedProductIds: ids(get("boosted")),
      buriedProductIds: ids(get("buried")),
      hiddenProductIds: ids(get("hidden")),
    };
    const bad = Object.values(lists).flat().find((x) => !/^\d+$/.test(x));
    if (bad) return errors.push(`Row ${line}: "${bad}" is not a numeric Shopify product id.`);
    const triggerQuery = get("trigger_query") || null;
    const triggerCollection = get("trigger_collection") || null;
    if (!triggerQuery && !triggerCollection) return errors.push(`Row ${line}: set trigger_query or trigger_collection.`);
    const p = Number(get("priority") || 0);
    rows.push({
      name,
      triggerQuery,
      triggerCollection,
      ...lists,
      priority: Number.isFinite(p) ? Math.max(-100, Math.min(100, Math.round(p))) : 0,
      active: get("active").toLowerCase() !== "false",
    });
  });
  return { rows, errors };
}
