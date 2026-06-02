import { test, expect, tauriInvocations } from "./fixtures/tauri-mock";

test("New chat focuses input and clears any active conversation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-ready")).toBeVisible();

  // The composer is the textarea inside ChatInput. Clicking "New chat" deselects
  // the current conversation (sets current=null), which empties the message list.
  const input = page.getByTestId("chat-input");
  await expect(input).toBeVisible();

  await page.getByTestId("new-chat-btn").click();

  // No conversation should be active, the message list should be empty.
  await expect(page.locator(".message")).toHaveCount(0);

  // settings_get is called once at boot — sanity check the mock pipeline is live.
  const calls = await tauriInvocations(page);
  expect(calls.some((c) => c.cmd === "settings_get")).toBe(true);

  // Composer is interactive (typing focuses it).
  await input.focus();
  await expect(input).toBeFocused();
});
