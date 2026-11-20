import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "_staging-dist");
const repository = process.env.GITHUB_REPOSITORY || "intrqu/mitchportfolio-staging";
const [owner, repo] = repository.split("/");

if (!owner || !repo || repository.split("/").length !== 2) {
  throw new Error("GITHUB_REPOSITORY must be in owner/repository form.");
}

const pagesBase = `https://${owner}.github.io/${repo}/`;
const pagesPath = `/${repo}/`;
const pages = [
  "index.html",
  "flash.html",
  "gift-cards/index.html",
  "admin/gift-cards/index.html"
];
const staticFiles = [
  "favicon.svg",
  "site.js",
  "style.css",
  "staging.css",
  "staging.js",
  "gift-cards.js",
  "admin-gift-cards.js"
];

if (existsSync(output)) {
  if (path.dirname(output) !== root || path.basename(output) !== "_staging-dist") {
    throw new Error("Refusing to clean an unexpected staging output path.");
  }
  rmSync(output, { recursive: true, force: true });
}
mkdirSync(output, { recursive: true });
for (const file of staticFiles) copyFile(file);
writeFirebaseConfig();
cpSync(path.join(root, "assets"), path.join(output, "assets"), { recursive: true });

for (const page of pages) {
  const file = path.join(output, page);
  mkdirSync(path.dirname(file), { recursive: true });
  let html = readFileSync(path.join(root, page), "utf8");
  html = preparePage(html, page);
  writeFileSync(file, html);
}

writeFileSync(path.join(output, "robots.txt"), "User-agent: *\nDisallow: /\n");
verifyOutput();
console.log(`Built ${pages.length} staging pages in ${path.relative(root, output)} for ${pagesBase}`);

function copyFile(file) {
  cpSync(path.join(root, file), path.join(output, file));
}

function preparePage(source, page) {
  let html = source;
  const prefix = "../".repeat(path.posix.dirname(page) === "."
    ? 0
    : path.posix.dirname(page).split("/").length);

  html = html.replace(
    /<a\b(?=[^>]*\bhref=["']mailto:[^"']*["'])[^>]*>[\s\S]*?<\/a>/gi,
    '<span class="staging-disabled-contact">Email contact is disabled on this test site.</span>'
  );
  html = html.replace(/mitchharsch@gmail\.com/gi, "Email contact disabled");
  html = html.replace(
    /<form\b(?=[^>]*\bid=["']inquiry["'])[^>]*>[\s\S]*?<\/form>/i,
    '<div id="inquiry" class="staging-disabled-form"><p>Inquiry submissions are disabled on this test site. No message is sent.</p></div>'
  );
  if (page === "gift-cards/index.html") {
    html = html
      .replace(
        /<fieldset>\s*<legend>Payment method<\/legend>[\s\S]*?<\/fieldset>/i,
        "<fieldset><legend>Payment</legend><p>TEST MODE — payment is disabled. No money will be collected.</p></fieldset>"
      )
      .replace(
        "The total shown is the exact amount to send by e-Transfer.",
        "The amount is for testing only. No payment will be collected."
      )
      .replace("Place e-Transfer order", "Create test order")
      .replace("Your certificate is issued after Mitch confirms the payment.",
        "Any certificate issued in this isolated test project is VOID — TEST ONLY.")
      .replace(
        "Interac orders remain inactive until the payment is confirmed. No certificate code is created before then.",
        "Test payments are simulated by an authorized staging administrator. Test certificates have no monetary value and are not valid for services."
      )
      .replace(
        /<dl class=["']payment-details["']>[\s\S]*?<\/dl>/i,
        '<dl class="payment-details"><div><dt>Test order reference</dt><dd><code id="order-reference"></code> <button type="button" class="copy-button" id="copy-reference">Copy test reference</button></dd></div><div><dt>Test amount</dt><dd id="transfer-amount"></dd></div></dl>'
      )
      .replace(
        "The certificate will be issued after payment confirmation. Reporting your transfer does not activate it.",
        "A test certificate can be issued only by an authorized staging administrator and is always marked VOID — TEST ONLY."
      )
      .replace(/<button id=["']payment-reported["']/i, '<button id="payment-reported" hidden');
  }

  if (page === "admin/gift-cards/index.html") {
    html = html
      .replace(
        "Confirm e-Transfer payments only after checking the bank account. Customer reports are not payment confirmation.",
        "STAGING ONLY. Simulate payment; no money is received. Every test certificate is VOID — TEST ONLY. Balance changes are isolated test data."
      )
      .replace("Private area", "Private test-only area");
  }

  html = html.replace(/<link rel=["']canonical["'][^>]*>\s*/i, "");
  const canonical = new URL(page === "index.html" ? "" : page.replace(/\/index\.html$/, "/"), pagesBase).href;
  html = html.replace(
    /<meta name=["']robots["'][^>]*>\s*/i,
    '<meta name="robots" content="noindex, nofollow">\n  '
  );
  if (!/<meta name=["']robots["']/.test(html)) {
    html = html.replace("</head>", '  <meta name="robots" content="noindex, nofollow">\n</head>');
  }
  html = html.replace("</head>",
    `  <link rel="canonical" href="${canonical}">\n  <link rel="stylesheet" href="${prefix}staging.css">\n</head>`);
  html = html.replace(/<body\b[^>]*>/i,
    (tag) => `${tag}\n  <div class="staging-banner" role="status"><strong>TEST SITE — NOT LIVE</strong><span>No real payments. Test emails are allowlisted; certificates are VOID — TEST ONLY.</span></div>`);
  html = html.replace("</body>", `  <script src="${prefix}staging.js" defer></script>\n</body>`);
  return html;
}

function writeFirebaseConfig() {
  const workerApiBaseUrl = (process.env.STAGING_WORKER_API_URL || "").replace(/\/+$/, "");
  const config = {
    apiKey: process.env.STAGING_FIREBASE_API_KEY || "",
    authDomain: process.env.STAGING_FIREBASE_AUTH_DOMAIN || "",
    projectId: process.env.STAGING_FIREBASE_PROJECT_ID || "",
    appId: process.env.STAGING_FIREBASE_APP_ID || "",
    workerApiBaseUrl,
    turnstileSiteKey: process.env.STAGING_TURNSTILE_SITE_KEY || "",
    stagingTestMode: true
  };
  const required = ["apiKey", "authDomain", "projectId", "appId", "workerApiBaseUrl", "turnstileSiteKey"];
  const missing = required.filter((key) => !config[key]);
  if (missing.length) {
    throw new Error(`Missing staging web configuration: ${missing.join(", ")}.`);
  }
  if (config.projectId !== "mht-giftcards-staging") {
    throw new Error("The staging artifact must use only the mht-giftcards-staging Firebase project.");
  }
  if (config.authDomain !== `${config.projectId}.firebaseapp.com`) {
    throw new Error("The staging Firebase auth domain does not match the staging project.");
  }
  const workerUrl = new URL(workerApiBaseUrl);
  const localWorker = ["localhost", "127.0.0.1"].includes(workerUrl.hostname);
  if ((!localWorker &&
       (workerUrl.protocol !== "https:" ||
        !workerUrl.hostname.startsWith("mht-giftcards-staging-api.") ||
        !workerUrl.hostname.endsWith(".workers.dev"))) ||
      (localWorker && !["http:", "https:"].includes(workerUrl.protocol)) ||
      (process.env.GITHUB_ACTIONS === "true" && localWorker) ||
      workerUrl.pathname !== "/" || workerUrl.search || workerUrl.hash) {
    throw new Error("The staging API URL must use the named staging Worker on workers.dev (or localhost outside GitHub Actions).");
  }
  writeFileSync(
    path.join(output, "firebase-config.js"),
    `window.MHT_FIREBASE_CONFIG = ${JSON.stringify(config, null, 2)};\n`
  );
}

function verifyOutput() {
  const forbidden = [
    "formspree.io",
    "mailto:",
    "mitchharsch@gmail.com",
    "mitchharschtattoo.com",
    "RESEND_API_KEY",
    "CERTIFICATE_ENCRYPTION_KEY",
    "RATE_LIMIT_HMAC_KEY",
    "INTERAC_EMAIL",
    "stripe.com",
    "api.resend.com"
  ];

  for (const page of pages) {
    const file = path.join(output, page);
    if (!existsSync(file)) throw new Error(`Missing staging page: ${page}`);
    const html = readFileSync(file, "utf8");
    if (!html.includes("TEST SITE — NOT LIVE") || !html.includes('name="robots" content="noindex, nofollow"')) {
      throw new Error(`Staging banner or noindex metadata is missing from ${page}.`);
    }
    if (page === "gift-cards/index.html" &&
        (!html.includes("../gift-cards.js") ||
         !html.includes("TEST MODE — payment is disabled. No money will be collected.") ||
         !html.includes("order-turnstile") ||
         !html.includes('id="download-certificate"') ||
         !html.includes('id="payment-reported" hidden'))) {
      throw new Error("The gift-card page is not configured for the Cloudflare staging test flow.");
    }
    if (page === "admin/gift-cards/index.html" &&
        (!html.includes("../../admin-gift-cards.js") || !html.includes("VOID — TEST ONLY"))) {
      throw new Error("The admin page is not configured for test-only Worker management.");
    }
    for (const marker of forbidden) {
      if (html.toLowerCase().includes(marker.toLowerCase())) {
        throw new Error(`Production integration marker "${marker}" remains in ${page}.`);
      }
    }
    checkLocalReferences(html, page);
  }

  if (existsSync(path.join(output, "CNAME")) || existsSync(path.join(output, "sitemap.xml"))) {
    throw new Error("Production DNS or sitemap files must not be included in the staging artifact.");
  }
  const configSource = readFileSync(path.join(output, "firebase-config.js"), "utf8");
  if (!configSource.includes('"projectId": "mht-giftcards-staging"') ||
      !configSource.includes('"workerApiBaseUrl":') ||
      !configSource.includes('"turnstileSiteKey":') ||
      !configSource.includes('"stagingTestMode": true') ||
      configSource.includes("REPLACE_")) {
    throw new Error("The output must include only configured staging service endpoints.");
  }
  for (const script of ["site.js", "staging.js", "gift-cards.js", "admin-gift-cards.js"]) {
    const source = readFileSync(path.join(output, script), "utf8");
    if (/api\.resend\.com|stripe\.com|RESEND_API_KEY|CERTIFICATE_ENCRYPTION_KEY/i.test(source)) {
      throw new Error(`A server-only payment or email integration was included in ${script}.`);
    }
  }
  if (existsSync(path.join(output, "staging-gift-cards.js")) ||
      existsSync(path.join(output, "staging-admin-gift-cards.js"))) {
    throw new Error("Browser-only mock scripts must not be included in the functional staging artifact.");
  }
}

function checkLocalReferences(html, page) {
  const references = [...html.matchAll(/\b(?:href|src)=["']([^"'#]+)["']/gi)];
  const pageUrl = new URL(page, `https://staging.invalid${pagesPath}`);
  for (const [, reference] of references) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) continue;
    const pathname = decodeURIComponent(new URL(reference, pageUrl).pathname);
    if (!pathname.startsWith(pagesPath)) {
      throw new Error(`Reference escapes the GitHub Pages project path: ${page} -> ${reference}`);
    }
    let relative = pathname.slice(pagesPath.length);
    if (!relative || relative.endsWith("/")) relative += "index.html";
    if (!existsSync(path.join(output, relative))) {
      throw new Error(`Missing local asset from ${page}: ${reference}`);
    }
  }
}
