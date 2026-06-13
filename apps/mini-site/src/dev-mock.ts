/** DEV-ONLY preview harness — tree-shaken from prod. Lets `vite dev` run the editor
 *  with no backend, and exposes window.__mock so the UI can be driven deterministically
 *  (delay → observe loading; fail → error path; empty → empty state; counters → double-submit). */
import type { BvSession } from "./bv-init";

interface MockCfg { delayMs: number; failProducts: boolean; emptyProducts: boolean; failUpload: boolean; failSections: boolean; sectionPatches: number; productPosts: number; }
const MOCK: MockCfg = ((window as any).__mock = (window as any).__mock || { delayMs: 350, failProducts: false, emptyProducts: false, failUpload: false, failSections: false, sectionPatches: 0, productPosts: 0 });

let SITE: any = {
  handle: "island-eats", published: false, business_name: "Island Eats", tagline: "Fresh island flavours, made daily",
  about: "We're a family kitchen serving the community since 2019.", accent: "#2f9e44", theme: "forest", logo: null, hero_image: null,
  cta_label: "Shop now", cta_target: "products", phone: "876-555-0100", email: "hello@islandeats.jm", address: "12 Hope Rd, Kingston",
  links: [{ label: "Instagram", url: "https://instagram.com/islandeats" }], show_products: true, show_social_proof: true,
  currency: "JMD", public_url: location.origin + "/s/island-eats",
  sections: [
    { id: "a1", type: "hero", data: {} },
    { id: "a2", type: "products", data: { heading: "Shop" } },
    { id: "a3", type: "text", data: { heading: "About", body: "We're a family kitchen serving the community since 2019." } },
  ],
};
const PRODUCTS: any[] = [
  { id: 1, name: "Signature Box", description: "Our bestselling combo, freshly made.", price: 2500, currency: "JMD", image_url: null, product_id: null, active: true, sort: 0 },
  { id: 2, name: "Family Pack", description: "Feeds 4–5, great for sharing.", price: 4800, currency: "JMD", image_url: null, product_id: null, active: true, sort: 1 },
];
let PID = 2;
const CATALOG = [
  { id: "p_a", title: "Daily Special", description: "Ask what's cooking.", price: 1200, image: null, currency: "JMD" },
  { id: "p_b", title: "Sweet Treat", description: "A little something.", price: 650, image: null, currency: "JMD" },
];
const DOMAINS: any[] = [{ id: 1, domain: "shop.islandeats.jm", status: "active" }];

const wait = () => new Promise((r) => setTimeout(r, Math.max(0, MOCK.delayMs)));

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url, location.origin);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
    await wait();
    const pm = u.pathname.match(/\/api\/products\/(\d+)/);
    const dm = u.pathname.match(/\/api\/domains\/(\d+)/);

    if (u.pathname === "/api/site" && method === "GET") return json({ site: SITE, themes: ["fresh", "sunset", "forest", "mono", "rose"], products_scope: true, can_sell: true, storage: true, webhook_realtime: true, stats: { paid_orders: 7, revenue: 21500 } });
    if (u.pathname === "/api/site" && method === "PATCH") { if (body.business_name !== undefined && !String(body.business_name).trim()) return json({ error: "invalid", message: "Business name can’t be empty.", field: "business_name" }, 400); SITE = { ...SITE, ...body }; if (body.handle) { const slug = String(body.handle).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); SITE.handle = slug; SITE.public_url = location.origin + "/s/" + slug; } return json({ site: SITE }); }
    if (u.pathname === "/api/sections" && method === "PATCH") { MOCK.sectionPatches++; if (MOCK.failSections) return json({ error: "server_error", message: "Couldn’t save your layout — please try again." }, 500); SITE.sections = body.sections; return json({ site: SITE }); }
    if (u.pathname === "/api/preview") return json({ html: "<!doctype html><body style='font-family:system-ui;padding:30px'><h1>" + SITE.business_name + "</h1><p>" + SITE.tagline + "</p><p style='color:#888'>Preview · " + SITE.sections.length + " sections</p></body>" });
    if (u.pathname === "/api/publish") { SITE.published = !!body.published; return json({ site: SITE }); }
    if (u.pathname === "/api/handle-check") return json({ ok: true, handle: u.searchParams.get("handle") });
    if (u.pathname === "/api/products" && method === "GET") return json({ products: MOCK.emptyProducts ? [] : PRODUCTS });
    if (u.pathname === "/api/products" && method === "POST") {
      MOCK.productPosts++;
      if (MOCK.failProducts || String(body.name).toUpperCase() === "FAIL") return json({ error: "server_error", message: "Couldn’t save the product — please try again." }, 500);
      if (!String(body.name || "").trim()) return json({ error: "invalid", message: "Product name is required.", field: "name" }, 400);
      const p = { id: ++PID, ...body, currency: "JMD", active: true, sort: PRODUCTS.length, product_id: null }; PRODUCTS.push(p); return json({ product: p }, 201);
    }
    if (pm && method === "PATCH") { const p = PRODUCTS.find((x) => x.id === Number(pm[1])); Object.assign(p, body); return json({ product: p }); }
    if (pm && method === "DELETE") { const i = PRODUCTS.findIndex((x) => x.id === Number(pm[1])); if (i >= 0) PRODUCTS.splice(i, 1); return json({ ok: true }); }
    if (u.pathname === "/api/catalog") return json({ products: CATALOG });
    if (u.pathname === "/api/import") { for (const p of body.products) PRODUCTS.push({ id: ++PID, name: p.title, description: p.description, price: p.price, currency: "JMD", image_url: p.image, product_id: p.id, active: true, sort: PRODUCTS.length }); return json({ added: body.products.length }); }
    if (u.pathname === "/api/upload") { if (MOCK.failUpload) return json({ error: "upload_failed", message: "Upload failed — try again." }, 502); return json({ url: body.data || "https://placehold.co/600x400/png" }); }
    if (u.pathname === "/api/status") return json({ realtime: true, webhook_registered: true });
    if (u.pathname === "/api/domains" && method === "GET") return json({ domains: DOMAINS, target: "89.167.13.203" });
    if (u.pathname === "/api/domains" && method === "POST") { if (!/^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i.test(body.domain || "")) return json({ error: "bad_domain", message: "Enter a valid domain like shop.yourbrand.com.", field: "domain" }, 400); DOMAINS.unshift({ id: Date.now(), domain: body.domain, status: "pending" }); return json({ domain: { id: Date.now(), domain: body.domain, status: "pending" }, target: "89.167.13.203", instructions: { a_record: { host: body.domain, type: "A", value: "89.167.13.203" }, note: "Add this A record, then your storefront goes live on it." } }, 201); }
    if (dm && method === "DELETE") { const i = DOMAINS.findIndex((x) => x.id === Number(dm[1])); if (i >= 0) DOMAINS.splice(i, 1); return json({ ok: true }); }
    return json({ error: "not_mocked", message: "Not mocked: " + u.pathname }, 404);
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { merchant: { id: 183, username: "jackjack", name: "Jack Jack", currency_code: "JMD" }, toast: () => {} } as any,
    merchant: { id: 183, username: "jackjack", name: "Jack Jack", currency_code: "JMD", email: null, logo: null },
    user: { id: 1, name: "Dev User", email: "dev@example.com" } as any,
    scopes: ["orders:read", "orders:write", "products:read", "merchant_profile:read", "customers:write", "offline_access", "webhooks:manage"],
  };
}
