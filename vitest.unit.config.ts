import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    setupFiles: ["tests/no-network.ts"],
    environment: "node",
    include: [
      "tests/correction-evidence.test.ts",
      "tests/stations.test.ts",
      "tests/stations-paths.integration.test.ts",
      "tests/static-railway.integration.test.ts",
      "tests/normalization-events.test.ts",
      "tests/correction-security.test.ts",
      "tests/local-railway.test.ts",
      "tests/local-policies.test.ts",
    ],
  },
});
