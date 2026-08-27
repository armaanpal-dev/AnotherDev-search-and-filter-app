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
Edit `shopify.app.toml` — set all three to your Fly URL:
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

The release command runs `prisma migrate deploy`, but it does NOT rebuild the raw
SQL layer (the generated tsvector column, trigram/GIN indexes, pgvector column) —
Prisma cannot model those. Run it once after deploying a migration that touches
indexed columns:
```bash
fly ssh console -C "npm run db:index"
```

## Notes
- **Scopes are unchanged and read-only**, so existing merchants are not prompted
  to re-approve the app after this deploy.
- **Analytics stops at add-to-cart.** Checkout runs on Shopify's domain, so
  measuring completed orders would need a Web Pixel extension and the
  `read_customer_events` + `write_pixels` scopes — deliberately not part of this
  app. Click-through and add-to-cart are both attributed to the exact search.
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
