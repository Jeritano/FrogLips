import { test, expect, setMockHandler } from "./fixtures/tauri-mock";

test("agent mode dispatches read_file tool without a confirmation modal", async ({ page }) => {
  // Two-turn Ollama exchange via NDJSON:
  //   1) Assistant requests `read_file` (no content). Loop dispatches it.
  //   2) Assistant returns final text "DONE".
  let turn = 0;
  await page.route("**/api/chat", async (route) => {
    turn += 1;
    const body =
      turn === 1
        ? [
            JSON.stringify({
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ function: { name: "read_file", arguments: { path: "/tmp/x.txt" } } }],
              },
            }),
            JSON.stringify({ done: true }),
            "",
          ].join("\n")
        : [
            JSON.stringify({ message: { role: "assistant", content: "DONE" } }),
            JSON.stringify({ done: true }),
            "",
          ].join("\n");
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
      body,
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("app-ready")).toBeVisible();

  // Stub agent_read_file so dispatch sees a fixture instead of nothing.
  await setMockHandler(page, "agent_read_file", () => ({ ok: true, content: "file contents" }));

  await page.getByTestId("agent-toggle").click();
  await page.getByTestId("chat-input").fill("read /tmp/x.txt");
  await page.getByTestId("send-btn").click();

  // read_file is non-dangerous → confirmation modal must NOT appear.
  await expect(page.getByTestId("agent-confirm-modal")).toHaveCount(0);

  // Tool result block appears after dispatch.
  await expect(page.getByTestId("tool-result").first()).toBeVisible({ timeout: 8000 });
});
