import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = path.resolve(process.env.PRODUCTION_SITE_SOURCE || root);
const output = path.join(root, "_production-pages-dist");
const siteFiles = [
	"CNAME",
	"favicon.svg",
	"flash.html",
	"index.html",
	"robots.txt",
	"site.js",
	"sitemap.xml",
	"style.css",
];
const productionFiles = [
	"admin/gift-cards/production/index.html",
	"production-admin.css",
	"production-home.css",
	"production-admin-gift-cards.js",
	"production-admin-api.js",
	"production-gift-cards.css",
	"production-gift-cards.js",
];

const firebaseApiKey = process.env.PRODUCTION_FIREBASE_API_KEY || "";
const firebaseAppId = process.env.PRODUCTION_FIREBASE_APP_ID || "";
const workerApiBaseUrl = (process.env.PRODUCTION_WORKER_API_URL || "").replace(
	/\/+$/,
	"",
);
const turnstileSiteKey = process.env.PRODUCTION_TURNSTILE_SITE_KEY || "";

if (
	!firebaseApiKey ||
	firebaseApiKey.startsWith("REPLACE_") ||
	!firebaseAppId ||
	firebaseAppId.startsWith("REPLACE_")
) {
	throw new Error(
		"Set the production Firebase Web API key and App ID as public build variables.",
	);
}
if (
	turnstileSiteKey !== turnstileSiteKey.trim() ||
	turnstileSiteKey.startsWith("REPLACE_") ||
	turnstileSiteKey.length > 512
) {
	throw new Error(
		"The production Turnstile site key must be a public, unpadded build value.",
	);
}
validateWorkerUrl(workerApiBaseUrl);
if (existsSync(output)) {
	if (
		path.dirname(output) !== root ||
		path.basename(output) !== "_production-pages-dist"
	) {
		throw new Error(
			"Refusing to clean an unexpected production Pages output path.",
		);
	}
	rmSync(output, { recursive: true, force: true });
}
mkdirSync(output, { recursive: true });

for (const file of siteFiles) {
	copyFile(siteRoot, file);
}
const siteAssets = path.join(siteRoot, "assets");
if (!existsSync(siteAssets))
	throw new Error("The existing production assets directory is missing.");
cpSync(siteAssets, path.join(output, "assets"), { recursive: true });

for (const file of productionFiles) {
	copyFile(root, file);
}
copyFile(root, "production/gift-cards/index.html", "gift-cards/index.html");
const homepagePath = path.join(output, "index.html");
writeFileSync(
	homepagePath,
	addGiftCardPromo(readFileSync(homepagePath, "utf8")),
);
writeFileSync(
	path.join(output, "production-gift-cards-config.js"),
	`window.MHT_PRODUCTION_GIFT_CARDS_CONFIG = Object.freeze(${JSON.stringify(
		{
			apiKey: firebaseApiKey,
			authDomain: "mht-giftcards-production.firebaseapp.com",
			projectId: "mht-giftcards-production",
			appId: firebaseAppId,
			workerApiBaseUrl,
			turnstileSiteKey,
		},
		null,
		2,
	)});\n`,
);

verifyOutput();
console.log(
	`Built production admin Pages artifact in ${path.relative(root, output)}. It has not been published.`,
);

function copyFile(sourceRoot, file, outputFile = file) {
	const source = path.join(sourceRoot, file);
	if (!existsSync(source))
		throw new Error(`Missing production site source: ${file}`);
	const target = path.join(output, outputFile);
	mkdirSync(path.dirname(target), { recursive: true });
	cpSync(source, target);
}

function validateWorkerUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Set the production Worker URL before building Pages.");
	}
	if (
		url.protocol !== "https:" ||
		!/^mht-giftcards-api\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) ||
		url.port ||
		url.username ||
		url.password ||
		(url.pathname !== "" && url.pathname !== "/") ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"The Worker URL must be the dedicated production mht-giftcards-api workers.dev endpoint.",
		);
	}
}

function addGiftCardPromo(html) {
	const stylesheet = '  <link rel="stylesheet" href="style.css">';
	const nav = '<nav id="nav" aria-label="Main navigation">';
	const booking =
		'    <section class="wrap section split booking" id="booking">';
	const section = `    <section class="wrap section gift-card-promo" id="gift-cards" aria-labelledby="gift-cards-title">
      <div class="gift-card-promo__panel">
        <div>
          <p class="kicker">For someone special</p>
          <h2 id="gift-cards-title">Buy a Gift Card</h2>
          <p class="muted">Give the gift of a tattoo by Mitch Harsch.</p>
          <a class="solid gift-card-promo__cta" href="gift-cards/">Buy a Gift Card <span aria-hidden="true">↗</span></a>
        </div>
      </div>
    </section>
`;
	const publishedStylesheet =
		'<link rel="stylesheet" href="production-home.css">';
	const publishedNavLink = '<a href="gift-cards/">Gift Cards</a>';
	if (
		html.includes(publishedStylesheet) &&
		html.includes(publishedNavLink) &&
		html.replace(/\r\n/g, "\n").includes(section)
	) {
		return html;
	}
	if (
		[stylesheet, nav, booking].some((marker) => !html.includes(marker)) ||
		html.includes('href="gift-cards/"')
	) {
		throw new Error(
			"The production homepage could not be safely extended with the gift-card CTA.",
		);
	}
	return html
		.replace(
			stylesheet,
			`${stylesheet}\n  <link rel="stylesheet" href="production-home.css">`,
		)
		.replace(nav, `${nav}\n      <a href="gift-cards/">Gift Cards</a>`)
		.replace(booking, `${section}${booking}`);
}

function verifyOutput() {
	if (
		readFileSync(path.join(output, "CNAME"), "utf8").trim() !==
		"mitchharschtattoo.com"
	) {
		throw new Error(
			"The artifact must preserve the existing production custom domain.",
		);
	}
	for (const file of siteFiles) {
		const original = readFileSync(path.join(siteRoot, file));
		const built = readFileSync(path.join(output, file));
		const expected =
			file === "index.html"
				? Buffer.from(addGiftCardPromo(original.toString("utf8")))
				: original;
		if (!expected.equals(built)) {
			throw new Error(
				`The existing live-site file was unexpectedly changed: ${file}`,
			);
		}
	}
	const homepage = readFileSync(path.join(output, "index.html"), "utf8");
	if (
		!homepage.includes('<a href="gift-cards/">Gift Cards</a>') ||
		!homepage.includes("Buy a Gift Card") ||
		homepage.includes("Coming Soon")
	) {
		throw new Error(
			"The production homepage must link to the gift-card order page.",
		);
	}
	const productionSettings = readFileSync(
		path.join(root, "worker", "wrangler.production.toml"),
		"utf8",
	);
	if (!/^\s*MAX_ORDER_AMOUNT_CENTS\s*=\s*"100000"\s*$/m.test(productionSettings)) {
		throw new Error("Production maximum must be $1,000 CAD.");
	}

	const html = readFileSync(path.join(output, productionFiles[0]), "utf8");
	if (
		!html.includes("production-admin-gift-cards.js") ||
		!html.includes("Confirm Payment Received") ||
		html.includes("simulate-payment")
	) {
		throw new Error(
			"The production admin page is missing required controls or includes a simulation route.",
		);
	}
	for (const file of productionFiles.slice(1)) {
		const source = readFileSync(path.join(output, file), "utf8");
		if (
			/mht-giftcards-staging|simulate-payment|VOID — TEST ONLY|RESEND_API_KEY|CERTIFICATE_ENCRYPTION_KEY|RATE_LIMIT_HMAC_KEY/i.test(
				source,
			)
		) {
			throw new Error(
				`A staging or server-only marker was included in ${file}.`,
			);
		}
	}
	const customerPagePath = path.join(output, "gift-cards", "index.html");
	const customerPage = readFileSync(customerPagePath, "utf8");
	const customerScript = readFileSync(
		path.join(output, "production-gift-cards.js"),
		"utf8",
	);
	const publicConfig = readFileSync(
		path.join(output, "production-gift-cards-config.js"),
		"utf8",
	);
	if (
		!customerPage.includes('id="production-order-disabled"') ||
		!customerPage.includes('id="submit-order"') ||
		!/id="submit-order"[^>]*disabled/.test(customerPage) ||
		!/Do\s+not\s+send\s+money\./i.test(customerPage) ||
		!customerPage.includes("recipient-name") ||
		!customerPage.includes("recipient-email") ||
		!customerPage.includes("buyer-name") ||
		!customerPage.includes("buyer-email") ||
		!customerPage.includes("gift-message") ||
		!customerPage.includes('value="5000"') ||
		!customerPage.includes('value="10000"') ||
		!customerPage.includes('value="15000"') ||
		!customerPage.includes('value="20000"') ||
		!customerPage.includes("Interac e-Transfer") ||
		!customerPage.includes("Receive your digital gift certificate by email") ||
		customerPage.includes("firebase-config.js") ||
		customerPage.includes('src="../gift-cards.js"') ||
		customerPage.includes("turnstile/v0/api.js") ||
		!customerPage.includes('src="../production-gift-cards-config.js"') ||
		customerPage.includes("mitchharsch@gmail.com")
	) {
		throw new Error(
			"The production order page is missing the disabled preview safeguards or includes staging/payment config.",
		);
	}
	if (
		!customerScript.includes("validateProductionAdminConfig") ||
		!customerScript.includes("window.MHT_PRODUCTION_GIFT_CARDS_CONFIG") ||
		!customerScript.includes("/api/healthz") ||
		!customerScript.includes("/api/orders") ||
		!customerScript.includes("/report-payment") ||
		!customerScript.includes("health.orderingEnabled !== true") ||
		!customerScript.includes("event.preventDefault()") ||
		/mht-giftcards-staging|STAGING_|RESEND_API_KEY|TURNSTILE_SECRET_KEY|CERTIFICATE_ENCRYPTION_KEY|RATE_LIMIT_HMAC_KEY/i.test(
			customerScript,
		)
	) {
		throw new Error(
			"The production customer form must use the production API and must not include staging/server credentials.",
		);
	}
	if (
		!publicConfig.includes('"workerApiBaseUrl"') ||
		!publicConfig.includes('"turnstileSiteKey"') ||
		!readFileSync(
			path.join(output, "production-admin-gift-cards.js"),
			"utf8",
		).includes("MHT_PRODUCTION_GIFT_CARDS_CONFIG")
	) {
		throw new Error(
			"The admin and customer pages must share production-only API and Turnstile configuration.",
		);
	}
	if (existsSync(path.join(output, "gift-cards", "gift-cards.js"))) {
		throw new Error(
			"The staging order submission script must not be included in the production site.",
		);
	}
	checkLocalReferences(homepage, "index.html");
	checkLocalReferences(html, productionFiles[0]);
	checkLocalReferences(customerPage, "gift-cards/index.html");
}

function checkLocalReferences(html, page) {
	const references = [...html.matchAll(/\b(?:href|src)=["']([^"'#]+)["']/gi)];
	for (const [, reference] of references) {
		if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) continue;
		const target = path.resolve(output, path.dirname(page), reference.split("?")[0]);
		if (
			(target !== output && !target.startsWith(`${output}${path.sep}`)) ||
			!existsSync(target)
		) {
			throw new Error(
				`Missing or unsafe production admin asset: ${reference}`,
			);
		}
	}
}
