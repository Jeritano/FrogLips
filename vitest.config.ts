import { defineConfig } from "vitest/config";

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
  },
});
