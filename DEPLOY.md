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

## Notes
- The DB (Supabase) and its search index already exist, so the release step is a
  no-op migrate. For a brand-new database, run `npm run db:setup` once against it first.
- Logs: `fly logs`. Status: `fly status`. Open: `fly open`.
