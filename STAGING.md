# GitHub Pages staging

The staging deployment is intentionally isolated from the existing production
Pages site. Use a separate public repository named
`intrqu/mitchportfolio-staging` and push the `staging` branch there. Never use
the production repository's Pages deployment for this workflow: it currently
serves `mitchharschtattoo.com`.

The expected test URL is
<https://intrqu.github.io/mitchportfolio-staging/>. Set the staging repository's
Pages source to **GitHub Actions**. The workflow only runs for the
`staging` branch in that exact repository; it is guarded against deploying from
the production repository.

No Firebase, Resend, Stripe, Formspree, or other application secrets are needed.
The workflow builds `_staging-dist` and publishes only that directory. The
artifact excludes Firebase configuration and Functions, `CNAME`, and the
production sitemap. Gift-card and admin actions are browser-only demonstrations
with synthetic admin data. No order is saved or sent; test certificate previews
are marked **VOID — TEST ONLY**, have no redemption code, and cannot be
redeemed.

Run the same build locally with:

```sh
node scripts/build-staging.mjs
```

Use synthetic details only. The site does not send gift-card form values to a
backend, but the existing social embeds and hosted fonts may still contact
their providers. The test URL is public even though it requests `noindex`.
