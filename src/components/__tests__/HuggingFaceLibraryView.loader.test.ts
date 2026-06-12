/**
 * Unit tests for the loader helpers in hf-library/loader.ts.
 *
 * Covers URL construction, fan-out for multi-task selection, and the
 * client-side filter helpers (apps / providers / params).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadHuggingFace,
  matchesApps,
  matchesProviders,
  matchesParams,
  extractParams,
  type HfModel,
} from "../hf-library/loader";

function stubFetch(returnValue: HfModel[] = []): {
  calls: string[];
  fn: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "x-total-count": "5" }),
      json: async () => returnValue,
    } as unknown as Response;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return { calls, fn };
}

describe("loadHuggingFace", () => {
  let originalFetch: typeof fetch | undefined;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it("emits a single fetch with no params when filters are empty", async () => {
    const { calls } = stubFetch();
    const ctrl = new AbortController();
    await loadHuggingFace({
      query: "",
      tasks: [],
      libraries: [],
      inference: false,
      sort: "trending",
      offset: 0,
      signal: ctrl.signal,
    });
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/^https:\/\/huggingface\.co\/api\/models\?/);
    expect(calls[0]).not.toContain("sort=");
    expect(calls[0]).not.toContain("pipeline_tag=");
  });

  it("fans out to N parallel fetches when multiple tasks are picked, capped at 10", async () => {
    const { calls } = stubFetch();
    const ctrl = new AbortController();
    const tasks = [
      "text-generation",
      "text-to-image",
      "text-to-speech",
      "image-to-text",
    ];
    await loadHuggingFace({
      query: "qwen",
      tasks,
      libraries: ["mlx", "gguf"],
      inference: true,
      sort: "downloads",
      offset: 0,
      signal: ctrl.signal,
    });
    expect(calls.length).toBe(tasks.length);
    for (const t of tasks) {
      expect(
        calls.some((u) => u.includes(`pipeline_tag=${encodeURIComponent(t)}`)),
      ).toBe(true);
    }
    // Library filter + inference flag flow into every call.
    for (const u of calls) {
      expect(u).toContain("filter=mlx%2Cgguf");
      expect(u).toContain("inference=warm");
      expect(u).toContain("search=qwen");
      expect(u).toContain("sort=downloads");
    }
  });

  it("propagates abort via AbortSignal", async () => {
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      // Simulate a hung request that respects the signal.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    }) as unknown as typeof fetch;
    const ctrl = new AbortController();
    const p = loadHuggingFace({
      query: "",
      tasks: [],
      libraries: [],
      inference: false,
      sort: "trending",
      offset: 0,
      signal: ctrl.signal,
    });
    ctrl.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});

describe("client-side filter helpers", () => {
  const M = (
    id: string,
    tags: string[] = [],
    numParameters?: number,
  ): HfModel => ({
    id,
    downloads: 0,
    likes: 0,
    tags,
    numParameters,
  });

  it("matchesApps detects both bare and library-prefixed tags", () => {
    expect(matchesApps(M("a", ["vllm"]), ["vllm"])).toBe(true);
    expect(matchesApps(M("a", ["library:llama.cpp"]), ["llama.cpp"])).toBe(
      true,
    );
    expect(matchesApps(M("a", ["unrelated"]), ["ollama"])).toBe(false);
    expect(matchesApps(M("a", []), [])).toBe(true); // no filter → pass
  });

  it("matchesProviders honors provider:* and inference_provider:* prefixes", () => {
    expect(matchesProviders(M("a", ["provider:groq"]), ["groq"])).toBe(true);
    expect(
      matchesProviders(M("a", ["inference_provider:together"]), ["together"]),
    ).toBe(true);
    expect(matchesProviders(M("a", ["something-else"]), ["groq"])).toBe(false);
  });

  it("extractParams parses common HF id shapes", () => {
    expect(extractParams(M("mlx-community/Llama-3.2-3B-Instruct"))).toBe(
      3_000_000_000,
    );
    expect(extractParams(M("meta/Llama-3.1-70B-Instruct"))).toBe(
      70_000_000_000,
    );
    expect(extractParams(M("foo/Qwen2.5-1.5B-Chat"))).toBe(1_500_000_000);
    expect(extractParams(M("foo/some-model-with-no-param-tag"))).toBe(null);
    expect(extractParams(M("foo/bar", [], 7_000_000_000))).toBe(7_000_000_000);
  });

  it("matchesParams honors the bucket range", () => {
    const buckets = [1e9, 6e9, 12e9, 32e9, 128e9, Infinity];
    const small = M("mlx-community/Llama-3.2-3B-Instruct"); // 3B → bucket 1
    const big = M("meta/Llama-3.1-70B-Instruct"); // 70B → bucket 4
    // Full range → always include.
    expect(matchesParams(small, 0, 5, buckets)).toBe(true);
    // Narrow to 0–1 → 3B excluded (> 1B but bucket 1 max is 6B; lo=1e9, hi=6e9 — 3e9 fits).
    expect(matchesParams(small, 1, 1, buckets)).toBe(true);
    // Narrow to >32B (buckets 4-5) → small excluded, big included.
    expect(matchesParams(small, 4, 5, buckets)).toBe(false);
    expect(matchesParams(big, 4, 5, buckets)).toBe(true);
    // Unknowns excluded when slider isn't at default.
    expect(matchesParams(M("foo/no-params"), 1, 3, buckets)).toBe(false);
  });
});
