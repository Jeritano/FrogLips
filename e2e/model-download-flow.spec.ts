import { test, expect } from "./fixtures/tauri-mock";

// ModelPicker disables its <select> when a model is running. Mark the server
// as stopped so the picker is interactable and the browser overlay can be opened.
test.use({
  tauriHandlers: {
    server_status: () => ({
      running: false,
      ready: false,
      model: null,
      backend: null,
      host: "",
      port: 0,
      last_error: null,
    }),
  },
});

test("ModelBrowser renders HuggingFace results after a search query", async ({ page }) => {
  await page.route("**/huggingface.co/api/models**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          id: "mlx-community/llama-3-8b",
          downloads: 1234,
          likes: 42,
          tags: ["mlx"],
          pipeline_tag: "text-generation",
        },
        {
          id: "mlx-community/qwen-2-7b",
          downloads: 567,
          likes: 12,
          tags: ["mlx"],
          pipeline_tag: "text-generation",
        },
      ]),
    });
  });

  // Block the live Civitai endpoint just in case.
  await page.route("**/civitai.com/**", (route) => route.fulfill({ status: 200, body: "[]" }));

  await page.goto("/");
  await expect(page.getByTestId("app-ready")).toBeVisible();

  // Open the ModelBrowser via the picker. The select option value `__browse__`
  // triggers the overlay. Use selectOption — Playwright fires the change event.
  await page.locator(".model-picker select").selectOption("__browse__");

  // Switch source to "hf" so search uses HF endpoint.
  await page.locator(".mb-source-select").selectOption("hf");

  await page.getByTestId("model-search").fill("llama");

  // Debounced fetch fires ~250ms later. Cards render with our mock payload.
  await expect(page.getByTestId("hf-model-card").first()).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("hf-model-card")).toHaveCount(2);
});
