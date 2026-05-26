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
  },
});
