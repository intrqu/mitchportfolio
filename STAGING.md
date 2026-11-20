# Gift card staging

The public test site is the separate GitHub Pages repository at
<https://intrqu.github.io/mitchportfolio-staging/>. Its static pages call a
staging-only Cloudflare Worker backed by D1. The Worker verifies Firebase
Authentication ID tokens for admin operations; it does not use Firebase
Cloud Functions, Firestore, or Cloud Storage.

The Worker is locked to `APP_ENV=staging` and Firebase project
`mht-giftcards-staging`. Public orders are synthetic test records: no payment
is requested or accepted. An allowlisted staging administrator can simulate
payment to test certificate delivery and partial redemption. Every staging
certificate and PDF says **VOID — TEST ONLY** and has no value. Resend can
deliver staging mail only to addresses explicitly allowlisted in Worker
configuration. Every email prominently says **TEST ONLY — DO NOT SEND MONEY**;
the Interac details are demonstration text only.

A staging D1 database has been created and its initial additive schema has
been applied. The staging Worker is deployed at
<https://mht-giftcards-staging-api.jenfrolics.workers.dev/> and the Pages site
is live at <https://intrqu.github.io/mitchportfolio-staging/>. No paid service
has been enabled.

## Architecture and services

- **GitHub Pages** serves the existing static site and its staging-only banner.
- **Cloudflare Workers** serves the API. `wrangler.toml` leaves CPU limits
  unset because custom CPU limits are not supported on the Free plan; it sets
  a small edge rate limit, staging-only Firebase project checks, and the D1
  binding.
- **Cloudflare D1** stores orders, encrypted certificate codes, balances,
  redemptions, rate-limit counters, and email delivery/idempotency records.
  PDF files are regenerated from D1 records; there is no object-storage
  dependency.
- **Cloudflare Turnstile** verifies public order submissions. The Worker also
  applies per-IP and daily D1 caps.
- **Firebase Authentication** is used only for the private admin login and
  signed ID tokens. The Worker verifies Firebase's RS256 signature, issuer,
  audience, expiration, `admin: true` custom claim, and the admin email
  allowlist. Firebase App Check, Cloud Functions, and Firestore are not used.
- **Email delivery** uses Resend from the verified sender configured for the
  staging Worker. The API key remains a Cloudflare Worker secret, and the
  Worker sends only to explicitly allowlisted test inboxes. Resend quotas and
  terms may change; verify them before use.

Cloudflare currently offers Workers, D1, and Turnstile free-tier quotas, but
quotas and plan terms can change. D1/Worker usage above free quotas can fail
closed; do not enable paid features or add a billing method during staging
setup. GitHub Pages and Firebase Authentication also have their own current
terms and limits. Resend's free email quota and verified-sender requirements
are separate; actual mail delivery may require a verified sender domain and
DNS records. Do not change production DNS. Confirm current provider terms
before enabling any public integration.

## Local implementation checks

From `worker/`:

```sh
npm ci --legacy-peer-deps
npm run typecheck
npm test
npx wrangler dev --local
```

The integration tests use Miniflare D1 and mocked Turnstile/Resend HTTP
responses. They cover order idempotency, rate limits, email retries, real
Firebase-token signature/claim verification, admin authorization, payment
gating, PDF attachment generation, duplicate issuance, partial redemption,
concurrent redemption, and certificate balance/history. The PDF test asserts
generation stays below a 10 ms target in the local Worker runtime. This is a
local measurement, not a guarantee of remote runtime performance under all
workloads.

`worker/.dev.vars.example` documents local Worker-only secrets and settings.
Copy it to `worker/.dev.vars`, fill in staging-only values, and never commit
that file. Local HTTP may use Cloudflare's documented Turnstile test keys; do
not use a production secret. The local API health check is
`http://127.0.0.1:8787/api/healthz`.

The static staging artifact can be validated locally with safe placeholder
Firebase web values and a local Worker URL:

```powershell
$env:STAGING_FIREBASE_API_KEY = "local-test-value"
$env:STAGING_FIREBASE_AUTH_DOMAIN = "mht-giftcards-staging.firebaseapp.com"
$env:STAGING_FIREBASE_PROJECT_ID = "mht-giftcards-staging"
$env:STAGING_FIREBASE_APP_ID = "local-test-app"
$env:STAGING_WORKER_API_URL = "http://127.0.0.1:8787"
$env:STAGING_TURNSTILE_SITE_KEY = "local-test-site-key"
node scripts/build-staging.mjs
```

The generated `_staging-dist` is ignored. The Pages build requires public
configuration for the staging Firebase web app, the deployed Worker URL, and
the Turnstile site key. These values are not secrets. It rejects non-staging
Firebase projects and Worker URLs outside `workers.dev` (or local development).

## Setup status

The following staging-only setup is complete except where noted. Stop if a
console asks for a payment method, paid plan, production DNS change, or paid
add-on.

1. **Completed:** Cloudflare account created without adding a billing card or
   purchasing a plan.
2. **Completed:** D1 database `mht-giftcards-staging` created; its additive
   initial schema is applied.
3. **Completed:** Turnstile widget created for `intrqu.github.io`. The public
   site key is a GitHub Actions variable; its secret key is stored only as a
   Worker secret. Do not reuse a production widget.
4. **Completed:** The separate Firebase staging project uses Email/Password
   sign-in, authorizes `intrqu.github.io`, has a registered web app, and has a
   test admin with the `admin: true` claim.
5. **Completed:** The sender `giftcards@mitchharschtattoo.com` is verified
   with Resend. The staging Worker uses that sender and its `RESEND_API_KEY`
   Cloudflare secret; the key is not in source, GitHub, or the frontend.
   Resend delivery is restricted to the configured test-inbox allowlist.
6. **In progress:** Add `STAGING_INTERAC_EMAIL` to the ignored local
   `worker/.dev.vars` as `mitchharsch@gmail.com`, then deploy the Worker
   configuration. It is a demo destination only; never send money. Do not
   put it in tracked configuration or GitHub variables.
7. **Completed:** The staging Worker was deployed on the Free plan. It serves
   `https://mht-giftcards-staging-api.jenfrolics.workers.dev/`. Cloudflare
   Free does not accept a custom CPU limit, so `cpu_ms` is unset; the local PDF
   test retains a 10 ms target.
8. **Completed:** GitHub Actions public variables are set and the staging Pages
   workflow deployed `https://intrqu.github.io/mitchportfolio-staging/`.
   Future Pages deployments must remain limited to
   `intrqu/mitchportfolio-staging` and its `staging` branch.

### Firebase admin claim tool

Install the local-only admin helper and authenticate with Application Default
Credentials authorized for the staging project:

```sh
npm install --prefix scripts/firebase-admin
gcloud auth application-default login
gcloud auth application-default set-quota-project mht-giftcards-staging
npm run --prefix scripts/firebase-admin set-admin-claim -- STAGING_AUTH_UID
```

The quota-project command only updates local ADC quota metadata; it does not
enable Firebase billing. The helper uses Firebase Admin's modular API,
hard-codes `mht-giftcards-staging`, and verifies the claim after setting it.
Never use production credentials or another project.

## Important safety notes

- The GitHub Pages site is public; `noindex` is not access control. Only
  synthetic data and allowlisted test inboxes belong there.
- Interac details in staging emails are demo-only. No real payment, Stripe
  integration, payment webhook, or redeemable certificate is configured. The
  staging admin action simulates payment only.
- Firebase client configuration, the Worker URL, and the Turnstile site key
  are public. Firebase service-account credentials, Resend keys, Turnstile
  secrets, encryption keys, and HMAC keys are not.
- Server-side writes require the staging Worker. Browser clients cannot access
  D1 or change payment state, issue codes, or alter balances directly.
