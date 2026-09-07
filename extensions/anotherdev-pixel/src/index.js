/* AnotherDev Search — purchase attribution.

   Runs in Shopify's strict web-pixel sandbox, which means: no window, no DOM,
   no access to the storefront's localStorage, and an allowlist of APIs. Two of
   them are all this needs — `browser.cookie` (first-party, on the shop's own
   domain) and `fetch`.

   How a purchase finds its search:

     1. The storefront widget writes the shopper's anonymous session token to the
        `adsf_st` cookie. It also keeps it in localStorage, but localStorage is
        per-origin and this sandbox is a different origin, so the cookie is the
        only thing both halves can see.
     2. On checkout_completed this reads that cookie and posts the order back
        through the app proxy — the same first-party endpoint the widget uses, so
        no third-party request leaves the shopper's browser and no CORS or
        consent-blocking edge case applies.
     3. The server matches the token to that shopper's most recent search inside
        a 24h window. No match means the order owes nothing to search, and
        nothing is recorded.

   The token is a random string generated in the browser. It is never linked to a
   customer id, an email or an order beyond this attribution, and the server
   clears it 24 hours later. No customer PII is read or sent from here.
*/

import { register } from "@shopify/web-pixels-extension";

register(({ analytics, browser, settings, init }) => {
  const base = normalizeBase(settings && settings.proxyBase);

  analytics.subscribe("checkout_completed", async (event) => {
    try {
      const token = await readSessionToken(browser);
      // No token means this shopper never used our search on this device.
      // Reporting the order anyway is how an app ends up taking credit for the
      // entire store's revenue.
      if (!token) return;

      const checkout = (event.data && event.data.checkout) || {};
      const total = checkout.totalPrice || {};

      await fetch(`${base}/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The sandbox may be torn down the moment checkout navigates away.
        keepalive: true,
        body: JSON.stringify({
          type: "purchase",
          st: token,
          // Deduplicates retries server-side, so one order can never be counted
          // twice however many times the pixel fires.
          orderId: String(checkout.order && checkout.order.id ? checkout.order.id : event.id || ""),
          revenue: Number(total.amount || 0),
          currency: String(total.currencyCode || ""),
          // Line items feed the popularity signal that ranks results. Product
          // ids only — no customer, address or payment data is read.
          productIds: lineItemProductIds(checkout),
        }),
      });
    } catch (e) {
      // Attribution must never interfere with a completed order. There is
      // nothing to recover here and nothing the shopper should ever see.
    }
  });

  // `init` carries the shop and context; touching it keeps the sandbox from
  // treating the subscription as the only reason this pixel loaded.
  void init;
});

/** `/apps/anotherdev-search`, with no trailing slash and never a full URL. */
function normalizeBase(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  // Same-origin paths only. An absolute URL here would send order data to
  // whatever host was configured, which is not a decision a settings field
  // should be able to make.
  if (!raw || raw[0] !== "/" || raw.slice(0, 2) === "//") {
    return "/apps/anotherdev-search";
  }
  return raw.replace(/\/+$/, "");
}

/** The anonymous session token, from the first-party cookie the widget sets. */
async function readSessionToken(browser) {
  try {
    const jar = await browser.cookie.get();
    if (!jar) return "";
    const match = /(?:^|;\s*)adsf_st=([^;]+)/.exec(jar);
    return match ? decodeURIComponent(match[1]).slice(0, 64) : "";
  } catch (e) {
    return "";
  }
}

/** Numeric product ids from the completed checkout's line items. */
function lineItemProductIds(checkout) {
  const items = (checkout && checkout.lineItems) || [];
  const ids = [];
  for (const item of items) {
    const id =
      item && item.variant && item.variant.product && item.variant.product.id;
    if (id == null) continue;
    // Shopify hands these over as either a bare numeric id or a GID.
    const numeric = String(id).split("/").pop();
    if (/^\d{1,20}$/.test(numeric) && ids.indexOf(numeric) < 0) ids.push(numeric);
    if (ids.length >= 50) break;
  }
  return ids;
}
