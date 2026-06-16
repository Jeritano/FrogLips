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

describe("Skills & Tools hub gating", () => {
  it("excludes globally-disabled built-in tools from the prompt", () => {
    // No allowlist (all built-ins available) but run_shell switched off.
    const p = buildSystemPrompt(
      null,
      [],
      undefined,
      [],
      undefined,
      [],
      [],
      ["run_shell"],
    );
    expect(p).toContain("read_file");
    // The available-tools line must not advertise the disabled tool.
    expect(p).not.toMatch(/Available tools:[^\n]*\brun_shell\b/);
  });

  it("default (no disabled list) advertises run_shell as today", () => {
    const p = buildSystemPrompt(null, []);
    expect(p).toMatch(/Available tools:[^\n]*\brun_shell\b/);
  });

  it("excludes MCP tools from a server whose config is enabled:false", () => {
    const mcpTools = [
      {
        type: "function" as const,
        function: { name: "mcp__fs__read", description: "read", parameters: {} },
      },
      {
        type: "function" as const,
        function: { name: "mcp__net__get", description: "get", parameters: {} },
      },
    ];
    const p = buildSystemPrompt(
      null,
      [],
      undefined,
      mcpTools,
      undefined,
      [],
      [],
      [],
      [
        { name: "fs", command: "x", enabled: true },
        { name: "net", command: "y", enabled: false },
      ],
    );
    expect(p).toContain("mcp__fs__read");
    expect(p).not.toContain("mcp__net__get");
  });

  it("MCP server with enabled undefined/true stays available (today's behavior)", () => {
    const mcpTools = [
      {
        type: "function" as const,
        function: { name: "mcp__fs__read", description: "read", parameters: {} },
      },
    ];
    const p = buildSystemPrompt(
      null,
      [],
      undefined,
      mcpTools,
      undefined,
      [],
      [],
      [],
      [{ name: "fs", command: "x" }], // enabled omitted
    );
    expect(p).toContain("mcp__fs__read");
  });
});
