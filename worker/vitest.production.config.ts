import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("./migrations/production", import.meta.url))
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.production.toml" },
        miniflare: {
          bindings: {
            ORDERS_ENABLED: "true",
            HOLIDAY_PROMOTION_ENABLED: "false",
            MAX_ORDER_AMOUNT_CENTS: "100000",
            PRODUCTION_ADMIN_EMAILS: "admin@example.com",
            PRODUCTION_INTERAC_EMAIL: "payments@example.com",
            EMAIL_FROM: "Mitch Harsch Tattoo <test@example.com>",
            EMAIL_DAILY_LIMIT: "80",
            RESEND_API_KEY: "test-resend-key",
            TURNSTILE_SECRET_KEY: "test-turnstile-key",
            CERTIFICATE_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            RATE_LIMIT_HMAC_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            TEST_MIGRATIONS: migrations
          }
        }
      })
    ],
    test: {
      include: ["test-production/**/*.test.ts"],
      setupFiles: ["./test-production/apply-migrations.ts"]
    }
  };
});
