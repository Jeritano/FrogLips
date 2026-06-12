import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerStatus } from "../../types";
import {
  resolveVisionSupport,
  prefetchVisionSupport,
  __clearVisionCacheForTest,
} from "../model-capability-lookup";

function ollamaStatus(model: string): ServerStatus {
  return {
    running: true,
    ready: true,
    model,
    backend: "ollama",
    host: "127.0.0.1",
    port: 11434,
    last_error: null,
  };
}

afterEach(() => {
  __clearVisionCacheForTest();
  vi.restoreAllMocks();
});

describe("resolveVisionSupport (sync, cache-first)", () => {
  it("falls back to the name heuristic before any prefetch", () => {
    // llava matches the heuristic → true.
    expect(resolveVisionSupport("llava:13b", ollamaStatus("llava:13b"))).toBe(
      true,
    );
    // plain text model → false.
    expect(resolveVisionSupport("llama3:8b", ollamaStatus("llama3:8b"))).toBe(
      false,
    );
  });

  it("returns false for null model", () => {
    expect(resolveVisionSupport(null, null)).toBe(false);
  });
});

describe("prefetchVisionSupport (authoritative via /api/show)", () => {
  it("caches a backend-reported vision capability and overrides the heuristic", async () => {
    // A model the heuristic does NOT recognise, but the backend reports
    // vision. Authoritative answer must win after prefetch.
    const status = ollamaStatus("my-custom-multimodal:latest");
    expect(resolveVisionSupport(status.model, status)).toBe(false); // heuristic miss

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ capabilities: ["completion", "vision"] }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );

    const got = await prefetchVisionSupport(status.model, status);
    expect(got).toBe(true);
    // Now the sync resolver returns the cached authoritative value.
    expect(resolveVisionSupport(status.model, status)).toBe(true);
  });

  it("caches a backend-reported NON-vision capability, overriding a heuristic false-positive", async () => {
    // Name contains "vision" → heuristic says true, but backend says no.
    const status = ollamaStatus("project-vision-planner:7b");
    expect(resolveVisionSupport(status.model, status)).toBe(true); // heuristic false-positive

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ capabilities: ["completion", "tools"] }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );

    const got = await prefetchVisionSupport(status.model, status);
    expect(got).toBe(false);
    expect(resolveVisionSupport(status.model, status)).toBe(false);
  });

  it("returns null and does not cache on non-Ollama backends", async () => {
    const status: ServerStatus = {
      ...ollamaStatus("qwen2-vl"),
      backend: "mlx",
    };
    const got = await prefetchVisionSupport("qwen2-vl", status);
    expect(got).toBeNull();
    // Heuristic still covers (qwen2-vl matches) — no cache poisoning.
    expect(resolveVisionSupport("qwen2-vl", status)).toBe(true);
  });

  it("returns null on fetch failure without caching (lets a later retry win)", async () => {
    const status = ollamaStatus("flaky-model");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const got = await prefetchVisionSupport("flaky-model", status);
    expect(got).toBeNull();
    // No cache entry → heuristic still in play.
    expect(resolveVisionSupport("flaky-model", status)).toBe(false);
  });
});
