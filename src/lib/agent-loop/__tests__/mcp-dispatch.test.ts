import { describe, expect, it, vi } from "vitest";

vi.mock("../../tauri-api", () => {
  return {
    api: {
      mcpCallTool: vi.fn(
        async (server: string, tool: string, args: unknown) => {
          return `called ${server}/${tool} with ${JSON.stringify(args)}`;
        },
      ),
      mcpListServers: vi.fn(async () => [{ name: "demo" }]),
      mcpListTools: vi.fn(async () => [
        {
          name: "echo",
          description: "Echo back the input",
          inputSchema: {
            type: "object",
            properties: { msg: { type: "string" } },
          },
        },
      ]),
    },
  };
});

import {
  dispatchMcpTool,
  fetchMcpTools,
  isMcpToolName,
  parseMcpToolName,
  mcpToolName,
} from "../mcp-tools";
import { executeTool } from "../dispatch";
import { api } from "../../tauri-api";

describe("MCP tool name helpers", () => {
  it("recognises mcp-prefixed names", () => {
    expect(isMcpToolName("mcp__fs__read_file")).toBe(true);
    expect(isMcpToolName("read_file")).toBe(false);
    expect(isMcpToolName("mcp__broken")).toBe(false);
  });

  it("parses server + tool from names", () => {
    expect(parseMcpToolName("mcp__fs__read_file")).toEqual({
      server: "fs",
      tool: "read_file",
    });
    expect(parseMcpToolName("mcp__fs__nested__name")).toEqual({
      server: "fs",
      tool: "nested__name",
    });
    expect(parseMcpToolName("read_file")).toBeNull();
  });

  it("round-trips through mcpToolName", () => {
    expect(mcpToolName("foo", "bar")).toBe("mcp__foo__bar");
  });
});

describe("dispatchMcpTool", () => {
  it("routes mcp__server__tool calls to api.mcpCallTool", async () => {
    const out = await dispatchMcpTool("mcp__demo__echo", { msg: "hi" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.server).toBe("demo");
    expect(parsed.tool).toBe("echo");
    expect(parsed.text).toContain("called demo/echo");
    expect(api.mcpCallTool).toHaveBeenCalledWith("demo", "echo", { msg: "hi" });
  });

  it("returns a structured error when the underlying RPC fails", async () => {
    (api.mcpCallTool as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("connection refused"),
    );
    const out = await dispatchMcpTool("mcp__demo__echo", {});
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("mcp_error");
    expect(parsed.message).toBe("connection refused");
  });

  it("rejects malformed names cleanly", async () => {
    const out = await dispatchMcpTool("not_an_mcp_name", {});
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("bad_mcp_name");
  });
});

describe("executeTool MCP routing", () => {
  it("routes mcp-prefixed tool names through the MCP path", async () => {
    const out = await executeTool("mcp__demo__echo", {
      msg: "from-executeTool",
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.server).toBe("demo");
    expect(parsed.tool).toBe("echo");
  });
});

describe("fetchMcpTools", () => {
  it("merges every running server's tools into one OpenAI-formatted list", async () => {
    const tools = await fetchMcpTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe("function");
    expect(tools[0].function.name).toBe("mcp__demo__echo");
    expect(tools[0].function.description).toContain("Echo");
    expect(tools[0].function.parameters).toEqual({
      type: "object",
      properties: { msg: { type: "string" } },
    });
  });
});
