// Runs sync.js against a fake Discogs + Shopify server and checks the results.
import http from "http";
import crypto from "crypto";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CK = "ck", CS = "cs", AT = "at", AS = "as";

const pe = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function verifyOAuth(req, base) {
  const h = req.headers.authorization || "";
  const params = {};
  for (const m of h.matchAll(/(\w+)="([^"]*)"/g)) params[m[1]] = decodeURIComponent(m[2]);
  const sig = params.oauth_signature;
  delete params.oauth_signature;
  delete params.realm;
  const u = new URL(req.url, base);
  for (const [k, v] of u.searchParams) params[k] = v;
  const paramStr = Object.keys(params).sort().map((k) => `${pe(k)}=${pe(params[k])}`).join("&");
  const baseStr = [req.method, pe(base + u.pathname), pe(paramStr)].join("&");
  const expected = crypto.createHmac("sha1", `${pe(CS)}&${pe(AS)}`).update(baseStr).digest("base64");
  return sig === expected;
}

function makeWorld(s) {
  return {
    listings: structuredClone(s.listings),
    products: structuredClone(s.products),
    orders: structuredClone(s.orders),
    log: [], badSig: 0, posts: [], first429: s.first429,
  };
}

function startServer(world) {
  let nextId = 9000;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const u = new URL(req.url, "http://x");
    const send = (code, data, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };

    if (u.pathname.startsWith("/discogs")) {
      const p = u.pathname.slice("/discogs".length);
      if (!verifyOAuth({ ...req, url: req.url.slice("/discogs".length), method: req.method, headers: req.headers }, `http://127.0.0.1:${server.address().port}/discogs`)) {
        world.badSig++;
        return send(401, { message: "bad signature" });
      }
      let m;
      if ((m = p.match(/^\/users\/[^/]+\/inventory$/))) {
        if (world.first429) { world.first429 = false; return send(429, { message: "slow down" }, { "retry-after": "1" }); }
        const status = u.searchParams.get("status");
        const page = Number(u.searchParams.get("page"));
        const items = world.listings.filter((l) => !status || l.status === status);
        const per = 2; // small pages to exercise pagination
        const pages = Math.max(1, Math.ceil(items.length / per));
        return send(200, { pagination: { page, pages }, listings: items.slice((page - 1) * per, page * per) });
      }
      if ((m = p.match(/^\/marketplace\/listings\/(\d+)$/))) {
        const l = world.listings.find((x) => String(x.id) === m[1]);
        if (!l) return send(404, { message: "not found" });
        if (req.method === "GET") return send(200, l);
        const b = JSON.parse(body);
        world.posts.push({ id: l.id, body: b });
        l.status = b.status;
        world.log.push(`draft ${l.id}`);
        return res.writeHead(204).end();
      }
      if ((m = p.match(/^\/releases\/(\d+)$/))) return send(200, { images: [{ uri: "http://img/x.jpg" }] });
      return send(404, {});
    }

    // Shopify
    const p = u.pathname.replace(/^\/shopify/, "");
    if (p === "/orders.json") {
      if (!u.searchParams.get("created_at_min") || u.searchParams.get("status") !== "any") return send(400, {});
      return send(200, { orders: world.orders });
    }
    if (p === "/products.json" && req.method === "GET") {
      const per = 2;
      const pi = Number(u.searchParams.get("page_info") || 0);
      const slice = world.products.slice(pi * per, pi * per + per);
      const headers = {};
      if ((pi + 1) * per < world.products.length) {
        headers.link = `<http://127.0.0.1/admin/products.json?limit=250&page_info=${pi + 1}>; rel="next"`;
      }
      return send(200, { products: slice }, headers);
    }
    if (p === "/products.json" && req.method === "POST") {
      const prod = JSON.parse(body).product;
      prod.id = nextId++;
      world.products.push(prod);
      world.log.push(`create ${prod.variants[0].sku}`);
      return send(201, { product: prod });
    }
    let m;
    if ((m = p.match(/^\/products\/(\d+)\.json$/)) && req.method === "DELETE") {
      const i = world.products.findIndex((x) => String(x.id) === m[1]);
      world.log.push(`delete ${world.products[i].variants[0].sku}`);
      world.products.splice(i, 1);
      return send(200, {});
    }
    if (p === "/custom_collections.json") return send(200, { custom_collections: [{ id: 1, title: u.searchParams.get("title") }] });
    if (p === "/collects.json") return send(201, { collect: { id: 1 } });
    return send(404, {});
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const L = (id, status, extra = {}) => ({
  id, status, condition: "Very Good Plus (VG+)", sleeve_condition: "Very Good (VG)",
  comments: `notes ${id}`, allow_offers: true, location: "Bin A", weight: 230, format_quantity: 1,
  price: { value: 25, currency: "USD" },
  release: { id: id * 10, artist: `Artist ${id}`, title: `Title ${id}`, format: id === 103 ? "CD, Album" : "LP", cover_image: id === 102 ? "" : "http://img/c.jpg" },
  ...extra,
});
const P = (id, sku) => ({ id, title: `Product ${sku}`, variants: [{ id: id * 10, sku }] });

const base = {
  listings: [L(101, "For Sale"), L(102, "For Sale"), L(103, "For Sale"), L(104, "Sold"), L(105, "For Sale"), L(106, "Draft")],
  products: [P(1, "101"), P(4, "104"), P(5, "105"), P(6, "106"), P(7, "TSHIRT"), P(8, "")],
  orders: [
    { id: 1, name: "#1001", cancelled_at: null, line_items: [{ sku: "105" }, { sku: "TSHIRT" }] },
    { id: 2, name: "#1002", cancelled_at: "2026-10-01T00:00:00Z", line_items: [{ sku: "101" }] },
  ],
};

async function run(name, scenario, env = {}) {
  const world = makeWorld(scenario);
  const server = await startServer(world);
  const port = server.address().port;
  const r = await new Promise((resolve) => {
    const c = spawn("node", ["sync.js"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      DISCOGS_CONSUMER_KEY: CK, DISCOGS_CONSUMER_SECRET: CS, DISCOGS_ACCESS_TOKEN: AT, DISCOGS_ACCESS_SECRET: AS,
      DISCOGS_USER: "barnhouse vinyl", SHOPIFY_STORE: "x.myshopify.com", SHOPIFY_TOKEN: "t",
      DISCOGS_API_BASE: `http://127.0.0.1:${port}/discogs`,
      SHOPIFY_API_BASE: `http://127.0.0.1:${port}/shopify`,
      ...env,
    },
    });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: "" }));
  });
  server.close();
  return { name, code: r.status, out: r.stdout + r.stderr, world };
}

const results = [];
const check = (name, cond, detail = "") => { results.push([name, !!cond]); console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : "  " + detail}`); };

// A: normal run (with a 429 on first inventory call)
{
  const r = await run("normal", { ...base, first429: true });
  const log = r.world.log.join(", ");
  check("A exits 0", r.code === 0, r.out);
  check("A all Discogs requests correctly signed", r.world.badSig === 0, `bad=${r.world.badSig}`);
  check("A retried after 429", /retrying/.test(r.out));
  check("A drafted 105 on Discogs", log.includes("draft 105"), log);
  check("A did not draft cancelled-order 101", !log.includes("draft 101"), log);
  const post = r.world.posts.find((x) => x.id === 105)?.body || {};
  check("A draft kept all listing fields", post.status === "Draft" && post.release_id === 1050 && post.price === 25 &&
    post.condition && post.sleeve_condition && post.comments === "notes 105" && post.location === "Bin A" && post.allow_offers === true, JSON.stringify(post));
  check("A created 102 and 103", log.includes("create 102") && log.includes("create 103"), log);
  check("A did not recreate 101", !log.includes("create 101"), log);
  check("A deleted 104 (sold on Discogs), 105 (sold on Shopify), 106 (draft)", ["104", "105", "106"].every((s) => log.includes(`delete ${s}`)), log);
  check("A kept 101 and non-Discogs products", !log.includes("delete 101") && !/delete (TSHIRT|$)/.test(log) && r.world.products.some((p) => p.variants[0].sku === "TSHIRT"), log);
  const cd = r.world.products.find((p) => p.variants[0].sku === "103");
  check("A CD weight 0.5lb", cd?.variants[0].weight === 0.5 && cd?.product_type === "CD");
  const second = await run("idempotent", { ...base, listings: r.world.listings, products: r.world.products, orders: base.orders });
  check("A second run changes nothing", second.code === 0 && second.world.log.length === 0, second.world.log.join(", ") + second.out);
}

// B: double sale
{
  const r = await run("double", { ...base, orders: [{ id: 3, name: "#1003", cancelled_at: null, line_items: [{ sku: "104" }] }] });
  check("B double sale flagged and run fails", r.code === 1 && /DOUBLE SALE/.test(r.out), r.out);
}

// C: Discogs returns nothing for sale
{
  const r = await run("empty", { ...base, listings: base.listings.map((l) => ({ ...l, status: "Sold" })), orders: [] });
  check("C empty inventory: nothing deleted, run fails", r.code === 1 && !r.world.log.some((x) => x.startsWith("delete")), r.world.log.join(", "));
}

// D: mass deletion guard
{
  const many = Array.from({ length: 40 }, (_, i) => L(200 + i, "For Sale"));
  const prods = many.map((l, i) => P(100 + i, String(l.id)));
  const listings = many.map((l, i) => (i < 15 ? { ...l, status: "Sold" } : l));
  const r = await run("mass", { listings, products: prods, orders: [] });
  check("D guard blocks 15 of 40 deletions", r.code === 1 && !r.world.log.some((x) => x.startsWith("delete")) && /Safety check/.test(r.out), r.out);
  const r2 = await run("mass-allowed", { listings, products: prods, orders: [] }, { ALLOW_MASS_DELETE: "true" });
  check("D allow_mass_delete lets it through", r2.code === 0 && r2.world.log.filter((x) => x.startsWith("delete")).length === 15);
}

// E: dry run changes nothing
{
  const r = await run("dry", base, { DRY_RUN: "true" });
  check("E dry run makes no changes", r.code === 0 && r.world.log.length === 0 && /would create/.test(r.out), r.world.log.join(", "));
}

// F: missing secrets
{
  const r = spawnSync("node", ["sync.js"], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH } });
  check("F missing settings fails clearly", r.status === 1 && /Missing settings/.test(r.stdout));
}

const failed = results.filter((x) => !x[1]).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
