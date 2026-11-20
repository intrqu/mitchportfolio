# Staging gift card Worker

This Worker is restricted to `APP_ENV=staging` and Firebase project
`mht-giftcards-staging`. It is not a payment processor. Its only payment action
is a Firebase-admin-authorized **test simulation** that permanently marks any
result **VOID — TEST ONLY**.

## Local development and tests

```sh
npm ci --legacy-peer-deps
npm run typecheck
npm test
npx wrangler dev --local
```

The Vitest plugin runs against local Workers/D1. It applies the migration in
`migrations/0001_init.sql` and mocks Turnstile and Resend. The test suite checks
order persistence/idempotency, rate limits, email retries, Firebase ID-token
verification and admin permissions, payment gating, PDF delivery, issuance
idempotency, and concurrent partial redemptions. It also checks local PDF
generation against a 10 ms target. Cloudflare does not accept a custom CPU
limit on the Free plan, so this is a local benchmark and not a guarantee of
remote latency or CPU usage under every condition.

`npx wrangler dev --local` serves
`http://127.0.0.1:8787/api/healthz`. For a local order flow, copy
`.dev.vars.example` to `.dev.vars` and use test-only Firebase/Turnstile
settings. Never put secrets in Pages or GitHub variables.

## API

- `GET /api/healthz` — public staging health check.
- `POST /api/orders` — public, Turnstile-protected order creation/recovery.
- `GET /api/orders/:reference/certificate.pdf` — bearer-token download, only
  after admin payment simulation and certificate issuance.
- `GET /api/admin/orders` — Firebase-admin-authenticated order list.
- `POST /api/admin/orders/:id/retry-order-emails` — idempotently retries the
  order confirmation and staging-admin notification.
- `POST /api/admin/orders/:id/simulate-payment` — payment simulation,
  confirmation email, and void test certificate issuance.
- `POST /api/admin/orders/:id/issue` — certificate issuance after simulation.
- `POST /api/admin/orders/:id/resend` — regenerate and resend the existing PDF.
- `POST /api/admin/certificates/lookup` — certificate and redemption history.
- `POST /api/admin/certificates/redeem` — atomic partial/full test redemption.

Firebase Auth tokens are verified by the Worker against Google's signing keys
and the exact staging issuer/audience. The signed `admin: true` custom claim
and configured admin email allowlist are both required. A browser-side admin
check is only a usability layer; the Worker performs authorization on every
admin route.

## D1 data and idempotency

Orders and certificates have database-level test-only/payment constraints.
Certificate redemption codes are generated with Web Crypto, stored encrypted
with AES-GCM, and indexed by a SHA-256 hash. The code is decrypted only to
regenerate a certificate email/PDF. Redemptions are recorded in a D1 batch
transaction; a unique request ID and a `deduction_applied` guard prevent a
retry or concurrent request from deducting twice. Email sends have unique
idempotency keys and stored delivery state.

No PDF objects are stored outside D1. No Stripe, Interac payment, webhook,
Firebase Functions, Firestore, or Cloud Storage integration is included.

## Configuration

`wrangler.toml` contains safe staging defaults and placeholders:

- `APP_ENV=staging` and `FIREBASE_PROJECT_ID=mht-giftcards-staging`
- `PUBLIC_SITE_ORIGIN=https://intrqu.github.io`
- `PUBLIC_SITE_URL=https://intrqu.github.io/mitchportfolio-staging/`
- the D1 binding to the separate staging database; its initial schema has been
  migrated
- a five-request edge rate limit, additional D1 per-IP limits, a daily order
  cap, and an email daily cap
- no explicit CPU limit, since Cloudflare rejects custom CPU limits on the Free
  plan; the local PDF test uses a 10 ms target

Set these server-only secrets in local `.dev.vars`; deploy them through
Wrangler's `--secrets-file` option. Keep the Resend key absent until an
approved non-production sender domain is available:

- `TURNSTILE_SECRET_KEY`
- `CERTIFICATE_ENCRYPTION_KEY` — independent random 32-byte base64 key
- `RATE_LIMIT_HMAC_KEY` — independent random 32-byte base64 key
- `STAGING_ALLOWED_EMAILS` — controlled test recipient addresses only
- `STAGING_ADMIN_EMAILS` — admin addresses, also included in the email allowlist

Set these Worker variables to staging-only values:

- `EMAIL_FROM`
- `TURNSTILE_EXPECTED_HOSTNAME=intrqu.github.io`

Never commit `.dev.vars`, add API keys to GitHub variables, or send production
customer data to this Worker. Do not configure Interac details or production
credentials.

## GitHub Pages configuration

The `staging` branch's Pages workflow is guarded to the separate
`intrqu/mitchportfolio-staging` repository. Its build requires these public
Actions variables:

- `STAGING_FIREBASE_API_KEY`
- `STAGING_FIREBASE_AUTH_DOMAIN`
- `STAGING_FIREBASE_PROJECT_ID` (must be `mht-giftcards-staging`)
- `STAGING_FIREBASE_APP_ID`
- `STAGING_WORKER_API_URL` (the staging `workers.dev` URL)
- `STAGING_TURNSTILE_SITE_KEY`

The browser bundle intentionally contains only these public configuration
values. Worker secrets must never be copied into Pages configuration. The
build rejects production Firebase projects, non-Workers API hosts, production
contact/payment markers, and paths that escape the GitHub Pages project base.

## Deployment boundary

This repository contains no Worker deployment credentials. Do not run
`wrangler deploy`, `wrangler d1 ... --remote`, or publish the Pages branch
without explicit owner approval. Cloudflare free quotas, Firebase Auth terms,
GitHub Pages terms, and Resend plan limits can change; confirm current pricing
before enabling any public service. See [`../STAGING.md`](../STAGING.md) for
the staged setup sequence.
