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

The separate production Worker preparation is documented in
[`PRODUCTION_SETUP.md`](PRODUCTION_SETUP.md). It uses another Worker config,
D1 database, Firebase project, and local test suite. Do not use the staging
`.dev.vars` values as production credentials.

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
Wrangler's `--secrets-file` option. Keep the Resend API key only in the
Cloudflare Worker secret store (and never in tracked files, GitHub variables,
or the browser bundle). Staging email is limited to the configured test
recipient allowlist:

- `TURNSTILE_SECRET_KEY`
- `CERTIFICATE_ENCRYPTION_KEY` — independent random 32-byte base64 key
- `RATE_LIMIT_HMAC_KEY` — independent random 32-byte base64 key
- `STAGING_ALLOWED_EMAILS` — controlled test recipient addresses only
- `STAGING_ADMIN_EMAILS` — admin addresses, also included in the email allowlist
- `STAGING_INTERAC_EMAIL` — demonstration recipient shown in order emails;
  never use the address to send money

Set `RESEND_API_KEY` directly as a Cloudflare Worker secret using the
Cloudflare dashboard or `wrangler secret put`. It is not required in local
`.dev.vars` unless you specifically want to send local test email.

Set these Worker variables to staging-only values:

- `EMAIL_FROM=Mitch Harsch Tattoo <giftcards@mitchharschtattoo.com>`
- `TURNSTILE_EXPECTED_HOSTNAME=intrqu.github.io`

The verified Resend sender is enabled for staging. Every message has a
prominent **TEST ONLY — DO NOT SEND MONEY** subject and body banner. Order
emails show the exact test amount, order reference, and demonstration Interac
recipient. Certificate emails attach a **VOID — TEST ONLY** PDF; no real
payment is accepted and no staging certificate is redeemable.

Never commit `.dev.vars`, add API keys to GitHub variables, or send production
customer data to this Worker. Do not add a real payment integration or
production credentials.

## Live staging email test

1. Submit a test order using an email address in `STAGING_ALLOWED_EMAILS` and
   complete the staging Turnstile check. Confirm the order email has the test
   warning, demo recipient, exact amount, and order reference.
2. Sign in to the staging admin dashboard and simulate payment for that order.
   Confirm the payment-simulation email and certificate email arrive; the PDF
   must say **VOID — TEST ONLY**.
3. Never send an e-Transfer. The displayed Interac address and instructions
   are demonstration text, and staging does not accept or reconcile money.

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
