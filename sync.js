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
//   SHOPIFY_STORE, and either
//     SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET  (Dev Dashboard app — recommended)
//     or SHOPIFY_TOKEN                           (legacy custom app token)
// Optional:
//   DRY_RUN=true            log what would happen, change nothing
//   ALLOW_MASS_DELETE=true  skip the safety check on large deletions
//   ORDER_LOOKBACK_HOURS    how far back to look for Shopify orders (default 48)
//   SHOPIFY_API_VERSION     default 2024-07 (same as the original script)

import dotenv from "dotenv";
import axios from "axios";
import OAuth from "oauth-1.0a";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config({ path: "./.env", quiet: true });

// ---------- CONFIG ----------
const REQUIRED_ENV = [
  "DISCOGS_CONSUMER_KEY",
  "DISCOGS_CONSUMER_SECRET",
  "DISCOGS_ACCESS_TOKEN",
  "DISCOGS_ACCESS_SECRET",
  "DISCOGS_USER",
  "SHOPIFY_STORE",
];

// Shopify login: either a Client ID + Client Secret (Dev Dashboard apps —
// a fresh 24-hour token is fetched at the start of every run), or a fixed
// SHOPIFY_TOKEN (legacy custom apps).
const USE_CLIENT_CREDENTIALS = !!(
  process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET
);

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (!USE_CLIENT_CREDENTIALS && !process.env.SHOPIFY_TOKEN) {
  missing.push("SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (or SHOPIFY_TOKEN)");
}
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

// How many existing products get their genres filled in per run.
const GENRE_BACKFILL_PER_RUN = Number(process.env.GENRE_BACKFILL_PER_RUN) || 60;

const DISCOGS_BASE = process.env.DISCOGS_API_BASE || "https://api.discogs.com";
const SHOPIFY_BASE =
  process.env.SHOPIFY_API_BASE ||
  `https://${process.env.SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;
const SHOPIFY_AUTH_URL =
  process.env.SHOPIFY_AUTH_URL ||
  `https://${process.env.SHOPIFY_STORE}/admin/oauth/access_token`;

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
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

addRetry(shopify, "Shopify");

// Gets a fresh Shopify token (valid 24h) from the app's Client ID/Secret,
// and checks the token has every permission the sync needs.
const NEEDED_SCOPES = ["read_products", "write_products", "read_orders"];

async function connectShopify() {
  if (USE_CLIENT_CREDENTIALS) {
    let res;
    try {
      res = await axios.post(
        SHOPIFY_AUTH_URL,
        new URLSearchParams({
          grant_type: "client_credentials",
          client_id: process.env.SHOPIFY_CLIENT_ID,
          client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 30000 }
      );
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      throw new Error(
        `Shopify wouldn't issue a token (${err.response?.status || "network error"}: ${detail}). ` +
        "Check SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET match the app's Settings page in the " +
        "Shopify Dev Dashboard, and that the app is installed on the store."
      );
    }
    shopify.defaults.headers["X-Shopify-Access-Token"] = res.data.access_token;
    const granted = String(res.data.scope || "").split(",").map((s) => s.trim());
    console.log(`Shopify: got a fresh access token (scopes: ${granted.join(", ") || "unknown"})`);

    // write_X implies read_X in Shopify
    const has = (s) => granted.includes(s) || granted.includes(s.replace(/^read_/, "write_"));
    const lacking = NEEDED_SCOPES.filter((s) => !has(s));
    if (res.data.scope && lacking.length) {
      throw new Error(
        `The Shopify app is missing permission(s): ${lacking.join(", ")}. ` +
        "Add them in a new app version in the Dev Dashboard, release it, and approve it on the store."
      );
    }
  } else {
    shopify.defaults.headers["X-Shopify-Access-Token"] = process.env.SHOPIFY_TOKEN;
  }
}

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
    if (err.response?.status === 401) {
      throw new Error(
        "Shopify rejected the access token (401) — it's invalid or expired. " +
        "Use SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET secrets so a fresh token is fetched every run."
      );
    }
    if (err.response?.status === 403) {
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

// ---------- DISCOGS RELEASE DETAILS (genres, styles, images) ----------
const releaseCache = new Map();
async function getRelease(releaseId) {
  if (releaseCache.has(releaseId)) return releaseCache.get(releaseId);
  let data = null;
  try {
    const res = await api.get(`/releases/${releaseId}`);
    data = {
      image: res.data.images?.[0]?.uri || res.data.images?.[0]?.uri150 || null,
      genres: res.data.genres || [],
      styles: res.data.styles || [],
    };
  } catch (err) {
    console.log("  ❌ Discogs release lookup failed:", err.response?.data || err.message);
  }
  releaseCache.set(releaseId, data);
  await sleep(1100); // stay under Discogs' 60 requests/minute
  return data;
}

// ---------- GENRE -> COLLECTION MAPPING (genre-map.json) ----------
const GENRE_MAP = (() => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "genre-map.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.log(`⚠️ Couldn't read genre-map.json (${err.message}) — genre collections will be skipped.`);
    return null;
  }
})();

const lc = (s) => String(s || "").trim().toLowerCase();

function genreCollectionsFor(release) {
  const out = new Set();
  if (!GENRE_MAP || !release) return [];
  const genreMap = Object.fromEntries(Object.entries(GENRE_MAP.genres || {}).map(([k, v]) => [lc(k), v]));
  const styleMap = Object.fromEntries(Object.entries(GENRE_MAP.styles || {}).map(([k, v]) => [lc(k), v]));
  const contains = Object.entries(GENRE_MAP.styleContains || {});

  for (const g of release.genres) for (const c of genreMap[lc(g)] || []) out.add(c);
  for (const st of release.styles) {
    for (const c of styleMap[lc(st)] || []) out.add(c);
    for (const [needle, cols] of contains) {
      if (lc(st).includes(lc(needle))) for (const c of cols) out.add(c);
    }
  }
  for (const [genre, rule] of Object.entries(GENRE_MAP.fallbacks || {})) {
    if (!release.genres.some((g) => lc(g) === lc(genre))) continue;
    const already = (rule.ifNoneOf || []).some((c) => [...out].some((o) => lc(o) === lc(c)));
    if (!already) for (const c of rule.use || []) out.add(c);
  }
  return [...out];
}

// ---------- SHOPIFY COLLECTIONS ----------
// Loaded once per run: manual ("custom") and automated ("smart") collections.
let collectionIndex = null;
const warnedCollections = new Set();

async function loadCollections() {
  if (collectionIndex) return collectionIndex;
  collectionIndex = new Map();
  const custom = await shopifyGetAll("/custom_collections.json", "custom_collections", { fields: "id,title" });
  for (const c of custom) collectionIndex.set(lc(c.title), { id: c.id, title: c.title, smart: false });
  try {
    const smart = await shopifyGetAll("/smart_collections.json", "smart_collections", { fields: "id,title,rules" });
    for (const c of smart) {
      const tagRule = (c.rules || []).find((r) => r.column === "tag" && r.relation === "equals");
      collectionIndex.set(lc(c.title), { id: c.id, title: c.title, smart: true, tag: tagRule?.condition || null });
    }
  } catch (err) {
    console.log("  ⚠️ Couldn't load automated collections:", err.response?.status || err.message);
  }
  console.log(`Shopify: ${collectionIndex.size} collection(s) found.`);
  return collectionIndex;
}

function warnOnce(key, msg) {
  if (warnedCollections.has(key)) return;
  warnedCollections.add(key);
  console.log(`  ⚠️ ${msg}`);
}

// Works out how to put a product into the given collection titles:
//   manual collections  -> collection IDs to add the product to
//   automated (by tag)  -> tags to add to the product
async function planCollections(titles) {
  const index = await loadCollections();
  const collectIds = [];
  const tags = [];
  const names = [];
  for (const title of titles) {
    const col = index.get(lc(title));
    if (!col) {
      warnOnce(title, `Collection "${title}" not found in Shopify — check the name in genre-map.json`);
      continue;
    }
    if (!col.smart) {
      collectIds.push(col.id);
      names.push(col.title);
    } else if (col.tag) {
      tags.push(col.tag);
      names.push(col.title);
    } else {
      warnOnce(title, `"${title}" is an automated collection without a "tag equals" rule — can't add products to it`);
    }
  }
  return { collectIds, tags, names };
}

async function addProductToCollection(productId, collectionId) {
  try {
    await shopify.post("/collects.json", {
      collect: { product_id: productId, collection_id: collectionId },
    });
    return true;
  } catch (err) {
    // 422 = already in that collection, which is fine
    if (err.response?.status === 422) return true;
    console.log("  ❌ Collection assignment failed:", err.response?.data || err.message);
    return false;
  }
}

const GENRE_DONE_TAG = "genres-synced";

function splitTags(tags) {
  return String(tags || "").split(",").map((t) => t.trim()).filter(Boolean);
}

function mergeTags(existing, extra) {
  const out = [...existing];
  for (const t of extra) if (!out.some((e) => lc(e) === lc(t))) out.push(t);
  return out;
}

async function mapToShopify(listing) {
  const r = listing.release;
  const release = await getRelease(r.id);
  const image = r.cover_image || release?.image || null;

  const format = r.format || r.formats || r.format_description;
  const { weight, weight_unit } = getWeightForFormat(format);
  const formatCollection = getCollectionForFormat(format);
  const genreCollections = genreCollectionsFor(release);

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
    product_type: formatCollection === "CDs" ? "CD" : "Vinyl",
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

  return { product, collections: [formatCollection, ...genreCollections], genreCollections, release };
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

    const plan = await planCollections(mapped.collections);
    if (mapped.genreCollections.length) console.log(`  Genres: ${mapped.genreCollections.join(", ")}`);
    mapped.product.tags = mergeTags(plan.tags, [GENRE_DONE_TAG]).join(", ");

    if (DRY_RUN) {
      console.log(`  (dry run) would create product in: ${plan.names.join(", ") || "no collections"}`);
      continue;
    }

    const product = await createShopifyProduct(mapped.product);
    if (product) {
      created++;
      console.log(`  ✔ Created Shopify ID: ${product.id}`);
      for (const id of plan.collectIds) await addProductToCollection(product.id, id);
      if (plan.names.length) console.log(`  ✔ Collections: ${plan.names.join(", ")}`);
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
    return new Set();
  }

  let removed = 0;
  const deletedIds = new Set();
  for (const product of stale) {
    const sku = product.variants.find((v) => isDiscogsSku(v.sku))?.sku;
    console.log(`🗑️ "${product.title}" (SKU ${sku}) — no longer for sale on Discogs`);
    if (DRY_RUN) continue;
    if (await deleteShopifyProduct(product.id)) {
      removed++;
      deletedIds.add(product.id);
      console.log("  ✔ Deleted");
    }
    await sleep(500);
  }

  if (!DRY_RUN) console.log(`Removed ${removed} product(s).`);
  return deletedIds;
}

// ============================================================
// STEP 4: FILL IN GENRES FOR EXISTING PRODUCTS
// ============================================================
// Products created before genre support get sorted into genre collections a
// batch at a time (Discogs allows ~1 lookup per second), then tagged
// "genres-synced" so they're never looked up again.
async function backfillGenres(listings, allProducts, deletedIds) {
  console.log("\n== Step 4: Genre collections for existing products ==");

  const listingBySku = new Map(listings.map((l) => [String(l.id), l]));
  const todo = allProducts.filter((p) => {
    if (deletedIds.has(p.id)) return false;
    if (splitTags(p.tags).some((t) => lc(t) === GENRE_DONE_TAG)) return false;
    return (p.variants || []).some((v) => listingBySku.has(v.sku));
  });

  if (!todo.length) {
    console.log("All products already have their genres.");
    return;
  }

  const batch = todo.slice(0, GENRE_BACKFILL_PER_RUN);
  console.log(`${todo.length} product(s) still need genres; doing ${batch.length} this run.`);

  let done = 0;
  for (const product of batch) {
    const sku = product.variants.find((v) => listingBySku.has(v.sku)).sku;
    const listing = listingBySku.get(sku);
    const release = await getRelease(listing.release.id);
    if (!release) continue; // lookup failed; try again next run

    const titles = genreCollectionsFor(release);
    const plan = await planCollections(titles);
    console.log(`  🎵 "${product.title}": ${plan.names.join(", ") || "(no matching genre collection)"}` +
      (release.genres.length ? `  [Discogs: ${[...release.genres, ...release.styles].join(", ")}]` : ""));

    if (DRY_RUN) continue;

    for (const id of plan.collectIds) await addProductToCollection(product.id, id);
    const tags = mergeTags(splitTags(product.tags), [...plan.tags, GENRE_DONE_TAG]);
    try {
      await shopify.put(`/products/${product.id}.json`, { product: { id: product.id, tags: tags.join(", ") } });
      done++;
    } catch (err) {
      console.log("  ❌ Couldn't update tags:", err.response?.data || err.message);
    }
    await sleep(500);
  }

  if (!DRY_RUN) {
    console.log(`Sorted ${done} product(s) into genres.` +
      (todo.length > batch.length ? ` ${todo.length - done} left — they'll be done over the next runs.` : ""));
  }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log(`Discogs <-> Shopify sync — ${new Date().toISOString()}`);
  if (DRY_RUN) console.log("🧪 DRY RUN — nothing will be changed");

  await connectShopify();

  // 1. Shopify sales -> Discogs (runs first, so those listings drop out of
  //    "For Sale" and their Shopify products are removed in step 3).
  await pushShopifySalesToDiscogs();

  // 2 + 3. Discogs -> Shopify
  console.log("\n== Loading current inventory ==");
  const listings = await fetchForSaleInventory(process.env.DISCOGS_USER);
  console.log(`Discogs: ${listings.length} listing(s) for sale.`);

  const allProducts = await shopifyGetAll("/products.json", "products", {
    fields: "id,title,tags,variants",
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
  const deletedIds = await removeProductsNotForSale(forSaleSkus, allProducts);

  // Products sold/removed on Discogs are skipped automatically: they're not in
  // the For Sale listings, so there's nothing to look up for them.
  await backfillGenres(listings, allProducts, deletedIds);
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
