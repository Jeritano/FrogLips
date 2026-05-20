import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for Froglips e2e tests.
 *
 * Strategy: drive the Vite dev server with a mocked window.__TAURI__ shim
 * (see e2e/fixtures/tauri-mock.ts). This validates UI logic + agent dispatch
 * wiring without needing a real Tauri runtime or installed bundle.
 */
export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["**/fixtures/**", "**/utils/**"],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  timeout: 15_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://localhost:1420",
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
