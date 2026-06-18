import { test, expect } from "./fixtures/tauri-mock";

test("Export → Plain Markdown downloads a transcript containing both turns", async ({ page }) => {
  // Send + complete one round-trip so the Export button enables.
  // backend=ollama → plain chat uses native /api/chat (NDJSON), not /v1 SSE.
  await page.route("**/api/chat", async (route) => {
    const ndjson =
      ['{"message":{"content":"hi there"},"done":false}', '{"done":true}'].join("\n") + "\n";
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
      body: ndjson,
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("app-ready")).toBeVisible();

  await page.getByTestId("chat-input").fill("hello");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("message-assistant").first()).toContainText("hi there");

  // Open the export dropdown, then click the Plain entry.
  await page.getByTestId("export-btn").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-plain").click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/\.md$/);
  expect(download.suggestedFilename()).not.toMatch(/-detailed\.md$/);
  const path = await download.path();
  if (!path) throw new Error("download had no path");
  const fs = await import("node:fs/promises");
  const body = await fs.readFile(path, "utf8");
  expect(body).toMatch(/^# /m);
  expect(body).toContain("hello");
  expect(body).toContain("hi there");
  // Plain mode must not contain collapsible tool blocks.
  expect(body).not.toContain("<details>");
});

test("Export → Detailed Markdown uses -detailed filename suffix", async ({ page }) => {
  // backend=ollama → plain chat uses native /api/chat (NDJSON), not /v1 SSE.
  await page.route("**/api/chat", async (route) => {
    const ndjson =
      ['{"message":{"content":"hi there"},"done":false}', '{"done":true}'].join("\n") + "\n";
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
      body: ndjson,
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("app-ready")).toBeVisible();

  await page.getByTestId("chat-input").fill("hello");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("message-assistant").first()).toContainText("hi there");

  await page.getByTestId("export-btn").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-detailed").click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/-detailed\.md$/);
  const path = await download.path();
  if (!path) throw new Error("download had no path");
  const fs = await import("node:fs/promises");
  const body = await fs.readFile(path, "utf8");
  expect(body).toContain("hello");
  expect(body).toContain("hi there");
  // Detailed mode header should reflect the mode.
  expect(body).toContain("Mode: detailed");
});
