import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain, ensureShop } from "../lib/shop.server";
import { invalidateShopConfig } from "../lib/search/config.server";

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

  return (
    <s-page heading="Synonyms">
      <s-section heading="Add a synonym group">
        <s-paragraph>
          <s-text color="subdued">
            Multi-way: all terms are interchangeable (e.g. “sneaker, trainer, running shoe”).
            One-way: an input maps to extra terms but not the reverse.
          </s-text>
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="create" />
          <s-stack direction="block" gap="base">
            <s-select name="type" label="Type" value="multiway">
              <s-option value="multiway">Multi-way (interchangeable)</s-option>
              <s-option value="oneway">One-way (input → terms)</s-option>
            </s-select>
            <s-text-field name="input" label="Input term (one-way only)" defaultValue={prefill} />
            <s-text-field
              name="terms"
              label="Terms (comma-separated)"
              defaultValue={prefill}
            />
            <s-button variant="primary" type="submit" {...(fetcher.state !== "idle" ? { loading: true } : {})}>
              Add synonym
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading={`Synonym groups (${synonyms.length})`}>
        {synonyms.length ? (
          <s-stack direction="block" gap="small">
            {synonyms.map((s) => (
              <s-box key={s.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-badge>{s.type}</s-badge>
                  <s-text>
                    {s.type === "oneway" ? `${s.input} → ` : ""}
                    {s.terms.join(", ")}
                  </s-text>
                  <fetcher.Form method="post" style={{ marginInlineStart: "auto" }}>
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="id" value={s.id} />
                    <s-button type="submit" variant="tertiary" tone="critical">Delete</s-button>
                  </fetcher.Form>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        ) : (
          <s-paragraph><s-text color="subdued">No synonyms yet.</s-text></s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
