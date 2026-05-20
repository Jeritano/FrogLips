import { describe, expect, it } from "vitest";
import { modelSupportsVision } from "../model-capabilities";

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
