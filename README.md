# Discogs ↔ Shopify Sync (Barnhouse Vinyl)

Keeps the Shopify store and the Discogs marketplace inventory in step, automatically, every 15 minutes via GitHub Actions.

## What it does

Each run:

1. **Sold on Shopify → hidden on Discogs.** Any record in a Shopify order from the last 48 hours (cancelled orders ignored) gets its Discogs listing set to **Draft**. Draft hides it from buyers; to relist (e.g. after a cancelled order), open the listing on Discogs and set it back to For Sale.
2. **New on Discogs → added to Shopify.** Every *For Sale* Discogs listing that isn't on Shopify yet is created as a product (with image, weight, and CDs/Vinyl collection).
3. **Gone from Discogs → removed from Shopify.** Any Shopify product linked to a Discogs listing that is no longer *For Sale* (sold, drafted, or deleted on Discogs) is deleted from Shopify.

4. **Genres → collections.** Each record is looked up on Discogs and added to **every** matching genre collection (Rock, Soul, Metal, Folk…). New products get this when they're created; products that were already on the store are filled in about 60 per run until they're all done, then tagged `genres-synced` so they're not looked up again.

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
| `SHOPIFY_CLIENT_ID` | Dev Dashboard → your app → **Settings** → Client ID |
| `SHOPIFY_CLIENT_SECRET` | Dev Dashboard → your app → **Settings** → Client secret |

Never upload the `.env` file itself.

The sync uses the Client ID/secret to get a fresh Shopify access token at the start of every run (Dev Dashboard tokens expire after 24 hours). A fixed `SHOPIFY_TOKEN` secret still works for old-style custom apps, but isn't needed.

### 2. Shopify app permissions

In the Shopify Dev Dashboard, the app's active version needs these scopes:
`read_products,write_products,read_inventory,write_inventory,read_orders`
(To change them: **Versions → Create version**, edit **Scopes**, **Release**, then approve the update in the store admin.) The sync checks these at the start of each run and says which are missing.

### 3. Do a test run

**Actions** tab → **Discogs <-> Shopify sync** → **Run workflow** → tick **Dry run** → **Run workflow**. Open the run to see what it *would* do. If it looks right, run it again without Dry run. After that it runs on its own every 15 minutes.

## Changing which genre goes where

Edit `genre-map.json` on GitHub (click it → pencil icon). It has four parts:

- **`genres`** — Discogs' broad genres (Rock, Funk / Soul, Hip Hop…) → your collection names.
- **`styles`** — Discogs' specific styles (Bossa Nova, Ska, Country Rock…) → your collection names.
- **`styleContains`** — any style containing this word (e.g. every "...Metal" style → Metal).
- **`fallbacks`** — e.g. a record marked only "Folk, World, & Country" with no clearer style goes to Folk.

Collection names must match Shopify exactly. Manual collections get products added directly; automated collections work if their condition is "Product tag is equal to …" (the sync adds that tag). The run log shows which collections each record went into, and warns about any name it can't find.

Changes only affect records sorted from then on. To re-sort a record, remove its `genres-synced` tag in Shopify and it will be redone on the next run.

## Changing how often it runs

Edit `.github/workflows/sync.yml` and change the `cron` line:

- `*/15 * * * *` — every 15 minutes (default; fine for **public** repos, which have free unlimited minutes)
- `*/30 * * * *` — every 30 minutes (use this if the repo is **private**, to fit GitHub's free minutes)

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
