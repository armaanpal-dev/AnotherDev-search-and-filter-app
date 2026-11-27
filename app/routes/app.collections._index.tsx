import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { Hub, type HubItem } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

const ITEMS: HubItem[] = [
  { href: "/app/merchandising", title: "Merchandising and pinning", blurb: "Pin products to the top of a collection, boost or bury by tag, brand or stock, and schedule it.", icon: "pin", badge: "Growth" },
  { href: "/app/filter-tools", title: "Collection filter groups", blurb: "Give specific collections their own filters, e.g. Size and Width on Shoes.", icon: "collection-list" },
  { href: "/app/settings/general?tab=cards", title: "Product cards and quick view", blurb: "Grid size, card look, quick view and market pricing.", icon: "product" },
];

export default function CollectionsHub() {
  return <Hub heading="Collections" intro="Control the order and filters of products on your collection pages." items={ITEMS} />;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
