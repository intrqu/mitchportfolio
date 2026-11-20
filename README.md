# Mitch Harsch Tattoo

Open `index.html` in a browser. The site runs directly from these files and can also be uploaded to a static web host. Google Fonts improves the typography when available. Local font fallbacks cover offline use.

## Replace the preview content

- The portfolio in `index.html` uses Mitch's tattoo photos in `assets/portfolio`. Keep captions and alt text accurate when replacing or adding work. Keep the lightbox markup and the link classes for the gallery interaction.
- The artist portrait is stored at `assets/artist-portrait.jpg`. Replace it with a higher-resolution photo and update its alt text when available. Add the artist’s biography and studio location.
- The Instagram section loads the public Elfsight feed widget for `@mitchharsch`. Manage the feed layout, background, gutters, and profile-header display in the Elfsight widget settings.
- The inquiry form submits to Formspree (`https://formspree.io/f/xkjroedl`) and sends submissions to the configured Formspree recipient. The current service and its plan are separate from gift card email.

The hero still life is original AI-generated preview imagery.

## Gift cards

The staging-only gift-card system uses the existing static site with a
Cloudflare Worker and D1 backend. Firebase Authentication is retained only for
admin sign-in; certificate codes, email credentials, and balances remain
server-side. See [`STAGING.md`](STAGING.md) for local tests, safe setup, and
deployment approval boundaries.

