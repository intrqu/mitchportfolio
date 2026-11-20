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
deliver mail only to addresses explicitly allowlisted in Worker configuration.

A staging D1 database has been created and its initial additive schema has
been applied. The Worker and public site have not yet been deployed; no paid
service has been enabled.

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
- **Email delivery** is disabled while no verified non-production sender
  domain is available. The Worker will not make Resend requests without both
  a Resend API key and sender address; email states will report not configured.

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

## Manual setup sequence (not performed)

Do these steps one at a time. Stop if a console asks for a payment method,
paid plan, production DNS change, or paid add-on.

1. **Completed:** Cloudflare account created without adding a billing card or
   purchasing a plan.
2. **Completed:** D1 database `mht-giftcards-staging` created. Its ID is set in
   `worker/wrangler.toml`; its schema has not been migrated.
3. **Completed:** Turnstile widget created for `intrqu.github.io`. Its public
   site key still needs to be added as a GitHub Actions variable; its secret
   key belongs in Worker secrets. Do not reuse a production widget.
4. **Completed:** The separate Firebase staging project uses Email/Password
   sign-in, authorizes `intrqu.github.io`, has a registered web app, and has a
   test admin with the `admin: true` claim.
5. **Deferred:** Resend requires a verified sender domain. No separate
   non-production domain is available, and production DNS must not be changed.
   Do not configure live email credentials until an approved staging sender
   domain is available. Tests continue to mock email delivery.
6. Configure Cloudflare Worker variables and secrets. Keep `RESEND_API_KEY`,
   `TURNSTILE_SECRET_KEY`, `CERTIFICATE_ENCRYPTION_KEY`, and
   `RATE_LIMIT_HMAC_KEY` only in Worker secrets. Never put them in GitHub,
   Pages, or browser code. Use separate random 32-byte base64 keys for the
   encryption and HMAC secrets.
7. Run local tests and inspect configuration. A public Worker deployment,
   remote D1 migration, or Pages publication requires separate explicit
   approval. Do not run `wrangler deploy` or `wrangler d1 ... --remote` before
   that approval.
8. After Worker deployment is approved and available, add these public GitHub
   Actions **variables** to `intrqu/mitchportfolio-staging`:
   `STAGING_WORKER_API_URL`, `STAGING_TURNSTILE_SITE_KEY`,
   `STAGING_FIREBASE_API_KEY`, `STAGING_FIREBASE_AUTH_DOMAIN`,
   `STAGING_FIREBASE_PROJECT_ID`, and `STAGING_FIREBASE_APP_ID`. The Pages
   workflow only builds for that staging repository and branch.

### Firebase admin claim tool

Install the local-only admin helper and authenticate with Application Default
Credentials authorized for the staging project:

```sh
npm install --prefix scripts/firebase-admin
gcloud auth application-default login
npm run --prefix scripts/firebase-admin set-admin-claim -- STAGING_AUTH_UID
```

The helper hard-codes `mht-giftcards-staging`; never use production credentials
or another project.

## Important safety notes

- The GitHub Pages site is public; `noindex` is not access control. Only
  synthetic data and allowlisted test inboxes belong there.
- No real Interac address, card payment, Stripe integration, payment webhook,
  or production certificate is configured. The staging admin action simulates
  payment only.
- Firebase client configuration, the Worker URL, and the Turnstile site key
  are public. Firebase service-account credentials, Resend keys, Turnstile
  secrets, encryption keys, and HMAC keys are not.
- Server-side writes require the staging Worker. Browser clients cannot access
  D1 or change payment state, issue codes, or alter balances directly.
