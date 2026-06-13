import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, card, openModal, flash, fmtMoney, pill, emptyState, h, iconEl,
} from "./bv-init";
import {
  field, validators, submitButton, formError, imageField, asyncView, apiForm,
  imageFileError, readDataUrl, IMAGE_TYPES, type Field,
} from "./form";

// ---- types -----------------------------------------------------------------
interface Link { label: string; url: string; }
interface Block { id: string; type: string; data: any; }
interface Site {
  handle: string; published: boolean; business_name: string; tagline: string; about: string;
  accent: string; theme: string; logo: string | null; hero_image: string | null; cta_label: string; cta_target: string;
  phone: string | null; email: string | null; address: string | null; links: Link[];
  show_products: boolean; show_social_proof: boolean; currency: string; sections: Block[]; public_url: string;
}
interface SiteResp { site: Site; themes: string[]; products_scope: boolean; can_sell: boolean; storage: boolean; webhook_realtime: boolean; stats: { paid_orders: number; revenue: number }; }
interface Product { id: number; name: string; description: string | null; price: number; currency: string; image_url: string | null; product_id: string | null; active: boolean; sort: number; }
interface CatalogItem { id: string; title: string; description: string | null; price: number; image: string | null; currency: string; }
interface Domain { id: number; domain: string; status: string; }

const BLOCKS: Record<string, { label: string; icon: string; summary: (d: any) => string }> = {
  hero: { label: "Hero", icon: "sparkles", summary: (d) => d.title || "Your name & tagline" },
  products: { label: "Products", icon: "tag", summary: (d) => d.heading || "Shop" },
  text: { label: "Text", icon: "edit", summary: (d) => d.heading || (d.body || "").slice(0, 40) || "A paragraph" },
  gallery: { label: "Gallery", icon: "camera", summary: (d) => `${(d.images || []).length} image(s)` },
  links: { label: "Links", icon: "link", summary: (d) => `${(d.links || []).length} link(s)` },
  contact: { label: "Contact", icon: "phone", summary: (d) => [d.phone, d.email, d.address].filter(Boolean).join(" · ") || "Contact details" },
  hours: { label: "Hours", icon: "clock", summary: (d) => `${(d.rows || []).length} row(s)` },
  testimonials: { label: "Testimonials", icon: "heart", summary: (d) => `${(d.items || []).length} quote(s)` },
};

// ---- app state -------------------------------------------------------------
const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant", currency = "JMD";
let caps = { products_scope: false, can_sell: false, storage: false };
let themes: string[] = [];
let shell: ReturnType<typeof mountShell>;

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); } catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";
  currency = session.merchant.currency_code || "JMD";
  shell = mountShell({
    brandIcon: "store", brandLogo: "/logo.svg", title: "Mini-site",
    subtitle: `${merchantName} · your storefront`, poweredBy: "Marketplace",
    tabs: [
      { id: "overview", label: "Overview", icon: "store", render: renderOverview },
      { id: "builder", label: "Builder", icon: "sparkles", render: renderBuilder },
      { id: "products", label: "Products", icon: "tag", render: renderProducts },
      { id: "theme", label: "Theme", icon: "edit", render: renderTheme },
    ],
  });
})();

const money = (n: number) => fmtMoney(n, currency);
function refresh() { shell.select(currentTabId()); }
function currentTabId() { return location.hash.slice(1) || "overview"; }

// ====================================================================== OVERVIEW
async function renderOverview(host: HTMLElement) {
  await asyncView<SiteResp>(host, () => bvApi<SiteResp>("/api/site"), (r) => {
    const site = r.site; caps = { products_scope: r.products_scope, can_sell: r.can_sell, storage: r.storage }; themes = r.themes; currency = site.currency || currency;
    const handleF = field({ label: "Storefront handle", value: site.handle, prefix: "…/s/", hint: "Your storefront’s web address — pick something memorable.", validate: validators.required("Handle is required."), onEnter: () => saveHandle.run() });
    const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    const saveHandle = submitButton("Update", async () => {
      if (!handleF.validate()) { handleF.focus(); return; }
      const want = handleF.value();
      const res = await apiForm<{ site: Site }>("/api/site", { method: "PATCH", body: JSON.stringify({ handle: want }) });
      if (!res.ok) { handleF.setError(res.message); return; }
      const got = res.data.site.handle;
      if (got !== slug(want)) flash(`“${slug(want)}” was taken — your handle is now “${got}”.`, "info");  // honest: tell them it changed
      else flash(`Live at …/s/${got}`, "success");
      refresh();
    }, "bv-btn");
    const domainsHost = h("div");
    host.replaceChildren(
      statRow([
        { k: "STATUS", v: site.published ? "Live" : "Draft", tone: site.published ? "ok" : undefined, icon: site.published ? "check" : "edit" },
        { k: "SECTIONS", v: String(site.sections.length), icon: "sparkles" },
        { k: "ORDERS", v: String(r.stats.paid_orders), d: r.stats.revenue ? money(r.stats.revenue) : undefined, icon: "receipt" },
        { k: "PRODUCTS", v: "—", icon: "tag" },
      ]),
      card({
        title: "Your public page",
        action: publishButton(site),
        body: h("div", null,
          h("p", { class: "bv-muted" }, site.published ? "Your storefront is live at:" : "Publish to make this address live:"),
          h("div", { class: "ms-url" },
            h("a", { href: site.public_url, target: "_blank", class: "bv-link" }, site.public_url),
            h("button", { class: "bv-btn sm", onClick: () => { navigator.clipboard?.writeText(site.public_url); flash("Link copied", "success"); } }, "Copy"),
            h("a", { class: "bv-btn sm", href: site.public_url, target: "_blank" }, "View")),
        ),
      }),
      card({ title: "Handle", body: h("form", { onSubmit: (e: Event) => { e.preventDefault(); saveHandle.run(); } }, handleF.el, h("div", { class: "modal-foot" }, saveHandle.el)) }),
      card({ title: "Custom domain", action: h("button", { class: "bv-btn", onClick: () => addDomainModal(() => loadDomains(domainsHost)) }, "Add domain"), body: domainsHost }),
    );
    bvApi<{ products: Product[] }>("/api/products").then((p) => { const v = host.querySelector(".bv-stats .bv-stat:nth-child(4) .v"); if (v) v.textContent = String(p.products.length); }).catch(() => {});
    loadDomains(domainsHost);
  });
}
function publishButton(site: Site) {
  const btn = submitButton(site.published ? "Unpublish" : "Publish site", async () => {
    const res = await apiForm<{ site: Site }>("/api/publish", { method: "POST", body: JSON.stringify({ published: !site.published }) });
    if (!res.ok) { flash(res.message, "error"); return; }
    flash(res.data.site.published ? "Site published 🎉" : "Unpublished", "success"); refresh();
  }, "bv-btn" + (site.published ? "" : " primary"));
  return btn.el;
}
async function loadDomains(host: HTMLElement) {
  await asyncView<{ domains: Domain[]; target: string }>(host, () => bvApi("/api/domains"), (r) => {
    host.replaceChildren(
      h("p", { class: "bv-muted bv-sm" }, "Use your own web address (e.g. shop.yourbrand.com) instead of the Inkress link."),
      ...(r.domains.length ? r.domains.map((d) => {
        const remove = submitButton("Remove", async () => {
          const res = await apiForm(`/api/domains/${d.id}`, { method: "DELETE" });
          if (res.ok) { flash("Removed", "success"); loadDomains(host); }
          else flash(res.message, "error");
        }, "bv-btn sm");
        return h("div", { class: "bv-row ms-domrow" },
          iconEl(d.status === "active" ? "check" : "clock", 16),
          h("span", { class: "bv-mono" }, d.domain), pill(d.status, d.status === "active" ? "ok" : undefined),
          remove.el);
      }) : [emptyState({ icon: "link", title: "No custom domain yet", text: "Add one to use your own web address." })]),
    );
  });
}
function addDomainModal(onDone: () => void) {
  const domainF = field({ label: "Your domain", placeholder: "shop.yourbrand.com", validate: validators.compose(validators.required("Enter a domain."), validators.domain()), onEnter: () => submit.run() });
  const fe = formError();
  const out = h("div");
  let modal: { close: () => void };
  const submit = submitButton("Add domain", async () => {
    fe.clear();
    if (!domainF.validate()) { domainF.focus(); return; }
    const res = await apiForm<{ instructions: any }>("/api/domains", { method: "POST", body: JSON.stringify({ domain: domainF.value() }) });
    if (!res.ok) { if (res.field === "domain") domainF.setError(res.message); else fe.show(res.message); return; }
    const a = res.data.instructions.a_record;
    out.replaceChildren(h("div", { class: "ms-success" }, iconEl("check", 18),
      h("div", null, h("b", null, "Added — now point your DNS"),
        h("p", { class: "bv-muted bv-sm" }, "Add this record at your DNS provider:"),
        h("div", { class: "bv-mono ms-dns" }, `A · ${a.host} · ${a.value}`),
        h("p", { class: "bv-muted bv-sm" }, res.data.instructions.note))));
    domainF.input.value = ""; onDone();
  });
  const formEl = h("form", { onSubmit: (e: Event) => { e.preventDefault(); submit.run(); } },
    domainF.el, fe.el, out, h("div", { class: "modal-foot" }, h("button", { class: "bv-btn", type: "button", onClick: () => modal.close() }, "Close"), submit.el));
  modal = openModal({ title: "Connect a custom domain", body: formEl });
  setTimeout(() => domainF.focus(), 50);
}

// ====================================================================== BUILDER
let previewFrame: HTMLIFrameElement | null = null;
async function renderBuilder(host: HTMLElement) {
  await asyncView<SiteResp>(host, () => bvApi<SiteResp>("/api/site"), (r) => {
    let sections = r.site.sections; currency = r.site.currency || currency;
    const publicUrl = r.site.public_url;
    const listHost = h("div", { class: "ms-blocks" });
    previewFrame = h("iframe", { class: "ms-preview", title: "Storefront preview" }) as HTMLIFrameElement;
    const idx = (id: string) => sections.findIndex((x) => x.id === id);
    const draw = () => {
      listHost.replaceChildren(...sections.map((b, i) => blockRow(b, i)));
      if (!sections.length) listHost.append(emptyState({ icon: "sparkles", title: "Empty page", text: "Add a block to start building your storefront." }));
    };
    // Serialize saves: row controls (move/remove/reorder) and the editor can all
    // trigger a save; chaining prevents overlapping PATCHes from interleaving and
    // resurrecting a just-deleted block. Returns the outcome so callers can react.
    let chain: Promise<unknown> = Promise.resolve();
    const commit = (o: { silent?: boolean } = {}): Promise<{ ok: boolean; message?: string }> => {
      draw();
      const snapshot = JSON.stringify({ sections });
      const run = chain.then(async () => {
        const res = await apiForm<{ site: Site }>("/api/sections", { method: "PATCH", body: snapshot });
        if (!res.ok) { if (!o.silent) flash(res.message, "error"); return { ok: false, message: res.message }; }
        sections = res.data.site.sections; draw(); refreshPreview(); return { ok: true };
      });
      chain = run.catch(() => {});
      return run;
    };
    function blockRow(b: Block, i: number) {
      const meta = BLOCKS[b.type] || { label: b.type, icon: "edit", summary: () => "" };
      const row = h("div", { class: "ms-block", draggable: "true" },
        iconEl("list", 16), iconEl(meta.icon, 18),
        h("div", { class: "ms-block-main" }, h("div", { class: "ms-block-label" }, meta.label), h("div", { class: "bv-muted bv-sm" }, meta.summary(b.data))),
        h("div", { class: "bv-row" },
          h("button", { class: "bv-btn sm", disabled: i === 0, title: "Move up", "aria-label": "Move up", onClick: () => move(b.id, -1) }, "↑"),
          h("button", { class: "bv-btn sm", disabled: i === sections.length - 1, title: "Move down", "aria-label": "Move down", onClick: () => move(b.id, 1) }, "↓"),
          h("button", { class: "bv-btn sm", onClick: () => editBlock(b.id) }, "Edit"),
          h("button", { class: "bv-btn sm", title: "Remove", "aria-label": "Remove block", onClick: () => { sections = sections.filter((x) => x.id !== b.id); commit(); } }, "✕"),
        ),
      ) as HTMLElement;
      row.addEventListener("dragstart", (e) => { (e as DragEvent).dataTransfer!.setData("text/plain", b.id); row.classList.add("dragging"); });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", (e) => e.preventDefault());
      row.addEventListener("drop", (e) => { e.preventDefault(); reorder((e as DragEvent).dataTransfer!.getData("text/plain"), b.id); });
      return row;
    }
    function move(id: string, dir: number) { const i = idx(id), j = i + dir; if (i < 0 || j < 0 || j >= sections.length) return; const a = sections.slice(); [a[i], a[j]] = [a[j]!, a[i]!]; sections = a; commit(); }
    function reorder(fromId: string, toId: string) { if (fromId === toId) return; const f = idx(fromId), t = idx(toId); if (f < 0 || t < 0) return; const a = sections.slice(); const [m] = a.splice(f, 1); a.splice(t, 0, m!); sections = a; commit(); }
    function addBlockMenu() {
      let modal: { close: () => void };
      const body = h("div", { class: "ms-addgrid" }, ...Object.entries(BLOCKS).map(([type, meta]) =>
        h("button", { class: "ms-addbtn", onClick: () => { modal.close(); sections = [...sections, { id: Math.random().toString(16).slice(2, 10), type, data: defaultData(type) }]; commit(); } },
          iconEl(meta.icon, 20), h("span", null, meta.label))));
      modal = openModal({ title: "Add a block", body });
    }
    function editBlock(id: string) { const b = sections.find((x) => x.id === id); if (b) openBlockEditor(b, () => commit({ silent: true })); }
    draw();
    host.replaceChildren(h("div", { class: "ms-builder" },
      card({ title: "Page sections", action: h("button", { class: "bv-btn primary", onClick: addBlockMenu }, "+ Add block"),
        body: h("div", null, h("p", { class: "bv-muted bv-sm" }, "Drag to reorder. Click Edit to change a block."), listHost) }),
      card({ title: "Live preview", action: h("a", { class: "bv-btn sm", href: publicUrl, target: "_blank" }, "Open ↗"), body: previewFrame }),
    ));
    refreshPreview();
  });
}
function defaultData(type: string): any {
  switch (type) {
    case "products": return { heading: "Shop" };
    case "text": return { heading: "About", body: "" };
    case "gallery": return { heading: "Gallery", images: [] };
    case "links": return { heading: "Find us", links: [] };
    case "contact": return { heading: "Contact", phone: "", email: "", address: "" };
    case "hours": return { heading: "Opening hours", rows: [] };
    case "testimonials": return { heading: "What customers say", items: [] };
    default: return {};
  }
}
async function refreshPreview() {
  if (!previewFrame) return;
  try { const r = await bvApi<{ html: string }>("/api/preview"); previewFrame.srcdoc = r.html; }
  catch { if (previewFrame) previewFrame.srcdoc = "<body style='font-family:system-ui;padding:24px;color:#9aa'>Preview unavailable right now.</body>"; }
}

// Block editor — fields per type + array editors, with a single-flight Save.
function openBlockEditor(b: Block, onSaved: () => Promise<{ ok: boolean; message?: string }>) {
  const d = JSON.parse(JSON.stringify(b.data || {}));
  const body = h("div", null);
  const heading = (val = d.heading) => { const f = field({ label: "Heading", value: val || "" }); f.input.addEventListener("input", () => { d.heading = f.input.value; }); return f.el; };
  const text = (label: string, key: string, ta = false, ph = "") => { const f = field({ label, value: d[key] || "", textarea: ta, rows: 4, placeholder: ph }); f.input.addEventListener("input", () => { d[key] = f.input.value; }); return f.el; };
  // generic array editor for {label,url}-style rows
  const arrayEditor = (key: string, cols: { k: string; ph: string; validate?: any }[]) => {
    d[key] = Array.isArray(d[key]) ? d[key] : [];
    const listEl = h("div", { class: "ms-arr" });
    const draw = () => listEl.replaceChildren(...d[key].map((item: any, i: number) => {
      const inputs = cols.map((c) => { const f = field({ label: "", placeholder: c.ph, value: item[c.k] || "", validate: c.validate }); f.input.setAttribute("aria-label", c.ph); f.input.addEventListener("input", () => { item[c.k] = f.input.value; }); return f.el; });
      return h("div", { class: "ms-arrrow" }, ...inputs, h("button", { class: "bv-btn sm", type: "button", title: "Remove", onClick: () => { d[key].splice(i, 1); draw(); } }, "✕"));
    }));
    draw();
    return h("div", null, listEl, h("button", { class: "bv-btn sm", type: "button", onClick: () => { d[key].push({}); draw(); } }, "+ Add"));
  };
  if (b.type === "hero") body.append(text("Headline (blank = business name)", "title"), text("Subtitle (blank = tagline)", "subtitle"), imageField("Background image", d.image || "", (u) => { d.image = u; }).el);
  else if (b.type === "products") body.append(heading());
  else if (b.type === "text") body.append(heading(), text("Body", "body", true, "Tell customers about your business…"));
  else if (b.type === "contact") body.append(heading(), text("Phone", "phone"), text("Email", "email"), text("Address", "address"));
  else if (b.type === "links") body.append(heading(), wrapField("Links", arrayEditor("links", [{ k: "label", ph: "Label (e.g. Instagram)" }, { k: "url", ph: "instagram.com/you", validate: validators.url() }])));
  else if (b.type === "hours") body.append(heading(), wrapField("Rows", arrayEditor("rows", [{ k: "label", ph: "Mon–Fri" }, { k: "value", ph: "9am – 5pm" }])));
  else if (b.type === "testimonials") body.append(heading(), wrapField("Quotes", arrayEditor("items", [{ k: "quote", ph: "Great service!" }, { k: "author", ph: "Customer name" }])));
  else if (b.type === "gallery") {
    d.images = (Array.isArray(d.images) ? d.images : []).filter(Boolean);
    const grid = h("div", { class: "ms-gallery-edit" });
    const gerr = h("div", { class: "field-error", role: "alert", "aria-live": "polite" }) as HTMLElement;
    const fileInput = h("input", { type: "file", accept: IMAGE_TYPES.join(","), multiple: true, style: { display: "none" } }) as HTMLInputElement;
    let uploading = false;
    const drawG = () => grid.replaceChildren(
      ...d.images.map((u: string, i: number) => h("div", { class: "ms-gtile", style: { backgroundImage: `url('${u}')` } }, h("button", { class: "ms-gtile-x", type: "button", "aria-label": "Remove image", onClick: () => { d.images.splice(i, 1); drawG(); } }, "✕"))),
      uploading
        ? h("div", { class: "ms-gtile add", "aria-busy": "true", "aria-label": "Uploading" }, h("span", { class: "ms-spin" }))
        : h("div", { class: "ms-gtile add", role: "button", tabindex: "0", "aria-label": "Add image", onClick: () => fileInput.click(), onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } } }, iconEl("plus", 22)));
    fileInput.addEventListener("change", async (e: any) => {
      const files: File[] = Array.from(e.target.files || []); e.target.value = "";
      if (!files.length) return;
      gerr.textContent = ""; uploading = true; drawG();
      const problems: string[] = [];
      for (const f of files) {
        const ve = imageFileError(f);                                   // same validation as the single-image field
        if (ve) { problems.push(`“${f.name}”: ${ve}`); continue; }
        let dataUrl: string;
        try { dataUrl = await readDataUrl(f); } catch { problems.push(`Couldn’t read “${f.name}”.`); continue; }
        const up = await apiForm<{ url: string }>("/api/upload", { method: "POST", body: JSON.stringify({ data: dataUrl }) });
        if (!up.ok) { problems.push(up.message || `Upload failed for “${f.name}”.`); continue; }
        d.images.push(up.data.url);
      }
      uploading = false; drawG();
      if (problems.length) gerr.textContent = problems.join("  ");        // inline, persistent — not a transient toast
    });
    drawG();
    body.append(heading(), wrapField("Images", h("div", null, grid, fileInput, gerr, h("p", { class: "bv-muted bv-sm" }, "Click + to upload (JPG, PNG, WEBP, GIF · up to 5 MB each)."))));
  }
  let modal: { close: () => void };
  const fe = formError();
  // The button stays in its loading state until the actual save resolves; on
  // failure the modal stays open with the error shown so edits aren't lost.
  const submit = submitButton("Done", async () => {
    fe.clear(); b.data = d;
    const res = await onSaved();
    if (res.ok) modal.close();
    else fe.show(res.message || "Couldn’t save your changes — try again.");
  });
  body.append(fe.el, h("div", { class: "modal-foot" }, h("button", { class: "bv-btn", type: "button", onClick: () => modal.close() }, "Cancel"), submit.el));
  modal = openModal({ title: `Edit ${BLOCKS[b.type]?.label || b.type}`, body });
}
function wrapField(label: string, control: HTMLElement) { return h("div", { class: "field" }, h("div", { class: "bv-label" }, label), control); }

// ====================================================================== PRODUCTS
async function renderProducts(host: HTMLElement) {
  await asyncView<{ products: Product[] }>(host, () => bvApi("/api/products"), (r) => {
    const parts: (HTMLElement | null)[] = [
      caps.can_sell ? null : note("alert", "Selling isn’t enabled", "This connection can’t create orders yet — reconnect with the orders permission so customers can buy."),
      card({
        title: "Products",
        action: h("div", { class: "bv-row" },
          caps.products_scope ? h("button", { class: "bv-btn", onClick: () => importModal(() => refresh()) }, "Import from catalog") : null,
          h("button", { class: "bv-btn primary", onClick: () => productModal(null, () => refresh()) }, "Add product")),
        body: r.products.length
          ? table(r.products)
          : emptyState({ icon: "tag", title: "No products yet", text: caps.products_scope ? "Add one, or import your existing catalog." : "Add your first product to start selling.", action: h("button", { class: "bv-btn primary", onClick: () => productModal(null, () => refresh()) }, "Add product") }),
      }),
    ];
    host.replaceChildren(...parts.filter((x): x is HTMLElement => x != null));
  });
  function table(products: Product[]) {
    return h("div", { class: "bv-table-wrap" }, h("table", { class: "bv-table" },
      h("thead", null, h("tr", null, h("th", null, ""), h("th", null, "Product"), h("th", { class: "num" }, "Price"), h("th", null, "Shown"), h("th", null, ""))),
      h("tbody", null, ...products.map((p) => h("tr", null,
        h("td", null, p.image_url ? h("img", { src: p.image_url, class: "ms-thumb", alt: "" }) : h("div", { class: "ms-thumb ph" }, (p.name || "?").slice(0, 1))),
        h("td", null, h("div", null, p.name), p.description ? h("div", { class: "bv-muted bv-sm" }, p.description.slice(0, 60)) : null),
        h("td", { class: "num" }, money(p.price)),
        h("td", null, pill(p.active ? "on site" : "hidden", p.active ? "ok" : undefined)),
        h("td", { class: "actions" }, h("div", { class: "bv-row" },
          h("button", { class: "bv-btn sm", onClick: () => productModal(p, () => refresh()) }, "Edit"),
          h("button", { class: "bv-btn sm", onClick: () => removeProduct(p) }, "Delete"))),
      )))));
  }
  async function removeProduct(p: Product) { const res = await apiForm(`/api/products/${p.id}`, { method: "DELETE" }); if (res.ok) { flash("Removed", "success"); refresh(); } else flash(res.message, "error"); }
}
// THE FLAGSHIP FORM — meets every Phase-2 requirement.
function productModal(p: Product | null, onDone: () => void) {
  const name = field({ label: "Product name", value: p?.name || "", placeholder: "e.g. Signature Box", validate: validators.required("Product name is required.") });
  const price = field({ label: "Price", value: p ? String(p.price) : "", placeholder: "0.00", prefix: currency, validate: validators.number({ required: true, min: 0 }) });
  const desc = field({ label: "Description", value: p?.description || "", textarea: true, rows: 2, placeholder: "A short description (optional)", hint: "Shown under the product name." });
  const photo = imageField("Photo", p?.image_url || "", () => {}, { hint: "Shown on your storefront · optional" });
  const fe = formError();
  const requiredFields: Field[] = [name, price];
  let modal: { close: () => void };
  const submit = submitButton(p ? "Save changes" : "Add product", async () => {
    fe.clear();
    let firstInvalid: Field | null = null;
    for (const f of requiredFields) { if (!f.validate() && !firstInvalid) firstInvalid = f; }
    if (firstInvalid) { firstInvalid.focus(); return; }                       // blocks submit, focuses the field
    const payload = JSON.stringify({ name: name.value(), description: desc.value(), price: Number(price.value()), image_url: photo.value() });
    const res = await apiForm<{ product: Product }>(p ? `/api/products/${p.id}` : "/api/products", { method: p ? "PATCH" : "POST", body: payload });
    if (!res.ok) {                                                            // error: keep data, surface inline
      if (res.field === "name") name.setError(res.message);
      else if (res.field === "price") price.setError(res.message);
      else fe.show(res.message);
      return;
    }
    flash(p ? "Product saved" : "Product added", "success");                 // explicit success
    modal.close(); onDone();                                                 // form closes, list refreshes
  });
  const formEl = h("form", { onSubmit: (e: Event) => { e.preventDefault(); submit.run(); } },
    name.el, price.el, desc.el, photo.el, fe.el,
    h("div", { class: "modal-foot" }, h("button", { class: "bv-btn", type: "button", onClick: () => modal.close() }, "Cancel"), submit.el));
  modal = openModal({ title: p ? "Edit product" : "Add product", body: formEl });
  setTimeout(() => name.focus(), 50);
}
function importModal(onDone: () => void) {
  const host = h("div", { class: "ms-picklist" });
  const picked = new Set<string>();
  let modal: { close: () => void };
  const submit = submitButton("Import selected", async () => {
    const ids = [...picked];
    if (!ids.length) { flash("Pick at least one product", "info"); return; }
    const res = await apiForm<{ added: number }>("/api/import", { method: "POST", body: JSON.stringify({ products: items.filter((c) => picked.has(c.id)) }) });
    if (!res.ok) { flash(res.message, "error"); return; }
    flash(`Imported ${res.data.added} product${res.data.added === 1 ? "" : "s"}`, "success"); modal.close(); onDone();
  });
  let items: CatalogItem[] = [];
  modal = openModal({ title: "Import from your catalog", body: h("div", null, host, h("div", { class: "modal-foot" }, h("button", { class: "bv-btn", type: "button", onClick: () => modal.close() }, "Cancel"), submit.el)) });
  asyncView<{ products: CatalogItem[]; unavailable?: boolean }>(host, () => bvApi("/api/catalog"), (r) => {
    items = r.products;
    if (!items.length) { host.replaceChildren(emptyState({ icon: "tag", title: "No catalog products", text: r.unavailable ? "Catalog access isn’t enabled for this connection." : "Your Inkress catalog is empty." })); return; }
    host.replaceChildren(...items.map((c) => {
      const cb = h("input", { type: "checkbox", "aria-label": `Select ${c.title}`, onChange: (e: any) => { e.target.checked ? picked.add(c.id) : picked.delete(c.id); } }) as HTMLInputElement;
      return h("label", { class: "ms-pick" }, cb, c.image ? h("img", { src: c.image, class: "ms-thumb", alt: "" }) : h("div", { class: "ms-thumb ph" }, c.title.slice(0, 1)),
        h("div", null, h("div", null, c.title), h("div", { class: "bv-muted bv-sm" }, money(c.price))));
    }));
  });
}

// ====================================================================== THEME
async function renderTheme(host: HTMLElement) {
  await asyncView<SiteResp>(host, () => bvApi<SiteResp>("/api/site"), (r) => {
    const site = r.site; themes = r.themes; currency = site.currency || currency; caps = { products_scope: r.products_scope, can_sell: r.can_sell, storage: r.storage };
    const name = field({ label: "Business name", value: site.business_name || "", validate: validators.required("Business name is required.") });
    const tag = field({ label: "Tagline", value: site.tagline || "", placeholder: "A short tagline" });
    const accent = h("input", { type: "color", value: site.accent, id: "ms-accent", "aria-label": "Accent colour" }) as HTMLInputElement;
    const theme = h("select", { id: "ms-theme", "aria-label": "Theme preset" }, ...themes.map((t) => h("option", { value: t, selected: site.theme === t }, t.charAt(0).toUpperCase() + t.slice(1)))) as HTMLSelectElement;
    const logo = imageField("Logo", site.logo || "", () => {}, { hint: "Square works best · optional" });
    const fe = formError();
    const submit = submitButton("Save", async () => {
      fe.clear();
      if (!name.validate()) { name.focus(); return; }
      const res = await apiForm<{ site: Site }>("/api/site", { method: "PATCH", body: JSON.stringify({ business_name: name.value(), tagline: tag.value(), logo: logo.value(), accent: accent.value, theme: theme.value }) });
      if (!res.ok) { if (res.field === "business_name") name.setError(res.message); else fe.show(res.message); return; }
      flash("Theme saved", "success");
    });
    const parts: (HTMLElement | null)[] = [
      card({ title: "Brand & theme", body: h("form", { onSubmit: (e: Event) => { e.preventDefault(); submit.run(); } },
        h("div", { class: "bv-formgrid" }, name.el, tag.el, wrapField("Accent colour", accent), wrapField("Theme", theme)),
        logo.el, fe.el, h("div", { class: "modal-foot" }, submit.el)) }),
      caps.storage ? null : note("send", "Image uploads off", "Image hosting isn’t configured on this deployment — paste image URLs for now."),
      card({ title: "Build your page", body: h("div", null, h("p", { class: "bv-muted bv-sm" }, "Add and arrange sections in the Builder tab."), h("button", { class: "bv-btn", onClick: () => shell.select("builder") }, "Open Builder")) }),
    ];
    host.replaceChildren(...parts.filter((x): x is HTMLElement => x != null));
  });
}

// ---- small helpers ---------------------------------------------------------
function note(icon: string, title: string, text: string) {
  return card({ body: h("div", { class: "bv-note" }, iconEl(icon, 18), h("div", null, h("b", null, title), h("p", { class: "bv-muted" }, text))) });
}
function fatal(msg?: string) { return h("div", { class: "bv-shell" }, h("div", { class: "bv-card" }, h("h3", null, "Couldn’t load Mini-site"), h("p", { class: "bv-muted" }, msg || "Try reopening from the dashboard."))); }
