import { defineConfig } from "vitest/config";

// End-to-end tests drive real bitcoind + lnd on regtest. Slow; run explicitly.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
