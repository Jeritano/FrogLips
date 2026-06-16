import { describe, expect, it } from "vitest";
import type { CheckpointTurn } from "../../tauri-api";
import { rehydrateCheckpointTurns } from "../runner";

/**
 * RESUME: `rehydrateCheckpointTurns` is the inverse of `checkpointTurnsFrom` —
 * it reconstructs runner `Message`s from the durable checkpoint shadow so an
 * interrupted run can continue. These cover the round-trip: a plain assistant
 * turn, an assistant-with-tool-calls JSON envelope, and a tool-result turn.
 */
describe("rehydrateCheckpointTurns", () => {
  const CONV = 7;

  it("rehydrates a plain assistant turn as text", () => {
    const turns: CheckpointTurn[] = [
      { turn_index: 0, role: "assistant", content: "thinking out loud" },
    ];
    const out = rehydrateCheckpointTurns(turns, CONV);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("assistant");
    expect(out[0].content).toBe("thinking out loud");
    expect(out[0].tool_calls).toBeUndefined();
    expect(out[0].conversation_id).toBe(CONV);
  });

  it("decodes the {content,tool_calls} envelope back into tool_calls", () => {
    const envelope = JSON.stringify({
      content: "let me read it",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read_file", arguments: { path: "a.txt" } },
        },
      ],
    });
    const turns: CheckpointTurn[] = [
      { turn_index: 0, role: "assistant", content: envelope, model: "m" },
    ];
    const out = rehydrateCheckpointTurns(turns, CONV);
    expect(out[0].content).toBe("let me read it");
    expect(out[0].tool_calls).toHaveLength(1);
    expect(out[0].tool_calls?.[0].id).toBe("c1");
    expect(out[0].tool_calls?.[0].function.name).toBe("read_file");
    expect(out[0].model).toBe("m");
  });

  it("rehydrates a tool-result turn with its call id + name", () => {
    const turns: CheckpointTurn[] = [
      {
        turn_index: 1,
        role: "tool",
        content: '{"ok":true}',
        tool_call_id: "c1",
        tool_name: "read_file",
      },
    ];
    const out = rehydrateCheckpointTurns(turns, CONV);
    expect(out[0].role).toBe("tool");
    expect(out[0].tool_call_id).toBe("c1");
    expect(out[0].tool_name).toBe("read_file");
    expect(out[0].content).toBe('{"ok":true}');
  });

  it("sorts by turn_index and ignores non-agent roles", () => {
    const turns: CheckpointTurn[] = [
      { turn_index: 2, role: "assistant", content: "second" },
      { turn_index: 0, role: "assistant", content: "first" },
      // A stray system/user turn (shouldn't be in a checkpoint, but be safe).
      { turn_index: 1, role: "user", content: "ignored" },
    ];
    const out = rehydrateCheckpointTurns(turns, CONV);
    expect(out.map((m) => m.content)).toEqual(["first", "second"]);
  });

  it("degrades a corrupt envelope to plain text rather than throwing", () => {
    const turns: CheckpointTurn[] = [
      { turn_index: 0, role: "assistant", content: "{not valid json" },
    ];
    const out = rehydrateCheckpointTurns(turns, CONV);
    expect(out[0].content).toBe("{not valid json");
    expect(out[0].tool_calls).toBeUndefined();
  });

  it("a round-trip pair survives stripUnpairedToolCalls (paired)", () => {
    // An assistant call + its matching tool result is a healthy pair.
    const turns: CheckpointTurn[] = [
      {
        turn_index: 0,
        role: "assistant",
        content: JSON.stringify({
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "read_file", arguments: {} },
            },
          ],
        }),
      },
      {
        turn_index: 1,
        role: "tool",
        content: '{"ok":true}',
        tool_call_id: "c1",
        tool_name: "read_file",
      },
    ];
    const out = rehydrateCheckpointTurns(turns, CONV);
    expect(out).toHaveLength(2);
    expect(out[0].tool_calls?.[0].id).toBe(out[1].tool_call_id);
  });
});
