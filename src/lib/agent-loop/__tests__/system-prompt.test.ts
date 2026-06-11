import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../system-prompt";
import { DANGEROUS_TOOLS } from "../dispatch";

/*
 * The capability assertion (2026-06-11) exists because small models recited
 * FALSE disclaimers ("I can't access APIs / browse the web") — especially
 * under a preset systemPromptOverride, which drops the rules block. These
 * tests pin that the capability line survives the override path and reflects
 * the actual allowlist.
 */

describe("buildSystemPrompt capability assertion", () => {
  it("asserts web/API access when http tools are allowed, even with an override", () => {
    const p = buildSystemPrompt(
      null,
      ["http_request", "web_fetch", "call_api"],
      "You are a coding agent.", // override path — rules block is dropped
    );
    expect(p).toContain("REAL and available");
    expect(p).toContain("web/API access");
    // The override is still present.
    expect(p).toContain("You are a coding agent.");
  });

  it("does NOT claim web access when no web tools are in the allowlist", () => {
    const p = buildSystemPrompt(null, ["read_file", "list_dir"]);
    expect(p).not.toContain("web/API access");
    expect(p).toContain("REAL and available");
  });

  it("lists registered API names only when call_api is allowed", () => {
    const withApi = buildSystemPrompt(
      null,
      ["call_api"],
      undefined,
      [],
      undefined,
      ["GitHub", "Internal"],
    );
    expect(withApi).toContain("Registered APIs for call_api: GitHub, Internal");
    // call_api NOT in allowlist → no registry line even if names are passed.
    const withoutTool = buildSystemPrompt(
      null,
      ["read_file"],
      undefined,
      [],
      undefined,
      ["GitHub"],
    );
    expect(withoutTool).not.toContain("Registered APIs");
  });
});

describe("call_api is gated", () => {
  it("requires confirmation (in DANGEROUS_TOOLS)", () => {
    expect(DANGEROUS_TOOLS.has("call_api")).toBe(true);
  });
});
