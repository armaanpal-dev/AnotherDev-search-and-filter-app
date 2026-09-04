import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import styles from "./styles.module.css";

// Public marketing page for anyone who reaches the app URL directly.
//
// Deliberately has no "enter your shop domain" form: App Store apps must be
// installed and opened from a Shopify-owned surface (the listing, or the app
// card in the admin), and asking a merchant to type their .myshopify.com domain
// is not permitted. A request that already carries `?shop=` came from Shopify,
// so it goes straight into the embedded app and OAuth runs there.
// Any of these means the request came from inside the Shopify admin.
//
// Keying only off the shop param was too narrow: clicking the app name in the
// admin sidebar loads the app root with host and embedded, but not always
// shop, so the public marketing page rendered inside the admin frame instead
// of the dashboard.
const EMBEDDED_MARKERS = ["shop", "host", "embedded", "id_token", "session"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (EMBEDDED_MARKERS.some((k) => url.searchParams.get(k))) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

const LISTING_URL = "https://apps.shopify.com/anotherdev-search";

export default function Index() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>AnotherDev Search &amp; Filters</h1>
        <p className={styles.text}>
          Fast, typo-tolerant search and faceted filters for your Shopify store —
          so shoppers find the right product in fewer clicks.
        </p>
        <a className={styles.cta} href={LISTING_URL}>
          Install from the Shopify App Store
        </a>
        <ul className={styles.list}>
          <li>
            <strong>Instant search</strong>. Results appear as customers type,
            across titles, SKUs, variants, tags and vendors, with typo tolerance
            and synonyms you control.
          </li>
          <li>
            <strong>Faceted filters</strong>. Price, brand, product type, colour,
            size and tags on search and collection pages, as a sidebar on desktop
            and a drawer on mobile.
          </li>
          <li>
            <strong>Search analytics</strong>. Top searches, zero-result searches
            and click-through rates, so you can see what shoppers want and where
            search is failing them.
          </li>
        </ul>
        <p className={styles.footnote}>
          Installs as a theme app extension — no theme code changes. Read-only
          access to your catalog; the app never writes to your store.
        </p>
      </div>
    </div>
  );
}
