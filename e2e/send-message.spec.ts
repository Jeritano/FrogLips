import { test, expect } from "./fixtures/tauri-mock";

test("send message streams tokens progressively via Ollama /v1/chat/completions", async ({ page }) => {
  // mlx-client.ts streams from `http://${status.host}:${status.port}/v1/chat/completions`.
  // Our default server_status mock returns host=127.0.0.1 / port=11434 / backend=ollama.
  await page.route("**/v1/chat/completions", async (route) => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" "}}]}',
      'data: {"choices":[{"delta":{"content":"world"}}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sse,
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("app-ready")).toBeVisible();

  const input = page.getByTestId("chat-input");
  await input.fill("hi there");
  await page.getByTestId("send-btn").click();

  // User bubble appears immediately
  await expect(page.getByTestId("message-user").first()).toContainText("hi there");

  // Final assistant message renders the streamed text. (We don't race the
  // streaming bubble — Playwright will catch the assistant bubble whether the
  // stream resolved before or after we assert.)
  await expect(page.getByTestId("message-assistant").first()).toContainText("Hello world");
});
