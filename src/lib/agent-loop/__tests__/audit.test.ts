import { afterEach, describe, expect, it, vi } from "vitest";

const { recordMock } = vi.hoisted(() => ({
  recordMock: vi.fn<(entry: Record<string, unknown>) => Promise<void>>(
    async () => undefined,
  ),
}));

vi.mock("../../tauri-api", () => {
  return {
    api: {
      agentAuditRecord: recordMock,
    },
  };
});

import { recordAuditSafe, redactArgsForAudit } from "../dispatch";

afterEach(() => {
  recordMock.mockClear();
});

describe("redactArgsForAudit", () => {
  it("leaves small args unchanged", () => {
    const out = redactArgsForAudit("read_file", { path: "/a", limit: 100 });
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ path: "/a", limit: 100 });
  });

  it("truncates write_file content to 256 chars + suffix", () => {
    const big = "x".repeat(1000);
    const out = redactArgsForAudit("write_file", { path: "/a", content: big });
    const parsed = JSON.parse(out) as { path: string; content: string };
    expect(parsed.path).toBe("/a");
    expect(parsed.content.length).toBe(256 + 3); // "..." suffix
    expect(parsed.content.endsWith("...")).toBe(true);
  });

  it("truncates edit_file old_string and new_string", () => {
    const big = "y".repeat(500);
    const out = redactArgsForAudit("edit_file", {
      path: "/a",
      old_string: big,
      new_string: big,
    });
    const parsed = JSON.parse(out) as { old_string: string; new_string: string };
    expect(parsed.old_string.length).toBe(259);
    expect(parsed.new_string.length).toBe(259);
  });

  it("truncates each entry in multi_edit edits", () => {
    const big = "z".repeat(400);
    const out = redactArgsForAudit("multi_edit", {
      path: "/a",
      edits: [{ old_string: big, new_string: big }],
    });
    const parsed = JSON.parse(out) as {
      edits: Array<{ old_string: string; new_string: string }>;
    };
    expect(parsed.edits[0].old_string.length).toBe(259);
    expect(parsed.edits[0].new_string.length).toBe(259);
  });
});

describe("recordAuditSafe", () => {
  it("forwards a sanitised entry to the backend", async () => {
    recordAuditSafe({
      toolName: "read_file",
      args: { path: "/tmp/x" },
      resultBody: '{"ok":true}',
      durationMs: 12.7,
      approval: "auto",
      outcome: "ok",
      conversationId: 42,
    });
    // recordAuditSafe is fire-and-forget — give the microtask queue a tick.
    await Promise.resolve();
    expect(recordMock).toHaveBeenCalledTimes(1);
    const call = recordMock.mock.calls[0]?.[0] as unknown as {
      tool_name: string;
      args_json: string;
      duration_ms: number;
      approval: string;
      outcome: string;
      conversation_id: string | null;
      result_body: string;
    };
    expect(call.tool_name).toBe("read_file");
    expect(call.duration_ms).toBe(13); // rounded
    expect(call.approval).toBe("auto");
    expect(call.outcome).toBe("ok");
    expect(call.conversation_id).toBe("42"); // stringified
    expect(JSON.parse(call.args_json)).toEqual({ path: "/tmp/x" });
    expect(call.result_body).toBe('{"ok":true}');
  });

  it("does not throw when the backend record call rejects", async () => {
    recordMock.mockRejectedValueOnce(new Error("db locked"));
    expect(() =>
      recordAuditSafe({
        toolName: "write_file",
        args: { path: "/a", content: "hi" },
        resultBody: "",
        durationMs: 0,
        approval: "user_allowed",
        outcome: "ok",
      }),
    ).not.toThrow();
    // Let the promise reject — should be swallowed by the catch handler.
    await new Promise((r) => setTimeout(r, 0));
  });
});
