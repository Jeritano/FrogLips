import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";

/**
 * custom-client streams via Tauri events (`custom-chunk:{opId}` /
 * `custom-done:{opId}` / `custom-error:{opId}`) rather than fetch, so the
 * test mocks `@tauri-apps/api/event` `listen` to capture the registered
 * handlers + the `api.customChatStream` IPC, then drives events through.
 */

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: Handler) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  }),
}));

// Resolve the IPC promise only when the test says generation is done, so
// the generator's `Promise.race([wait, reqPromise])` mirrors production
// timing (the request resolves at end-of-stream).
let resolveReq: (() => void) | null = null;
vi.mock("../tauri-api", () => ({
  api: {
    customChatStream: vi.fn(
      () => new Promise<void>((r) => { resolveReq = r; }),
    ),
  },
}));

import { streamCustomChat } from "../custom-client";

afterEach(() => {
  handlers.clear();
  resolveReq = null;
  vi.clearAllMocks();
});

function fire(suffix: string, opIdPrefix: string, payload: unknown) {
  // The opId is random; find the handler whose name ends with the suffix.
  for (const [name, cb] of handlers) {
    if (name.startsWith(`${suffix}:${opIdPrefix}`)) {
      cb({ payload });
      return;
    }
  }
  throw new Error(`no handler for ${suffix}`);
}

const MSGS: Message[] = [{ conversation_id: 1, role: "user", content: "hi" }];

const tick = () => new Promise((r) => setTimeout(r, 0));

async function drainWith(driver: () => void): Promise<{ text: string; err: string | null }> {
  // The async-generator body only runs once consumption starts, so kick the
  // drain in the background, wait for its three listeners to register, then
  // fire the scripted events.
  const gen = streamCustomChat("backend-1", MSGS);
  let text = "";
  let err: string | null = null;
  const consume = (async () => {
    try {
      for await (const c of gen) {
        if (c.done) break;
        text += c.delta;
      }
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
  })();

  for (let i = 0; i < 50 && handlers.size < 3; i++) await tick();
  driver();
  await consume;
  return { text, err };
}

describe("streamCustomChat", () => {
  it("reassembles chunk deltas then completes on done", async () => {
    const out = await drainWith(() => {
      fire("custom-chunk", "custom-", { delta: "Hel" });
      fire("custom-chunk", "custom-", { delta: "lo" });
      fire("custom-done", "custom-", null);
      resolveReq?.();
    });
    expect(out.text).toBe("Hello");
    expect(out.err).toBeNull();
  });

  it("throws the streamed error after draining buffered deltas", async () => {
    const out = await drainWith(() => {
      fire("custom-chunk", "custom-", { delta: "partial" });
      fire("custom-error", "custom-", "rate limited (429)");
      resolveReq?.();
    });
    // Partial output is preserved, and the error surfaces.
    expect(out.text).toBe("partial");
    expect(out.err).toContain("rate limited (429)");
  });
});
