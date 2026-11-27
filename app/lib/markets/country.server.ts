// Country availability (ported from the source app, without Redis/workers).
//
// The index holds one availability flag per product, which is the primary
// market's answer. Shopify can make a product unsellable in a specific country
// (market product exclusions, publishing). This asks the Storefront API, once
// per country, which products are NOT for sale there, and stores only that
// (usually short) list. Search then drops those products for shoppers in that
// country — in SQL, so totals, facet counts and pagination stay correct.
import prisma from "../../db.server";
import { apiVersion } from "../../shopify.server";

const TOKEN_TITLE = "AnotherDev Search country availability";
const MAX_COUNTRIES = 60;
const MAX_PAGES = 200; // 50k products per country

type AdminLike = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

/** Create (or reuse) this app's Storefront token for the shop and store it. */
export async function connectCountryAvailability(shopId: string, admin: AdminLike): Promise<void> {
  const res = await admin.graphql(
    `#graphql
    mutation CreateStorefrontToken($input: StorefrontAccessTokenInput!) {
      storefrontAccessTokenCreate(input: $input) {
        storefrontAccessToken { accessToken title }
        userErrors { field message }
      }
    }`,
    { variables: { input: { title: TOKEN_TITLE } } },
  );
  const json: any = await res.json();
  const payload = json.data?.storefrontAccessTokenCreate;
  const token = payload?.storefrontAccessToken?.accessToken;
  if (!token) {
    throw new Error(payload?.userErrors?.[0]?.message ?? "Shopify did not create a storefront token.");
  }
  await prisma.shop.update({ where: { id: shopId }, data: { storefrontToken: token } });
}

async function storefront(domain: string, token: string, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(`https://${domain}/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Storefront API ${res.status}`);
  const json: any = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0]?.message ?? "Storefront API error");
  return json.data;
}

/** Rebuild the per-country "not for sale here" lists for one shop. */
export async function refreshCountryAvailability(shopId: string): Promise<{ countries: number }> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { domain: true, storefrontToken: true },
  });
  if (!shop?.storefrontToken) return { countries: 0 };
  const { domain, storefrontToken: token } = shop;

  const loc = await storefront(domain, token, `query Countries { localization { availableCountries { isoCode } } }`);
  const countries: string[] = (loc.localization?.availableCountries ?? [])
    .map((c: { isoCode: string }) => c.isoCode)
    .slice(0, MAX_COUNTRIES);

  for (const country of countries) {
    const unavailable: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await storefront(
        domain,
        token,
        `query CountryAvailability($country: CountryCode!, $after: String) @inContext(country: $country) {
          products(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id availableForSale }
          }
        }`,
        { country, after },
      );
      for (const p of data.products.nodes) {
        if (!p.availableForSale) unavailable.push(String(p.id).split("/").pop()!);
      }
      if (!data.products.pageInfo.hasNextPage) break;
      after = data.products.pageInfo.endCursor;
    }
    await prisma.countryAvailability.upsert({
      where: { shopId_country: { shopId, country } },
      create: { shopId, country, unavailable, checkedAt: new Date() },
      update: { unavailable, checkedAt: new Date() },
    });
  }
  // Countries the store no longer sells to keep no stale exclusions.
  await prisma.countryAvailability.deleteMany({ where: { shopId, country: { notIn: countries } } });
  return { countries: countries.length };
}
