# Mini-site

A real storefront on the apps-core stack. Rebuilt 2026-06-12 to fix what v1 lacked
(a single hero/about/links page — no products, no ordering, no handle, a UUID URL with a
`my-business-…` slug, "My business" lorem defaults).

## What it does
- **Products**: app-managed products **+ one-click "Import from catalog"** (pulls the
  merchant's real catalog via `products:read` → `GET products` → `result.entries`).
- **Ordering**: each product has an **Order** button → name+email → **real Inkress hosted
  checkout** (`createInkressOrder`, `kind:"online"` → `payment_url`). The money path the old
  app never had.
- **Vanity URL**: merchant picks a **handle**; the storefront lives at
  `mini-site.apps.inkress.com/s/<handle>` — no UUID, no random slug. (Custom domains via the
  gateway on-demand-TLS rail are the remaining P2.)
- **Brand hydration**: on install the site name/logo/handle are seeded from the merchant
  profile (no "My business"/example.com lorem).
- **Polished public storefront**: hero (logo, name, tagline, CTA) + products grid + about +
  links + contact + optional social proof ("N orders fulfilled here", driven by paid-order
  webhooks), themeable accent/preset, OG/social meta. Curated layout, not a free-form builder.
- **Editor SPA**: Overview (status, public URL, publish, handle, setup checklist), Design
  (brand/hero/theme/CTA), Products (manage + import), Content (about, links, contact, section
  toggles).

## Stack & env
Express + `@inkress/apps-core` (Postgres schema `mini_site`, app-bridge session, `createInkressOrder`,
catalog read, S3 image upload, webhooks). Vite/TS SPA on the shared `apps-core/browser` UI kit.
Env: `OAUTH_CLIENT_ID/SECRET`, `INKRESS_API_BASE`, `APPS_DATABASE_URL`, `INKRESS_WEBHOOK_SECRET`,
`PUBLIC_BASE_URL`, optional `AWS_*`/`S3_BUCKET`/`S3_PUBLIC_BASE` (image uploads → else URL paste).
Scopes: `orders:read orders:write products:read merchant_profile:read customers:write offline_access webhooks:manage`.

## Verified (2026-06-12)
Local (throwaway pg): vite+tsc clean; published storefront renders products + Order buttons +
social proof; unpublished handle → 404; buy reaches the order path; bad email → 400; missing
product → 404; HMAC webhook marks orders paid.
**Live as Jack Jack** (`mini-site.apps.inkress.com`, deployed in place over the legacy
`mini-site-app` Coolify service): imported 3 real catalog products, published, storefront live
at `/s/jack-jack` with the real Jack Jack logo, **Order → real Inkress hosted checkout (J$400,
3-D Secure)**.

## Notes
- The legacy `mini_site` schema is handled with `ALTER TABLE ADD COLUMN IF NOT EXISTS` (same
  lesson as Loyalty v2 — a pre-existing same-named schema makes `CREATE TABLE IF NOT EXISTS` a no-op).
- Re-registered in place (idempotent-by-name): the key change was **adding the storefront
  scopes** (v1 had only `orders:read,customers:read,merchant_profile:read` — no products, no selling).
