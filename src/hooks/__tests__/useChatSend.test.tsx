import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Conversation, Message, ServerStatus } from "../../types";

// ── Module stubs ───────────────────────────────────────────────────────────
const addMessage = vi.fn(async (..._a: unknown[]) => 1);
vi.mock("../../lib/tauri-api", () => ({
  api: {
    addMessage: (...a: unknown[]) => addMessage(...a),
    touchMemories: vi.fn(async () => undefined),
  },
}));

// Plain-streaming path yields two deltas then completes.
vi.mock("../../lib/mlx-client", () => ({
  // eslint-disable-next-line require-yield
  streamChat: async function* () {
    yield { delta: "hello ", done: false };
    yield { delta: "world", done: false };
    yield { delta: "", done: true };
  },
}));
vi.mock("../../lib/native-client", () => ({
  streamNativeChat: async function* () {
    yield { delta: "", done: true };
  },
}));
vi.mock("../../lib/agent-loop", () => ({
  runAgentLoop: vi.fn(async () => null),
  cancelActiveShell: vi.fn(),
}));
vi.mock("../../lib/memory-client", () => ({
  getMemoryMode: () => "off",
  recall: vi.fn(async () => []),
  formatRecallBlock: () => null,
  extractFacts: vi.fn(async () => []),
  saveMemory: vi.fn(async () => ({ deduped: false })),
  // W4-SEND item 2: plain-chat RAG auto-retrieve. Default off so the send path
  // is unchanged in these tests.
  getRagContextEnabled: () => false,
  retrieveRagContext: vi.fn(async () => []),
  formatRagContextBlock: () => null,
}));

import { useChatSend, type ChatSendConfig } from "../useChatSend";
import type { AgentSettings } from "../useAgentSettings";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const STATUS: ServerStatus = {
  running: true,
  model: "test-model",
  backend: "mlx",
} as ServerStatus;

const CONV: Conversation = { id: 7, title: "t", model: null, created_at: 1 };

const AGENT_STUB = {
  allowlist: [],
  activePreset: undefined,
  approveAllShell: false,
  approveAllWrite: false,
  dryRun: false,
  approvedShellPrefixes: [],
  setApprovedShellPrefixes: vi.fn(),
} as unknown as AgentSettings;

function makeConfig(over: Partial<ChatSendConfig> = {}): ChatSendConfig {
  const convRef = { current: CONV };
  return {
    status: STATUS,
    agentMode: false,
    agentAvailable: true,
    workspaceRoot: null,
    projectPolicy: null,
    convParams: {
      temperature: null,
      top_p: null,
      max_tokens: null,
      system_prompt: null,
    },
    agent: AGENT_STUB,
    messages: [],
    ensureConversation: async () => CONV,
    convRef,
    requestConfirmation: async () => ({ approve: false, remember: false }),
    setMessages: vi.fn(),
    setStreaming: vi.fn(),
    setErr: vi.fn(),
    setRecalled: vi.fn(),
    setAgentStatus: vi.fn(),
    setAgentMetrics: vi.fn(),
    ...over,
  };
}

let captured: ReturnType<typeof useChatSend> | null = null;
function Harness({ config }: { config: ChatSendConfig }) {
  captured = useChatSend(config);
  return null;
}

let root: Root;
let container: HTMLElement;
async function render(config: ChatSendConfig) {
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root.render(<Harness config={config} />);
  });
}

afterEach(() => {
  vi.clearAllMocks();
  if (root) act(() => root.unmount());
});

describe("useChatSend", () => {
  it("returns stable send/resend/abort callbacks", async () => {
    await render(makeConfig());
    expect(typeof captured!.send).toBe("function");
    expect(typeof captured!.resend).toBe("function");
    expect(typeof captured!.abort).toBe("function");
  });

  it("errors out without persisting when no model is running", async () => {
    const setErr = vi.fn();
    await render(makeConfig({ status: null, setErr }));
    await act(async () => {
      await captured!.send("hi");
    });
    expect(setErr).toHaveBeenCalledWith("Start a model first");
    expect(addMessage).not.toHaveBeenCalled();
  });

  it("plain-streaming send persists the user turn and the assistant reply", async () => {
    const setMessages = vi.fn();
    await render(makeConfig({ setMessages }));
    await act(async () => {
      await captured!.send("hi");
    });
    // user turn + assistant turn both persisted.
    expect(addMessage).toHaveBeenCalledWith(7, "user", "hi", null, undefined);
    expect(addMessage).toHaveBeenCalledWith(
      7,
      "assistant",
      "hello world",
      "test-model",
    );
    // assistant message appended to state.
    const appended = setMessages.mock.calls.some(([arg]) => {
      if (typeof arg !== "function") return false;
      const out = (arg as (m: Message[]) => Message[])([]);
      return out.some(
        (m) => m.role === "assistant" && m.content === "hello world",
      );
    });
    expect(appended).toBe(true);
  });
});
