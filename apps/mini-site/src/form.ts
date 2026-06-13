// Reusable form + UX primitives for the Mini-site editor.
// Goal: every form behaves the same — inline validation, blocked-when-invalid submit,
// single-flight loading buttons, explicit success/error, and accessible controls.
import { h, iconEl, bvApi, flash } from "./bv-init";

let _seq = 0;
const uid = (p = "f") => `${p}-${++_seq}`;

// ---- form submit: keeps the server's structured error (bvApi drops `field`) -
const storedSid = () => sessionStorage.getItem("bv_app_session_id") || localStorage.getItem("bv_app_session_id") || "";
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error?: string; message: string; field?: string };
export async function apiForm<T = unknown>(path: string, init: RequestInit = {}, _retry = true): Promise<ApiResult<T>> {
  let r: Response, body: any = null;
  try {
    r = await fetch(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Accept: "application/json", "X-BV-Session": storedSid(), ...(init.body ? { "Content-Type": "application/json" } : {}) } });
    try { body = await r.json(); } catch { body = null; }
  } catch { return { ok: false, status: 0, message: "Network error — check your connection and try again." }; }
  // Transparent session recovery after a server restart (mirrors bvApi): re-bootstrap once, retry.
  if (r.status === 401 && body?.error === "no_session" && _retry) {
    await bvApi("/api/site").catch(() => {});
    return apiForm<T>(path, init, false);
  }
  if (!r.ok) return { ok: false, status: r.status, error: body?.error, message: body?.message || body?.error || `Request failed (${r.status}).`, field: body?.field };
  return { ok: true, data: body as T };
}

// ---- validators ------------------------------------------------------------
export type Validator = (value: string) => string | null; // returns an error message, or null if valid
const URLISH = /^https?:\/\//i;
const DOMAINISH = /^[a-z0-9]([a-z0-9-]*\.)+[a-z]{2,}(\/.*)?$/i;
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i;
export function looksLikeUrl(s: string) { const t = s.trim(); return URLISH.test(t) || DOMAINISH.test(t); }
export function looksLikeDomain(s: string) { const t = s.trim(); return DOMAIN.test(t) && t.length <= 253; }
export const validators = {
  required: (msg = "This field is required.") => (v: string) => (v.trim() ? null : msg),
  number: (opts: { required?: boolean; min?: number; max?: number } = {}) => (v: string) => {
    if (!v.trim()) return opts.required ? "Enter a number." : null;
    const n = Number(v);
    if (!Number.isFinite(n)) return "Enter a valid number.";
    if (opts.min != null && n < opts.min) return `Must be at least ${opts.min}.`;
    if (opts.max != null && n > opts.max) return `Must be ${opts.max} or less.`;
    return null;
  },
  url: (msg = "Enter a valid web address (e.g. instagram.com/you).") => (v: string) => (!v.trim() || looksLikeUrl(v) ? null : msg),
  domain: (msg = "Enter a domain like shop.yourbrand.com.") => (v: string) => (!v.trim() || looksLikeDomain(v) ? null : msg),
  maxLen: (n: number) => (v: string) => (v.length > n ? `Keep it under ${n} characters.` : null),
  compose: (...fns: Validator[]): Validator => (v: string) => { for (const f of fns) { const e = f(v); if (e) return e; } return null; },
};

// ---- a single validated field ---------------------------------------------
export interface Field {
  el: HTMLElement;
  input: HTMLInputElement | HTMLTextAreaElement;
  value: () => string;
  validate: () => boolean;
  setError: (msg: string | null) => void;
  focus: () => void;
}
export function field(opts: {
  label: string; value?: string; placeholder?: string; hint?: string;
  type?: string; textarea?: boolean; rows?: number; validate?: Validator;
  prefix?: string; onEnter?: () => void;
}): Field {
  const id = uid("in"); const errId = uid("err"); const hintId = uid("hint");
  const describedBy = [opts.hint ? hintId : "", errId].filter(Boolean).join(" ");
  const input = (opts.textarea
    ? h("textarea", { id, rows: String(opts.rows || 3), placeholder: opts.placeholder || "", "aria-describedby": describedBy }, opts.value || "")
    : h("input", { id, type: opts.type || "text", value: opts.value || "", placeholder: opts.placeholder || "", "aria-describedby": describedBy })) as HTMLInputElement | HTMLTextAreaElement;
  const errEl = h("div", { class: "field-error", id: errId, role: "alert", "aria-live": "polite" });
  const hintEl = opts.hint ? h("div", { class: "field-hint", id: hintId }, opts.hint) : null;
  const labelEl = h("label", { class: "bv-label", for: id }, opts.label);
  const control = opts.prefix ? h("div", { class: "field-prefixed" }, h("span", { class: "field-prefix" }, opts.prefix), input) : input;
  const wrap = h("div", { class: "field" }, labelEl, hintEl, control, errEl);
  const setError = (msg: string | null) => {
    if (msg) { errEl.textContent = msg; wrap.classList.add("has-error"); input.setAttribute("aria-invalid", "true"); }
    else { errEl.textContent = ""; wrap.classList.remove("has-error"); input.removeAttribute("aria-invalid"); }
  };
  const validate = () => { const e = opts.validate ? opts.validate(input.value) : null; setError(e); return !e; };
  // Validate on blur; once an error is shown, clear it live as the user fixes it.
  input.addEventListener("blur", () => { if (input.value.trim() || wrap.classList.contains("has-error")) validate(); });
  input.addEventListener("input", () => { if (wrap.classList.contains("has-error")) validate(); });
  if (opts.onEnter && !opts.textarea) input.addEventListener("keydown", (e: Event) => { if ((e as KeyboardEvent).key === "Enter") { e.preventDefault(); opts.onEnter!(); } });
  return { el: wrap, input, value: () => input.value, validate, setError, focus: () => input.focus() };
}

// ---- single-flight submit button ------------------------------------------
// Disables + shows a spinner while the action runs; a second click is ignored;
// re-enables when the action settles (success closes the form; error keeps it).
export function submitButton(label: string, onSubmit: () => Promise<unknown>, klass = "bv-btn primary"): { el: HTMLButtonElement; run: () => void } {
  let busy = false;
  const labelNode = h("span", null, label);
  const btn = h("button", { class: klass, type: "submit" }, labelNode) as HTMLButtonElement;
  const run = async () => {
    if (busy) return;
    busy = true;
    btn.disabled = true; btn.setAttribute("aria-busy", "true");
    btn.replaceChildren(h("span", { class: "ms-spin", "aria-hidden": "true" }), h("span", null, "Working…"));
    try { await onSubmit(); }
    finally { busy = false; btn.disabled = false; btn.removeAttribute("aria-busy"); btn.replaceChildren(labelNode); }
  };
  btn.addEventListener("click", (e: Event) => { e.preventDefault(); run(); });
  return { el: btn, run };
}

// A form-level error banner (for errors not tied to one field).
export function formError(): { el: HTMLElement; show: (msg: string) => void; clear: () => void } {
  const el = h("div", { class: "form-error", role: "alert", "aria-live": "assertive", style: { display: "none" } });
  return { el, show: (msg: string) => { el.textContent = msg; el.style.display = ""; }, clear: () => { el.textContent = ""; el.style.display = "none"; } };
}

// ---- async view: loading / error+retry (empty handled by the renderer) -----
export function loadingState(): HTMLElement {
  return h("div", { class: "ms-loading", "aria-busy": "true", "aria-label": "Loading" },
    h("div", { class: "ms-skel", style: { width: "45%" } }), h("div", { class: "ms-skel", style: { width: "75%" } }), h("div", { class: "ms-skel", style: { width: "60%" } }));
}
export function errorState(msg: string, onRetry: () => void): HTMLElement {
  return h("div", { class: "ms-state" }, h("div", { class: "ic" }, iconEl("alert", 24)),
    h("p", null, msg || "Something went wrong."), h("button", { class: "bv-btn", onClick: onRetry }, "Retry"));
}
// Renders loading, runs load(), then hands the data to render() (which replaces host).
// On failure shows an error with a Retry that re-runs the whole thing.
export async function asyncView<T>(host: HTMLElement, load: () => Promise<T>, render: (data: T) => void): Promise<void> {
  host.replaceChildren(loadingState());
  try { const data = await load(); render(data); }
  catch (e: any) { host.replaceChildren(errorState(e?.message || "Couldn’t load this.", () => asyncView(host, load, render))); }
}

// ---- image upload field ----------------------------------------------------
// Exported so every uploader (single image field, gallery grid) shares one
// definition of "valid image" and one robust file reader.
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export function imageFileError(file: File): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return "Use a JPG, PNG, WEBP, GIF or SVG image.";
  if (file.size > MAX_IMAGE_BYTES) return "Image must be under 5 MB.";
  return null;
}
export function readDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = () => rej(new Error("Couldn’t read that file.")); r.readAsDataURL(file); });
}
const fileTypeError = imageFileError; const MAX_BYTES = MAX_IMAGE_BYTES;
// Real upload control: click OR drag-and-drop, immediate local preview, inline
// validation/errors, loading state, Replace/Remove, plus a collapsed URL fallback.
export function imageField(label: string, current: string, onChange: (url: string) => void, opts: { hint?: string } = {}): { el: HTMLElement; value: () => string } {
  let url = current;
  const errEl = h("div", { class: "field-error", role: "alert", "aria-live": "polite" });
  const fileInput = h("input", { type: "file", accept: IMAGE_TYPES.join(","), style: { display: "none" }, tabindex: "-1", "aria-hidden": "true" }) as HTMLInputElement;
  const drop = h("div", { class: "ms-drop", role: "button", tabindex: "0", "aria-label": `Upload ${label.toLowerCase()}` }) as HTMLElement;
  const urlInput = h("input", { value: current, placeholder: "https://… or paste a URL" }) as HTMLInputElement;
  const idle = () => drop.replaceChildren(
    iconEl("camera", 22),
    h("div", { class: "bv-muted bv-sm" }, "Drag an image here, or click to upload"),
    h("div", { class: "ms-drop-meta" }, opts.hint || "JPG, PNG, WEBP, GIF or SVG · up to 5 MB"));
  const showImage = (src: string, busy = false) => drop.replaceChildren(
    h("img", { src, class: "ms-imgprev", alt: "" }),
    busy ? h("div", { class: "ms-uploading" }, h("span", { class: "ms-spin" }), "Uploading…")
         : h("div", { class: "ms-imgactions" },
             h("button", { class: "bv-btn sm", type: "button", onClick: (e: Event) => { e.stopPropagation(); fileInput.click(); } }, "Replace"),
             h("button", { class: "bv-btn sm", type: "button", onClick: (e: Event) => { e.stopPropagation(); url = ""; urlInput.value = ""; onChange(""); errEl.textContent = ""; idle(); } }, "Remove")));
  const render = () => (url ? showImage(url) : idle());
  const handle = async (file?: File) => {
    if (!file) return;
    const ve = fileTypeError(file);
    if (ve) { errEl.textContent = ve; return; }        // reject inline — no preview, no upload
    errEl.textContent = "";
    let local = "";
    try { local = await readDataUrl(file); } catch (e: any) { errEl.textContent = e.message; return; }
    showImage(local, true);                            // immediate preview + uploading state
    const out = await bvApi<{ url: string }>("/api/upload", { method: "POST", body: JSON.stringify({ data: local }) }).catch((e: any) => ({ __err: e?.message || "Upload failed." }));
    if ((out as any).__err) { errEl.textContent = (out as any).__err; render(); return; } // revert to prior on error
    url = (out as any).url; urlInput.value = url; onChange(url); showImage(url); flash("Image uploaded", "success");
  };
  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e: any) => { e.preventDefault(); drop.classList.remove("over"); handle(e.dataTransfer?.files?.[0]); });
  fileInput.addEventListener("change", (e: any) => { handle(e.target.files?.[0]); e.target.value = ""; });
  urlInput.addEventListener("input", (e: any) => { url = e.target.value; onChange(url); render(); });
  render();
  const alt = h("details", { class: "ms-urlalt" }, h("summary", { class: "bv-muted bv-sm" }, "or paste a URL"), urlInput);
  const wrap = h("div", { class: "field ms-imgfield" }, h("label", { class: "bv-label" }, label), drop, fileInput, errEl, alt);
  return { el: wrap, value: () => url };
}
