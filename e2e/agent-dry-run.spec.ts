import { test, expect, setMockHandler, tauriInvocations } from "./fixtures/tauri-mock";

/**
 * Dry-run mode: a dangerous side-effectful tool (`run_shell`) is short-
 * circuited in the dispatcher. It returns a simulated `{dry_run:true,
 * would_run:...}` payload and the real Tauri command (`agent_run_shell`) is
 * never invoked.
 */
test("dry-run mode simulates a dangerous tool without real execution", async ({ page }) => {
  // Turn 1: assistant requests run_shell. Turn 2: final text.
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
                  { function: { name: "run_shell", arguments: { command: "rm -rf /tmp/x" } } },
                ],
              },
            }),
            JSON.stringify({ done: true }),
            "",
          ].join("\n")
        : [
            JSON.stringify({ message: { role: "assistant", content: "Simulated only." } }),
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

  await setMockHandler(page, "agent_classify_shell", () => "normal");
  // If dry-run is broken and the real command runs, this records an invocation.
  await setMockHandler(page, "agent_run_shell", () => ({ ok: true, stdout: "ran", stderr: "", code: 0 }));

  await page.getByTestId("agent-toggle").click();

  // Enable dry-run via the agent settings panel.
  await page.getByTestId("agent-settings-gear").click();
  await page.getByTestId("agent-dry-run-toggle").locator("input").check();

  // The dry-run banner confirms the mode is active.
  await expect(page.getByTestId("agent-dry-run-banner")).toBeVisible();

  await page.getByTestId("chat-input").fill("delete /tmp/x");
  await page.getByTestId("send-btn").click();

  // run_shell always confirms (dry-run does not bypass the gate) — approve so
  // the call proceeds to the dispatcher, where dry-run short-circuits it.
  const modal = page.getByTestId("agent-confirm-modal");
  await expect(modal).toBeVisible({ timeout: 8000 });
  await page.getByTestId("agent-confirm-allow").click();
  await expect(modal).toHaveCount(0);

  // Tool I/O is no longer rendered inline (it lives in the Tool History
  // panel). The loop's final turn proves it consumed the simulated result and
  // continued; the invocation check below proves nothing real ran.
  await expect(page.getByText("Simulated only.")).toBeVisible({ timeout: 8000 });

  // The real shell command must never have been invoked.
  const invs = await tauriInvocations(page);
  expect(invs.some((i) => i.cmd === "agent_run_shell")).toBe(false);
});
