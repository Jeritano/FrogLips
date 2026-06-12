import { describe, expect, it } from "vitest";
import type { Message, ToolCall } from "../../../types";
import { stripUnpairedToolCalls } from "../runner";

const CONV = 1;
const sys = (c: string): Message => ({
  conversation_id: CONV,
  role: "system",
  content: c,
});
const user = (c: string): Message => ({
  conversation_id: CONV,
  role: "user",
  content: c,
});
const asst = (c: string): Message => ({
  conversation_id: CONV,
  role: "assistant",
  content: c,
});
function call(id: string, content = ""): Message {
  const tc: ToolCall = {
    id,
    type: "function",
    function: { name: "run_shell", arguments: "{}" },
  };
  return {
    conversation_id: CONV,
    role: "assistant",
    content,
    tool_calls: [tc],
  };
}
function multiCall(ids: string[]): Message {
  return {
    conversation_id: CONV,
    role: "assistant",
    content: "",
    tool_calls: ids.map((id) => ({
      id,
      type: "function",
      function: { name: "run_shell", arguments: "{}" },
    })),
  };
}
const toolRes = (id: string, c = "ok"): Message => ({
  conversation_id: CONV,
  role: "tool",
  content: c,
  tool_call_id: id,
  tool_name: "run_shell",
});

function ids(ms: Message[]) {
  return ms.map((m) =>
    m.role === "assistant" && m.tool_calls?.length
      ? `asst[${m.tool_calls.map((t) => t.id)}]`
      : m.role,
  );
}

describe("stripUnpairedToolCalls", () => {
  it("leaves a fully-paired history unchanged", () => {
    const h = [sys("s"), user("u"), call("a"), toolRes("a"), asst("done")];
    expect(stripUnpairedToolCalls(h)).toEqual(h);
  });

  it("drops a trailing orphan tool_calls turn (no content)", () => {
    const out = stripUnpairedToolCalls([sys("s"), user("u"), call("a")]);
    expect(ids(out)).toEqual(["system", "user"]);
  });

  it("keeps assistant prose but drops the unpaired tool_calls", () => {
    const out = stripUnpairedToolCalls([
      sys("s"),
      user("u"),
      call("a", "thinking…"),
    ]);
    expect(out).toHaveLength(3);
    const last = out[2];
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("thinking…");
    expect(last.tool_calls).toBeUndefined();
  });

  it("drops a mid-array orphan when the user has already re-sent", () => {
    // The exact regression: abort left an orphan, user sends again.
    const out = stripUnpairedToolCalls([
      sys("s"),
      user("u1"),
      call("a"),
      user("u2"),
    ]);
    expect(ids(out)).toEqual(["system", "user", "user"]);
  });

  it("drops an orphan tool result with no preceding call", () => {
    const out = stripUnpairedToolCalls([sys("s"), user("u"), toolRes("ghost")]);
    expect(ids(out)).toEqual(["system", "user"]);
  });

  it("drops a partially-paired multi-call turn and its partial result", () => {
    const out = stripUnpairedToolCalls([
      user("u"),
      multiCall(["a", "b"]),
      toolRes("a"),
    ]);
    expect(ids(out)).toEqual(["user"]);
  });
});
