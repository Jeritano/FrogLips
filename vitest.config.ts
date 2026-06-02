import { defineConfig } from "vitest/config";

// Maturity review P1 #22: vitest was running single-threaded despite the
// 444+ test suite — `fullyParallel: true` only governs intra-file
// ordering, not worker count. Bumped to `threads` pool with 4 workers
// for a ~3x local wall-clock improvement on a 2024-era Mac. `isolate:
// true` so a module-level Lazy/Mutex from one suite can't leak into
// the next (some agent-loop tests stash global registries).
export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    include: [
      "src/**/__tests__/**/*.test.ts",
      "src/**/*.test.ts",
      "src/**/__tests__/**/*.test.tsx",
      "src/**/*.test.tsx",
    ],
    pool: "threads",
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 4,
        isolate: true,
      },
    },
    // Audit LOW (2026-05-27): report slow tests so the dev loop has a
    // visible signal when a single test starts dominating wall-clock.
    // Threshold = 250ms slow / 500ms heavy. Local 461-test suite
    // currently runs in ~1s, so anything >250ms is an outlier.
    slowTestThreshold: 250,
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: { junit: "test-results/junit.xml" },
  },
});
