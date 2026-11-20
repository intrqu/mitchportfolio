# Gift card setup

The existing static site serves `/gift-cards/` and `/admin/gift-cards/`.
Firebase callable Cloud Functions are the trusted backend. The browser Firebase
configuration contains public web-app values only. Firestore client access is
denied by default.

## Required services and costs

- **Firebase Authentication:** Email/password sign-in for Mitch. The code does
  not use paid SMS authentication.
- **Cloud Firestore:** Orders, encrypted certificate codes, redemption records,
  and rate-limit counters. Current no-cost quotas are subject to Google pricing
  and project limits.
- **Cloud Functions for Firebase:** Required for server-side ordering,
  e-Transfer approval, certificate creation, email, and redemption. Functions
  require the **Blaze** plan and a linked billing account, but have no-cost
  usage allowances. Current published allowances include 2 million
  invocations/month, 400K GB-seconds, 200K CPU-seconds, and 5 GB outbound
  networking; usage above quotas can be billed.
- **Secret Manager:** Firebase Functions secrets hold the Resend API key and
  certificate encryption key and rate-limit HMAC key. Current free usage
  includes six active secret versions and 10,000 accesses/month; additional
  usage can be billed.
- **Build artifacts and logs:** Function deployment uses Cloud Build and
  Artifact Registry; Cloud Logging is also used. They have separate quotas and
  can incur fees if usage or retained artifacts exceed their free allowances.
- **Email:** The server-side adapter is Resend. Its current Free plan includes
  3,000 emails/month and 100/day; sending is limited when a free-plan quota is
  reached. See [Resend pricing](https://resend.com/pricing).
- **App Check:** The public order and payment-report functions require App
  Check. Firebase currently lists App Check as no-cost, subject to provider
  quotas and limits.
- **No Cloud Storage bucket is used.** The server stores only an AES-256-GCM
  encrypted redemption code and certificate details in Firestore, then
  regenerates the same PDF when issuing or resending. This removes the
  Storage-bucket dependency and its Blaze requirement.

Blaze is pay-as-you-go, not a fixed monthly subscription, but it does require
payment details and can create charges beyond no-cost usage. Firebase budget
alerts do **not** stop spending. Set alerts and monitor usage. The functions
are capped at one instance each with concurrency two; this caps scaling per
function, not across the whole project. Public endpoints also have per-IP and
global limits: orders are limited to 2/minute, 5/hour, 20/day per IP and 20/day
globally; payment reports are limited to 5/minute, 10/hour, 30/day per IP.
Payment reports are also capped at 100/day globally. Email attempts are capped
at 80 recipients/day globally. Adjust these technical limits to expected
traffic before launch.

## Security and retries

- Firestore rules deny all direct client reads and writes. All admin callables
  require Firebase Authentication and an `admin: true` custom claim checked on
  the server. Hiding the dashboard URL is not the security control.
- Public order and payment-report callables enforce App Check and rate limits.
  The order reference is server-generated. The browser creates a cryptographically
  random 256-bit order token, keeps it for retries, and the server stores only
  its hash; it only authorizes reporting a transfer. Reusing the token safely
  resumes the same order and email attempts rather than creating duplicate
  orders.
- Rate-limit records retain only keyed HMAC identifiers, not raw IP addresses,
  and expire through a Firestore TTL policy.
- Only an admin-confirmed `paid` order may issue a certificate. Redemption also
  rechecks the paid order inside the same Firestore transaction that updates
  the balance.
- Redemption codes are stored encrypted with AES-256-GCM; their lookup uses a
  SHA-256 hash. Preserve the certificate encryption secret. Rotating or losing
  it without migrating encrypted records makes existing certificate PDFs
  impossible to regenerate.
- Issuance is idempotent: a paid order gets one certificate/code, and retries
  regenerate its PDF using that same code. Redemptions use request IDs and a
  Firestore transaction so retrying the same request cannot deduct twice.
- Resend requests carry Resend idempotency keys; Resend retains these for 24
  hours. Email delivery timestamps are also stored so ordinary retries do not
  resend a successfully delivered certificate or payment confirmation.

The dashboard can still be opened as a static page, but an account without the
admin claim cannot read orders or call administrative operations. There is no
public sign-up control in the dashboard.

## Configure before deployment

1. **Create/select a Firebase project.** Enable Email/Password Authentication
   and create the Firestore database. Choose the database location with privacy
   and data-residency needs in mind. Link a billing account and select Blaze
   before deploying Functions. Add budget alerts; remember that they are not
   hard spending limits.
2. **Register a Firebase web app and App Check.** Register the production
   domain for reCAPTCHA v3, register the web app with Firebase App Check, and
   put the public site key in `firebase-config.js`. Keep the matching reCAPTCHA
   secret in Firebase App Check settings, not in the repository. Replace
   `apiKey`, `authDomain`, `projectId`, and `appId` with the web-app config.
3. **Configure Resend.** Create an account, verify a sender domain and DNS
   records, and decide the verified `EMAIL_FROM` address and admin notification
   recipient(s). The e-Transfer destination must be supplied and verified by
   Mitch; no real address is included in this repository.
4. **Select the Firebase project and set Functions parameters.** Install and
   authenticate Firebase CLI, then select the project. Set these values in
   Functions parameter prompts or `functions/.env.<project-id>` (never commit
   the environment file):

   ```sh
   npm install --global firebase-tools
   firebase login
   firebase use --add
   ```

   ```dotenv
   INTERAC_EMAIL=REPLACE_WITH_MITCHS_VERIFIED_ETRANSFER_EMAIL
   ADMIN_NOTIFICATION_EMAILS=REPLACE_WITH_ADMIN_EMAIL
   EMAIL_FROM=Mitch Harsch Tattoo <verified-sender@your-domain.example>
   EMAIL_PROVIDER=resend
   PUBLIC_SITE_URL=https://mitchharschtattoo.com
   ```

   Set the API key as a Firebase Secret:

   ```sh
   firebase functions:secrets:set RESEND_API_KEY
   ```

   Generate two separate 32-byte keys and store their Base64 values as Firebase
   Secrets. Back up the certificate key securely; never check either key into
   source control:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   firebase functions:secrets:set CERTIFICATE_ENCRYPTION_KEY
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   firebase functions:secrets:set RATE_LIMIT_HMAC_KEY
   ```

5. **Create Mitch's administrator account.** Create the account in Firebase
   Authentication, then grant its UID the `admin` custom claim from a trusted
   machine with Firebase Authentication Admin credentials:

   ```sh
   gcloud auth application-default login
   node functions/scripts/set-admin-claim.cjs FIREBASE_AUTH_UID
   ```

   Sign out and back in so the client receives a refreshed ID token. Do not
   expose service-account credentials in the website or commit them.
6. **Run checks before deployment.**

   ```sh
   cd functions
   npm install
   npm test
   cd ..
   ```

   The test suite covers validation, rate-limit window logic, code encryption,
   PDF generation, and redemption calculations. It does not replace an
   emulator/integration test against Firebase, App Check, or Resend. Use test
   accounts and provider test/sandbox facilities where available.
7. **Only after approval, deploy** the backend, Firestore rules/TTL policy, and
   static website:

   ```sh
   firebase deploy --only functions,firestore:rules,firestore:indexes
   ```

   The website can remain on its current static host. There is no Firebase
   Hosting or Storage target in `firebase.json`.

## Email behavior

Creating an order attempts to email the purchaser exact e-Transfer instructions
and notify the admin. Reporting a sent transfer notifies the admin. After Mitch
checks the bank and confirms payment, the purchaser receives a confirmation and
the recipient receives a PDF attachment. If email delivery fails, the order or
issued certificate remains in the dashboard and the certificate can be resent.
No email API key is exposed to the browser.
