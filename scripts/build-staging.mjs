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
  "staging-gift-cards.js",
  "staging-admin-gift-cards.js"
];

if (existsSync(output)) {
  if (path.dirname(output) !== root || path.basename(output) !== "_staging-dist") {
    throw new Error("Refusing to clean an unexpected staging output path.");
  }
  rmSync(output, { recursive: true, force: true });
}
mkdirSync(output, { recursive: true });
for (const file of staticFiles) copyFile(file);
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
  html = html.replace(
    /<form\b(?=[^>]*\bid=["']admin-login["'])[^>]*>[\s\S]*?<\/form>/i,
    '<p id="admin-login" hidden>Administrator sign-in is unavailable in the test demo.</p>'
  );
  html = html.replace(
    /<form\b(?=[^>]*\bid=["']certificate-search["'])[^>]*>[\s\S]*?<\/form>/i,
    '<p id="certificate-search-note">Certificate lookup and redemption are disabled. Test previews have no redemption code.</p>'
  );

  if (page === "gift-cards/index.html") {
    html = html
      .replace(/<script src=["']\.\.\/firebase-config\.js["']><\/script>\s*/i, "")
      .replace(
        /<script type=["']module["'] src=["']\.\.\/gift-cards\.js["']><\/script>/i,
        '<script src="../staging-gift-cards.js" defer></script>'
      )
      .replace(
        /<form\b(?=[^>]*\bid=["']gift-order["'])[^>]*>/i,
        (tag) => tag.replace(/>$/, ' onsubmit="return false">')
      )
      .replace(
        /<fieldset>\s*<legend>Payment method<\/legend>[\s\S]*?<\/fieldset>/i,
        "<fieldset><legend>Payment method</legend><p>Disabled in test mode. No payment is collected.</p></fieldset>"
      )
      .replace(
        "The total shown is the exact amount to send by e-Transfer.",
        "The amount is for preview only. No payment will be collected."
      )
      .replace("Place e-Transfer order", "Create test order")
      .replace("Your certificate is issued after Mitch confirms the payment.",
        "Test certificate previews are void and cannot be redeemed.")
      .replace(
        "Interac orders remain inactive until the payment is confirmed. No certificate code is created before then.",
        "This demo never accepts payment or creates a redeemable certificate."
      )
      .replace(
        /<dl class=["']payment-details["']>[\s\S]*?<\/dl>/i,
        '<p class="form-note">Payment and transfer details are disabled in test mode.</p>'
      )
      .replace(
        "The certificate will be issued after payment confirmation. Reporting your transfer does not activate it.",
        "No payment, transfer report, email, or real certificate is created on this test site."
      )
      .replace(/<button id=["']payment-reported["']/i, '<button id="payment-reported" hidden');
  }

  if (page === "admin/gift-cards/index.html") {
    html = html
      .replace(/<script src=["']\.\.\/\.\.\/firebase-config\.js["']><\/script>\s*/i, "")
      .replace(
        /<script type=["']module["'] src=["']\.\.\/\.\.\/admin-gift-cards\.js["']><\/script>/i,
        '<script src="../../staging-admin-gift-cards.js" defer></script>'
      )
      .replace(
        "Confirm e-Transfer payments only after checking the bank account. Customer reports are not payment confirmation.",
        "Demo only. No Firebase, customer records, payments, certificates, or redemption services are connected."
      )
      .replace("Private area", "Test-only admin demo");
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
    (tag) => `${tag}\n  <div class="staging-banner" role="status"><strong>TEST SITE — NOT LIVE</strong><span>No real payments, email, or redeemable certificates.</span></div>`);
  html = html.replace("</body>", `  <script src="${prefix}staging.js" defer></script>\n</body>`);
  return html;
}

function verifyOutput() {
  const forbidden = [
    "formspree.io",
    "mailto:",
    "mitchharsch@gmail.com",
    "mitchharschtattoo.com",
    "firebase-config.js",
    "MHT_FIREBASE_CONFIG",
    "gstatic.com/firebasejs",
    "RESEND_API_KEY",
    "INTERAC_EMAIL"
  ];

  for (const page of pages) {
    const file = path.join(output, page);
    if (!existsSync(file)) throw new Error(`Missing staging page: ${page}`);
    const html = readFileSync(file, "utf8");
    if (!html.includes("TEST SITE — NOT LIVE") || !html.includes('name="robots" content="noindex, nofollow"')) {
      throw new Error(`Staging banner or noindex metadata is missing from ${page}.`);
    }
    if (page === "gift-cards/index.html" &&
        (!html.includes("staging-gift-cards.js") ||
         !html.includes("No payment will be collected.") ||
         !/<form\b[^>]*id="gift-order"[^>]*onsubmit="return false"/i.test(html))) {
      throw new Error("The gift-card page is not configured for the local test flow.");
    }
    if (page === "admin/gift-cards/index.html" &&
        (!html.includes("staging-admin-gift-cards.js") || html.includes("firebase-config.js"))) {
      throw new Error("The admin page is not isolated from Firebase.");
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
  const certificateScript = readFileSync(path.join(output, "staging-gift-cards.js"), "utf8") +
    readFileSync(path.join(output, "staging-admin-gift-cards.js"), "utf8");
  if (!certificateScript.includes("VOID — TEST ONLY") ||
      !certificateScript.includes("cannot be redeemed") ||
      /redemptionCode\s*[:=]/i.test(certificateScript)) {
    throw new Error("Test certificates must be void and must not expose a redemption code.");
  }
  for (const script of ["site.js", "staging.js", "staging-gift-cards.js", "staging-admin-gift-cards.js"]) {
    const source = readFileSync(path.join(output, script), "utf8");
    if (/\b(?:fetch|XMLHttpRequest|httpsCallable)\s*\(/i.test(source) ||
        /firebase-config|api\.resend\.com|stripe\.com/i.test(source)) {
      throw new Error(`Unexpected network or production integration in ${script}.`);
    }
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
