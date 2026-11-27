import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { Hub, type HubItem } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

const ITEMS: HubItem[] = [
  { href: "/app/search-tools", title: "Banners and suggestions", blurb: "Promotional banners per search term, blocked suggestions and products for an empty search box.", icon: "image" },
  { href: "/app/synonyms", title: "Synonyms", blurb: "Teach search that words mean the same thing, with suggestions from failed searches.", icon: "arrows-out-horizontal" },
  { href: "/app/merchandising", title: "Redirects and pinning", blurb: "Send a term straight to a page, or pin, boost, bury and hide products for it.", icon: "pin", badge: "Growth" },
  { href: "/app/preview", title: "Test search", blurb: "See exactly what shoppers get for a term, and why it ranks that way.", icon: "search" },
  { href: "/app/settings/general?tab=search", title: "Search settings", blurb: "Instant search behaviour, typo tolerance, panel layout, colours and fonts.", icon: "settings" },
];

export default function SearchHub() {
  return <Hub heading="Search" intro="Tune what shoppers find when they search, and what they see on the way." items={ITEMS} />;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
