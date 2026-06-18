import { test, expect } from "./fixtures/tauri-mock";

test("send message streams tokens progressively via Ollama /api/chat", async ({ page }) => {
  // backend=ollama (the default server_status mock) → plain chat streams from the
  // NATIVE `http://${host}:${port}/api/chat` endpoint (ollama-plain-client.ts),
  // NOT the OpenAI-compat /v1 path (that's mlx/custom/openrouter). Frames are
  // newline-delimited JSON: each {message:{content}} yields a delta, {done:true}
  // ends the stream.
  await page.route("**/api/chat", async (route) => {
    const ndjson =
      [
        '{"message":{"role":"assistant","content":"Hello"},"done":false}',
        '{"message":{"content":" "},"done":false}',
        '{"message":{"content":"world"},"done":false}',
        '{"done":true,"prompt_eval_count":3,"eval_count":3}',
      ].join("\n") + "\n";
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
      body: ndjson,
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
