# Production gift card preparation

The initial production Worker has been deployed to
`https://mht-giftcards-api.jenfrolics.workers.dev`. All six required production
secrets are configured in the Worker secret store; their values are
intentionally not recorded in this file or source. Migration
`migrations/production/0001_init.sql` has been applied to
`mht-giftcards-production` (database ID
`26ccd01c-190b-4b58-9c06-c85a7809747f`) and its schema was verified. Worker
health returns `200` with `orderingEnabled=false`. No production orders or
emails have been created or sent, and online ordering remains disabled
(`ORDERS_ENABLED=false`, `MAX_ORDER_AMOUNT_CENTS=0`). The existing production
website and DNS were not changed.

## Resources and isolation

- Cloudflare Worker: `mht-giftcards-api`
- Cloudflare D1: `mht-giftcards-production`
- Firebase project: `mht-giftcards-production`
- Allowed site origin: `https://mitchharschtattoo.com`
- Email sender: `Mitch Harsch Tattoo <giftcards@mitchharschtattoo.com>`
- Payment method: manual Interac e-Transfer; a customer report never confirms
  payment. An administrator must use **Confirm Payment Received** after
  checking the bank account.

The production schema marks records `environment='production'` and
`test_only=0`. The staging database and schema remain separate. Production
redemption codes use the `MHT-PROD-` prefix; staging codes are rejected by the
production parser. PDFs are generated on demand from encrypted certificate
records in D1; no Cloud Storage binding is used.

## Production configuration

### Cloudflare Worker secrets

All six secrets below are configured only in the production Worker secret
store. Their values are not recorded here. Never put them in source, GitHub
Actions variables, a frontend bundle, or staging `.dev.vars`:

- `PRODUCTION_ADMIN_EMAILS` — comma-separated production admin email
  allowlist. Each admin also needs the Firebase `admin: true` custom claim.
- `PRODUCTION_INTERAC_EMAIL` — the approved Interac recipient address.
- `RESEND_API_KEY` — production Resend API key with sending access.
- `TURNSTILE_SECRET_KEY` — secret for the production Turnstile widget.
- `CERTIFICATE_ENCRYPTION_KEY` — independent random 32-byte key, base64
  encoded. Keep a recoverable, access-controlled backup; losing it prevents
  decrypting issued certificate codes.
- `RATE_LIMIT_HMAC_KEY` — a different independent random 32-byte key, base64
  encoded. Do not reuse the certificate key.

Do not paste any of these values into a terminal command line that is saved
to shell history. Use the Cloudflare dashboard's secret input or another
approved secure secret-entry method. Secret updates may publish a Worker
version; do not rotate or change them without separate approval.

### Non-secret Worker values

`worker/wrangler.production.toml` currently contains the production project,
origin, sender, D1 resource ID, and conservative limits. Ordering is off and
the maximum order value is zero. Keep those settings unchanged until a
separate approval to enable live ordering. The production Turnstile hostname
is `mitchharschtattoo.com`.

The production admin page/client is prepared at
`/admin/gift-cards/production/`. The deployed Worker URL is
`https://mht-giftcards-api.jenfrolics.workers.dev`; the production frontend
configuration now targets that URL. The local review artifact is in
`_production-pages-dist/` and has not been published. The production Firebase
web-app API key and App ID have been configured as public values. These are
public values, unlike Firebase Admin SDK credentials, the Turnstile secret,
Resend key, and certificate keys. The production Turnstile **site key** is
not yet configured. The customer form reads `PRODUCTION_TURNSTILE_SITE_KEY` as
a public build value and stays disabled if it is absent. Use the site key
paired with the production Turnstile widget for `mitchharschtattoo.com`; never
use a staging key. The matching secret remains in the Worker secret store.

The current live Pages settings use legacy publishing from the `master` branch
root and serve `mitchharschtattoo.com`. The separate
`.github/workflows/production-pages-artifact.yml` workflow is manual-only,
restricted to that repository's `master` branch, and only builds/uploads an
artifact for review; it has no deployment step. Its build starts from the
existing master site, preserves the existing pages, assets, and `CNAME`, and
adds the production admin route and a production customer form that remains
disabled until both the Worker health check and production Turnstile
configuration allow it. Artifact upload does not change the live site. A
future Pages Actions cutover would replace the published artifact and requires
explicit approval after reviewing the complete artifact. Do not add production
values to the staging Pages workflow.

### Firebase admin authorization

The Worker requires both the Firebase `admin: true` claim and an email in
`PRODUCTION_ADMIN_EMAILS`. The helper
`scripts/firebase-admin/set-production-admin-claim.cjs` is hard-coded to
`mht-giftcards-production`, checks the target UID's enabled account email,
preserves existing custom claims, and verifies the claim afterward. The
initial administrator's `admin: true` claim has been assigned and independently
verified in `mht-giftcards-production`.

When explicitly approved, use a trusted workstation authenticated with
least-privilege Firebase Admin credentials for the production project:

```sh
cd scripts/firebase-admin
npm ci
npm run set-production-admin-claim -- PRODUCTION_AUTH_UID ADMIN_EMAIL
```

Replace the placeholders with the production Firebase Auth UID and its
matching email. Never put a service-account JSON file in this repository.
After the claim is set, the admin must sign out and sign back in to receive a
fresh ID token.

## Local checks

Run from `worker/`:

```sh
npm run typecheck
npm test
```

The production test suite uses a local Miniflare D1 database and dummy
Turnstile, Resend, Interac, and encryption values supplied by
`vitest.production.config.ts`; no real email is sent. The migration is applied
only to that local test database. Do not run `wrangler deploy` or any
`wrangler d1 ... --remote` command during local validation.

The gift-card sales dashboard and archive controls require production migration
`0002_order_archive.sql`. After release approval, apply it to production D1,
deploy the production Worker, then publish the admin frontend. Publishing to
the live Pages branch can update the site under the legacy Pages configuration.
The migration leaves existing orders active and adds indexes for the new views.

## Production sequence — each remaining live step requires separate approval

1. **Complete:** The initial Firebase admin claim is assigned and verified,
   and the admin email is included in `PRODUCTION_ADMIN_EMAILS`.
2. **Complete:** All six Worker secrets are configured in the production
   Cloudflare account. Keep staging keys and values separate.
3. **Complete:** `migrations/production/0001_init.sql` is applied to the
   production D1 database only. The six gift-card tables, four explicit
   indexes, and global-limits seed row were verified.
4. Verify production admin authorization without creating customer orders.
   Worker health is already verified; ordering must remain disabled.
5. Add the public GitHub Actions variables `PRODUCTION_FIREBASE_API_KEY`,
   `PRODUCTION_FIREBASE_APP_ID`,
   `PRODUCTION_WORKER_API_URL=https://mht-giftcards-api.jenfrolics.workers.dev`,
   and `PRODUCTION_TURNSTILE_SITE_KEY` from the production Turnstile widget.
   Run the artifact-only workflow and review its contents. Without the
   Turnstile site key, customer ordering remains unavailable.
6. Only after explicit approval, switch Pages from legacy publishing to
   Actions and publish the reviewed full-site artifact with the production
   admin page. Confirm the existing custom domain and site content remain
   intact. This is a publishing change and is not included in the current
   workflow.
7. Only after another explicit approval, enable live ordering by changing
   `ORDERS_ENABLED` and the approved maximum amount, then deploy the Worker.
   A customer payment report is never proof of receipt; only manual admin
   confirmation issues a certificate.

The initial Worker deployment, production secret configuration, and initial
D1 migration are complete. No production email, customer order, certificate,
or redemption has been created; no DNS change, Pages publication, or
live-ordering enablement has been performed.
