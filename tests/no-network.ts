import { beforeEach, afterEach, vi } from "vitest";
// Unit/integration tests may replace this with a fake; paid endpoints are CLI-only.
beforeEach(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error(
      "External network is disabled in tests; inject a fake provider/fetcher",
    );
  });
});
afterEach(() => vi.unstubAllGlobals());
