import { test, expect, setMockHandler, tauriInvocations } from "./fixtures/tauri-mock";

test("destructive run_shell triggers confirm modal; Deny short-circuits the tool", async ({ page }) => {
  // First turn: assistant requests a destructive shell command.
  // Second turn (after denial → tool result `user_denied`): assistant produces final text.
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
                tool_calls: [{ function: { name: "run_shell", arguments: { command: "rm -rf /" } } }],
              },
            }),
            JSON.stringify({ done: true }),
            "",
          ].join("\n")
        : [
            JSON.stringify({ message: { role: "assistant", content: "Stopped." } }),
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

  // Classify rm -rf / as destructive so the confirm dialog goes the dangerous path.
  await setMockHandler(page, "agent_classify_shell", () => "destructive");
  // Don't actually run the shell if the path is taken.
  await setMockHandler(page, "agent_run_shell", () => ({ ok: true, stdout: "", stderr: "", code: 0 }));

  await page.getByTestId("agent-toggle").click();
  await page.getByTestId("chat-input").fill("clean my disk");
  await page.getByTestId("send-btn").click();

  // Confirmation modal renders for a destructive tool.
  const modal = page.getByTestId("agent-confirm-modal");
  await expect(modal).toBeVisible({ timeout: 8000 });

  // Deny → modal closes, loop receives user_denied; final assistant text lands.
  await page.getByTestId("agent-confirm-deny").click();
  await expect(modal).toHaveCount(0);

  // Tool I/O moved to the Tool History panel (hidden from the chat stream).
  // Assert the loop completed by its final turn, and that the real shell was
  // never executed — the deny gate's actual guarantee.
  await expect(page.getByText("Stopped.")).toBeVisible({ timeout: 8000 });
  const invs = await tauriInvocations(page);
  expect(invs.some((i) => i.cmd === "agent_run_shell")).toBe(false);
});
