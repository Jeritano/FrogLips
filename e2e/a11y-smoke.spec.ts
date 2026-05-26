import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Maturity dim 10 (a11y): regression-floor smoke test. Runs axe-core
 * over the cold-start chat surface + ModelPicker open state.
 *
 * Failure policy: WCAG 2.1 AA violations fail. We deliberately don't
 * gate on best-practice / experimental rules — those tend to produce
 * design-feedback noise that would block legitimate PRs. Tune the
 * `withTags` list as the team matures.
 */
test.describe("a11y", () => {
  test("cold-start chat surface has no AA violations", async ({ page }) => {
    await page.goto("/");
    // Wait for the app shell to render — keyed off the sidebar Workflows
    // entry which always exists post-mount.
    await page.getByText("Workflows").first().waitFor({ state: "visible" });

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    if (results.violations.length > 0) {
      // Pretty-print so the failure log is actionable, not a wall of
      // serialized JSON.
      const summary = results.violations
        .map((v) => `  - [${v.id}] ${v.help} (${v.nodes.length} nodes)`)
        .join("\n");
      throw new Error(`axe-core found ${results.violations.length} AA violation(s):\n${summary}`);
    }
    expect(results.violations).toHaveLength(0);
  });
});
