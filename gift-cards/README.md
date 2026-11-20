# Gift card staging application

The existing static site serves `/gift-cards/` and `/admin/gift-cards/`. Its
staging JavaScript calls the Cloudflare Worker API; Firebase Authentication is
used only to sign the administrator in. See [`../STAGING.md`](../STAGING.md)
for provider setup and costs, and [`../worker/README.md`](../worker/README.md)
for the API, database schema, local tests, and deployment boundary.

The Pages build is sanitized and visibly marked **TEST SITE — NOT LIVE**.
Staging orders do not accept money. Admin-only payment simulation can issue a
certificate marked **VOID — TEST ONLY**. Test redemptions exist only to verify
the balance workflow and cannot produce a production-redeemable certificate.

The browser receives only Firebase web-app values, the public Worker URL, and
the public Turnstile site key. Resend credentials, Turnstile secrets, and
certificate-encryption/HMAC keys stay in Worker secrets. All D1 writes,
payment-state changes, certificate issuance, email delivery, and redemptions
are server-side.

No Worker, D1 database, remote migration, or public deployment has been run.
Follow `STAGING.md` one step at a time; public deployment requires the owner's
explicit approval.
