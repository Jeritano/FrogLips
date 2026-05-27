// Dispatch coverage for the two Claude-Skills agent tool arms in
// dispatch.ts:
//
//   - list_claude_skills returns enabled-only name+description summaries
//   - load_claude_skill returns the body + parses allowed_tools_json
//   - load_claude_skill returns not_found for an unknown name
//   - load_claude_skill returns disabled when the row's enabled flag is false
//   - load_claude_skill handles null / unparseable allowed_tools_json
//
// Both arms are read-only; no approval flow is exercised here.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claudeSkillList: vi.fn(async (_enabledOnly?: boolean) =>
    [] as Array<Record<string, unknown>>),
  claudeSkillGet: vi.fn(async (_name: string) =>
    null as Record<string, unknown> | null),
}));

vi.mock("../../tauri-api", () => ({
  api: {
    claudeSkillList: mocks.claudeSkillList,
    claudeSkillGet: mocks.claudeSkillGet,
  },
}));

import { executeTool } from "../dispatch";

beforeEach(() => {
  mocks.claudeSkillList.mockReset();
  mocks.claudeSkillList.mockResolvedValue([]);
  mocks.claudeSkillGet.mockReset();
  mocks.claudeSkillGet.mockResolvedValue(null);
});

describe("list_claude_skills", () => {
  it("requests enabled-only and returns name+description summaries", async () => {
    mocks.claudeSkillList.mockResolvedValue([
      {
        id: 1, name: "pdf-extractor", description: "Extract PDF tables",
        source_path: "/sk/pdf", enabled: true, pinned: false,
      },
      {
        id: 2, name: "react-helper", description: "React patterns reference",
        source_path: "/sk/react", enabled: true, pinned: true,
      },
    ]);
    const out = await executeTool("list_claude_skills", {});
    expect(mocks.claudeSkillList).toHaveBeenCalledWith(true);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.skills).toEqual([
      { name: "pdf-extractor", description: "Extract PDF tables" },
      { name: "react-helper", description: "React patterns reference" },
    ]);
  });

  it("returns an empty list when no skills are imported", async () => {
    mocks.claudeSkillList.mockResolvedValue([]);
    const out = await executeTool("list_claude_skills", {});
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.skills).toEqual([]);
  });
});

describe("load_claude_skill", () => {
  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: 1,
      name: "pdf-extractor",
      description: "Extract PDF tables",
      source_path: "/sk/pdf",
      enabled: true,
      pinned: false,
      body_md: "# PDF Extractor\n\nWhen the user asks ...",
      allowed_tools_json: JSON.stringify(["Read", "Bash"]),
      imported_at: 1717000000,
      ...overrides,
    };
  }

  it("returns the body and parses allowed_tools_json into an array", async () => {
    mocks.claudeSkillGet.mockResolvedValue(row());
    const out = await executeTool("load_claude_skill", { name: "pdf-extractor" });
    expect(mocks.claudeSkillGet).toHaveBeenCalledWith("pdf-extractor");
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.name).toBe("pdf-extractor");
    expect(parsed.description).toBe("Extract PDF tables");
    expect(parsed.body).toContain("PDF Extractor");
    expect(parsed.allowed_tools).toEqual(["Read", "Bash"]);
    expect(parsed.source_path).toBe("/sk/pdf");
  });

  it("returns bad_args when name is empty / missing", async () => {
    const out = await executeTool("load_claude_skill", {});
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("bad_args");
    expect(mocks.claudeSkillGet).not.toHaveBeenCalled();
  });

  it("returns not_found when the api returns null", async () => {
    mocks.claudeSkillGet.mockResolvedValue(null);
    const out = await executeTool("load_claude_skill", { name: "ghost" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("not_found");
    expect(parsed.message).toContain("ghost");
  });

  it("returns disabled when the row's enabled flag is false", async () => {
    mocks.claudeSkillGet.mockResolvedValue(row({ enabled: false }));
    const out = await executeTool("load_claude_skill", { name: "pdf-extractor" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("disabled");
  });

  it("leaves allowed_tools undefined when allowed_tools_json is null", async () => {
    mocks.claudeSkillGet.mockResolvedValue(row({ allowed_tools_json: null }));
    const out = await executeTool("load_claude_skill", { name: "pdf-extractor" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.allowed_tools).toBeUndefined();
    expect(parsed.body).toContain("PDF Extractor");
  });

  it("leaves allowed_tools undefined when allowed_tools_json is unparseable", async () => {
    mocks.claudeSkillGet.mockResolvedValue(row({ allowed_tools_json: "not json {" }));
    const out = await executeTool("load_claude_skill", { name: "pdf-extractor" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.allowed_tools).toBeUndefined();
  });

  it("leaves allowed_tools undefined when allowed_tools_json is not an array of strings", async () => {
    mocks.claudeSkillGet.mockResolvedValue(
      row({ allowed_tools_json: JSON.stringify({ Read: true }) }),
    );
    const out = await executeTool("load_claude_skill", { name: "pdf-extractor" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.allowed_tools).toBeUndefined();
  });
});
