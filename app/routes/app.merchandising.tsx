import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { invalidateShopConfig } from "../lib/search/config.server";
import { getPlanStatus } from "../lib/billing.server";
import { csvCell } from "../lib/analytics.server";
import { Row, Empty, Card } from "../components/ui";

const ids = (v: FormDataEntryValue | null) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{1,20}$/.test(s))
    .slice(0, 200);

/** Fields a condition can test. Mirrors conditionPredicate() in the engine. */
const CONDITION_FIELDS = [
  { value: "tag", label: "Tag" },
  { value: "vendor", label: "Brand / vendor" },
  { value: "productType", label: "Product type" },
  { value: "collection", label: "Collection handle" },
  { value: "available", label: "In stock (true/false)" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const { limits } = await getPlanStatus(billing, shop.planOverride);
  const isPro = limits.merchandising;

  const url = new URL(request.url);

  const [rules, redirects, syncState] = await Promise.all([
    prisma.merchandisingRule.findMany({
      where: { shopId: shop.id },
      orderBy: { priority: "desc" },
    }),
    prisma.redirect.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" } }),
    // Option names come from the cache the last sync wrote, not from a
    // `SELECT DISTINCT jsonb_object_keys(...)` full scan of Product on every
    // page load.
    prisma.syncState.findUnique({
      where: { shopId: shop.id },
      select: { optionNames: true },
    }),
  ]);

  if (url.searchParams.get("export") === "redirects") {
    const rows = [["query", "url", "active"]].concat(
      redirects.map((r) => [r.query, r.url, String(r.active)]),
    );
    return new Response(rows.map((r) => r.map(csvCell).join(",")).join("\r\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="redirects.csv"`,
      },
    });
  }

  // The four states a rule can be in, resolved on the server.
  //
  // Comparing against `Date.now()` during render would be both impure and a
  // hydration mismatch waiting to happen — the server and the browser evaluate
  // it at different instants, so a rule starting in the next second renders two
  // different badges.
  const now = Date.now();
  const statusOf = (r: (typeof rules)[number]) => {
    if (!r.active) return "paused" as const;
    if (r.startsAt && r.startsAt.getTime() > now) return "scheduled" as const;
    if (r.endsAt && r.endsAt.getTime() <= now) return "ended" as const;
    return "active" as const;
  };

  return {
    rules: rules.map((r) => ({
      ...r,
      status: statusOf(r),
      startsAt: r.startsAt?.toISOString() ?? null,
      endsAt: r.endsAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    redirects,
    isPro,
    optionNames: syncState?.optionNames ?? [],
  };
};

/**
 * `YYYY-MM-DD` from a date field, or null.
 *
 * `edge: "end"` moves to the last instant of that day, because "ends 10 March"
 * means through the 10th to a merchant, not at midnight as it begins.
 */
function parseWhen(v: FormDataEntryValue | null, edge: "start" | "end" = "start"): Date | null {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const d = new Date(edge === "end" ? `${s.slice(0, 10)}T23:59:59.999Z` : `${s.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  // Gate on the capability so the tier boundary lives in one place.
  const { limits } = await getPlanStatus(billing, shop.planOverride);
  if (!limits.merchandising) {
    return { error: "Merchandising is available on the Growth and Pro plans." };
  }
  const form = await request.formData();
  const intent = form.get("intent");

  const ruleData = () => {
    const startsAt = parseWhen(form.get("startsAt"), "start");
    const endsAt = parseWhen(form.get("endsAt"), "end");
    if (startsAt && endsAt && endsAt <= startsAt) {
      return { error: "The end of a schedule has to be after its start." };
    }
    const variantRaw = String(form.get("variant") || "all");
    return {
      data: {
        name: String(form.get("name") || "Untitled rule").slice(0, 120),
        triggerQuery: String(form.get("triggerQuery") || "").trim() || null,
        triggerCollection: String(form.get("triggerCollection") || "").trim() || null,
        pinnedProductIds: ids(form.get("pinned")),
        boostedProductIds: ids(form.get("boosted")),
        buriedProductIds: ids(form.get("buried")),
        hiddenProductIds: ids(form.get("hidden")),
        conditions: parseConditionsForm(form),
        priority: parseInt(String(form.get("priority") || "0"), 10) || 0,
        startsAt,
        endsAt,
        variant: ["all", "a", "b"].includes(variantRaw) ? variantRaw : "all",
      },
    };
  };

  if (intent === "createRule") {
    const parsed = ruleData();
    if ("error" in parsed) return parsed;
    await prisma.merchandisingRule.create({
      data: { shopId: shop.id, ...parsed.data },
    });
  } else if (intent === "updateRule") {
    const parsed = ruleData();
    if ("error" in parsed) return parsed;
    // Scoped by shopId as well as id: an id from another shop matches nothing.
    await prisma.merchandisingRule.updateMany({
      where: { id: String(form.get("id")), shopId: shop.id },
      data: parsed.data,
    });
  } else if (intent === "deleteRule") {
    await prisma.merchandisingRule.deleteMany({ where: { id: String(form.get("id")), shopId: shop.id } });
  } else if (intent === "toggleRule") {
    await prisma.merchandisingRule.updateMany({
      where: { id: String(form.get("id")), shopId: shop.id },
      data: { active: form.get("active") === "true" },
    });
  } else if (intent === "createRedirect") {
    const query = String(form.get("query") || "").trim().toLowerCase();
    const url = String(form.get("url") || "").trim();
    // Only same-origin paths. An absolute URL here would turn the merchant's own
    // search box into an open redirect for anyone who can guess the term.
    if (query && url.startsWith("/") && !url.startsWith("//")) {
      await prisma.redirect.upsert({
        where: { shopId_query: { shopId: shop.id, query } },
        create: { shopId: shop.id, query, url },
        update: { url, active: true },
      });
    } else if (query && url) {
      return { error: "Redirect targets must be a path on your store, e.g. /collections/sale" };
    }
  } else if (intent === "deleteRedirect") {
    await prisma.redirect.deleteMany({ where: { id: String(form.get("id")), shopId: shop.id } });
  } else if (intent === "importRedirects") {
    const text = String(form.get("csv") || "");
    if (!text.trim()) return { error: "Paste some CSV first." };
    let imported = 0;
    let skipped = 0;
    for (const line of text.split(/\r?\n/).slice(0, 2000)) {
      if (!line.trim()) continue;
      const cells = parseCsvLine(line);
      if (cells[0]?.toLowerCase() === "query") continue;
      const query = (cells[0] ?? "").trim().toLowerCase().slice(0, 200);
      const url = (cells[1] ?? "").trim().slice(0, 500);
      // Same same-origin rule as the single-add form. An import must not be a
      // way around a validation the form enforces.
      if (!query || !url.startsWith("/") || url.startsWith("//")) {
        skipped++;
        continue;
      }
      await prisma.redirect.upsert({
        where: { shopId_query: { shopId: shop.id, query } },
        create: { shopId: shop.id, query, url },
        update: { url, active: true },
      });
      imported++;
    }
    invalidateShopConfig(shop.id);
    return imported
      ? { ok: true, imported, skipped }
      : { error: `Nothing importable found${skipped ? ` (${skipped} rows skipped)` : ""}.` };
  }
  invalidateShopConfig(shop.id);
  return { ok: true };
};

/** Minimal RFC-4180 line parser, matching the export's escaping. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.replace(/^'(?=[=+\-@])/, ""));
}

/** Condition rows arrive as parallel arrays (cond.field[], cond.op[], …). */
function parseConditionsForm(form: FormData) {
  const fields = form.getAll("cond.field").map(String);
  const ops = form.getAll("cond.op").map(String);
  const values = form.getAll("cond.value").map(String);
  const actions = form.getAll("cond.action").map(String);
  const weights = form.getAll("cond.weight").map(String);

  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]?.trim();
    const value = values[i]?.trim();
    if (!field || !value) continue;
    out.push({
      field,
      op: ops[i] || "eq",
      value,
      action: actions[i] || "boost",
      weight: Number(weights[i]) || 5,
    });
  }
  return out;
}

type LoadedRule = ReturnType<typeof useLoaderData<typeof loader>>["rules"][number];

export default function MerchandisingPage() {
  const { rules, redirects, isPro, optionNames } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [sp] = useSearchParams();
  const [editing, setEditing] = useState<string | null>(null);
  const data = fetcher.data;
  const error = data && "error" in data ? data.error : null;
  const imported = data && "imported" in data ? data.imported : null;

  if (!isPro) {
    return (
      <s-page heading="Merchandising">
        <s-banner tone="info" heading="Merchandising is a Pro feature">
          <s-paragraph>
            Pin products to the top of results, boost or bury by relevance, hide products,
            schedule a rule for a sale window, A/B test two strategies, and set search
            redirects. Upgrade to Pro to unlock these controls.
          </s-paragraph>
          <s-button slot="primary-action" href="/app/plans" variant="primary">
            See Pro plan
          </s-button>
        </s-banner>
      </s-page>
    );
  }

  const fieldOptions = [
    ...CONDITION_FIELDS,
    ...optionNames.map((n) => ({ value: `option:${n}`, label: `Option: ${n}` })),
  ];
  const experimentRunning = rules.some((r) => r.active && r.variant !== "all");

  return (
    <s-page heading="Merchandising">
      {error && <s-banner tone="critical">{error}</s-banner>}
      {imported ? (
        <s-banner tone="success" heading={`Imported ${imported} redirects`} dismissible />
      ) : null}

      {experimentRunning && (
        <s-banner tone="info" heading="An A/B test is running">
          <s-paragraph>
            Shoppers are split evenly and stay in the same group for the life of their
            session. Compare the two in{" "}
            <s-link href="/app/analytics">Analytics</s-link>.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Rules">
        <s-paragraph>
          <s-text color="subdued">
            Rules run on the highest priority first. A rule fires when its trigger matches
            the shopper&rsquo;s search or the collection they&rsquo;re browsing, it is inside
            its schedule, and the shopper is in its test group.
          </s-text>
        </s-paragraph>
        {rules.length ? (
          <s-stack direction="block" gap="small">
            {rules.map((r) => (
              <Row
                key={r.id}
                actions={
                  <>
                    <s-button
                      variant="secondary"
                      onClick={() => setEditing(editing === r.id ? null : r.id)}
                    >
                      {editing === r.id ? "Close" : "Edit"}
                    </s-button>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="toggleRule" />
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="active" value={String(!r.active)} />
                      <s-button type="submit" variant="secondary">
                        {r.active ? "Pause" : "Activate"}
                      </s-button>
                    </fetcher.Form>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="deleteRule" />
                      <input type="hidden" name="id" value={r.id} />
                      <s-button type="submit" variant="secondary" tone="critical">Delete</s-button>
                    </fetcher.Form>
                  </>
                }
              >
                <s-stack direction="inline" gap="small-500" alignItems="center">
                  <StatusBadge rule={r} />
                  <s-text type="strong">{r.name}</s-text>
                  {r.variant !== "all" && (
                    <s-badge tone="info">{`Test group ${r.variant.toUpperCase()}`}</s-badge>
                  )}
                </s-stack>
                <s-text color="subdued">
                  {r.triggerQuery ? `query “${r.triggerQuery}”` : ""}
                  {r.triggerQuery && r.triggerCollection ? " · " : ""}
                  {r.triggerCollection ? `collection ${r.triggerCollection}` : ""}
                  {!r.triggerQuery && !r.triggerCollection ? "always on" : ""}
                  {` · priority ${r.priority}`}
                  {scheduleSummary(r)}
                </s-text>
                <RuleSummary rule={r} />

                {editing === r.id && (
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="updateRule" />
                    <input type="hidden" name="id" value={r.id} />
                    <RuleFields rule={r} fieldOptions={fieldOptions} />
                    <s-button variant="primary" type="submit">Save changes</s-button>
                  </fetcher.Form>
                )}
              </Row>
            ))}
          </s-stack>
        ) : (
          <Empty heading="No rules yet">
            Rules change what ranks first for a search. Start from a term in
            Analytics that returned results nobody clicked.
          </Empty>
        )}
      </s-section>

      <s-section heading="Add a rule">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="createRule" />
          <RuleFields
            rule={null}
            fieldOptions={fieldOptions}
            defaultQuery={sp.get("query") ?? ""}
          />
          <s-button variant="primary" type="submit">Create rule</s-button>
        </fetcher.Form>
      </s-section>

      <s-section heading="Search redirects">
        <s-paragraph>
          <s-text color="subdued">
            Send a search straight to a page instead of showing results — “shipping” to your
            policy page, “sale” to the sale collection.
          </s-text>
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="createRedirect" />
          <s-grid gridTemplateColumns="1fr 1fr auto" gap="base" alignItems="end">
            <s-text-field name="query" label="When someone searches" defaultValue={sp.get("redirect") ?? ""} />
            <s-text-field name="url" label="Send them to (a path on your store)" placeholder="/collections/sale" />
            <s-button variant="primary" type="submit">Add redirect</s-button>
          </s-grid>
        </fetcher.Form>
        {redirects.length ? (
          <s-stack direction="block" gap="small">
            {redirects.map((r) => (
              <Row
                key={r.id}
                actions={
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="deleteRedirect" />
                    <input type="hidden" name="id" value={r.id} />
                    <s-button type="submit" variant="secondary" tone="critical">Delete</s-button>
                  </fetcher.Form>
                }
              >
                <s-text type="strong">{r.query}</s-text>
                <s-text color="subdued">goes to {r.url}</s-text>
              </Row>
            ))}
          </s-stack>
        ) : null}

        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(260px, 1fr))" gap="large-100">
          <Card title="Bulk import">
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="importRedirects" />
              <s-stack direction="block" gap="small-300">
                <s-text-area
                  name="csv"
                  label="Paste CSV"
                  rows={5}
                  placeholder={"query,url\nshipping,/policies/shipping-policy\nsale,/collections/sale"}
                  details="Targets must be a path on your store."
                />
                <s-button variant="secondary" type="submit">Import</s-button>
              </s-stack>
            </fetcher.Form>
          </Card>
          <Card title="Export">
            <s-text color="subdued">
              Take your redirects with you, or edit them in a spreadsheet and paste
              them back.
            </s-text>
            <s-link href="?export=redirects" download="redirects.csv">Download CSV</s-link>
          </Card>
        </s-grid>
      </s-section>

      <s-section slot="aside" heading="Check your work">
        <s-paragraph>
          <s-text color="subdued">
            <s-link href="/app/preview">Test search</s-link> runs the real engine and
            reports which rule fired and what it did to the score.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

/**
 * The rule form, shared by create and edit.
 *
 * One component rather than two, so an edit can never offer a field the create
 * form does not — which is how a rule ends up silently losing its schedule the
 * first time someone edits it.
 */
function RuleFields({
  rule,
  fieldOptions,
  defaultQuery = "",
}: {
  rule: LoadedRule | null;
  fieldOptions: { value: string; label: string }[];
  defaultQuery?: string;
}) {
  const existing = Array.isArray(rule?.conditions)
    ? (rule?.conditions as { field: string; op: string; value: string; action: string; weight: number }[])
    : [];
  const [conditionRows, setConditionRows] = useState<number[]>(
    existing.length ? existing.map((_, i) => i) : [0],
  );

  return (
    <s-stack direction="block" gap="base">
      <s-text-field
        name="name"
        label="Rule name"
        placeholder="Push new arrivals for “jacket”"
        defaultValue={rule?.name ?? ""}
      />
      <s-grid gridTemplateColumns="1.4fr 1.4fr 0.7fr" gap="base" alignItems="end">
        <s-text-field
          name="triggerQuery"
          label="When the search is (blank = any)"
          defaultValue={rule?.triggerQuery ?? defaultQuery}
        />
        <s-text-field
          name="triggerCollection"
          label="…or the collection is (handle)"
          defaultValue={rule?.triggerCollection ?? ""}
        />
        <s-number-field name="priority" label="Priority" defaultValue={String(rule?.priority ?? 0)} />
      </s-grid>

      {/* Scheduling. A sale rule that has to be switched on and off by hand at
          midnight is a rule that gets left on. */}
      <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base" alignItems="end">
        <s-date-field
          name="startsAt"
          label="Starts (optional)"
          details="From the start of this day"
          defaultValue={toDateInput(rule?.startsAt)}
        />
        <s-date-field
          name="endsAt"
          label="Ends (optional)"
          details="Through the end of this day"
          defaultValue={toDateInput(rule?.endsAt)}
        />
        <s-select name="variant" label="Test group" value={rule?.variant ?? "all"}>
          <s-option value="all">Everyone</s-option>
          <s-option value="a">Group A (half of shoppers)</s-option>
          <s-option value="b">Group B (the other half)</s-option>
        </s-select>
      </s-grid>

      <s-text type="strong">Specific products</s-text>
      <ProductPicker name="pinned" label="Pin to top (in order)" initial={rule?.pinnedProductIds ?? []} />
      <ProductPicker name="boosted" label="Boost" initial={rule?.boostedProductIds ?? []} />
      <ProductPicker name="buried" label="Bury" initial={rule?.buriedProductIds ?? []} />
      <ProductPicker name="hidden" label="Hide completely" initial={rule?.hiddenProductIds ?? []} />

      <s-text type="strong">…or by attribute</s-text>
      <s-paragraph>
        <s-text color="subdued">
          Attribute rules keep working as the catalog changes — “bury anything tagged
          clearance” never needs re-entering, unlike a list of product IDs.
        </s-text>
      </s-paragraph>
      {conditionRows.map((row, i) => {
        const c = existing[i];
        return (
          <s-grid
            key={row}
            gridTemplateColumns="1fr 1fr 1.5fr 1fr 0.8fr"
            gap="small"
            alignItems="end"
          >
            <s-select name="cond.field" label="Field" value={c?.field ?? "tag"}>
              {fieldOptions.map((f) => (
                <s-option key={f.value} value={f.value}>{f.label}</s-option>
              ))}
            </s-select>
            <s-select name="cond.op" label="Is" value={c?.op ?? "eq"}>
              <s-option value="eq">equal to</s-option>
              <s-option value="neq">not equal to</s-option>
              <s-option value="contains">containing</s-option>
            </s-select>
            <s-text-field
              name="cond.value"
              label="Value"
              placeholder="clearance"
              defaultValue={c?.value ?? ""}
            />
            <s-select name="cond.action" label="Then" value={c?.action ?? "boost"}>
              <s-option value="boost">boost</s-option>
              <s-option value="bury">bury</s-option>
              <s-option value="pin">pin to top</s-option>
              <s-option value="hide">hide</s-option>
            </s-select>
            <s-number-field
              name="cond.weight"
              label="Strength"
              min={1}
              max={20}
              defaultValue={String(c?.weight ?? 5)}
            />
          </s-grid>
        );
      })}
      <s-button
        type="button"
        variant="secondary"
        onClick={() => setConditionRows((r) => [...r, (r[r.length - 1] ?? 0) + 1])}
      >
        Add another condition
      </s-button>
    </s-stack>
  );
}

/** Active / Paused / Scheduled / Ended, resolved by the loader. */
function StatusBadge({ rule }: { rule: LoadedRule }) {
  if (rule.status === "paused") return <s-badge>Paused</s-badge>;
  if (rule.status === "scheduled") return <s-badge tone="info">Scheduled</s-badge>;
  if (rule.status === "ended") return <s-badge tone="warning">Ended</s-badge>;
  return <s-badge tone="success">Active</s-badge>;
}

function scheduleSummary(rule: LoadedRule): string {
  if (!rule.startsAt && !rule.endsAt) return "";
  // Dates, not timestamps: the end is stored as the last instant of its day, and
  // rendering "23:59:59" would read as a bug rather than as "through that day".
  const fmt = (iso: string) => new Date(iso).toLocaleDateString();
  if (rule.startsAt && rule.endsAt) return ` · ${fmt(rule.startsAt)} → ${fmt(rule.endsAt)}`;
  if (rule.startsAt) return ` · from ${fmt(rule.startsAt)}`;
  return ` · until ${fmt(rule.endsAt as string)}`;
}

/** ISO string -> the `YYYY-MM-DD` a date field expects. */
function toDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function RuleSummary({ rule }: { rule: LoadedRule }) {
  const counts = [
    rule.pinnedProductIds.length && `${rule.pinnedProductIds.length} pinned`,
    rule.boostedProductIds.length && `${rule.boostedProductIds.length} boosted`,
    rule.buriedProductIds.length && `${rule.buriedProductIds.length} buried`,
    rule.hiddenProductIds.length && `${rule.hiddenProductIds.length} hidden`,
    Array.isArray(rule.conditions) && rule.conditions.length
      ? `${rule.conditions.length} attribute condition${rule.conditions.length === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);
  return (
    <s-text color="subdued">{counts.length ? counts.join(" · ") : "No actions set"}</s-text>
  );
}

/**
 * Product selection via Shopify's own resource picker.
 *
 * Merchants previously had to paste comma-separated numeric product IDs, which
 * means leaving the app, finding each product, and copying digits out of a URL.
 * The hidden input keeps the same submitted shape, so the action is unchanged.
 *
 * `initial` is what an existing rule already holds. Only the ids are stored, so
 * until the picker is opened the count is shown rather than a list of titles the
 * page would have to fetch — and crucially the ids are PRESERVED, so editing a
 * rule to change its schedule cannot silently empty its product lists.
 */
function ProductPicker({
  name,
  label,
  initial = [],
}: {
  name: string;
  label: string;
  initial?: string[];
}) {
  const [selected, setSelected] = useState<{ id: string; title: string }[]>(
    initial.map((id) => ({ id, title: `#${id}` })),
  );

  async function pick() {
    const bridge = (globalThis as { shopify?: { resourcePicker?: (o: unknown) => Promise<unknown> } })
      .shopify;
    if (!bridge?.resourcePicker) return;
    const picked = (await bridge.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: selected.map((s) => ({ id: `gid://shopify/Product/${s.id}` })),
    })) as { id: string; title: string }[] | undefined;
    if (!picked) return;
    setSelected(
      picked.map((p) => ({
        // The engine stores the numeric part of the GID.
        id: String(p.id).split("/").pop() as string,
        title: p.title,
      })),
    );
  }

  return (
    <s-stack direction="block" gap="small">
      <input type="hidden" name={name} value={selected.map((s) => s.id).join(",")} />
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-button type="button" variant="secondary" onClick={pick}>{label}</s-button>
        <s-text color="subdued">
          {selected.length
            ? selected.map((s) => s.title).join(", ")
            : "none selected"}
        </s-text>
        {selected.length > 0 && (
          <s-button type="button" variant="secondary" onClick={() => setSelected([])}>
            Clear
          </s-button>
        )}
      </s-stack>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
