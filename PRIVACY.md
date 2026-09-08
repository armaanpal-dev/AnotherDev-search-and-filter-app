# Privacy Policy — AnotherDev Search and Filters

**Effective date:** `[DATE]`
**Last updated:** `[DATE]`
**Data controller:** `[LEGAL ENTITY NAME]`, `[REGISTERED ADDRESS]`
**Contact:** `[PRIVACY CONTACT EMAIL]`

> **Before you publish this**, replace every `[BRACKETED]` placeholder and read the
> "Notes for the publisher" section at the end. This document describes what the
> app's code actually does, verified against the source. It is not legal advice,
> and it does not cover obligations that depend on your company rather than the
> software (your legal entity, your jurisdiction, your DPA terms, whether you
> appoint an EU/UK representative).

---

## 1. Who this policy is for

AnotherDev Search and Filters ("the app") is a Shopify app installed by a
merchant onto their Shopify store. This policy covers:

- **Merchants** — the store owner and staff who install and configure the app.
- **Shoppers** — visitors to a merchant's storefront who use the search box and
  filters the app provides.

The merchant is the **controller** of shopper data collected through their
storefront. `[LEGAL ENTITY NAME]` acts as a **processor** on the merchant's
behalf for that data, and as a controller for merchant account data.

---

## 2. What the app reads from Shopify

The app requests **read-only** access. It holds no write scopes and never
creates, edits, or deletes anything in a merchant's store.

| Scope | Why |
|---|---|
| `read_products` | Index product titles, descriptions, vendors, types, tags, options, variants, SKUs, prices, images and metafields so they are searchable and filterable |
| `read_product_listings` | Know which products are published to the Online Store |
| `read_collection_listings` | Index collections so filters and collection pages work |
| `read_inventory` | Show and filter by availability |
| `read_content` | Index pages so they can appear in search results |

The app does **not** request access to customers, orders, checkouts, draft
orders, price rules, discounts, fulfilment, or payment data.

---

## 3. What the app stores

### 3.1 Merchant and store data

- Store domain (`example.myshopify.com`), store name, currency
- Subscription plan and install/uninstall timestamps
- App configuration: settings, filter definitions, quick filters, synonyms,
  merchandising rules and search redirects
- A Shopify OAuth access token, used to call Shopify's API on the store's behalf
- For staff who open the app in the Shopify admin, Shopify may supply and the
  app may store the staff member's Shopify user ID, first and last name, email
  address, locale, and whether they are the account owner or a collaborator.
  This is used only to authenticate the session.

### 3.2 Catalog data

A mirror of the merchant's published catalog — products, variants, collections
and pages, with the fields listed in section 2. This is the search index. It
contains no personal data unless the merchant has put personal data into their
own product content.

### 3.3 Storefront search analytics

When a shopper uses the search or filters, the app records:

- The search term as typed, and a normalised form of it
- The number of results returned
- Which product (if any) was clicked, and whether it was added to cart
- An A/B test bucket, where the merchant is running one
- A timestamp
- An **anonymous session token** — a random string generated in the shopper's
  own browser (see section 4)

The app does **not** record IP addresses, user-agent strings, device
fingerprints, names, email addresses, or any Shopify customer identifier.

### 3.4 Purchase attribution (optional, merchant-enabled)

If the merchant switches on revenue tracking, a Shopify Web Pixel records, on
checkout completion only:

- The order ID, order total and currency
- The product IDs in the order
- The anonymous session token described above

This exists solely to link a completed order back to the search that led to it.
No customer name, email address, shipping address, or payment information is
read or transmitted. If the shopper has no session token — meaning they never
used the app's search on that device — nothing is sent at all.

---

## 4. Cookies and browser storage

The app sets the following on the merchant's own domain (first-party). It sets
no third-party cookies and runs no advertising or cross-site tracking.

| Name | Type | Contents | Lifetime |
|---|---|---|---|
| `adsf_st` | Cookie + `localStorage` | A random session token. Not derived from any personal identifier. | Until cleared by the shopper; the server discards the copy stored with an event after **24 hours** |
| `adsf_recent` | `localStorage` | The shopper's last 8 search terms, shown back to them as shortcuts | Until cleared by the shopper. Never sent to our servers |
| `adsf_viewed` | `localStorage` | Up to 20 recently viewed product IDs, used to order recommendations | Until cleared by the shopper. Never sent to our servers |

The token exists so that a click or a purchase can be joined to the search that
produced it. It is never linked to a Shopify customer ID, an email address, or
an account.

---

## 5. How long data is kept

| Data | Retention |
|---|---|
| Session tokens attached to analytics events | **24 hours**, then permanently nulled |
| Search analytics events | **180 days**, then permanently deleted |
| Catalog index, settings and configuration | For as long as the app is installed |
| All store data after uninstall | Deleted when Shopify sends the `shop/redact` webhook, **48 hours** after uninstall |

Retention windows are enforced automatically by the app, not by manual cleanup.

---

## 6. Who else processes this data

| Sub-processor | Purpose | Location |
|---|---|---|
| Shopify Inc. | The platform the app runs on; source of all catalog data | Global |
| `[HOSTING PROVIDER — e.g. Railway]` | Application hosting | `[REGION]` |
| `[DATABASE PROVIDER — e.g. Supabase]` | PostgreSQL database | `[REGION]` |
| `[EMBEDDINGS PROVIDER — Voyage AI or OpenAI]` | Semantic search only, if enabled | `[REGION]` |

**Semantic search:** on plans where it is available and switched on, product
titles and descriptions (up to 1,000 characters), and the text a shopper types
into the search box, are sent to the embeddings provider named above to be
converted into vectors. No session token, order data, or shopper identifier is
included in those requests. If the feature is off, no data leaves our
infrastructure for this purpose.

Data is not sold, rented, or shared with advertisers, data brokers, or any
party not listed above.

---

## 7. Legal basis (UK/EU GDPR)

- **Merchant account data** — performance of a contract (providing the app).
- **Catalog data** — performance of a contract; processed on the merchant's
  documented instructions.
- **Storefront search analytics** — the merchant's legitimate interest in
  understanding and improving how shoppers find products on their own store,
  using data that identifies no individual. Where the merchant's own consent
  banner or local law requires consent for storage on a shopper's device, the
  merchant is responsible for obtaining it.

---

## 8. Shopper rights and Shopify's mandatory data requests

The app implements Shopify's three compliance webhooks.

- **`customers/data_request`** — acknowledged. The app stores no value that can
  be matched to a Shopify customer ID or email address, so there is nothing to
  export.
- **`customers/redact`** — acknowledged, for the same reason: no stored row is
  keyed to a customer.
- **`shop/redact`** — all data for that store is permanently deleted: index,
  configuration, analytics and session records.

Shoppers wishing to remove the app's browser storage can clear site data for the
store's domain, which deletes `adsf_st`, `adsf_recent` and `adsf_viewed`.

Merchants may request access to, correction of, or deletion of their account
data at `[PRIVACY CONTACT EMAIL]`. Uninstalling the app triggers full deletion
within 48 hours.

---

## 9. Security

- All traffic to the app is over HTTPS.
- Storefront requests reach the app through Shopify's App Proxy and are verified
  by HMAC signature; unsigned requests are rejected.
- Admin requests are authenticated through Shopify's session tokens.
- Access tokens are stored in the application database and are not exposed to
  the storefront or to any client-side code.
- The app holds no write scopes, so a compromise of the app cannot alter a
  merchant's store data.

`[Add any further measures you actually have — encryption at rest, access
control policy, backup policy, incident response times. Do not claim a
certification you do not hold.]`

---

## 10. International transfers

Data is stored in `[REGION]`. Where data is transferred outside the UK/EEA, the
transfer relies on `[Standard Contractual Clauses / UK IDTA / adequacy
decision]`.

---

## 11. Children

The app is not directed at children and does not knowingly collect data from
them.

---

## 12. Changes to this policy

Material changes will be posted at `[PUBLIC URL OF THIS POLICY]` with an updated
effective date. Continued use of the app after that date constitutes acceptance.

---

## 13. Contact

`[LEGAL ENTITY NAME]`
`[REGISTERED ADDRESS]`
`[PRIVACY CONTACT EMAIL]`
`[EU/UK REPRESENTATIVE, IF REQUIRED]`

---

## Notes for the publisher — delete before publishing

**Placeholders to fill:** legal entity, address, contact email, effective date,
public URL, hosting/database/embeddings providers and their regions, the
international-transfer mechanism, and any security measures you can genuinely
evidence.

**Check these against your deployment before publishing:**

1. **Retention numbers are configurable.** 180 days and 24 hours are the code
   defaults (`ANALYTICS_RETENTION_DAYS`, `ANALYTICS_SESSION_TOKEN_RETENTION_HOURS`).
   If you have overridden either environment variable in production, change
   section 5 to match — a policy that misstates retention is worse than none.
2. **Sub-processor regions.** Section 6 lists placeholders. Your database is
   currently on Supabase in `ap-southeast-1` (Singapore), which is outside the
   UK/EEA — section 10 must therefore name a real transfer mechanism.
3. **Embeddings provider.** Section 6 assumes semantic search may be enabled.
   The provider defaults to Voyage AI and switches to OpenAI via
   `EMBEDDINGS_PROVIDER`. Name whichever you actually use. If you never enable
   semantic search, delete that row and paragraph rather than leaving it in.
4. **Shopify staff data.** Section 3.1 discloses that staff name and email may
   be stored on the session record. This is what the Prisma `Session` model
   holds; do not remove that paragraph unless you remove the columns.
5. **Shopify's App Store requirements.** A privacy policy URL is mandatory on
   the listing. It must be reachable without a login and must not be a PDF or a
   cloud-document link.
