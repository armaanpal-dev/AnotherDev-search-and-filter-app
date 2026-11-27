import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { Hub, type HubItem } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

const ITEMS: HubItem[] = [
  { href: "/app/settings/general", title: "General settings", blurb: "What the app does on your storefront, search, filters and product cards.", icon: "settings" },
  { href: "/app/theme-setup", title: "Theme setup", blurb: "Turn on the app embed and add the search, results and recommendation blocks.", icon: "theme" },
  { href: "/app/sync", title: "Index", blurb: "Pull your catalog into search and watch the sync.", icon: "refresh" },
  { href: "/app/catalog-health", title: "Catalog check", blurb: "Compare the index with Shopify to find missing or out-of-date products.", icon: "check-circle" },
  { href: "/app/settings/general?tab=advanced", title: "Integrations and custom code", blurb: "Wishlist Growth, custom CSS and JavaScript, revenue tracking.", icon: "code" },
  { href: "/app/plans", title: "Plans", blurb: "Your plan and what each one includes.", icon: "credit-card" },
];

export default function SettingsHub() {
  return <Hub heading="Settings" intro="Set up the app on your theme and configure how it behaves." items={ITEMS} />;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
