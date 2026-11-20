import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            EMAIL_FROM: "Mitch Harsch Tattoo <test@example.com>",
            STAGING_INTERAC_EMAIL: "test-interac@example.com",
            STAGING_ALLOWED_EMAILS: "test@example.com,admin@example.com",
            STAGING_ADMIN_EMAILS: "admin@example.com",
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
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"]
    }
  };
});
