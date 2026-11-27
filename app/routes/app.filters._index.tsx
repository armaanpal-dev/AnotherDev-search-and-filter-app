import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { Hub, type HubItem } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

const ITEMS: HubItem[] = [
  { href: "/app/filters/manage", title: "Manage filters", blurb: "Pick the filters shoppers see, their order, labels and display style, plus one-click presets.", icon: "filter" },
  { href: "/app/filter-tools", title: "Filter groups and values", blurb: "Different filters per collection, merge values that mean the same thing, and set size order.", icon: "collection-list" },
  { href: "/app/settings/general?tab=filters", title: "Filter appearance", blurb: "Layout, widths, price filter style, behaviour and colour swatches.", icon: "paint-brush-flat" },
];

export default function FiltersHub() {
  return <Hub heading="Filters" intro="Choose what shoppers can filter by, and how those filters look and behave." items={ITEMS} />;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
