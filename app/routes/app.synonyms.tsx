import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { invalidateShopConfig } from "../lib/search/config.server";
import { getPlanStatus } from "../lib/billing.server";
import { suggestSynonyms, csvCell } from "../lib/analytics.server";
import { Stat, Card, Row, Empty, TILES, CARDS } from "../components/ui";

/** A shop cannot have unlimited rules: every one is another OR group in the
 *  tsquery, and config.server only loads the first 2000 anyway. */
const MAX_SYNONYMS = 2000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const { limits } = await getPlanStatus(billing, shop.planOverride);

  const url = new URL(request.url);

  const synonyms = await prisma.synonym.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
  });

  // CSV export. Merchants migrating from another search app arrive with
  // hundreds of these, and leave with them too; a list you cannot get out of the
  // app is a reason not to try it.
  if (url.searchParams.get("export") === "csv") {
    const rows = [["type", "input", "terms"]].concat(
      synonyms.map((s) => [s.type, s.input ?? "", s.terms.join("|")]),
    );
    return new Response(rows.map((r) => r.map(csvCell).join(",")).join("\r\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="synonyms.csv"`,
      },
    });
  }

  // Candidates derived from searches that found nothing. This turns the
  // zero-result list from a list of problems into a list of one-click fixes —
  // the app already knows both the failing word and the closest word the catalog
  // actually uses.
  const suggestions = await suggestSynonyms(shop.id, limits.analyticsDays).catch(
    () => [] as { term: string; count: number; suggestion: string }[],
  );

  return { synonyms, suggestions };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const form = await request.formData();
  const intent = form.get("intent");

  const parseTerms = (raw: string) =>
    [
      ...new Set(
        raw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => t.slice(0, 80)),
      ),
    ].slice(0, 50);

  if (intent === "create" || intent === "update") {
    const type = String(form.get("type") || "multiway") === "oneway" ? "oneway" : "multiway";
    const terms = parseTerms(String(form.get("terms") || ""));
    const input = type === "oneway" ? String(form.get("input") || "").trim().slice(0, 80) : null;

    if (type === "oneway" && !input) return { error: "A one-way rule needs an input term." };
    if (terms.length < (type === "oneway" ? 1 : 2)) {
      return {
        error:
          type === "oneway"
            ? "A one-way rule needs at least one term to expand to."
            : "An interchangeable group needs at least two terms.",
      };
    }

    if (intent === "update") {
      await prisma.synonym.updateMany({
        where: { id: String(form.get("id")), shopId: shop.id },
        data: { type, input, terms },
      });
    } else {
      const count = await prisma.synonym.count({ where: { shopId: shop.id } });
      if (count >= MAX_SYNONYMS) {
        return { error: `This store already has the maximum of ${MAX_SYNONYMS} groups.` };
      }
      await prisma.synonym.create({ data: { shopId: shop.id, type, input, terms } });
    }
  } else if (intent === "delete") {
    await prisma.synonym.deleteMany({
      where: { id: String(form.get("id")), shopId: shop.id },
    });
  } else if (intent === "accept") {
    // One click on a suggestion: the failing word becomes interchangeable with
    // the word the catalog actually uses.
    const term = String(form.get("term") || "").trim().slice(0, 80);
    const suggestion = String(form.get("suggestion") || "").trim().slice(0, 80);
    if (term && suggestion && term !== suggestion) {
      await prisma.synonym.create({
        data: { shopId: shop.id, type: "multiway", input: null, terms: [term, suggestion] },
      });
    }
  } else if (intent === "import") {
    // CSV import: `type,input,terms` with terms pipe-separated, which is the
    // shape the export produces — so a round trip is lossless.
    const text = String(form.get("csv") || "");
    if (!text.trim()) return { error: "Paste some CSV first." };

    const existing = await prisma.synonym.count({ where: { shopId: shop.id } });
    let room = MAX_SYNONYMS - existing;
    const rows: { type: string; input: string | null; terms: string[] }[] = [];
    let skipped = 0;

    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || room <= 0) continue;
      const cells = parseCsvLine(line);
      // Tolerate the exported header rather than importing it as a rule.
      if (cells[0]?.toLowerCase() === "type") continue;
      const type = cells[0]?.trim().toLowerCase() === "oneway" ? "oneway" : "multiway";
      const input = type === "oneway" ? (cells[1] ?? "").trim().slice(0, 80) : null;
      // Accept either the pipe-separated export shape or plain extra columns,
      // because a merchant's own spreadsheet will not match ours.
      const termSource = (cells[2] ?? "").includes("|")
        ? (cells[2] ?? "").split("|")
        : cells.slice(2);
      const terms = [
        ...new Set(termSource.map((t) => t.trim()).filter(Boolean).map((t) => t.slice(0, 80))),
      ].slice(0, 50);

      if (type === "oneway" ? !input || !terms.length : terms.length < 2) {
        skipped++;
        continue;
      }
      rows.push({ type, input, terms });
      room--;
    }

    if (!rows.length) {
      return { error: `Nothing importable found${skipped ? ` (${skipped} rows skipped)` : ""}.` };
    }
    await prisma.synonym.createMany({
      data: rows.map((r) => ({ shopId: shop.id, ...r })),
    });
    invalidateShopConfig(shop.id);
    return { ok: true, imported: rows.length, skipped };
  }

  invalidateShopConfig(shop.id);
  return { ok: true };
};

/** Minimal RFC-4180 line parser: quoted cells, doubled quotes inside them. */
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
  // The export prefixes a leading =+-@ to defuse spreadsheet formulas; strip it
  // back off so a round trip returns the original term.
  return out.map((c) => c.replace(/^'(?=[=+\-@])/, ""));
}

export default function SynonymsPage() {
  const { synonyms, suggestions } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [sp] = useSearchParams();
  const prefill = sp.get("prefill") ?? "";
  const multi = synonyms.filter((s) => s.type !== "oneway").length;
  const data = fetcher.data;
  const error = data && "error" in data ? data.error : null;
  const imported = data && "imported" in data ? data.imported : null;

  return (
    <s-page heading="Synonyms">
      <s-button slot="primary-action" href="?export=csv" variant="secondary" download="synonyms.csv">
        Export CSV
      </s-button>

      {error && <s-banner tone="critical">{error}</s-banner>}
      {imported ? (
        <s-banner tone="success" heading={`Imported ${imported} groups`} dismissible>
          <s-paragraph>
            {data && "skipped" in data && data.skipped
              ? `${data.skipped} rows were skipped because they had too few terms.`
              : "Your storefront picks them up within about 30 seconds."}
          </s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Overview">
        <s-grid gridTemplateColumns={TILES} gap="large-100">
          <Stat label="Groups" value={String(synonyms.length)} />
          <Stat label="Interchangeable" value={String(multi)} />
          <Stat label="One-way" value={String(synonyms.length - multi)} />
          <Stat
            label="Suggested"
            value={String(suggestions.length)}
            {...(suggestions.length ? { hint: "From failed searches", tone: "info" as const } : {})}
          />
        </s-grid>
      </s-section>

      {suggestions.length > 0 && (
        <s-section heading="Suggested from failed searches">
          <s-paragraph>
            <s-text color="subdued">
              Shoppers searched for these and got nothing — but your catalog has a
              close word. One click makes them interchangeable.
            </s-text>
          </s-paragraph>
          <s-stack direction="block" gap="small-300">
            {suggestions.map((s) => (
              <Row
                key={s.term}
                actions={
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="accept" />
                    <input type="hidden" name="term" value={s.term} />
                    <input type="hidden" name="suggestion" value={s.suggestion} />
                    <s-button type="submit" variant="primary">Add group</s-button>
                  </fetcher.Form>
                }
              >
                <s-stack direction="inline" gap="small-500" alignItems="center">
                  <s-text type="strong">{s.term}</s-text>
                  <s-text color="subdued">→</s-text>
                  <s-text type="strong">{s.suggestion}</s-text>
                </s-stack>
                <s-text color="subdued">
                  {s.count} {s.count === 1 ? "search" : "searches"} found nothing
                </s-text>
              </Row>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section heading="Add a group">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="create" />
          <s-stack direction="block" gap="base">
            <s-grid gridTemplateColumns="1fr 1fr 2fr" gap="base" alignItems="end">
              <s-select name="type" label="Type" value="multiway">
                <s-option value="multiway">Interchangeable</s-option>
                <s-option value="oneway">One-way</s-option>
              </s-select>
              <s-text-field
                name="input"
                label="Input term"
                details="One-way only"
                defaultValue={prefill}
              />
              <s-text-field
                name="terms"
                label="Terms"
                details="Comma separated"
                defaultValue={prefill}
              />
            </s-grid>
            <s-button
              variant="primary"
              type="submit"
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              Add group
            </s-button>
          </s-stack>
        </fetcher.Form>

        <s-grid gridTemplateColumns={CARDS} gap="large-100">
          <Card title="Interchangeable">
            <s-text color="subdued">
              Every term finds the others. Searching sneaker also returns trainer
              and running shoe.
            </s-text>
          </Card>
          <Card title="One-way">
            <s-text color="subdued">
              The input finds the terms, but not the reverse. Useful when a broad
              word should reach a narrow one without dragging it back.
            </s-text>
          </Card>
        </s-grid>
      </s-section>

      <s-section heading="Groups">
        {synonyms.length ? (
          <s-stack direction="block" gap="small-300">
            {synonyms.map((s) => (
              <Row
                key={s.id}
                actions={
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="id" value={s.id} />
                    <s-button type="submit" variant="secondary" tone="critical">
                      Delete
                    </s-button>
                  </fetcher.Form>
                }
              >
                <s-stack direction="inline" gap="small-500" alignItems="center">
                  <s-badge tone={s.type === "oneway" ? "info" : "success"}>
                    {s.type === "oneway" ? "One-way" : "Interchangeable"}
                  </s-badge>
                </s-stack>

                {/* Edit in place. A group with one wrong word previously had to
                    be deleted and retyped in full. */}
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="update" />
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="type" value={s.type} />
                  <s-grid
                    gridTemplateColumns={s.type === "oneway" ? "1fr 2fr auto" : "3fr auto"}
                    gap="small-300"
                    alignItems="end"
                  >
                    {s.type === "oneway" && (
                      <s-text-field name="input" label="Input" defaultValue={s.input ?? ""} />
                    )}
                    <s-text-field
                      name="terms"
                      label="Terms"
                      details="Comma separated"
                      defaultValue={s.terms.join(", ")}
                    />
                    <s-button type="submit" variant="secondary">Save</s-button>
                  </s-grid>
                </fetcher.Form>
              </Row>
            ))}
          </s-stack>
        ) : (
          <Empty heading="No synonyms yet">
            Start with the terms that returned nothing. Analytics lists them.
          </Empty>
        )}
      </s-section>

      <s-section heading="Import from a spreadsheet">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="import" />
          <s-stack direction="block" gap="base">
            <s-text-area
              name="csv"
              label="Paste CSV"
              rows={6}
              placeholder={
                "type,input,terms\nmultiway,,sneaker|trainer|running shoe\noneway,jumper,sweater|pullover"
              }
              details="One group per line. Same shape as the export, so a round trip is lossless."
            />
            <s-button variant="secondary" type="submit">Import</s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section slot="aside" heading="Where to start">
        <s-paragraph>
          <s-text color="subdued">
            Your <s-link href="/app/analytics">zero-result searches</s-link> are
            the best source of synonyms. Each one is a word a shopper used that
            your catalog does not — and the suggestions above are generated from
            exactly that list.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text color="subdued">
            Check a change landed with{" "}
            <s-link href="/app/preview">Test search</s-link>.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
