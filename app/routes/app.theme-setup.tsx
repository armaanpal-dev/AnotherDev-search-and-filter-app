import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { Row, Empty } from "../components/ui";
import { embedEnabled } from "../lib/theme";

const THEMES_QUERY = `#graphql
  query ThemeEmbeds {
    themes(first: 20, roles: [MAIN, UNPUBLISHED, DEVELOPMENT]) {
      nodes {
        id
        name
        role
        updatedAt
        files(filenames: ["config/settings_data.json"], first: 1) {
          nodes {
            body {
              ... on OnlineStoreThemeFileBodyText {
                content
              }
            }
          }
        }
      }
    }
  }`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  let themes: { id: string; name: string; role: string; updatedAt: string; embed: boolean | null }[] = [];
  let error: string | null = null;
  try {
    const res = await admin.graphql(THEMES_QUERY);
    const json: any = await res.json();
    if (json.errors?.length) throw new Error("themes");
    themes = (json.data?.themes?.nodes ?? []).map((t: any) => ({
      id: String(t.id).split("/").pop(),
      name: t.name,
      role: t.role,
      updatedAt: t.updatedAt,
      embed: embedEnabled(t.files?.nodes?.[0]?.body?.content ?? ""),
    }));
  } catch {
    error = "Shopify did not return your themes. Reload the app to grant theme access, then try again.";
  }
  return { themes, error, shop: session.shop, apiKey: process.env.SHOPIFY_API_KEY ?? "" };
};

export default function ThemeSetupPage() {
  const { themes, error, shop, apiKey } = useLoaderData<typeof loader>();
  const editor = (themeId: string, query: string) =>
    `https://${shop}/admin/themes/${themeId}/editor?${query}`;

  return (
    <s-page heading="Theme setup">
      <s-link slot="breadcrumb-actions" href="/app/settings">Settings</s-link>
      {error && <s-banner tone="warning">{error}</s-banner>}
      <s-section heading="Your themes">
        <s-paragraph>
          <s-text color="subdued">
            The app embed loads instant search and filters on every page. Turn it on
            in each theme you want to use, then optionally add the blocks.
          </s-text>
        </s-paragraph>
        {themes.length ? (
          <s-stack direction="block" gap="small-300">
            {themes.map((t) => (
              <Row
                key={t.id}
                actions={
                  <s-stack direction="inline" gap="small-300">
                    <s-button
                      variant={t.embed ? "secondary" : "primary"}
                      href={editor(t.id, `context=apps&activateAppId=${apiKey}/app-embed`)}
                      target="_blank"
                    >
                      {t.embed ? "Manage embed" : "Turn on app embed"}
                    </s-button>
                  </s-stack>
                }
              >
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-text type="strong">{t.name}</s-text>
                  {t.role === "MAIN" && <s-badge tone="info">Live</s-badge>}
                  {t.embed === true && <s-badge tone="success">Embed on</s-badge>}
                  {t.embed === false && <s-badge tone="warning">Embed off</s-badge>}
                  {t.embed === null && <s-badge>Status unknown</s-badge>}
                </s-stack>
                <s-stack direction="inline" gap="small-300">
                  <s-link
                    href={editor(t.id, `template=search&addAppBlockId=${apiKey}/search-results&target=newAppsSection`)}
                    target="_blank"
                  >
                    Add search results block
                  </s-link>
                  <s-link
                    href={editor(t.id, `template=product&addAppBlockId=${apiKey}/recommendations&target=newAppsSection`)}
                    target="_blank"
                  >
                    Add recommendations to product page
                  </s-link>
                  <s-link
                    href={editor(t.id, `template=index&addAppBlockId=${apiKey}/search-bar&target=newAppsSection`)}
                    target="_blank"
                  >
                    Add search bar to home page
                  </s-link>
                </s-stack>
              </Row>
            ))}
          </s-stack>
        ) : (
          !error && <Empty heading="No themes found" />
        )}
      </s-section>
      <s-section slot="aside" heading="After setup">
        <s-paragraph>
          <s-text color="subdued">
            Open your store and type in the search box. If nothing changes, check the
            embed is on for the <s-text type="strong">Live</s-text> theme, then use{" "}
            <s-link href="/app/preview">Test search</s-link>.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
