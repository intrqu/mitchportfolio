import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Env } from "../src/types.js";

interface TestEnv extends Env {
  TEST_MIGRATIONS: D1Migration[];
}

await applyD1Migrations((env as TestEnv).DB, (env as TestEnv).TEST_MIGRATIONS);
