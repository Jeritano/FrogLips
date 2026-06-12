import { describe, expect, it } from "vitest";
import { conversationToMarkdown, safeFilename } from "../export";
import type { Conversation, Message } from "../../types";

const conv: Conversation = {
  id: 42,
  title: "test chat",
  model: "llama3",
  created_at: 1_700_000_000,
};

function fixtureMessages(): Message[] {
  return [
    {
      conversation_id: 42,
      role: "user",
      content: "Read foo.rs and bar.rs please.",
      created_at: 1_700_000_000,
    },
    {
      conversation_id: 42,
      role: "assistant",
      content: "Sure, opening both files.",
      model: "llama3",
      created_at: 1_700_000_001,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "read_file",
            arguments: { path: "src/foo.rs" },
          },
        },
        {
          id: "call_2",
          type: "function",
          function: {
            name: "read_file",
            arguments: { path: "src/bar.rs" },
          },
        },
      ],
    },
    {
      conversation_id: 42,
      role: "tool",
      content: 'fn main() { println!("hi"); }',
      tool_call_id: "call_1",
      tool_name: "read_file",
      created_at: 1_700_000_002,
    },
    {
      conversation_id: 42,
      role: "tool",
      content: "pub fn bar() {}",
      tool_call_id: "call_2",
      tool_name: "read_file",
      created_at: 1_700_000_003,
    },
    {
      conversation_id: 42,
      role: "assistant",
      content: "Both files look fine.",
      model: "llama3",
      created_at: 1_700_000_004,
    },
  ];
}

describe("conversationToMarkdown — plain mode", () => {
  it("defaults to plain mode and drops tool calls / tool results", () => {
    const md = conversationToMarkdown(conv, fixtureMessages());
    expect(md).toContain("# test chat");
    expect(md).toContain("Read foo.rs and bar.rs please.");
    expect(md).toContain("Sure, opening both files.");
    expect(md).toContain("Both files look fine.");
    // Tool calls and tool results must not appear.
    expect(md).not.toContain("read_file");
    expect(md).not.toContain("fn main()");
    expect(md).not.toContain("pub fn bar()");
    expect(md).not.toContain("<details>");
  });

  it("explicit plain mode matches default", () => {
    const a = conversationToMarkdown(conv, fixtureMessages());
    const b = conversationToMarkdown(conv, fixtureMessages(), "plain");
    expect(a).toEqual(b);
  });
});

describe("conversationToMarkdown — detailed mode", () => {
  it("includes one <details> block per tool call, in order", () => {
    const md = conversationToMarkdown(conv, fixtureMessages(), "detailed");
    const detailsCount = (md.match(/<details>/g) ?? []).length;
    expect(detailsCount).toBe(2);
    // Both tool calls appear, in order.
    const firstIdx = md.indexOf("src/foo.rs");
    const secondIdx = md.indexOf("src/bar.rs");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    // Tool name in summary.
    expect(md).toContain("🔧 read_file");
    // Result bodies are present.
    expect(md).toContain("fn main()");
    expect(md).toContain("pub fn bar()");
    // Assistant prose still flows around the tool blocks.
    expect(md).toContain("Sure, opening both files.");
    expect(md).toContain("Both files look fine.");
  });

  it("pretty-prints tool args JSON with 2-space indent", () => {
    const md = conversationToMarkdown(conv, fixtureMessages(), "detailed");
    expect(md).toContain('{\n  "path": "src/foo.rs"\n}');
  });

  it("truncates tool results longer than 500 chars with a suffix", () => {
    const big = "x".repeat(2000);
    const msgs: Message[] = [
      {
        conversation_id: 42,
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read_file", arguments: { path: "/big" } },
          },
        ],
      },
      {
        conversation_id: 42,
        role: "tool",
        content: big,
        tool_call_id: "c1",
        tool_name: "read_file",
      },
    ];
    const md = conversationToMarkdown(conv, msgs, "detailed");
    expect(md).toContain("... (truncated)");
    // Body length must be capped: 500 'x' chars + suffix appears, but not all 2000.
    expect(md).not.toContain("x".repeat(600));
  });

  it("handles string-form tool arguments by attempting to JSON-parse", () => {
    const msgs: Message[] = [
      {
        conversation_id: 42,
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "run_shell",
              arguments: '{"cmd":"ls"}' as unknown as Record<string, unknown>,
            },
          },
        ],
      },
      {
        conversation_id: 42,
        role: "tool",
        content: "ok",
        tool_call_id: "c1",
        tool_name: "run_shell",
      },
    ];
    const md = conversationToMarkdown(conv, msgs, "detailed");
    expect(md).toContain('"cmd": "ls"');
  });
});

describe("safeFilename", () => {
  it("appends suffix when provided", () => {
    expect(safeFilename("My chat", "md")).toBe("My_chat.md");
    expect(safeFilename("My chat", "md", "detailed")).toBe(
      "My_chat-detailed.md",
    );
  });
});
