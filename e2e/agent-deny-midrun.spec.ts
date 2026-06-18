import { test, expect, setMockHandler, tauriInvocations } from "./fixtures/tauri-mock";

/**
 * A dangerous tool is DENIED by the user partway through a multi-step run.
 * The loop must not wedge: it receives the `user_denied` tool result, the
 * model is given another turn, and a final assistant message lands.
 */
test("user denies a dangerous tool mid-run; loop recovers and finishes", async ({ page }) => {
  // Turn 1: assistant requests a destructive write_file.
  // Turn 2 (after the denial tool result): assistant produces final text.
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
                tool_calls: [
                  {
                    function: {
                      name: "write_file",
                      arguments: { path: "/etc/hosts", content: "malicious" },
                    },
                  },
                ],
              },
            }),
            JSON.stringify({ done: true }),
            "",
          ].join("\n")
        : [
            JSON.stringify({
              message: {
                role: "assistant",
                content: "Understood — I won't write that file. Let me know how to proceed.",
              },
            }),
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

  // write_file should never actually be invoked once denied.
  await setMockHandler(page, "agent_write_file", () => ({ ok: true }));

  await page.getByTestId("agent-toggle").click();
  await page.getByTestId("chat-input").fill("overwrite my hosts file");
  await page.getByTestId("send-btn").click();

  // Confirmation modal renders for the dangerous write.
  const modal = page.getByTestId("agent-confirm-modal");
  await expect(modal).toBeVisible({ timeout: 8000 });

  // Deny → modal closes; loop gets `user_denied` and re-prompts the model.
  await page.getByTestId("agent-confirm-deny").click();
  await expect(modal).toHaveCount(0);

  // The loop did NOT wedge — a follow-up assistant message is produced (tool
  // I/O now lives in the Tool History panel, not inline in the transcript).
  // `.first()`: the mock returns the SAME canned text on every post-denial turn,
  // and the runner's bounded narrate-without-acting nudge re-queries it a couple
  // of times, so the identical bubble can render more than once — recovery is
  // what we assert here (the dangerous write never running is asserted below).
  await expect(
    page.getByText("Understood — I won't write that file.").first(),
  ).toBeVisible({ timeout: 8000 });

  // The dangerous write must never have actually run.
  const invs = await tauriInvocations(page);
  expect(invs.some((i) => i.cmd === "agent_write_file")).toBe(false);
});
