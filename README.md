# Discogs ↔ Shopify Sync (Barnhouse Vinyl)

Keeps the Shopify store and the Discogs marketplace inventory in step, automatically, every 30 minutes via GitHub Actions.

## What it does

Each run:

1. **Sold on Shopify → hidden on Discogs.** Any record in a Shopify order from the last 48 hours (cancelled orders ignored) gets its Discogs listing set to **Draft**. Draft hides it from buyers; to relist (e.g. after a cancelled order), open the listing on Discogs and set it back to For Sale.
2. **New on Discogs → added to Shopify.** Every *For Sale* Discogs listing that isn't on Shopify yet is created as a product (with image, weight, and CDs/Vinyl collection).
3. **Gone from Discogs → removed from Shopify.** Any Shopify product linked to a Discogs listing that is no longer *For Sale* (sold, drafted, or deleted on Discogs) is deleted from Shopify.

Products are linked by SKU: the Shopify SKU is the Discogs listing ID. Products without a numeric SKU (merch, etc.) are never touched.

### Safety checks

- If Discogs returns **zero** listings for sale, the run changes nothing on Shopify (an API hiccup should never wipe the store).
- If a run would delete more than 25% of the Discogs-linked Shopify products (minimum 10), or draft more than 25 Discogs listings, it stops and lists what it *would* have done.
- If a record sold on **both** sites before the sync caught it, the run flags it as a **DOUBLE SALE** so you can cancel one order.

In all of these cases the run shows as failed (red ❌ on the Actions tab), and GitHub emails you.

## One-time setup

### 1. Add your keys as secrets

In this repo on GitHub: **Settings → Secrets and variables → Actions → New repository secret**. Add each of these, copying the values from your local `.env` file:

| Name | Value |
|---|---|
| `DISCOGS_CONSUMER_KEY` | from `.env` |
| `DISCOGS_CONSUMER_SECRET` | from `.env` |
| `DISCOGS_ACCESS_TOKEN` | from `.env` |
| `DISCOGS_ACCESS_SECRET` | from `.env` |
| `DISCOGS_USER` | your Discogs username |
| `SHOPIFY_STORE` | `yourstore.myshopify.com` |
| `SHOPIFY_TOKEN` | from `.env` |

Never upload the `.env` file itself.

### 2. Let the Shopify app read orders

The sync now reads orders to see what sold. In Shopify admin: **Settings → Apps and sales channels → Develop apps →** (your app) **→ Configuration → Admin API integration**, make sure **`read_orders`** is ticked (alongside the product permissions it already has), and save. If Shopify asks you to reinstall the app and gives you a new token, update the `SHOPIFY_TOKEN` secret.

### 3. Do a test run

**Actions** tab → **Discogs <-> Shopify sync** → **Run workflow** → tick **Dry run** → **Run workflow**. Open the run to see what it *would* do. If it looks right, run it again without Dry run. After that it runs on its own every 30 minutes.

## Changing how often it runs

Edit `.github/workflows/sync.yml` and change the `cron` line:

- `*/30 * * * *` — every 30 minutes (default; fits GitHub's free minutes for private repos)
- `*/15 * * * *` — every 15 minutes (fine for **public** repos, which have free unlimited minutes)

GitHub can start scheduled runs a few minutes late at busy times. Because Discogs has no instant sale notifications, there's always a short window where a record could sell on both sites; the double-sale warning covers that.

## Running on your own computer

```
npm install
cp .env.example .env     # then fill it in
npm run dry-run          # show what would change
npm run sync             # do it
npm test                 # run the built-in tests (uses a fake Discogs/Shopify, no keys needed)
```

To get new Discogs access tokens: `npm run get-token`.
