// Arm-coverage tests for `executeTool` in dispatch.ts.
//
// The switch in dispatch.ts has 50+ arms. A regression where a contributor
// adds a new IPC + tauri-api wrapper but forgets the matching arm produces
// {ok:false, kind:"unknown_tool"} at runtime — clear failure, but only at
// the moment the agent actually calls that tool. This test file covers two
// guarantees:
//
//   1. Unknown tool names fall through cleanly to the documented contract.
//   2. A representative arm from every category routes to the right
//      api.* method — a typo'd `agentReadFile` → `agentReadDir` swap shows
//      up here, not after a model run.
//
// We don't enumerate every arm (that would just be a copy of the switch).
// We sample one per cluster so any future swap of api.* methods inside the
// switch is caught. Add a new sample when adding a new tool *category*;
// adding another file-ops tool is fine without a new test.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the api object — vi.mock is hoisted to the top, so the factory must
// be self-contained (no top-level identifiers it depends on). Every method
// is a vi.fn returning either a JSON-shaped payload (so `JSON.stringify`
// in the arm doesn't choke) or void.
vi.mock("../../tauri-api", () => ({
  api: {
    agentReadFile: vi.fn(async (path: string) => ({ path, bytes: "hi" })),
    agentListDir: vi.fn(async (path: string) => ({ path, entries: [] })),
    agentSearchFiles: vi.fn(async () => ({ matches: [] })),
    agentGitStatus: vi.fn(async () => ({ branch: "main", dirty: false })),
    agentWebFetch: vi.fn(async (url: string) => ({ url, body: "" })),
    agentScreenshot: vi.fn(async () => ({ path: "/tmp/x.png" })),
    agentClipboardGet: vi.fn(async () => "clip-text"),
    agentClipboardSet: vi.fn(async () => undefined),
    agentRunShell: vi.fn(async () => ({ stdout: "", stderr: "", exit_code: 0 })),
    agentWriteFile: vi.fn(async () => undefined),
    agentBrowserNavigate: vi.fn(async (url: string) => ({ url, title: "" })),
    taskCreate: vi.fn(async () => ({ id: "t1" })),
    agentListUndo: vi.fn(async () => []),
    agentUndoLast: vi.fn(async () => ({ path: "/tmp", kind: "x", restored_bytes: 0, was_absent: false })),
    agentHashFile: vi.fn(async () => ({ algorithm: "sha256", hex: "ab", size_bytes: 0 })),
    agentDeletePath: vi.fn(async () => ({ path: "/x", was_dir: false })),
    agentMultiEdit: vi.fn(async () => ({})),
    agentGitDiff: vi.fn(async () => ({})),
    agentGitLog: vi.fn(async () => ({})),
    agentGitShow: vi.fn(async () => ({})),
    agentGitBranches: vi.fn(async () => ({})),
    agentGitCommit: vi.fn(async () => ({})),
    agentWebSearch: vi.fn(async () => ({})),
    agentReadPdf: vi.fn(async () => ({})),
    agentOpenApp: vi.fn(async () => undefined),
    agentShowNotification: vi.fn(async () => undefined),
    agentApplescriptRun: vi.fn(async () => ({})),
    agentHttpRequest: vi.fn(async () => ({})),
    agentFindDefinition: vi.fn(async () => ({})),
    agentFindReferences: vi.fn(async () => ({})),
    agentFormatCode: vi.fn(async () => ({})),
    agentBrowserClick: vi.fn(async () => ({})),
    agentBrowserFill: vi.fn(async () => ({})),
    agentBrowserScreenshot: vi.fn(async () => ({})),
    agentBrowserGetText: vi.fn(async () => ({})),
    agentBrowserClose: vi.fn(async () => ({})),
    taskStatus: vi.fn(async () => ({})),
    taskList: vi.fn(async () => []),
    taskCancel: vi.fn(async () => undefined),
    agentAskUser: vi.fn(async () => "y"),
    agentFileExists: vi.fn(async () => ({ exists: false })),
    agentEditFile: vi.fn(async () => ({})),
    agentWatchPath: vi.fn(async () => ({})),
    agentPollWatch: vi.fn(async () => ({})),
    agentStopWatch: vi.fn(async () => undefined),
    agentListWatches: vi.fn(async () => []),
    agentMovePath: vi.fn(async () => ({ from: "", to: "" })),
    agentCopyPath: vi.fn(async () => ({ from: "", to: "" })),
    agentMakeDir: vi.fn(async () => ({ path: "", created: false })),
    agentDiffFiles: vi.fn(async () => ({})),
    agentListProcesses: vi.fn(async () => []),
    agentKillProcess: vi.fn(async () => ({})),
    mcpCallTool: vi.fn(async () => "mcp-result"),
    mcpListServers: vi.fn(async () => []),
    mcpListTools: vi.fn(async () => []),
    imageGet: vi.fn(async () => null),
    ragSearch: vi.fn(async () => ({ hits: [] })),
    workflowRunsList: vi.fn(async () => []),
  },
}));

import { api } from "../../tauri-api";
import { executeTool } from "../dispatch";

describe("executeTool: unknown tool fallback", () => {
  it("returns ok=false kind=unknown_tool for a completely unknown name", async () => {
    const out = await executeTool("definitely_not_a_real_tool", {});
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("unknown_tool");
    expect(parsed.message).toContain("definitely_not_a_real_tool");
  });

  it("the unknown fallback never reaches any api.* method", async () => {
    await executeTool("definitely_not_a_real_tool", {});
    // Spot-check the most plausibly-typoed routes.
    expect(api.agentReadFile).not.toHaveBeenCalled();
    expect(api.agentListDir).not.toHaveBeenCalled();
    expect(api.agentRunShell).not.toHaveBeenCalled();
  });
});

describe("executeTool: arm routing (sample one per category)", () => {
  it("'read_file' routes to api.agentReadFile with path + offset/limit", async () => {
    await executeTool("read_file", { path: "/tmp/x", offset: 16, limit: 256 });
    expect(api.agentReadFile).toHaveBeenCalledWith("/tmp/x", 16, 256);
  });

  it("'list_dir' routes to api.agentListDir", async () => {
    await executeTool("list_dir", { path: "/tmp" });
    expect(api.agentListDir).toHaveBeenCalledWith("/tmp");
  });

  it("'search_files' routes to api.agentSearchFiles", async () => {
    await executeTool("search_files", { path: "/x", pattern: "TODO", regex: true });
    expect(api.agentSearchFiles).toHaveBeenCalledWith("/x", "TODO", undefined, true);
  });

  it("'git_status' routes to api.agentGitStatus", async () => {
    await executeTool("git_status", {});
    expect(api.agentGitStatus).toHaveBeenCalledWith(undefined);
  });

  it("'web_fetch' routes to api.agentWebFetch", async () => {
    await executeTool("web_fetch", { url: "https://example.com" });
    expect(api.agentWebFetch).toHaveBeenCalledWith("https://example.com");
  });

  it("'screenshot' routes to api.agentScreenshot", async () => {
    await executeTool("screenshot", { out_path: "/tmp/s.png" });
    expect(api.agentScreenshot).toHaveBeenCalledWith("/tmp/s.png");
  });

  it("'clipboard_get' routes to api.agentClipboardGet", async () => {
    const out = await executeTool("clipboard_get", {});
    expect(api.agentClipboardGet).toHaveBeenCalled();
    expect(JSON.parse(out).text).toBe("clip-text");
  });

  it("'browser_navigate' routes to api.agentBrowserNavigate", async () => {
    await executeTool("browser_navigate", { url: "https://x" });
    expect(api.agentBrowserNavigate).toHaveBeenCalledWith("https://x");
  });

  it("'task_create' routes to api.taskCreate", async () => {
    await executeTool("task_create", { command: "echo hi" });
    expect(api.taskCreate).toHaveBeenCalledWith("echo hi", undefined);
  });

  it("'list_undo' routes to api.agentListUndo", async () => {
    await executeTool("list_undo", {});
    expect(api.agentListUndo).toHaveBeenCalled();
  });

  it("'agent_undo' routes to api.agentUndoLast", async () => {
    await executeTool("agent_undo", {});
    expect(api.agentUndoLast).toHaveBeenCalled();
  });

  it("'hash_file' routes to api.agentHashFile with default algo", async () => {
    await executeTool("hash_file", { path: "/x" });
    expect(api.agentHashFile).toHaveBeenCalledWith("/x", "sha256");
  });

  it("'delete_path' routes to api.agentDeletePath", async () => {
    await executeTool("delete_path", { path: "/tmp/x", recursive: true });
    expect(api.agentDeletePath).toHaveBeenCalledWith("/tmp/x", true);
  });

  it("'write_file' routes to api.agentWriteFile with path + content", async () => {
    await executeTool("write_file", { path: "/tmp/x", content: "hi" });
    expect(api.agentWriteFile).toHaveBeenCalledWith("/tmp/x", "hi");
  });
});

describe("executeTool: dry-run default-deny (sec audit round 3)", () => {
  // Clear cumulative call-state from earlier describe blocks so `not.toHaveBeenCalled`
  // reflects only this block.
  beforeEach(() => vi.clearAllMocks());

  it("suppresses run_code (RCE) instead of executing it", async () => {
    const out = await executeTool("run_code", { language: "python", code: "x" }, { dryRun: true });
    const parsed = JSON.parse(out);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.suppressed).toBe(true);
  });

  it("suppresses delete_path without calling api.agentDeletePath", async () => {
    const out = await executeTool("delete_path", { path: "/tmp/x", recursive: true }, { dryRun: true });
    expect(JSON.parse(out).suppressed).toBe(true);
    expect(api.agentDeletePath).not.toHaveBeenCalled();
  });

  it("suppresses task_create (backgrounded sh -c) without calling api.taskCreate", async () => {
    const out = await executeTool("task_create", { command: "rm -rf ~" }, { dryRun: true });
    expect(JSON.parse(out).suppressed).toBe(true);
    expect(api.taskCreate).not.toHaveBeenCalled();
  });

  it("suppresses MCP tools without calling api.mcpCallTool", async () => {
    const out = await executeTool("mcp__srv__do", { x: 1 }, { dryRun: true });
    expect(JSON.parse(out).suppressed).toBe(true);
    expect(api.mcpCallTool).not.toHaveBeenCalled();
  });

  it("still EXECUTES read-only tools under dry-run (read_file falls through)", async () => {
    await executeTool("read_file", { path: "/tmp/x" }, { dryRun: true });
    expect(api.agentReadFile).toHaveBeenCalled();
  });

  it("write_file gets a rich preview, never a real write", async () => {
    const out = await executeTool("write_file", { path: "/tmp/x", content: "hi" }, { dryRun: true });
    const parsed = JSON.parse(out);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.would_write).toBeTruthy();
    expect(api.agentWriteFile).not.toHaveBeenCalled();
  });
});

describe("executeTool: kill_process pid guard", () => {
  it("rejects pid < 2 without calling the IPC", async () => {
    const out = await executeTool("kill_process", { pid: 1 });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("invalid_argument");
    expect(api.agentKillProcess).not.toHaveBeenCalled();
  });
});
