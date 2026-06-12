import { describe, expect, it, vi } from "vitest";

/* ── Mock the tauri-api before importing dispatch/tools. ──────────────── */

const { ragSearchSpy } = vi.hoisted(() => {
  return {
    ragSearchSpy: vi.fn(
      async (corpus: string, query: string, topK?: number) => {
        void topK;
        return [
          {
            path: "src/foo.ts",
            snippet: `match for ${query} in ${corpus}`,
            score: 0.87,
            start_byte: 0,
            end_byte: 12,
          },
        ];
      },
    ),
  };
});

vi.mock("../../tauri-api", () => {
  return {
    api: {
      ragSearch: ragSearchSpy,
      // Other api members are not used by these tests; provide no-op stubs
      // for any incidental imports.
    },
  };
});

import { executeTool, agentRagSearch } from "../dispatch";
import { TOOLS } from "../tools";

describe("search_project_knowledge tool", () => {
  it("appears in the TOOLS registry with required parameters", () => {
    const tool = TOOLS.find(
      (t) => t.function.name === "search_project_knowledge",
    );
    expect(tool).toBeDefined();
    expect(tool?.function.parameters).toMatchObject({
      type: "object",
      required: ["corpus_name", "query"],
    });
  });

  it("dispatches to api.ragSearch with corpus + query + top_k", async () => {
    ragSearchSpy.mockClear();
    const out = await executeTool("search_project_knowledge", {
      corpus_name: "my-proj",
      query: "kernel boot",
      top_k: 3,
    });
    expect(ragSearchSpy).toHaveBeenCalledWith("my-proj", "kernel boot", 3);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.hits)).toBe(true);
    expect(parsed.hits[0].path).toBe("src/foo.ts");
    expect(parsed.hits[0].score).toBeGreaterThan(0);
  });

  it("defaults top_k to undefined when not provided", async () => {
    ragSearchSpy.mockClear();
    await executeTool("search_project_knowledge", {
      corpus_name: "c",
      query: "q",
    });
    expect(ragSearchSpy).toHaveBeenCalledWith("c", "q", undefined);
  });

  it("agentRagSearch helper is exported", async () => {
    ragSearchSpy.mockClear();
    const hits = await agentRagSearch("c", "q", 7);
    expect(ragSearchSpy).toHaveBeenCalledWith("c", "q", 7);
    expect(hits).toHaveLength(1);
  });
});
