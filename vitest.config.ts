import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["tests/**/*.test.ts"],
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
