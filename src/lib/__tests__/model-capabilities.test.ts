import { describe, expect, it } from "vitest";
import {
  classifyToolFitness,
  formatContextTokens,
  modelSupportsVision,
} from "../model-capabilities";

describe("modelSupportsVision", () => {
  it("recognises known vision-capable families", () => {
    expect(modelSupportsVision("llava:13b")).toBe(true);
    expect(modelSupportsVision("llava-llama3")).toBe(true);
    expect(modelSupportsVision("qwen2-vl-7b")).toBe(true);
    expect(modelSupportsVision("qwen2_vl:latest")).toBe(true);
    expect(modelSupportsVision("Qwen-VL-Chat")).toBe(true);
    expect(modelSupportsVision("gemma3:12b")).toBe(true);
    expect(modelSupportsVision("gemma-3-27b-it")).toBe(true);
    expect(modelSupportsVision("minicpm-v:8b")).toBe(true);
    expect(modelSupportsVision("MiniCPM-V-2_6")).toBe(true);
    expect(modelSupportsVision("pixtral-12b")).toBe(true);
    expect(modelSupportsVision("moondream:1.8b")).toBe(true);
    // Generic name carrying the "vision" hint
    expect(modelSupportsVision("some-vision-thing")).toBe(true);
    expect(modelSupportsVision("llama-3.2-vision:90b")).toBe(true);
  });

  it("recognises families added in the 2026-05-28 maturity pass", () => {
    expect(modelSupportsVision("qwen2.5-vl-7b")).toBe(true);
    expect(modelSupportsVision("qwen3-vl-32b")).toBe(true);
    expect(modelSupportsVision("llama-4-scout")).toBe(true);
    expect(modelSupportsVision("llama4:maverick")).toBe(true);
    expect(modelSupportsVision("internvl2-8b")).toBe(true);
    expect(modelSupportsVision("cogvlm-chat")).toBe(true);
    expect(modelSupportsVision("phi-3.5-vision-instruct")).toBe(true);
    expect(modelSupportsVision("phi-4-multimodal")).toBe(true);
    expect(modelSupportsVision("mistral-small-3.1-24b")).toBe(true);
    expect(modelSupportsVision("smolvlm-instruct")).toBe(true);
    expect(modelSupportsVision("idefics2-8b")).toBe(true);
    expect(modelSupportsVision("molmo-7b")).toBe(true);
    expect(modelSupportsVision("aya-vision-8b")).toBe(true);
  });

  it("rejects text-only models", () => {
    expect(modelSupportsVision("llama3:8b")).toBe(false);
    expect(modelSupportsVision("mistral:7b")).toBe(false);
    expect(modelSupportsVision("qwen2:7b")).toBe(false);
    expect(modelSupportsVision("deepseek-coder")).toBe(false);
    expect(modelSupportsVision("phi3")).toBe(false);
    expect(modelSupportsVision("gemma:7b")).toBe(false); // no "3"
    expect(modelSupportsVision("gemma2:9b")).toBe(false);
  });

  it("handles null/undefined/empty input", () => {
    expect(modelSupportsVision(null)).toBe(false);
    expect(modelSupportsVision(undefined)).toBe(false);
    expect(modelSupportsVision("")).toBe(false);
  });
});

describe("classifyToolFitness", () => {
  it("flags known-good tool-calling families", () => {
    for (const m of [
      "qwen2.5-coder:7b",
      "qwen3:4b",
      "hermes3:8b",
      "mistral-nemo",
      "mistral-small:24b",
      "llama3.1:8b",
      "llama-3.3-70b",
      "command-r:35b",
      "gpt-4o",
      "claude-3.5-sonnet",
      "deepseek-v4-pro:cloud",
      "glm-4.6:cloud",
      "kimi-k2-thinking:cloud",
    ]) {
      expect(classifyToolFitness(m)).toBe("good");
    }
  });

  it("flags weak / unreliable families", () => {
    for (const m of [
      "qwen2.5-coder-7b-abliterated",
      "dolphin-mistral",
      "gemma3:12b",
      "gemma-4-27b",
      "phi3:mini",
      "tinyllama",
      "llama3.2:1b",
      "qwen2.5:0.5b",
      "llama2:13b",
      "codellama:7b",
    ]) {
      expect(classifyToolFitness(m)).toBe("weak");
    }
  });

  it("weak wins over good when both match (abliterated qwen)", () => {
    expect(classifyToolFitness("qwen3-8b-uncensored")).toBe("weak");
  });

  it("unknown families are 'untested' (no false confidence)", () => {
    expect(classifyToolFitness("some-random-model:7b")).toBe("untested");
    expect(classifyToolFitness(null)).toBe("untested");
    expect(classifyToolFitness("")).toBe("untested");
  });
});

describe("formatContextTokens", () => {
  it("renders k / M markers for common windows", () => {
    expect(formatContextTokens(8192)).toBe("8k");
    expect(formatContextTokens(32_768)).toBe("33k");
    expect(formatContextTokens(128_000)).toBe("128k");
    expect(formatContextTokens(256_000)).toBe("256k");
    expect(formatContextTokens(1_000_000)).toBe("1M");
    expect(formatContextTokens(2_000_000)).toBe("2M");
  });

  it("returns empty for unknown / zero / negative", () => {
    expect(formatContextTokens(0)).toBe("");
    expect(formatContextTokens(null)).toBe("");
    expect(formatContextTokens(undefined)).toBe("");
    expect(formatContextTokens(-1)).toBe("");
  });
});
