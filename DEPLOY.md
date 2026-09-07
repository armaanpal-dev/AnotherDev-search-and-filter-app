# Deploying AnotherDev Search to Fly.io

A permanent, always-on host — no tunnels, no `example.com`, survives your PC being off.

## One-time setup

### 1. Install flyctl (if not already)
PowerShell:
```powershell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```
Then open a NEW terminal so `fly` is on your PATH.

### 2. Log in
```bash
fly auth login
```
(Opens a browser. Fly requires a card on file even for the small machines, but the
shared-cpu-1x/512MB this app uses is a few dollars a month.)

### 3. Create the app
The name must be globally unique. If `anotherdev-search` is taken, pick another and
update BOTH `fly.toml` (`app = "..."`) and the `SHOPIFY_APP_URL` secret below.
```bash
fly apps create anotherdev-search
```

### 4. Set secrets (env vars)
Get your Shopify API key + secret from `shopify app env show`, then:
```bash
fly secrets set \
  SHOPIFY_API_KEY=<your-api-key> \
  SHOPIFY_API_SECRET=<your-api-secret> \
  SCOPES="read_products,read_product_listings,read_collection_listings,read_inventory,read_content" \
  DATABASE_URL="postgresql://postgres.<ref>:<PASSWORD>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres" \
  DIRECT_URL="postgresql://postgres.<ref>:<PASSWORD>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres" \
  SHOPIFY_APP_URL="https://anotherdev-search.fly.dev"
```
Fill in your real values (never commit them). The URL/app name too, if you changed it.

### 5. Deploy
```bash
fly deploy
```
This builds the Docker image, runs `prisma migrate deploy` (release command), and
starts the server. When it finishes, check it's live:
```bash
curl -I https://anotherdev-search.fly.dev/
```

### 6. Point Shopify at the permanent URL
`shopify.app.toml` is already set to the Fly URL below. If you renamed the Fly
app in step 2, update all three to match:
```toml
application_url = "https://anotherdev-search.fly.dev"
[auth]
redirect_urls = [ "https://anotherdev-search.fly.dev/auth/callback" ]
[app_proxy]
url = "https://anotherdev-search.fly.dev/proxy"
```
Then push the config to Shopify:
```bash
shopify app deploy --allow-updates --message "point at permanent fly.io host"
```

Done. The app now loads from Fly with a stable URL — reload it in the Shopify admin.

## Redeploying after code changes
```bash
fly deploy
```
(No need to touch Shopify unless you change scopes, webhooks, the app proxy, or the
extension — those still go through `shopify app deploy`.)

## After a schema change

The release command now runs BOTH halves:

```
release_command = "sh -c 'npx prisma migrate deploy && npm run db:index'"
```

`db:index` is not optional. The generated tsvector column, the trigram/GIN
indexes and the pgvector column live in `prisma/sql/search_index.sql`, which
Prisma cannot model and therefore does not apply — so a deploy to a fresh
database with only `migrate deploy` left `Product."searchVector"` missing and
every storefront search returned a 500. The script is idempotent and only
rebuilds the generated column when its definition is actually stale, so running
it on every deploy is cheap.

If your host has no release hook, use `npm run docker-start` as the container
command instead; it runs `setup` (migrate + index) before starting the server.

## Scheduled catalog reconciliation

Webhooks keep the index close to live, but they are not a guarantee — a delivery
can be dropped, a bulk API edit can be throttled, and `collections/update` on a
very large collection deliberately defers its removals. A nightly pass closes
that gap. Set `CRON_SECRET`, then have any scheduler call it once a day:

```bash
curl -X POST https://<app>/cron/sync -H "Authorization: Bearer $CRON_SECRET"
```

With `CRON_SECRET` unset the endpoint refuses every request — an unset variable
in production must never mean "open to anyone". Merchants can opt out per shop
from Settings.

## Purchase attribution (Web Pixel)

`extensions/anotherdev-pixel` reports completed orders back to the search that
produced them. Two things are required and neither is automatic:

1. **New scopes.** `write_pixels` and `read_customer_events` were added to
   `shopify.app.toml` and `.env`/`SCOPES`. Existing merchants WILL be prompted to
   re-approve the app on their next visit. Deploy the app config
   (`shopify app deploy`) before the server, or the grant will not exist yet.
2. **Per-shop activation.** Shopify only runs the pixel once the app has created
   a WebPixel record for that shop. Merchants turn it on from Settings →
   Revenue tracking; nothing is installed on a store that has not asked for it.

The pixel reads the order total, its line-item product ids, and the anonymous
`adsf_st` cookie the search widget sets. It reads no customer identifiers.

## Notes
- **Scopes changed in this release.** `write_pixels` and `read_customer_events`
  were added for purchase attribution, so existing merchants ARE prompted to
  re-approve on their next admin visit. Everything touching the catalog stays
  read-only.
- **Analytics now reaches revenue.** Click-through and add-to-cart come from the
  storefront widget; completed orders come from the Web Pixel, which is the only
  surface Shopify runs inside checkout. Shops that have not switched the pixel on
  see the funnel stop at add-to-cart, as before.
- **Sync streams.** The bulk export is read line by line rather than buffered
  into one string, so a large catalog no longer has to fit in the machine's
  memory alongside its own parse.
- **Sync runs in the web process.** It is guarded against concurrent runs and
  recovers from a crash mid-run (a heartbeat marks a stale run dead after 3
  minutes), but a deploy during a sync interrupts it — re-run it from the Index
  page afterwards. If catalogs grow large enough for this to hurt, `runFullSync`
  is already standalone and moving it behind a queue is a contained change.
- **Semantic search** needs pgvector. Supabase ships it; enable the extension,
  then run `npm run db:index`. Without it the migration skips the vector column
  and search stays keyword-only — no errors, no configuration needed.
- `min_machines_running = 1` keeps storefront search off cold starts. Don't set it
  to 0 — a cold start in front of an autocomplete request is very visible.
- The DB (Supabase) and its search index already exist, so the release step is a
  no-op migrate. For a brand-new database, run `npm run db:setup` once against it first.
- Logs: `fly logs`. Status: `fly status`. Open: `fly open`.
