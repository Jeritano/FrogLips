import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, ProjectPolicy } from "../../../types";

// Mock the tauri-api surface so the runner can execute under jsdom without
// real Tauri bindings. policyLoad is stubbed to return null by default; the
// per-test opts.projectPolicy short-circuits the load anyway.
vi.mock("../../tauri-api", () => {
  return {
    api: {
      agentRunShell: vi.fn(async () => ({
        stdout: "ok",
        stderr: "",
        exit_code: 0,
        duration_ms: 1,
        timed_out: false,
      })),
      agentClassifyShell: vi.fn(async () => "normal"),
      agentClassifyApplescript: vi.fn(async () => "normal"),
      agentClassifyHttp: vi.fn(async () => "normal"),
      agentCancelShell: vi.fn(async () => {}),
      policyLoad: vi.fn(async () => null),
      auditAppend: vi.fn(async () => {}),
    },
  };
});

import { policyDecisionFor, runAgentLoop } from "../runner";
import type { AgentRunOptions } from "../types";

function ollamaShellToolResponse(id: string, command: string) {
  return {
    message: {
      content: "",
      tool_calls: [
        {
          id,
          type: "function",
          function: { name: "run_shell", arguments: { command } },
        },
      ],
    },
    prompt_eval_count: 1,
    eval_count: 1,
  };
}

function ollamaFinalResponse(text: string) {
  return { message: { content: text }, prompt_eval_count: 1, eval_count: 1 };
}

describe("policyDecisionFor", () => {
  it("returns needs-confirm with no policy", () => {
    expect(policyDecisionFor(null, "run_shell", { command: "ls" })).toBe(
      "needs-confirm",
    );
  });

  it("user-level allowed_shell_prefixes auto-approves a matching first token", () => {
    // A USER-level policy (no `.froglips/` segment in source_path) opts in
    // to auto-approving the listed shell prefixes — this is the documented
    // behaviour of the structured `allowed_shell_prefixes` field.
    const policy: ProjectPolicy = {
      allowed_shell_prefixes: ["cargo", "git"],
      source_path: "/home/u/.config/froglips/policy.json",
    };
    expect(policyDecisionFor(policy, "run_shell", { command: "cargo test" })).toBe(
      "auto",
    );
    expect(policyDecisionFor(policy, "run_shell", { command: "rm -rf /" })).toBe(
      "needs-confirm",
    );
  });

  it("repo-local allowed_shell_prefixes is downgraded to needs-confirm", () => {
    // A `.froglips/policy.json` in a workspace is attacker-controllable;
    // its prefix list must NEVER silently auto-approve a shell command.
    const repoPolicy: ProjectPolicy = {
      allowed_shell_prefixes: ["cargo", "git"],
      source_path: "/home/u/projx/.froglips/policy.json",
    };
    expect(
      policyDecisionFor(repoPolicy, "run_shell", { command: "cargo test" }),
    ).toBe("needs-confirm");
  });

  it("compound shell command never auto-approves even with matching prefix", () => {
    const policy: ProjectPolicy = {
      allowed_shell_prefixes: ["cargo"],
      source_path: "/home/u/.config/froglips/policy.json",
    };
    expect(
      policyDecisionFor(policy, "run_shell", { command: "cargo test; rm -rf /" }),
    ).toBe("needs-confirm");
  });

  it("never auto-approves run_shell / applescript_run via auto_approve list", () => {
    const policy: ProjectPolicy = {
      auto_approve_dangerous_tools: ["run_shell", "applescript_run"],
    };
    expect(policyDecisionFor(policy, "run_shell", { command: "ls" })).toBe(
      "needs-confirm",
    );
    expect(policyDecisionFor(policy, "applescript_run", { script: "x" })).toBe(
      "needs-confirm",
    );
  });

  it("ignores auto_approve from a repo-local .froglips policy", () => {
    const repoPolicy: ProjectPolicy = {
      auto_approve_dangerous_tools: ["clipboard_set"],
      source_path: "/home/u/projx/.froglips/policy.json",
    };
    expect(policyDecisionFor(repoPolicy, "clipboard_set", { text: "x" })).toBe(
      "needs-confirm",
    );
  });

  it("does not auto-approve non-normal-risk tools", () => {
    const policy: ProjectPolicy = {
      auto_approve_dangerous_tools: ["http_request"],
      source_path: "/home/u/.config/froglips/policy.json",
    };
    expect(
      policyDecisionFor(policy, "http_request", { method: "POST" }, "privileged"),
    ).toBe("needs-confirm");
    expect(
      policyDecisionFor(policy, "http_request", { method: "GET" }, "normal"),
    ).toBe("auto");
  });

  it("denies writes to a denied path even if allowed elsewhere", () => {
    const policy: ProjectPolicy = {
      allowed_write_paths: ["src/", "tests/"],
      denied_write_paths: [".env", "secrets/", "*.key"],
    };
    expect(policyDecisionFor(policy, "write_file", { path: ".env" })).toBe("denied");
    expect(
      policyDecisionFor(policy, "edit_file", { path: "secrets/db.json" }),
    ).toBe("denied");
    expect(policyDecisionFor(policy, "write_file", { path: "src/main.rs" })).toBe(
      "auto",
    );
    expect(
      policyDecisionFor(policy, "write_file", { path: "README.md" }),
    ).toBe("needs-confirm");
  });

  it("respects auto_approve_dangerous_tools list", () => {
    const policy: ProjectPolicy = {
      auto_approve_dangerous_tools: ["clipboard_set"],
    };
    expect(policyDecisionFor(policy, "clipboard_set", { text: "x" })).toBe(
      "auto",
    );
    expect(policyDecisionFor(policy, "applescript_run", { script: "" })).toBe(
      "needs-confirm",
    );
  });
});

describe("runAgentLoop with project policy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("user-level allowed_shell_prefixes auto-approves without prompting", async () => {
    const responses: object[] = [
      ollamaShellToolResponse("tc-1", "cargo test"),
      ollamaFinalResponse("done"),
    ];
    let idx = 0;
    const fetchMock = vi.fn(async () => {
      const payload = responses[idx++] ?? ollamaFinalResponse("done");
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const requestConfirmation = vi.fn(async () => ({ approve: true }));
    const collected: Message[][] = [];

    const opts: AgentRunOptions = {
      model: "test",
      messages: [{ conversation_id: 1, role: "user", content: "run tests" }],
      conversationId: 1,
      workspaceRoot: "/tmp/projx",
      // User-level policy (path NOT under .froglips/) — allowed_shell_prefixes
      // honoured: `cargo test` matches the `cargo` prefix → auto-approve.
      projectPolicy: {
        allowed_shell_prefixes: ["cargo"],
        source_path: "/home/u/.config/froglips/policy.json",
      },
      onUpdate: (m) => collected.push([...m]),
      onStatusChange: () => {},
      requestConfirmation,
      signal: new AbortController().signal,
    };

    await runAgentLoop(opts);

    expect(requestConfirmation).not.toHaveBeenCalled();

    const last = collected[collected.length - 1] ?? [];
    const toolMsgs = last.filter((m) => m.role === "tool" && m.tool_name === "run_shell");
    expect(toolMsgs.length).toBe(1);
  });

  it("repo-local allowed_shell_prefixes still requires confirmation", async () => {
    const responses: object[] = [
      ollamaShellToolResponse("tc-1", "cargo test"),
      ollamaFinalResponse("done"),
    ];
    let idx = 0;
    const fetchMock = vi.fn(async () => {
      const payload = responses[idx++] ?? ollamaFinalResponse("done");
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const requestConfirmation = vi.fn(async () => ({ approve: true }));

    const opts: AgentRunOptions = {
      model: "test",
      messages: [{ conversation_id: 1, role: "user", content: "run tests" }],
      conversationId: 1,
      workspaceRoot: "/tmp/projx",
      // Repo-local policy — prefix-allow downgraded to needs-confirm.
      projectPolicy: {
        allowed_shell_prefixes: ["cargo"],
        source_path: "/tmp/projx/.froglips/policy.json",
      },
      onUpdate: () => {},
      onStatusChange: () => {},
      requestConfirmation,
      signal: new AbortController().signal,
    };

    await runAgentLoop(opts);

    expect(requestConfirmation).toHaveBeenCalledTimes(1);
  });

  it("blocks denied writes without prompting", async () => {
    const responses: object[] = [
      {
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-1",
              type: "function",
              function: {
                name: "write_file",
                arguments: { path: ".env", content: "X=1" },
              },
            },
          ],
        },
        prompt_eval_count: 1,
        eval_count: 1,
      },
      ollamaFinalResponse("done"),
    ];
    let idx = 0;
    const fetchMock = vi.fn(async () => {
      const payload = responses[idx++] ?? ollamaFinalResponse("done");
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const requestConfirmation = vi.fn(async () => ({ approve: true }));
    const collected: Message[][] = [];

    const opts: AgentRunOptions = {
      model: "test",
      messages: [{ conversation_id: 1, role: "user", content: "write .env" }],
      conversationId: 1,
      workspaceRoot: "/tmp/projx",
      projectPolicy: {
        denied_write_paths: [".env"],
        allowed_write_paths: ["src/"],
      },
      onUpdate: (m) => collected.push([...m]),
      onStatusChange: () => {},
      requestConfirmation,
      signal: new AbortController().signal,
    };

    await runAgentLoop(opts);

    expect(requestConfirmation).not.toHaveBeenCalled();
    const last = collected[collected.length - 1] ?? [];
    const denied = last.find((m) => {
      if (m.role !== "tool") return false;
      try {
        return JSON.parse(m.content).kind === "policy_denied";
      } catch {
        return false;
      }
    });
    expect(denied).toBeTruthy();
  });
});
