import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { createRequire } from "node:module";

// Use Wrangler's installed runtime. The older test-pool runtime crashes with
// the full master; its storage snapshot implementation also predates SQLite WAL.
const requireWrangler = createRequire(
  import.meta.resolve("wrangler/package.json"),
);
process.env.MINIFLARE_WORKERD_PATH ??= requireWrangler("workerd").default;

export default defineWorkersConfig({
  test: {
    setupFiles: ["tests/no-network.ts"],
    include: ["tests/d1-candidate-index.integration.test.ts"],
    pool: "@cloudflare/vitest-pool-workers",
    poolOptions: {
      workers: {
        // This suite seeds one immutable snapshot and makes read-only queries.
        isolatedStorage: false,
        miniflare: { compatibilityDate: "2025-09-06", d1Databases: ["DB"] },
      },
    },
  },
});
