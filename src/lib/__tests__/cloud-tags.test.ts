import { describe, expect, it } from "vitest";
import { resolveCloudPullId } from "../cloud-tags";

describe("resolveCloudPullId", () => {
  it("uses the verified known tag for size-suffixed cloud models", () => {
    // The bug: these used to resolve to `<name>:cloud` → manifest 404.
    expect(resolveCloudPullId("gpt-oss", ["20b", "120b"])).toBe(
      "gpt-oss:120b-cloud",
    );
    expect(resolveCloudPullId("qwen3-coder", ["30b", "480b"])).toBe(
      "qwen3-coder:480b-cloud",
    );
    expect(resolveCloudPullId("deepseek-v3.1", ["671b"])).toBe(
      "deepseek-v3.1:671b-cloud",
    );
  });

  it("uses bare :cloud for known models that have no size tag", () => {
    expect(resolveCloudPullId("glm-4.6", [])).toBe("glm-4.6:cloud");
    expect(resolveCloudPullId("deepseek-r1", [])).toBe("deepseek-r1:cloud");
    expect(resolveCloudPullId("qwen3-max", [])).toBe("qwen3-max:cloud");
  });

  it("falls back to largest-size heuristic for an unknown cloud model", () => {
    // Not in the known map — derive `<name>:<largest>-cloud` from the sizes.
    expect(resolveCloudPullId("some-new-moe", ["7b", "235b"])).toBe(
      "some-new-moe:235b-cloud",
    );
    // 't' (trillion) outranks 'b'.
    expect(resolveCloudPullId("huge-model", ["70b", "1t"])).toBe(
      "huge-model:1t-cloud",
    );
  });

  it("falls back to bare :cloud for an unknown cloud model with no sizes", () => {
    expect(resolveCloudPullId("mystery", [])).toBe("mystery:cloud");
  });

  it("leaves an already-tagged id untouched", () => {
    expect(resolveCloudPullId("gpt-oss:120b-cloud", [])).toBe(
      "gpt-oss:120b-cloud",
    );
  });
});
