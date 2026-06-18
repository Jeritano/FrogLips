import { test, expect } from "./fixtures/tauri-mock";

test("settings gear opens the agent settings panel with the expected sections", async ({ page }) => {
  // Note: Froglips has no separate global settings modal — the gear in the
  // chat toolbar opens an inline "agent-settings" panel that hosts:
  //   • Workspace picker
  //   • Approve-all toggles
  //   • Allowed tools grid
  //   • McpSettings panel
  // We assert those sections render after click.
  await page.goto("/");
  await expect(page.getByTestId("app-ready")).toBeVisible();

  await page.getByTestId("agent-toggle").click();
  await page.getByTestId("agent-settings-gear").click();

  const panel = page.getByTestId("agent-settings-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Agent workspace");
  await expect(panel).toContainText("Allowed tools");

  // Tool grid renders the pre-defined tool pills (e.g. read_file)
  await expect(panel.locator(".agent-tool-pill", { hasText: "read_file" })).toBeVisible();

  // MCP subpanel mounted (the McpSettings component renders inside).
  await expect(panel).toContainText(/MCP/i);
});
