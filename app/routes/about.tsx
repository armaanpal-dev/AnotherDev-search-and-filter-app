// Public marketing page for anyone who opens the app URL directly.
//
// Moved off "/" because the app root has to redirect into the embedded
// dashboard: an App Bridge client-side navigation to "/" carries no query
// params, so there is no reliable way to tell it apart from an outside visit.
//
// Deliberately has no "enter your shop domain" form: App Store apps must be
// installed from a Shopify-owned surface, and asking a merchant to type their
// .myshopify.com domain is not permitted.
import styles from "./_index/styles.module.css";

const LISTING_URL = "https://apps.shopify.com/anotherdev-search";

export default function About() {
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
