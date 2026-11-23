import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { ProductionEnv } from "../src/production/types.js";

interface TestEnv extends ProductionEnv {
  TEST_MIGRATIONS: D1Migration[];
}

await applyD1Migrations(
  (env as TestEnv).DB,
  (env as TestEnv).TEST_MIGRATIONS
);
