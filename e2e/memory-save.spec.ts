import { test, expect, tauriInvocations } from "./fixtures/tauri-mock";

test("pinning a message saves it via add_memory with the expected args", async ({ page }) => {
  // No "Add memory" button exists in Froglips today — the memory-save path is:
  // open Memories panel (verifies the section), then pin a message bubble,
  // which calls `saveMemory` → `add_memory` IPC.
  // Short-circuit the embedding probe so saveMemory skips dedup quickly.
  await page.route("**/api/tags", (route) => route.fulfill({ status: 500, body: "" }));

  await page.route("**/v1/chat/completions", async (route) => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"got it"}}]}',
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

  // Verify the panel mounts and toggles.
  await page.getByTestId("memories-toggle").click();
  await expect(page.getByTestId("memory-body")).toBeVisible();

  // Produce a pinnable assistant message.
  await page.getByTestId("chat-input").fill("remember: I prefer dark mode");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("message-assistant").first()).toContainText("got it");

  // Pin the user bubble. The pin button is hover-only in CSS; use
  // `locator.dispatchEvent` to fire a click without requiring visibility.
  const userMsg = page.getByTestId("message-user").first();
  await userMsg.getByTestId("pin-btn").dispatchEvent("click");

  // Wait for add_memory IPC to fire.
  await expect.poll(async () => {
    const calls = await tauriInvocations(page);
    return calls.some((c) => c.cmd === "add_memory");
  }, { timeout: 5000 }).toBe(true);

  const calls = await tauriInvocations(page);
  const addCall = calls.find((c) => c.cmd === "add_memory");
  expect(addCall).toBeDefined();
  const args = addCall!.args as { content?: string; tags?: string; status?: string };
  expect(args.content).toContain("dark mode");
  expect(args.tags).toBe("user");
  expect(args.status).toBe("active");
});
