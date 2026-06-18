import { test, expect } from "./fixtures/tauri-mock";

test("Stop aborts the in-flight stream and returns the UI to idle", async ({ page }) => {
  // Short-circuit the memory embedding probe so send() reaches the streaming
  // fetch quickly (otherwise recall awaits an ECONNREFUSED).
  await page.route("**/api/tags", (route) => route.fulfill({ status: 500, body: "" }));

  // Hold the chat request open until we abort. We never call `route.fulfill`;
  // the request hangs until the page's AbortController kills it (Stop click).
  // Playwright auto-cancels the handler when the page navigates / test ends.
  // backend=ollama → plain chat streams from native /api/chat (NOT /v1).
  await page.route("**/api/chat", async (_route) => {
    // intentionally never resolve — the client AbortController will fail it.
    await new Promise((r) => setTimeout(r, 30_000));
  });

  await page.goto("/");
  await expect(page.getByTestId("app-ready")).toBeVisible();

  await page.getByTestId("chat-input").fill("write a long story");
  await page.getByTestId("send-btn").click();

  // While the request is in-flight, the Stop button replaces Send.
  const stop = page.getByTestId("stop-btn");
  await expect(stop).toBeVisible({ timeout: 8000 });
  await stop.click();

  // UI returns to idle — Send button is back.
  await expect(page.getByTestId("send-btn")).toBeVisible({ timeout: 5000 });
});
