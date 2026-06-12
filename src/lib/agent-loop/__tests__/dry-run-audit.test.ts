import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../../types";

/**
 * Integration-ish test: drive runAgentLoop with dryRun=true and assert that
 *  (a) the underlying write Tauri command (`agentWriteFile`) is never called
 *  (b) the audit log is still written with outcome="dry_run"
 */

const { writeFileMock, auditRecordMock, readFileMock } = vi.hoisted(() => ({
  writeFileMock: vi.fn(async () => undefined),
  auditRecordMock: vi.fn(async () => undefined),
  readFileMock: vi.fn(async () => ({
    content: "x",
    bytes_read: 1,
    total_bytes: 1,
    truncated: false,
    binary: false,
  })),
}));

vi.mock("../../tauri-api", () => ({
  api: {
    agentWriteFile: writeFileMock,
    agentReadFile: readFileMock,
    agentAuditRecord: auditRecordMock,
    agentClassifyShell: vi.fn(async () => "normal"),
    agentClassifyApplescript: vi.fn(async () => "normal"),
    agentClassifyHttp: vi.fn(async () => "normal"),
    agentCancelShell: vi.fn(async () => {}),
  },
}));

import { runAgentLoop } from "../runner";
import type { AgentRunOptions } from "../types";

function ollamaToolCallResponse(id: string, name: string, args: object) {
  return {
    message: {
      content: "",
      tool_calls: [
        { id, type: "function", function: { name, arguments: args } },
      ],
    },
    prompt_eval_count: 1,
    eval_count: 1,
  };
}

function ollamaFinalResponse(text: string) {
  return { message: { content: text }, prompt_eval_count: 1, eval_count: 1 };
}

describe("dry-run audit integration", () => {
  beforeEach(() => {
    writeFileMock.mockClear();
    auditRecordMock.mockClear();
    readFileMock.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dryRun=true: write_file is suppressed and audit row has outcome=dry_run", async () => {
    const responses: object[] = [
      ollamaToolCallResponse("tc-1", "write_file", {
        path: "/tmp/a",
        content: "hello",
      }),
      ollamaFinalResponse("done"),
    ];
    let callIdx = 0;
    const fetchMock = vi.fn(async () => {
      const payload = responses[callIdx++] ?? ollamaFinalResponse("done");
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const collected: Message[][] = [];
    const opts: AgentRunOptions = {
      model: "test",
      messages: [{ conversation_id: 1, role: "user", content: "write" }],
      conversationId: 1,
      workspaceRoot: null,
      // Pre-approve writes so the confirmation prompt doesn't block.
      approveAllWrite: true,
      dryRun: true,
      onUpdate: (m) => collected.push([...m]),
      onStatusChange: () => {},
      requestConfirmation: async () => ({ approve: true }),
      signal: new AbortController().signal,
    };

    await runAgentLoop(opts);

    // The Tauri write_file command must NEVER have fired.
    expect(writeFileMock).not.toHaveBeenCalled();

    // Audit must contain at least one row for write_file with outcome=dry_run.
    await Promise.resolve();
    const writeAudits = auditRecordMock.mock.calls
      .map((c) => (c as unknown[])[0] as Record<string, unknown>)
      .filter((e) => e && e.tool_name === "write_file");
    expect(writeAudits.length).toBeGreaterThanOrEqual(1);
    expect(writeAudits[0]?.outcome).toBe("dry_run");

    // The tool message in the conversation should also carry dry_run:true.
    const last = collected[collected.length - 1] ?? [];
    const writeToolMsgs = last.filter(
      (m) => m.role === "tool" && m.tool_name === "write_file",
    );
    expect(writeToolMsgs.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(writeToolMsgs[0]!.content);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.would_write?.path).toBe("/tmp/a");

    vi.unstubAllGlobals();
  });

  it("dryRun=false: write_file does invoke Tauri", async () => {
    const responses: object[] = [
      ollamaToolCallResponse("tc-1", "write_file", {
        path: "/tmp/b",
        content: "hi",
      }),
      ollamaFinalResponse("done"),
    ];
    let callIdx = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const payload = responses[callIdx++] ?? ollamaFinalResponse("done");
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const opts: AgentRunOptions = {
      model: "test",
      messages: [{ conversation_id: 1, role: "user", content: "write" }],
      conversationId: 1,
      workspaceRoot: null,
      approveAllWrite: true,
      dryRun: false,
      onUpdate: () => {},
      onStatusChange: () => {},
      requestConfirmation: async () => ({ approve: true }),
      signal: new AbortController().signal,
    };

    await runAgentLoop(opts);
    expect(writeFileMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});
