import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { Hub, type HubItem } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

const ITEMS: HubItem[] = [
  { href: "/app/merchandising?view=pinning&scope=search", title: "Product pinning", blurb: "Pin chosen products to the top of the results for a search term, in your order.", icon: "pin", badge: "Growth" },
  { href: "/app/merchandising?view=rules&scope=search", title: "Merchandising rules", blurb: "Boost, bury or hide products by tag, brand, type or stock for a search term. Schedule and A/B test.", icon: "arrow-up", badge: "Growth" },
  { href: "/app/search-tools?view=blacklist", title: "Blacklist suggestions", blurb: "Stop words such as competitor names from being offered as search suggestions.", icon: "disabled", badge: undefined },
  { href: "/app/synonyms", title: "Synonyms", blurb: "Teach search that words mean the same thing, with suggestions from failed searches.", icon: "arrows-out-horizontal" },
  { href: "/app/search-tools?view=banners", title: "Banners", blurb: "Show a promotional banner above or inside the results for a search term.", icon: "image" },
  { href: "/app/merchandising?view=redirects", title: "Page redirects", blurb: "Send a search straight to a page, e.g. “shipping” to your shipping policy.", icon: "link", badge: "Growth" },
  { href: "/app/search-tools?view=empty", title: "Empty search", blurb: "Products shown when a shopper opens the search box before typing.", icon: "product" },
  { href: "/app/preview", title: "Test search", blurb: "See exactly what shoppers get for a term, and why it ranks that way.", icon: "search" },
  { href: "/app/settings/general?tab=search", title: "Search settings", blurb: "Instant search behaviour, typo tolerance, panel layout, colours and fonts.", icon: "settings" },
];

export default function SearchHub() {
  return <Hub heading="Search" intro="Tune what shoppers find when they search, and what they see on the way." items={ITEMS} />;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
