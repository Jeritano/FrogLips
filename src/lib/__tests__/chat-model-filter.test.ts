import { describe, expect, it } from "vitest";
import { isNonChatRepo } from "../chat-model-filter";

describe("isNonChatRepo", () => {
  it("filters FLUX base weights + community quants", () => {
    expect(isNonChatRepo("black-forest-labs/FLUX.1-dev")).toBe(true);
    expect(isNonChatRepo("black-forest-labs/FLUX.1-schnell")).toBe(true);
    expect(isNonChatRepo("city96/FLUX.1-dev-gguf")).toBe(true);
    expect(isNonChatRepo("Comfy-Org/flux-fp8")).toBe(true);
  });

  it("filters standalone vision-text encoders pulled by diffusion pipelines", () => {
    expect(isNonChatRepo("openai/clip-vit-large-patch14")).toBe(true);
    expect(isNonChatRepo("google/siglip-so400m-patch14-384")).toBe(true);
  });

  it("filters T5 encoder + tokenizer repos used by FLUX", () => {
    expect(isNonChatRepo("EricB/t5-v1_1-xxl-enc-only")).toBe(true);
    expect(isNonChatRepo("EricB/t5_tokenizer")).toBe(true);
  });

  it("filters standalone VAE repos", () => {
    expect(isNonChatRepo("stabilityai/vae-ft-mse-840000-ema-pruned")).toBe(true);
    expect(isNonChatRepo("madebyollin/sdxl-vae")).toBe(true);
  });

  it("passes real chat checkpoints through unchanged", () => {
    expect(isNonChatRepo("mlx-community/Llama-3.2-3B-Instruct-4bit")).toBe(false);
    expect(isNonChatRepo("mlx-community/Qwen3-7B-Instruct")).toBe(false);
    expect(isNonChatRepo("microsoft/phi-2")).toBe(false);
    expect(isNonChatRepo("mistralai/Mistral-7B-Instruct-v0.3")).toBe(false);
  });
});
