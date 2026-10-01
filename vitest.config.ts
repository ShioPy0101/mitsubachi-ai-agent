import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    setupFiles: ["tests/no-network.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: [
      "tests/correction-evidence.test.ts",
      "tests/local-railway.test.ts",
      "tests/local-policies.test.ts",
      "tests/stations-paths.integration.test.ts",
      "tests/static-railway.integration.test.ts",
    ],
    pool: "@cloudflare/vitest-pool-workers",
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: "2025-09-06",
          d1Databases: ["DB"],
        },
      },
    },
  },
});
