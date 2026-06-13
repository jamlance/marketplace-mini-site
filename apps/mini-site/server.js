/**
 * Mini-site — a real storefront for an Inkress merchant.
 *
 * Responsibilities:
 *   • Merchant editor API (site config, block sections, products, catalog import, custom domains, image upload)
 *   • Public storefront render (block-based) + single-product hosted checkout
 *   • Custom-domain serving (Host-matched) + paid-order webhook
 *
 * All API errors return a structured body: { error, message, field? } so the client
 * can surface them inline. The storefront/checkout/webhook paths are intentionally
 * conservative — they're the money + customer-facing surfaces.
 */
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi, createInkressOrder } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { openMerchantTokens } from "@inkress/apps-core/merchant-tokens";
import { putObject, storageConfigured, decodeDataUrl, isAllowedImage } from "@inkress/apps-core/storage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const WEBHOOK_SECRET = process.env.INKRESS_WEBHOOK_SECRET || "";
const CUSTOM_DOMAIN_TARGET = process.env.CUSTOM_DOMAIN_TARGET || "89.167.13.203";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[mini-site] Missing env: ${k}`); process.exit(1); }
}

// ---- schema (idempotent; survives redeploys + a legacy same-named schema) ---
const db = await openPg("mini-site", `
  CREATE TABLE IF NOT EXISTS site (
    merchant_id BIGINT PRIMARY KEY,
    handle TEXT, published BOOLEAN NOT NULL DEFAULT false,
    business_name TEXT, tagline TEXT, about TEXT,
    accent TEXT NOT NULL DEFAULT '#3b5bdb', theme TEXT NOT NULL DEFAULT 'fresh',
    logo TEXT, hero_image TEXT,
    cta_label TEXT NOT NULL DEFAULT 'Shop now', cta_target TEXT NOT NULL DEFAULT 'products',
    phone TEXT, email TEXT, address TEXT,
    links JSONB NOT NULL DEFAULT '[]', sections JSONB NOT NULL DEFAULT '[]',
    show_products BOOLEAN NOT NULL DEFAULT true, show_social_proof BOOLEAN NOT NULL DEFAULT true,
    currency TEXT NOT NULL DEFAULT 'JMD', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE site ADD COLUMN IF NOT EXISTS handle TEXT;
  ALTER TABLE site ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE site ADD COLUMN IF NOT EXISTS business_name TEXT;
  ALTER TABLE site ADD COLUMN IF NOT EXISTS tagline TEXT;
  ALTER TABLE site ADD COLUMN IF NOT EXISTS about TEXT;
  ALTER TABLE site ADD COLUMN IF NOT EXISTS accent TEXT NOT NULL DEFAULT '#3b5bdb';
  ALTER TABLE site ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'fresh';
  ALTER TABLE site ADD COLUMN IF NOT EXISTS logo TEXT;
  ALTER TABLE site ADD COLUMN IF NOT EXISTS hero_image TEXT;
  ALTER TABLE site ADD COLUMN IF NOT EXISTS cta_label TEXT NOT NULL DEFAULT 'Shop now';
  ALTER TABLE site ADD COLUMN IF NOT EXISTS cta_target TEXT NOT NULL DEFAULT 'products';
  ALTER TABLE site ADD COLUMN IF NOT EXISTS phone TEXT;
  ALTER TABLE site ADD COLUMN IF NOT EXISTS email TEXT;
  ALTER TABLE site ADD COLUMN IF NOT EXISTS address TEXT;
  ALTER TABLE site ADD COLUMN IF NOT EXISTS links JSONB NOT NULL DEFAULT '[]';
  ALTER TABLE site ADD COLUMN IF NOT EXISTS sections JSONB NOT NULL DEFAULT '[]';
  ALTER TABLE site ADD COLUMN IF NOT EXISTS show_products BOOLEAN NOT NULL DEFAULT true;
  ALTER TABLE site ADD COLUMN IF NOT EXISTS show_social_proof BOOLEAN NOT NULL DEFAULT true;
  ALTER TABLE site ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'JMD';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ms_handle ON site (handle) WHERE handle IS NOT NULL;
  CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL,
    name TEXT NOT NULL, description TEXT, price NUMERIC NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'JMD',
    image_url TEXT, product_id TEXT, sort INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE products ADD COLUMN IF NOT EXISTS product_id TEXT;
  ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
  ALTER TABLE products ADD COLUMN IF NOT EXISTS sort INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE products ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
  CREATE INDEX IF NOT EXISTS idx_ms_products ON products (merchant_id, sort, id);
  CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, ref TEXT, product_name TEXT,
    customer_name TEXT, customer_email TEXT, total NUMERIC, currency TEXT,
    inkress_order_id TEXT, payment_url TEXT, state TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS custom_domains (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL,
    domain TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (domain)
  );
  CREATE TABLE IF NOT EXISTS webhook_subs (merchant_id BIGINT PRIMARY KEY, url TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS webhook_seen (webhook_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
`);

// ---- helpers ---------------------------------------------------------------
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const arr = (v) => (Array.isArray(v) ? v : []);
const PUBLIC_BASE = (req) => process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
const PUBLIC_BASE_S = () => process.env.PUBLIC_BASE_URL || "";
const slugify = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const newId = () => crypto.randomBytes(4).toString("hex");
const isDomain = (d) => /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i.test(d) && String(d).length <= 253;
// Accept full URLs as-is and scheme-less domains/paths (prepend https://); reject junk.
function cleanUrl(u) {
  const s = String(u || "").trim();
  if (!s || /\s/.test(s)) return null;
  if (/^https?:\/\//i.test(s)) return s.slice(0, 600);
  if (/^[a-z0-9]([a-z0-9-]*\.)+[a-z]{2,}(\/.*)?$/i.test(s)) return ("https://" + s).slice(0, 600);
  return null;
}
// Structured API error.
const fail = (res, status, error, message, field) => res.status(status).json({ error, message, ...(field ? { field } : {}) });

const THEMES = {
  fresh: { grad: "linear-gradient(135deg,#3b5bdb,#5c7cfa)", accent: "#3b5bdb" },
  sunset: { grad: "linear-gradient(135deg,#ff6b6b,#feca57)", accent: "#ff6b6b" },
  forest: { grad: "linear-gradient(135deg,#0f5132,#2f9e44)", accent: "#2f9e44" },
  mono: { grad: "linear-gradient(135deg,#1a1a2e,#3a3a5e)", accent: "#1a1a2e" },
  rose: { grad: "linear-gradient(135deg,#d6336c,#f783ac)", accent: "#d6336c" },
};
const BLOCK_TYPES = ["hero", "products", "text", "gallery", "links", "contact", "hours", "testimonials"];

function defaultSections(s) {
  const out = [{ id: newId(), type: "hero", data: {} }, { id: newId(), type: "products", data: { heading: "Shop" } }];
  if (s.about) out.push({ id: newId(), type: "text", data: { heading: "About", body: s.about } });
  if (arr(s.links).length) out.push({ id: newId(), type: "links", data: { heading: "Find us", links: arr(s.links) } });
  if (s.phone || s.email || s.address) out.push({ id: newId(), type: "contact", data: { heading: "Contact", phone: s.phone, email: s.email, address: s.address } });
  return out;
}
function sanitizeSections(input) {
  const cap = (v, n) => String(v || "").slice(0, n);
  return arr(input).slice(0, 30).map((b) => {
    if (!BLOCK_TYPES.includes(b?.type)) return null;
    const d = b.data || {}; let data = {};
    if (b.type === "hero") data = { title: cap(d.title, 80), subtitle: cap(d.subtitle, 160), image: cleanUrl(d.image), cta_label: cap(d.cta_label, 30), cta_target: ["products", "contact", "link"].includes(d.cta_target) ? d.cta_target : "products" };
    else if (b.type === "products") data = { heading: cap(d.heading, 60) || "Shop" };
    else if (b.type === "text") data = { heading: cap(d.heading, 60), body: cap(d.body, 2000) };
    else if (b.type === "gallery") data = { heading: cap(d.heading, 60), images: arr(d.images).map(cleanUrl).filter(Boolean).slice(0, 12) };
    else if (b.type === "links") data = { heading: cap(d.heading, 60), links: arr(d.links).map((l) => ({ label: cap(l.label, 40), url: cleanUrl(l.url) })).filter((l) => l.label && l.url).slice(0, 12) };
    else if (b.type === "contact") data = { heading: cap(d.heading, 60), phone: cap(d.phone, 40), email: cap(d.email, 120), address: cap(d.address, 200) };
    else if (b.type === "hours") data = { heading: cap(d.heading, 60), rows: arr(d.rows).map((r) => ({ label: cap(r.label, 40), value: cap(r.value, 40) })).filter((r) => r.label).slice(0, 14) };
    else if (b.type === "testimonials") data = { heading: cap(d.heading, 60), items: arr(d.items).map((i) => ({ quote: cap(i.quote, 300), author: cap(i.author, 60) })).filter((i) => i.quote).slice(0, 10) };
    return { id: b.id && /^[a-z0-9]{1,16}$/i.test(b.id) ? b.id : newId(), type: b.type, data };
  }).filter(Boolean);
}
async function uniqueHandle(base, mid) {
  base = base || "shop";
  for (let i = 0; i < 50; i++) {
    const cand = i === 0 ? base : `${base}-${i}`;
    const ex = await db.one(`SELECT merchant_id FROM site WHERE handle=$1`, [cand]);
    if (!ex || (mid && ex.merchant_id === mid)) return cand;
  }
  return `${base}-${crypto.randomBytes(2).toString("hex")}`;
}
async function getSite(mid, merchant) {
  let s = await db.one(`SELECT * FROM site WHERE merchant_id=$1`, [mid]);
  if (!s) {
    const name = merchant?.name || merchant?.username || "My shop";
    const handle = await uniqueHandle(slugify(name) || `shop-${mid}`);
    s = await db.one(`INSERT INTO site (merchant_id, handle, business_name, tagline, about, logo, currency, cta_label)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'Shop now') ON CONFLICT (merchant_id) DO UPDATE SET merchant_id=EXCLUDED.merchant_id RETURNING *`,
      [mid, handle, name, "Quality you can count on.", `Welcome to ${name}.`, merchant?.logo || merchant?.logo_url || null, merchant?.currency_code || "JMD"]);
  }
  if (!arr(s.sections).length) s = await db.one(`UPDATE site SET sections=$2 WHERE merchant_id=$1 RETURNING *`, [mid, JSON.stringify(defaultSections(s))]);
  return s;
}
const serializeSite = (s, req) => ({
  handle: s.handle, published: s.published, business_name: s.business_name, tagline: s.tagline, about: s.about,
  accent: s.accent, theme: s.theme, logo: s.logo, hero_image: s.hero_image, cta_label: s.cta_label, cta_target: s.cta_target,
  phone: s.phone, email: s.email, address: s.address, links: arr(s.links), show_products: s.show_products, show_social_proof: s.show_social_proof,
  currency: s.currency, sections: arr(s.sections), public_url: `${PUBLIC_BASE(req)}/s/${s.handle}`,
});
const serializeProduct = (p) => ({ id: p.id, name: p.name, description: p.description, price: Number(p.price), currency: p.currency, image_url: p.image_url, product_id: p.product_id, active: p.active, sort: p.sort });

// ---- app + pre-mount middleware --------------------------------------------
const app = express();
app.use("/webhooks/inkress", express.raw({ type: () => true, limit: "1mb" }));
// Image uploads are large base64 data URLs; give /api/upload its own big limit BEFORE
// mountAppCore's global 256kb json parser (which would otherwise 413 the request).
app.use("/api/upload", express.json({ limit: "12mb" }));

const APP_HOSTS = /(\.apps\.inkress\.com|\.webapps\.host|localhost|127\.0\.0\.1)$/i;
// Serve the merchant's published storefront when the request Host is their active custom domain.
// Must run before mountAppCore's static/SPA handler. API + webhook paths fall through.
app.use(async (req, res, next) => {
  const host = String(req.hostname || "").toLowerCase();
  if (!host || APP_HOSTS.test(host)) return next();
  if (req.path.startsWith("/api/") || req.path.startsWith("/webhooks/") || req.method !== "GET") return next();
  try {
    const cd = await db.one(`SELECT merchant_id FROM custom_domains WHERE domain=$1 AND status='active'`, [host]);
    if (!cd) return next();
    const s = await db.one(`SELECT * FROM site WHERE merchant_id=$1 AND published=true`, [cd.merchant_id]);
    if (!s) return next();
    const products = await db.q(`SELECT * FROM products WHERE merchant_id=$1 AND active=true ORDER BY sort, id`, [cd.merchant_id]);
    const stats = await db.one(`SELECT COUNT(*)::int orders FROM orders WHERE merchant_id=$1 AND state='paid'`, [cd.merchant_id]).catch(() => ({ orders: 0 }));
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(storefront(s, products.map(serializeProduct), stats));
  } catch { return next(); }
});

const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
  onBootstrap: (entry) => { tokens.save(entry.merchantId, entry.refreshToken).catch(() => {}); },
});
const tokens = await openMerchantTokens("mini_site", core.cfg);

// ---- merchant API: site config ---------------------------------------------
app.get("/api/site", core.requireSession, async (req, res) => {
  const s = await getSite(req.session.merchantId, req.session.data?.merchant);
  const stats = await db.one(`SELECT COUNT(*)::int orders, COALESCE(SUM(total),0) revenue FROM orders WHERE merchant_id=$1 AND state='paid'`, [req.session.merchantId]);
  res.json({ site: serializeSite(s, req), themes: Object.keys(THEMES),
    products_scope: (req.session.scope || []).includes("products:read"), can_sell: (req.session.scope || []).includes("orders:write"),
    storage: storageConfigured(), webhook_realtime: Boolean(WEBHOOK_SECRET),
    stats: { paid_orders: stats.orders, revenue: round2(stats.revenue) } });
});
app.patch("/api/site", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId; const b = req.body || {};
  const s = await getSite(mid, req.session.data?.merchant);
  if (b.business_name !== undefined && !String(b.business_name).trim()) return fail(res, 400, "invalid", "Business name can’t be empty.", "business_name");
  let handle = s.handle;
  if (b.handle !== undefined) { const want = slugify(b.handle); if (!want) return fail(res, 400, "invalid", "Handle must contain letters or numbers.", "handle"); if (want !== s.handle) handle = await uniqueHandle(want, mid); }
  const str = (v, max, dflt) => (v !== undefined ? String(v || "").slice(0, max) || null : dflt);
  const links = b.links !== undefined ? arr(b.links).map((l) => ({ label: String(l.label || "").slice(0, 40), url: cleanUrl(l.url) })).filter((l) => l.label && l.url).slice(0, 12) : arr(s.links);
  const u = await db.one(`UPDATE site SET handle=$2, business_name=$3, tagline=$4, about=$5, accent=$6, theme=$7, logo=$8, hero_image=$9,
      cta_label=$10, cta_target=$11, phone=$12, email=$13, address=$14, links=$15, show_products=$16, show_social_proof=$17 WHERE merchant_id=$1 RETURNING *`,
    [mid, handle, str(b.business_name, 80, s.business_name), str(b.tagline, 140, s.tagline), str(b.about, 1200, s.about),
     /^#[0-9a-fA-F]{6}$/.test(b.accent) ? b.accent : s.accent, THEMES[b.theme] ? b.theme : s.theme,
     b.logo !== undefined ? cleanUrl(b.logo) : s.logo, b.hero_image !== undefined ? cleanUrl(b.hero_image) : s.hero_image,
     str(b.cta_label, 30, s.cta_label) || "Shop now", ["products", "link", "contact"].includes(b.cta_target) ? b.cta_target : s.cta_target,
     str(b.phone, 40, s.phone), str(b.email, 120, s.email), str(b.address, 200, s.address),
     JSON.stringify(links), b.show_products !== undefined ? !!b.show_products : s.show_products, b.show_social_proof !== undefined ? !!b.show_social_proof : s.show_social_proof]);
  res.json({ site: serializeSite(u, req) });
});
app.patch("/api/sections", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId; await getSite(mid, req.session.data?.merchant);
  const u = await db.one(`UPDATE site SET sections=$2 WHERE merchant_id=$1 RETURNING *`, [mid, JSON.stringify(sanitizeSections(req.body?.sections))]);
  res.json({ site: serializeSite(u, req) });
});
app.get("/api/preview", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId; const s = await getSite(mid, req.session.data?.merchant);
  const products = await db.q(`SELECT * FROM products WHERE merchant_id=$1 AND active=true ORDER BY sort, id`, [mid]);
  const stats = await db.one(`SELECT COUNT(*)::int orders FROM orders WHERE merchant_id=$1 AND state='paid'`, [mid]).catch(() => ({ orders: 0 }));
  res.json({ html: storefront(s, products.map(serializeProduct), stats, true) });
});
app.post("/api/publish", core.requireSession, async (req, res) => {
  const u = await db.one(`UPDATE site SET published=$2 WHERE merchant_id=$1 RETURNING *`, [req.session.merchantId, !!req.body?.published]);
  res.json({ site: serializeSite(u, req) });
});
app.get("/api/handle-check", core.requireSession, async (req, res) => {
  const want = slugify(req.query.handle); if (!want) return res.json({ ok: false, reason: "empty" });
  const ex = await db.one(`SELECT merchant_id FROM site WHERE handle=$1`, [want]);
  res.json({ ok: !ex || ex.merchant_id === req.session.merchantId, handle: want });
});

// ---- custom domains --------------------------------------------------------
app.get("/api/domains", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT id, domain, status, created_at FROM custom_domains WHERE merchant_id=$1 ORDER BY id DESC`, [req.session.merchantId]);
  res.json({ domains: rows, target: CUSTOM_DOMAIN_TARGET });
});
app.post("/api/domains", core.requireSession, async (req, res) => {
  const domain = String(req.body?.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!domain) return fail(res, 400, "required", "Enter a domain.", "domain");
  if (!isDomain(domain)) return fail(res, 400, "bad_domain", "Enter a valid domain like shop.yourbrand.com.", "domain");
  if (APP_HOSTS.test(domain)) return fail(res, 400, "reserved", "That domain can’t be used.", "domain");
  const taken = await db.one(`SELECT merchant_id FROM custom_domains WHERE domain=$1`, [domain]);
  if (taken && taken.merchant_id !== req.session.merchantId) return fail(res, 409, "taken", "That domain is already connected to another shop.", "domain");
  const row = await db.one(`INSERT INTO custom_domains (merchant_id, domain) VALUES ($1,$2) ON CONFLICT (domain) DO UPDATE SET merchant_id=EXCLUDED.merchant_id RETURNING id, domain, status, created_at`, [req.session.merchantId, domain]);
  res.status(201).json({ domain: row, target: CUSTOM_DOMAIN_TARGET,
    instructions: { a_record: { host: domain, type: "A", value: CUSTOM_DOMAIN_TARGET }, note: "Add this A record at your DNS provider, then we issue a certificate and your storefront goes live on it (usually within minutes)." } });
});
app.delete("/api/domains/:id", core.requireSession, async (req, res) => { await db.run(`DELETE FROM custom_domains WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]); res.json({ ok: true }); });
// Privileged provisioning hook (operator flips active after wiring cert + routing).
app.post("/api/admin/domain", express.json(), async (req, res) => {
  if (!process.env.ADMIN_SECRET || req.get("x-admin-secret") !== process.env.ADMIN_SECRET) return fail(res, 403, "forbidden", "Forbidden.");
  const domain = String(req.body?.domain || "").trim().toLowerCase();
  const status = ["pending", "active"].includes(req.body?.status) ? req.body.status : "active";
  let r;
  if (req.body?.merchant_id) r = await db.one(`INSERT INTO custom_domains (merchant_id, domain, status) VALUES ($1,$2,$3) ON CONFLICT (domain) DO UPDATE SET status=$3, merchant_id=$1 RETURNING id, merchant_id, domain, status`, [Number(req.body.merchant_id), domain, status]);
  else r = await db.one(`UPDATE custom_domains SET status=$2 WHERE domain=$1 RETURNING id, merchant_id, domain, status`, [domain, status]);
  if (!r) return fail(res, 404, "not_found", "Domain not found.");
  res.json({ domain: r });
});

// ---- products: app-managed + catalog import --------------------------------
app.get("/api/products", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT * FROM products WHERE merchant_id=$1 ORDER BY sort, id`, [req.session.merchantId]);
  res.json({ products: rows.map(serializeProduct) });
});
function validateProduct(b) {
  if (!String(b.name || "").trim()) return { field: "name", message: "Product name is required." };
  const price = Number(b.price);
  if (b.price === "" || b.price == null || !Number.isFinite(price)) return { field: "price", message: "Enter a price." };
  if (price < 0) return { field: "price", message: "Price can’t be negative." };
  return null;
}
app.post("/api/products", core.requireSession, async (req, res) => {
  const b = req.body || {}; const v = validateProduct(b); if (v) return fail(res, 400, "invalid", v.message, v.field);
  const mid = req.session.merchantId; const cur = req.session.data?.merchant?.currency_code || "JMD";
  const row = await db.one(`INSERT INTO products (merchant_id, name, description, price, currency, image_url, product_id, sort)
      VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE((SELECT MAX(sort)+1 FROM products WHERE merchant_id=$1),0)) RETURNING *`,
    [mid, String(b.name).slice(0, 100), String(b.description || "").slice(0, 500) || null, round2(b.price), cur, cleanUrl(b.image_url), b.product_id ? String(b.product_id) : null]);
  res.status(201).json({ product: serializeProduct(row) });
});
app.patch("/api/products/:id", core.requireSession, async (req, res) => {
  const b = req.body || {}; const p = await db.one(`SELECT * FROM products WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!p) return fail(res, 404, "not_found", "Product not found.");
  if (b.name !== undefined && !String(b.name).trim()) return fail(res, 400, "invalid", "Product name is required.", "name");
  if (b.price !== undefined) { const pr = Number(b.price); if (!Number.isFinite(pr) || pr < 0) return fail(res, 400, "invalid", "Enter a valid price.", "price"); }
  const u = await db.one(`UPDATE products SET name=$2, description=$3, price=$4, image_url=$5, active=$6 WHERE id=$1 RETURNING *`,
    [p.id, b.name !== undefined ? String(b.name).slice(0, 100) : p.name, b.description !== undefined ? (String(b.description || "").slice(0, 500) || null) : p.description,
     b.price !== undefined ? round2(b.price) : p.price, b.image_url !== undefined ? cleanUrl(b.image_url) : p.image_url, b.active !== undefined ? !!b.active : p.active]);
  res.json({ product: serializeProduct(u) });
});
app.delete("/api/products/:id", core.requireSession, async (req, res) => { await db.run(`DELETE FROM products WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]); res.json({ ok: true }); });

app.get("/api/catalog", core.requireSession, async (req, res) => {
  if (!(req.session.scope || []).includes("products:read")) return res.json({ products: [], unavailable: true });
  const q = String(req.query.q || "").trim();
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, `products?limit=40&order=id desc${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const products = (r?.result?.entries || []).map((p) => { const cur = p.currency || {}; const raw = Number(p.price ?? 0); return { id: String(p.id), title: p.title || p.name || `Product ${p.id}`, description: p.description || null, price: cur.is_float === true ? raw / 100 : raw, image: p.image_url || p.image || null, currency: cur.code || req.session.data?.merchant?.currency_code || "JMD" }; });
    res.json({ products });
  } catch (err) { return fail(res, 502, "catalog_failed", err?.message || "Couldn’t load your catalog."); }
});
app.post("/api/import", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId; const picks = arr(req.body?.products).slice(0, 100); let added = 0;
  for (const p of picks) {
    const exists = p.id ? await db.one(`SELECT 1 FROM products WHERE merchant_id=$1 AND product_id=$2`, [mid, String(p.id)]) : null;
    if (exists) continue;
    await db.run(`INSERT INTO products (merchant_id, name, description, price, currency, image_url, product_id, sort)
        VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE((SELECT MAX(sort)+1 FROM products WHERE merchant_id=$1),0))`,
      [mid, String(p.title || "Product").slice(0, 100), String(p.description || "").slice(0, 500) || null, round2(p.price), p.currency || "JMD", cleanUrl(p.image), p.id ? String(p.id) : null]);
    added++;
  }
  res.json({ added });
});

// ---- image upload (S3) -----------------------------------------------------
app.post("/api/upload", core.requireSession, async (req, res) => {
  if (!storageConfigured()) return fail(res, 503, "storage_off", "Image hosting isn’t set up on this deployment — paste an image URL instead.");
  const decoded = decodeDataUrl(req.body?.data);
  if (!decoded || !isAllowedImage(decoded.contentType)) return fail(res, 400, "bad_image", "Upload a JPG, PNG, WEBP, GIF or SVG image.");
  if (decoded.body.length > 5 * 1024 * 1024) return fail(res, 400, "too_big", "Image must be under 5 MB.");
  try { const { url } = await putObject({ prefix: `mini-site/${req.session.merchantId}`, body: decoded.body, contentType: decoded.contentType }); res.json({ url }); }
  catch (err) { return fail(res, 502, "upload_failed", err?.message || "Upload failed — try again."); }
});

// ---- webhook self-registration + status ------------------------------------
app.get("/api/status", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId; let sub = await db.one(`SELECT * FROM webhook_subs WHERE merchant_id=$1`, [mid]);
  const canRegister = WEBHOOK_SECRET && (req.session.scope || []).includes("webhooks:manage");
  if (!sub && canRegister) {
    const url = `${PUBLIC_BASE(req)}/webhooks/inkress/${mid}`;
    try { await inkressApi(core.cfg, req.session.accessToken, `webhook_urls`, { method: "POST", body: JSON.stringify({ url, event: "orders" }) }); await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET url=$2`, [mid, url]); sub = { merchant_id: mid }; }
    catch (err) { if (String(err?.message || "").match(/already|unique|exist|422/i)) { await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO NOTHING`, [mid, url]); sub = { merchant_id: mid }; } }
  }
  res.json({ realtime: Boolean(sub) && Boolean(WEBHOOK_SECRET), webhook_registered: Boolean(sub) });
});

// ---- public storefront + checkout ------------------------------------------
const siteByHandle = (handle) => db.one(`SELECT * FROM site WHERE handle=$1 AND published=true`, [handle]).catch(() => null);
app.get("/s/:handle", async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const s = await siteByHandle(req.params.handle);
  if (!s) return res.status(404).send(shellLite("Not published", `<div style="padding:40px;text-align:center"><h1>This site isn’t published yet.</h1></div>`));
  const products = await db.q(`SELECT * FROM products WHERE merchant_id=$1 AND active=true ORDER BY sort, id`, [s.merchant_id]);
  const stats = await db.one(`SELECT COUNT(*)::int orders FROM orders WHERE merchant_id=$1 AND state='paid'`, [s.merchant_id]).catch(() => ({ orders: 0 }));
  res.send(storefront(s, products.map(serializeProduct), stats));
});
app.post("/api/public/buy/:handle", express.json(), async (req, res) => {
  const s = await siteByHandle(req.params.handle);
  if (!s) return fail(res, 404, "closed", "This shop isn’t available right now.");
  const p = await db.one(`SELECT * FROM products WHERE id=$1 AND merchant_id=$2 AND active=true`, [req.body?.product_id, s.merchant_id]).catch(() => null);
  if (!p) return fail(res, 404, "no_product", "That product isn’t available.");
  const qty = Math.min(99, Math.max(1, Math.round(Number(req.body?.qty) || 1)));
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, "bad_email", "Enter a valid email.", "email");
  let accessToken; try { accessToken = await tokens.accessTokenFor(s.merchant_id); } catch { return fail(res, 503, "not_connected", "This shop hasn’t finished setup."); }
  const total = round2(Number(p.price) * qty);
  const ref = `ms-${s.merchant_id}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
  const nm = String(req.body?.name || "Customer").trim().split(/\s+/).filter(Boolean);
  let created;
  try {
    created = await createInkressOrder(core.cfg, accessToken, {
      referenceId: ref, total, currencyCode: p.currency, kind: "online", title: `${p.name}${qty > 1 ? ` ×${qty}` : ""} — ${s.business_name || "Shop"}`,
      customer: { email, first_name: nm[0] || "Customer", last_name: nm.slice(1).join(" ") || "" },
      metaData: { source: "mini-site", handle: s.handle, product: p.name, qty },
    });
  } catch (err) { return fail(res, 502, "order_failed", err?.message || "Couldn’t start checkout — try again."); }
  await db.run(`INSERT INTO orders (merchant_id, ref, product_name, customer_name, customer_email, total, currency, inkress_order_id, payment_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [s.merchant_id, ref, p.name, req.body?.name || null, email, total, p.currency, created.id != null ? String(created.id) : null, created.payment_url || null]);
  res.json({ payment_url: created.payment_url });
});

// ---- webhook: mark storefront orders paid ----------------------------------
app.post("/webhooks/inkress/:merchantId", async (req, res) => {
  const merchantId = Number(req.params.merchantId);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (WEBHOOK_SECRET) {
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
    const got = String(req.get("x-inkress-webhook-signature") || "");
    const a = Buffer.from(expected), b = Buffer.from(got);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "bad_signature" });
  }
  res.json({ received: true });
  try {
    const evt = JSON.parse(raw.toString("utf8"));
    const o = evt?.order || evt?.data?.order;
    if (!o || !merchantId || String(o.status || "").toLowerCase() !== "paid") return;
    const wid = String(req.get("x-inkress-webhook-id") || `${o.id}.${o.status}`);
    if (await db.one(`SELECT 1 FROM webhook_seen WHERE webhook_id=$1`, [wid])) return;
    await db.run(`INSERT INTO webhook_seen (webhook_id) VALUES ($1) ON CONFLICT DO NOTHING`, [wid]);
    await db.run(`UPDATE orders SET state='paid' WHERE merchant_id=$1 AND inkress_order_id=$2`, [merchantId, String(o.id)]);
  } catch (err) { console.error(`[mini-site] webhook failed: ${err?.message}`); }
});

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[mini-site] listening on ${HOST}:${PORT}`));

// ---- storefront HTML render (blocks) ---------------------------------------
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function money(n, c) { try { return new Intl.NumberFormat("en-JM", { style: "currency", currency: c }).format(n); } catch { return `${c} ${n}`; } }
function shellLite(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f7f9;color:#1f2430;display:grid;place-items:center;min-height:100vh}</style></head><body>${inner}</body></html>`;
}
function storefront(s, products, stats, preview = false) {
  const t = THEMES[s.theme] || THEMES.fresh; const accent = s.accent || t.accent;
  let sections = arr(s.sections); if (!sections.length) sections = defaultSections(s);
  const heroData = sections.find((b) => b.type === "hero")?.data || {};
  const productCard = (p) => `
    <div class="card">
      ${p.image_url ? `<div class="thumb" style="background-image:url('${esc(p.image_url)}')"></div>` : `<div class="thumb ph">${esc((p.name || "?").slice(0, 1))}</div>`}
      <div class="cbody"><div class="pname">${esc(p.name)}</div>
        ${p.description ? `<div class="pdesc">${esc(p.description)}</div>` : ""}
        <div class="prow"><span class="price">${esc(money(p.price, p.currency))}</span>
          <button class="buy" data-id="${p.id}" data-name="${esc(p.name)}" data-price="${p.price}" data-cur="${esc(p.currency)}">Order</button></div>
      </div></div>`;
  const phBlock = (heading, hint) => preview ? `<section class="wrap">${heading ? `<h2>${esc(heading)}</h2>` : ""}<p class="muted">${esc(hint)}</p></section>` : "";
  const renderBlock = (b) => {
    const d = b.data || {};
    switch (b.type) {
      case "hero": {
        const img = d.image || s.hero_image;
        const bg = img ? `background-image:linear-gradient(rgba(0,0,0,.42),rgba(0,0,0,.42)),url('${esc(img)}');background-size:cover;background-position:center` : `background:${t.grad}`;
        const logo = s.logo ? `<img class="logo" src="${esc(s.logo)}" alt="">` : "";
        const social = s.show_social_proof !== false && stats.orders > 0 ? `<div class="proof">★ ${stats.orders} order${stats.orders === 1 ? "" : "s"} fulfilled here</div>` : "";
        const ctaHref = d.cta_target === "contact" ? "#contact" : d.cta_target === "link" ? (arr(s.links)[0]?.url || "#products") : "#products";
        const title = d.title || s.business_name || "Shop"; const sub = d.subtitle || s.tagline || "";
        return `<header class="hero" style="${bg}">${logo}<h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ""}
          ${products.length ? `<a class="cta" href="${esc(ctaHref)}">${esc(d.cta_label || s.cta_label || "Shop now")}</a>` : ""}${social}</header>`;
      }
      case "products":
        return products.length ? `<section class="wrap" id="products"><h2>${esc(d.heading || "Shop")}</h2><div class="grid">${products.map(productCard).join("")}</div></section>` : phBlock(d.heading || "Shop", "Products you add will appear here.");
      case "text":
        return (d.heading || d.body) ? `<section class="wrap">${d.heading ? `<h2>${esc(d.heading)}</h2>` : ""}<div class="about">${esc(d.body || "")}</div></section>` : phBlock(d.heading, "Add a heading and text in the editor.");
      case "gallery":
        return arr(d.images).length ? `<section class="wrap">${d.heading ? `<h2>${esc(d.heading)}</h2>` : ""}<div class="gal">${arr(d.images).map((u) => `<div class="gphoto" style="background-image:url('${esc(u)}')"></div>`).join("")}</div></section>` : phBlock(d.heading, "Add images in the editor.");
      case "links":
        return arr(d.links).length ? `<section class="wrap">${d.heading ? `<h2>${esc(d.heading)}</h2>` : ""}<div class="links">${arr(d.links).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join("")}</div></section>` : phBlock(d.heading, "Add links in the editor.");
      case "contact":
        return (d.phone || d.email || d.address) ? `<section class="wrap" id="contact">${d.heading ? `<h2>${esc(d.heading)}</h2>` : ""}<div class="contact">${[d.phone, d.email, d.address].filter(Boolean).map(esc).join("<br>")}</div></section>` : phBlock(d.heading, "Add contact details in the editor.");
      case "hours":
        return arr(d.rows).length ? `<section class="wrap">${d.heading ? `<h2>${esc(d.heading)}</h2>` : ""}<table class="hours">${arr(d.rows).map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.value)}</td></tr>`).join("")}</table></section>` : phBlock(d.heading, "Add opening hours in the editor.");
      case "testimonials":
        return arr(d.items).length ? `<section class="wrap">${d.heading ? `<h2>${esc(d.heading)}</h2>` : ""}<div class="tg">${arr(d.items).map((i) => `<figure class="tcard"><blockquote>“${esc(i.quote)}”</blockquote>${i.author ? `<figcaption>— ${esc(i.author)}</figcaption>` : ""}</figure>`).join("")}</div></section>` : phBlock(d.heading, "Add customer quotes in the editor.");
      default: return "";
    }
  };
  const body = sections.map(renderBlock).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(s.business_name || "Shop")}</title>
  <meta property="og:title" content="${esc(heroData.title || s.business_name || "Shop")}"><meta property="og:description" content="${esc(heroData.subtitle || s.tagline || "")}">
  ${(heroData.image || s.hero_image) ? `<meta property="og:image" content="${esc(heroData.image || s.hero_image)}">` : ""}
  <style>
  :root{--accent:${accent}}
  *{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;color:#1d2330;background:#fff}
  a{color:var(--accent);text-decoration:none}.muted{color:#9aa3b2}
  .hero{color:#fff;padding:64px 20px 56px;text-align:center}
  .logo{width:84px;height:84px;border-radius:20px;object-fit:cover;margin:0 auto 16px;display:block;border:3px solid rgba(255,255,255,.5)}
  .hero h1{font-size:2.3rem;margin:0 0 8px;font-weight:800}.hero p{font-size:1.1rem;opacity:.95;margin:0 auto;max-width:560px}
  .cta{display:inline-block;margin-top:22px;background:#fff;color:var(--accent);padding:13px 28px;border-radius:11px;font-weight:700;font-size:1rem}
  .proof{margin-top:18px;font-size:.9rem;opacity:.92}
  .wrap{max-width:980px;margin:0 auto;padding:40px 20px}h2{font-size:1.4rem;margin:0 0 18px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:18px}
  .card{border:1px solid #ececf1;border-radius:16px;overflow:hidden;background:#fff;box-shadow:0 6px 20px rgba(20,25,40,.06);display:flex;flex-direction:column}
  .thumb{height:150px;background-size:cover;background-position:center;background-color:#f0f1f5}.thumb.ph{display:grid;place-items:center;font-size:2.4rem;font-weight:800;color:#c2c6d2}
  .cbody{padding:14px;display:flex;flex-direction:column;gap:6px;flex:1}.pname{font-weight:700}.pdesc{color:#6b7280;font-size:.85rem;flex:1}
  .prow{display:flex;align-items:center;justify-content:space-between;margin-top:8px}.price{font-weight:800}
  .buy{background:var(--accent);color:#fff;border:0;border-radius:9px;padding:9px 16px;font-weight:700;cursor:pointer}
  .about{color:#46505f;line-height:1.6;white-space:pre-line}
  .links{display:flex;flex-wrap:wrap;gap:10px}.links a{border:1px solid #e3e5ea;padding:9px 16px;border-radius:10px;color:#46505f}
  .contact{color:#46505f;line-height:1.9}
  .gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.gphoto{aspect-ratio:1;background-size:cover;background-position:center;border-radius:12px;background-color:#f0f1f5}
  .hours{border-collapse:collapse;color:#46505f}.hours td{padding:6px 24px 6px 0}.hours td:first-child{font-weight:600}
  .tg{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}.tcard{margin:0;border:1px solid #ececf1;border-radius:14px;padding:18px;background:#fafbfc}.tcard blockquote{margin:0;color:#46505f;line-height:1.5}.tcard figcaption{margin-top:10px;font-weight:600;font-size:.85rem}
  .foot{text-align:center;color:#aab;font-size:.8rem;padding:26px}
  .modal{position:fixed;inset:0;background:rgba(15,20,35,.5);display:none;place-items:center;padding:20px;z-index:9}.modal.on{display:grid}
  .sheet{background:#fff;border-radius:16px;max-width:380px;width:100%;padding:22px}
  .sheet h3{margin:0 0 4px}.sheet label{display:block;font-size:.72rem;color:#6b7280;margin:10px 0 4px;text-transform:uppercase;letter-spacing:.04em}
  .sheet input{width:100%;padding:12px 14px;border:1px solid #d4d8df;border-radius:10px;font-size:15px}
  .sheet .go{width:100%;margin-top:16px;background:var(--accent);color:#fff;border:0;border-radius:10px;padding:14px;font-weight:700;font-size:15px;cursor:pointer}.sheet .go:disabled{opacity:.6}
  .sheet .x{float:right;cursor:pointer;color:#9aa;font-size:20px;border:0;background:none}
  @media(max-width:540px){.hero h1{font-size:1.8rem}}
  </style></head><body>
  ${body}
  <div class="foot">Powered by Inkress · ${esc(s.business_name || "")}</div>
  <div class="modal" id="m"><div class="sheet">
    <button class="x" onclick="closeM()" aria-label="Close">×</button><h3 id="mt">Order</h3><div id="mp" style="color:#6b7280;font-size:.9rem"></div>
    <label for="cn">Your name</label><input id="cn" placeholder="Name">
    <label for="ce">Email (for the receipt)</label><input id="ce" type="email" placeholder="you@email.com" aria-describedby="merr">
    <button class="go" id="go">Continue to payment</button>
    <div id="merr" style="color:#c92a2a;font-size:.85rem;margin-top:8px;display:none" role="alert"></div>
  </div></div>
  <script>
    var cur=null; var PREVIEW=${preview ? "true" : "false"}; var busy=false;
    document.querySelectorAll('.buy').forEach(function(b){b.onclick=function(){cur={id:b.dataset.id,name:b.dataset.name};
      document.getElementById('mt').textContent='Order '+b.dataset.name;
      document.getElementById('mp').textContent=new Intl.NumberFormat('en-JM',{style:'currency',currency:b.dataset.cur}).format(b.dataset.price);
      document.getElementById('merr').style.display='none';document.getElementById('m').classList.add('on');document.getElementById('ce').focus();};});
    function closeM(){if(busy)return;document.getElementById('m').classList.remove('on');}
    document.getElementById('go').onclick=async function(){if(PREVIEW){document.getElementById('m').classList.remove('on');return;}if(busy)return;var e=document.getElementById('ce').value,n=document.getElementById('cn').value;
      var err=document.getElementById('merr');if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(e)){err.style.display='block';err.textContent='Enter a valid email.';document.getElementById('ce').focus();return;}
      var g=document.getElementById('go');busy=true;g.disabled=true;g.textContent='Creating your order…';err.style.display='none';
      try{var r=await fetch('/api/public/buy/${esc(s.handle)}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({product_id:cur.id,name:n,email:e})});
      var j=await r.json().catch(function(){return {};});if(r.ok&&j.payment_url){window.top.location.href=j.payment_url;return;}
      err.style.display='block';err.textContent=j.message||(r.ok?'We couldn\\'t start checkout — please try again.':'Something went wrong — please try again.');}
      catch(_){err.style.display='block';err.textContent='Network error — try again.';}
      busy=false;g.disabled=false;g.textContent='Continue to payment';};
  </script></body></html>`;
}
