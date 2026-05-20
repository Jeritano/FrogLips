import { test, expect } from "./fixtures/tauri-mock";

test("switching the Agent preset persists to localStorage and updates the select", async ({ page }) => {
  // Note: Froglips does not surface the active preset's `systemPromptOverride`
  // in a user-visible textarea (it's only injected into the model context).
  // The user-visible observable for a preset switch is the dropdown value and
  // the cached active id in localStorage. We assert both.
  await page.goto("/");
  await expect(page.getByTestId("app-ready")).toBeVisible();

  await page.getByTestId("agent-toggle").click();
  const presetSelect = page.getByTestId("agent-preset-select");
  await expect(presetSelect).toBeVisible();

  // Default is "general".
  await expect(presetSelect).toHaveValue("general");

  await presetSelect.selectOption("coder");
  await expect(presetSelect).toHaveValue("coder");

  // setActivePresetId persists into localStorage under "agent.activePresetId".
  const stored = await page.evaluate(() => localStorage.getItem("agent.activePresetId"));
  expect(stored).toBe("coder");
});
