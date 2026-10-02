// Barnhouse Vinyl — two-way Discogs <-> Shopify sync
//
// Each run does three things, in this order:
//   1. Shopify -> Discogs: any record that was ordered on Shopify recently
//      gets its Discogs listing set to Draft (hidden from buyers, easy to relist).
//   2. Discogs -> Shopify: every "For Sale" Discogs listing that isn't on
//      Shopify yet gets created as a product.
//   3. Discogs -> Shopify: any Discogs-linked Shopify product whose listing is
//      no longer "For Sale" (sold, drafted, deleted on Discogs) is deleted.
//
// Products are linked by SKU: the Shopify SKU is the Discogs listing ID.
//
// Environment variables (GitHub secrets, or a local .env file):
//   DISCOGS_CONSUMER_KEY, DISCOGS_CONSUMER_SECRET,
//   DISCOGS_ACCESS_TOKEN, DISCOGS_ACCESS_SECRET, DISCOGS_USER,
//   SHOPIFY_STORE, SHOPIFY_TOKEN
// Optional:
//   DRY_RUN=true            log what would happen, change nothing
//   ALLOW_MASS_DELETE=true  skip the safety check on large deletions
//   ORDER_LOOKBACK_HOURS    how far back to look for Shopify orders (default 48)
//   SHOPIFY_API_VERSION     default 2024-07 (same as the original script)

import dotenv from "dotenv";
import axios from "axios";
import OAuth from "oauth-1.0a";
import crypto from "crypto";

dotenv.config({ path: "./.env", quiet: true });

// ---------- CONFIG ----------
const REQUIRED_ENV = [
  "DISCOGS_CONSUMER_KEY",
  "DISCOGS_CONSUMER_SECRET",
  "DISCOGS_ACCESS_TOKEN",
  "DISCOGS_ACCESS_SECRET",
  "DISCOGS_USER",
  "SHOPIFY_STORE",
  "SHOPIFY_TOKEN",
];

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.log(`❌ Missing settings: ${missing.join(", ")}`);
  console.log("   Add them as GitHub secrets (or to your local .env file).");
  process.exit(1);
}

const isTrue = (v) => /^(1|true|yes)$/i.test(String(v || "").trim());

const DRY_RUN = isTrue(process.env.DRY_RUN);
const ALLOW_MASS_DELETE = isTrue(process.env.ALLOW_MASS_DELETE);
const ORDER_LOOKBACK_HOURS = Number(process.env.ORDER_LOOKBACK_HOURS) || 48;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-07";

// Safety limits. If a run would delete/draft more than this, it stops and
// asks for a human to confirm (re-run with ALLOW_MASS_DELETE=true).
const MAX_DELETE_FRACTION = 0.25; // 25% of Discogs-linked Shopify products
const MIN_DELETE_LIMIT = 10;      // ...but always allow at least this many
const MAX_DRAFTS_PER_RUN = 25;

const DISCOGS_BASE = process.env.DISCOGS_API_BASE || "https://api.discogs.com";
const SHOPIFY_BASE =
  process.env.SHOPIFY_API_BASE ||
  `https://${process.env.SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Problems that need a human to look at them. The run is marked as failed at
// the end if any are recorded, so GitHub emails you.
const problems = [];

// ---------- RETRY ON RATE LIMITS / SERVER ERRORS ----------
function addRetry(instance, name) {
  instance.interceptors.response.use(null, async (err) => {
    const config = err.config;
    const status = err.response?.status;
    const retryable = !status || status === 429 || status >= 500;

    if (!config || !retryable) throw err;

    config.__retries = (config.__retries || 0) + 1;
    if (config.__retries > 5) throw err;

    const retryAfter = Number(err.response?.headers?.["retry-after"]);
    const wait = retryAfter > 0
      ? retryAfter * 1000
      : Math.min(2000 * 2 ** (config.__retries - 1), 60000);

    console.log(
      `⏳ ${name} ${status || "network error"} — retrying in ${Math.round(wait / 1000)}s`
    );
    await sleep(wait);
    return instance(config);
  });
}

// ---------- DISCOGS CLIENT ----------
const oauth = OAuth({
  consumer: {
    key: process.env.DISCOGS_CONSUMER_KEY,
    secret: process.env.DISCOGS_CONSUMER_SECRET,
  },
  signature_method: "HMAC-SHA1",
  hash_function(base_string, key) {
    return crypto.createHmac("sha1", key).update(base_string).digest("base64");
  },
});

const token = {
  key: process.env.DISCOGS_ACCESS_TOKEN,
  secret: process.env.DISCOGS_ACCESS_SECRET,
};

const api = axios.create({
  baseURL: DISCOGS_BASE,
  headers: { "User-Agent": "barnhouse-discogs-shopify-sync/2.0" },
  timeout: 30000,
});

// Query strings are built into the URL (see qs() below) so they are included
// in the OAuth signature.
api.interceptors.request.use((config) => {
  const requestData = {
    url: config.baseURL + config.url,
    method: config.method.toUpperCase(),
  };
  config.headers = {
    ...config.headers,
    ...oauth.toHeader(oauth.authorize(requestData, token)),
  };
  return config;
});

addRetry(api, "Discogs");

function qs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// ---------- SHOPIFY CLIENT ----------
const shopify = axios.create({
  baseURL: SHOPIFY_BASE,
  headers: {
    "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

addRetry(shopify, "Shopify");

function nextPageInfo(res) {
  const link = res.headers?.link || res.headers?.Link;
  if (!link) return null;
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  if (!match) return null;
  try {
    return new URL(match[1]).searchParams.get("page_info");
  } catch {
    return null;
  }
}

// Fetch every page of a Shopify list endpoint.
async function shopifyGetAll(path, key, params) {
  const all = [];
  let query = { limit: 250, ...params };

  while (true) {
    const res = await shopify.get(path, { params: query });
    all.push(...(res.data[key] || []));
    const pageInfo = nextPageInfo(res);
    if (!pageInfo) break;
    // When paginating, Shopify only allows limit/page_info (and fields).
    query = { limit: 250, page_info: pageInfo };
    if (params?.fields) query.fields = params.fields;
  }

  return all;
}

const isDiscogsSku = (sku) => typeof sku === "string" && /^\d+$/.test(sku);

// ---------- FORMAT HELPERS ----------
function formatToString(format) {
  if (Array.isArray(format)) {
    return format
      .map((item) => (typeof item === "string" ? item : item?.name || ""))
      .join(" ");
  }
  return String(format || "");
}

// CDs = 0.5lb, vinyl / everything else = 1lb
function getWeightForFormat(format) {
  const upper = formatToString(format).toUpperCase();
  const isCD = ["CD", "COMPACT DISC", "CD-R", "CDROM"].some((k) => upper.includes(k));
  return { weight: isCD ? 0.5 : 1, weight_unit: "lb" };
}

function getCollectionForFormat(format) {
  const upper = formatToString(format).toUpperCase();
  return upper.includes("CD") || upper.includes("COMPACT DISC") ? "CDs" : "Vinyl";
}

// ============================================================
// STEP 1: SHOPIFY SALES -> DRAFT ON DISCOGS
// ============================================================

// Discogs listing IDs that appear in recent, non-cancelled Shopify orders.
async function fetchListingIdsSoldOnShopify() {
  const since = new Date(Date.now() - ORDER_LOOKBACK_HOURS * 3600 * 1000).toISOString();

  let orders;
  try {
    orders = await shopifyGetAll("/orders.json", "orders", {
      status: "any",
      created_at_min: since,
      fields: "id,name,cancelled_at,line_items",
    });
  } catch (err) {
    if (err.response?.status === 403 || err.response?.status === 401) {
      throw new Error(
        "Shopify refused access to orders. In your Shopify app's API settings, " +
        "turn on the read_orders permission, then update the SHOPIFY_TOKEN secret if it changed."
      );
    }
    throw err;
  }

  const sold = new Map(); // listingId -> order name (e.g. #1042)
  for (const order of orders) {
    if (order.cancelled_at) continue;
    for (const item of order.line_items || []) {
      if (isDiscogsSku(item.sku)) sold.set(item.sku, order.name || String(order.id));
    }
  }
  return sold;
}

async function draftDiscogsListing(listingId, orderName) {
  let listing;
  try {
    const res = await api.get(`/marketplace/listings/${listingId}`);
    listing = res.data;
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`  • Listing ${listingId} no longer exists on Discogs — nothing to do`);
      return "gone";
    }
    throw err;
  }

  const title = `${listing.release?.artist || ""} - ${listing.release?.title || ""}`;

  if (listing.status === "Sold") {
    const msg =
      `DOUBLE SALE: "${title}" (listing ${listingId}) sold on Shopify (order ${orderName}) ` +
      `AND on Discogs. One of the orders needs to be cancelled/refunded.`;
    console.log(`  🚨 ${msg}`);
    problems.push(msg);
    return "double";
  }

  if (listing.status !== "For Sale") return "skip"; // already Draft/Expired/etc.

  console.log(`  📝 "${title}" sold on Shopify (order ${orderName}) — setting Discogs listing ${listingId} to Draft`);

  if (DRY_RUN) return "drafted";

  // Discogs' edit endpoint replaces the listing, so send every existing field
  // back unchanged and only switch the status.
  const body = {
    release_id: listing.release.id,
    condition: listing.condition,
    price: listing.price?.value,
    status: "Draft",
  };
  const optional = {
    sleeve_condition: listing.sleeve_condition,
    comments: listing.comments,
    allow_offers: listing.allow_offers,
    external_id: listing.external_id,
    location: listing.location,
    weight: listing.weight,
    format_quantity: listing.format_quantity,
  };
  for (const [k, v] of Object.entries(optional)) {
    if (v !== undefined && v !== null && v !== "") body[k] = v;
  }

  await api.post(`/marketplace/listings/${listingId}`, body, {
    headers: { "Content-Type": "application/json" },
  });
  console.log("  ✔ Drafted on Discogs");
  return "drafted";
}

async function pushShopifySalesToDiscogs() {
  console.log(`\n== Step 1: Shopify orders from the last ${ORDER_LOOKBACK_HOURS}h -> Discogs ==`);

  const sold = await fetchListingIdsSoldOnShopify();
  console.log(`Found ${sold.size} Discogs record(s) in recent Shopify orders.`);

  let drafted = 0;
  for (const [listingId, orderName] of sold) {
    if (drafted >= MAX_DRAFTS_PER_RUN && !ALLOW_MASS_DELETE) {
      const msg =
        `More than ${MAX_DRAFTS_PER_RUN} Discogs listings to draft in one run — stopped as a safety check. ` +
        `If this is expected, run the workflow manually with "allow mass delete" checked.`;
      console.log(`🛑 ${msg}`);
      problems.push(msg);
      break;
    }
    const result = await draftDiscogsListing(listingId, orderName);
    if (result === "drafted") drafted++;
    await sleep(1100); // stay under Discogs' 60 requests/minute
  }

  console.log(`${DRY_RUN ? "Would draft" : "Drafted"} ${drafted} Discogs listing(s).`);
}

// ============================================================
// STEP 2 + 3: DISCOGS -> SHOPIFY
// ============================================================

async function fetchForSaleInventory(username) {
  console.log("Fetching Discogs inventory (For Sale only)...");
  const all = [];
  let page = 1;

  while (true) {
    const res = await api.get(
      `/users/${encodeURIComponent(username)}/inventory?` +
      qs({ status: "For Sale", page, per_page: 100 })
    );
    all.push(...(res.data.listings || []));
    const p = res.data.pagination;
    if (!p || p.page >= p.pages) break;
    page++;
    await sleep(1100);
  }

  // Belt and braces: only keep listings actually marked For Sale.
  return all.filter((l) => !l.status || l.status === "For Sale");
}

async function getDiscogsImage(releaseId) {
  try {
    const res = await api.get(`/releases/${releaseId}`);
    return res.data.images?.[0]?.uri || res.data.images?.[0]?.uri150 || null;
  } catch (err) {
    console.log("  ❌ Discogs image lookup failed:", err.response?.data || err.message);
    return null;
  }
}

async function mapToShopify(listing) {
  const r = listing.release;
  let image = r.cover_image;
  if (!image) image = await getDiscogsImage(r.id);

  const format = r.format || r.formats || r.format_description;
  const { weight, weight_unit } = getWeightForFormat(format);
  const collection = getCollectionForFormat(format);

  const product = {
    title: `${r.artist} - ${r.title}`,
    body_html: `
      <p><strong>Format:</strong> ${r.format}</p>
      <p><strong>Condition:</strong> ${listing.condition}</p>
      <p><strong>Sleeve:</strong> ${listing.sleeve_condition}</p>
      <p><strong>Notes:</strong> ${listing.comments || ""}</p>
      <p><strong>Discogs ID:</strong> ${listing.id}</p>
    `,
    vendor: r.label || r.artist || "Unknown",
    product_type: collection === "CDs" ? "CD" : "Vinyl",
    variants: [
      {
        price: listing.price.value,
        inventory_management: "shopify",
        inventory_quantity: 1,
        sku: String(listing.id),
        weight,
        weight_unit,
      },
    ],
  };

  if (image) product.images = [{ src: image }];

  return { product, collection };
}

const collectionIdCache = new Map();
async function getCollectionIdByTitle(title) {
  if (collectionIdCache.has(title)) return collectionIdCache.get(title);
  try {
    const res = await shopify.get("/custom_collections.json", { params: { title } });
    const id = res.data.custom_collections?.[0]?.id || null;
    if (!id) console.log(`  ⚠️ Collection "${title}" not found`);
    collectionIdCache.set(title, id);
    return id;
  } catch (err) {
    console.log("  ❌ Collection lookup failed:", err.response?.data || err.message);
    return null;
  }
}

async function addProductToCollection(productId, collectionId) {
  try {
    const res = await shopify.post("/collects.json", {
      collect: { product_id: productId, collection_id: collectionId },
    });
    return res.data.collect;
  } catch (err) {
    console.log("  ❌ Collection assignment failed:", err.response?.data || err.message);
    return null;
  }
}

async function createShopifyProduct(product) {
  try {
    const res = await shopify.post("/products.json", { product });
    return res.data.product;
  } catch (err) {
    console.log("  ❌ Shopify upload failed:", err.response?.data || err.message);
    return null;
  }
}

async function deleteShopifyProduct(productId) {
  try {
    await shopify.delete(`/products/${productId}.json`);
    return true;
  } catch (err) {
    console.log("  ❌ Product deletion failed:", err.response?.data || err.message);
    return false;
  }
}

async function createNewProducts(listings, existingBySku) {
  console.log("\n== Step 2: New Discogs listings -> Shopify ==");

  const toCreate = listings.filter((l) => !existingBySku.has(String(l.id)));
  console.log(`${toCreate.length} new listing(s) to add to Shopify.`);

  let created = 0;
  let index = 0;
  for (const listing of toCreate) {
    index++;
    const mapped = await mapToShopify(listing);
    console.log(`\n[${index}/${toCreate.length}] ${mapped.product.title}`);

    if (DRY_RUN) {
      console.log("  (dry run) would create product");
      continue;
    }

    const product = await createShopifyProduct(mapped.product);
    if (product) {
      created++;
      console.log(`  ✔ Created Shopify ID: ${product.id}`);
      const collectionId = await getCollectionIdByTitle(mapped.collection);
      if (collectionId && (await addProductToCollection(product.id, collectionId))) {
        console.log(`  ✔ Added to collection: ${mapped.collection}`);
      }
    }
    await sleep(800);
  }

  if (!DRY_RUN) console.log(`\nCreated ${created} product(s).`);
}

async function removeProductsNotForSale(forSaleSkus, allProducts) {
  console.log("\n== Step 3: Remove Shopify products no longer for sale on Discogs ==");

  const linked = allProducts.filter((p) => (p.variants || []).some((v) => isDiscogsSku(v.sku)));
  const stale = linked.filter(
    (p) => !(p.variants || []).some((v) => isDiscogsSku(v.sku) && forSaleSkus.has(v.sku))
  );

  console.log(`${linked.length} Discogs-linked Shopify product(s); ${stale.length} no longer for sale.`);

  const limit = Math.max(MIN_DELETE_LIMIT, Math.floor(linked.length * MAX_DELETE_FRACTION));
  if (stale.length > limit && !ALLOW_MASS_DELETE) {
    const msg =
      `Safety check: this run would delete ${stale.length} Shopify products (limit ${limit}). ` +
      `Nothing was deleted. If this is expected, run the workflow manually with "allow mass delete" checked.`;
    console.log(`🛑 ${msg}`);
    for (const p of stale.slice(0, 20)) console.log(`   - ${p.title}`);
    if (stale.length > 20) console.log(`   ...and ${stale.length - 20} more`);
    problems.push(msg);
    return;
  }

  let removed = 0;
  for (const product of stale) {
    const sku = product.variants.find((v) => isDiscogsSku(v.sku))?.sku;
    console.log(`🗑️ "${product.title}" (SKU ${sku}) — no longer for sale on Discogs`);
    if (DRY_RUN) continue;
    if (await deleteShopifyProduct(product.id)) {
      removed++;
      console.log("  ✔ Deleted");
    }
    await sleep(500);
  }

  if (!DRY_RUN) console.log(`Removed ${removed} product(s).`);
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log(`Discogs <-> Shopify sync — ${new Date().toISOString()}`);
  if (DRY_RUN) console.log("🧪 DRY RUN — nothing will be changed");

  // 1. Shopify sales -> Discogs (runs first, so those listings drop out of
  //    "For Sale" and their Shopify products are removed in step 3).
  await pushShopifySalesToDiscogs();

  // 2 + 3. Discogs -> Shopify
  console.log("\n== Loading current inventory ==");
  const listings = await fetchForSaleInventory(process.env.DISCOGS_USER);
  console.log(`Discogs: ${listings.length} listing(s) for sale.`);

  const allProducts = await shopifyGetAll("/products.json", "products", {
    fields: "id,title,variants",
  });
  console.log(`Shopify: ${allProducts.length} product(s).`);

  if (listings.length === 0) {
    // An empty inventory is far more likely to be an API hiccup than a
    // genuinely empty shop, so never wipe Shopify on that basis.
    const msg = "Discogs returned 0 listings for sale — skipped all Shopify changes as a precaution.";
    console.log(`🛑 ${msg}`);
    problems.push(msg);
    return;
  }

  const existingBySku = new Map();
  for (const p of allProducts) {
    for (const v of p.variants || []) if (v.sku) existingBySku.set(v.sku, p);
  }

  await createNewProducts(listings, existingBySku);

  const forSaleSkus = new Set(listings.map((l) => String(l.id)));
  await removeProductsNotForSale(forSaleSkus, allProducts);
}

main()
  .then(() => {
    if (problems.length) {
      console.log("\n⚠️ Finished, but needs your attention:");
      for (const p of problems) console.log(`  - ${p}`);
      process.exit(1);
    }
    console.log("\n✅ Done.");
  })
  .catch((err) => {
    console.log("\n❌ ERROR:", err.response?.data ? JSON.stringify(err.response.data) : err.message);
    process.exit(1);
  });
