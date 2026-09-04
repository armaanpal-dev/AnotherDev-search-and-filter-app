import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { invalidateShopConfig } from "../lib/search/config.server";
import { Stat, Card, Row, Empty, TILES, CARDS } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const synonyms = await prisma.synonym.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
  });
  return { synonyms };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "create") {
    const type = String(form.get("type") || "multiway");
    const terms = String(form.get("terms") || "")
      .split(",").map((t) => t.trim()).filter(Boolean);
    const input = type === "oneway" ? String(form.get("input") || "").trim() : null;
    if (terms.length >= (type === "oneway" ? 1 : 2) && (type !== "oneway" || input)) {
      await prisma.synonym.create({ data: { shopId: shop.id, type, input, terms } });
    }
  } else if (intent === "delete") {
    await prisma.synonym.deleteMany({
      where: { id: String(form.get("id")), shopId: shop.id },
    });
  }
  invalidateShopConfig(shop.id);
  return { ok: true };
};

export default function SynonymsPage() {
  const { synonyms } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const [sp] = useSearchParams();
  const prefill = sp.get("prefill") ?? "";
  const multi = synonyms.filter((s) => s.type !== "oneway").length;

  return (
    <s-page heading="Synonyms">
      <s-section heading="Overview">
        <s-grid gridTemplateColumns={TILES} gap="large-100">
          <Stat label="Groups" value={String(synonyms.length)} />
          <Stat label="Interchangeable" value={String(multi)} />
          <Stat label="One-way" value={String(synonyms.length - multi)} />
        </s-grid>
      </s-section>

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
                  {s.type === "oneway" && <s-text type="strong">{s.input}</s-text>}
                </s-stack>
                <s-text color="subdued">{s.terms.join(", ")}</s-text>
              </Row>
            ))}
          </s-stack>
        ) : (
          <Empty heading="No synonyms yet">
            Start with the terms that returned nothing. Analytics lists them.
          </Empty>
        )}
      </s-section>

      <s-section slot="aside" heading="Where to start">
        <s-paragraph>
          <s-text color="subdued">
            Your <s-link href="/app/analytics">zero-result searches</s-link> are
            the best source of synonyms. Each one is a word a shopper used that
            your catalog does not.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
