import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Hoisted mock surface for the Tauri API. The dry-run dispatcher MUST NOT
 * invoke any of these for side-effectful tools; the test asserts on each
 * spy's call count.
 */
const {
  writeFileMock,
  editFileMock,
  multiEditMock,
  runShellMock,
  applescriptMock,
  browserNavigateMock,
  browserClickMock,
  browserFillMock,
  readFileMock,
  auditRecordMock,
} = vi.hoisted(() => ({
  writeFileMock: vi.fn(async () => undefined),
  editFileMock: vi.fn(async () => ({ ok: true })),
  multiEditMock: vi.fn(async () => ({ ok: true })),
  runShellMock: vi.fn(async () => ({
    ok: true,
    stdout: "",
    stderr: "",
    code: 0,
  })),
  applescriptMock: vi.fn(async () => ({ ok: true, output: "" })),
  browserNavigateMock: vi.fn(async () => ({ status: 200, title: "", url: "" })),
  browserClickMock: vi.fn(async () => ({ ok: true })),
  browserFillMock: vi.fn(async () => ({ ok: true })),
  readFileMock: vi.fn(async (path: string) => ({
    content: `line one\nline two\nline three\n`,
    path,
    total_bytes: 26,
  })),
  auditRecordMock: vi.fn(async () => undefined),
}));

vi.mock("../../tauri-api", () => ({
  api: {
    agentWriteFile: writeFileMock,
    agentEditFile: editFileMock,
    agentMultiEdit: multiEditMock,
    agentRunShell: runShellMock,
    agentApplescriptRun: applescriptMock,
    agentBrowserNavigate: browserNavigateMock,
    agentBrowserClick: browserClickMock,
    agentBrowserFill: browserFillMock,
    agentReadFile: readFileMock,
    agentAuditRecord: auditRecordMock,
  },
}));

import { executeTool, dryRunValidateUrl } from "../dispatch";

afterEach(() => {
  writeFileMock.mockClear();
  editFileMock.mockClear();
  multiEditMock.mockClear();
  runShellMock.mockClear();
  applescriptMock.mockClear();
  browserNavigateMock.mockClear();
  browserClickMock.mockClear();
  browserFillMock.mockClear();
  readFileMock.mockClear();
  auditRecordMock.mockClear();
});

describe("dry-run mode: write-side tools short-circuit", () => {
  it("write_file: never invokes Tauri, returns would_write payload", async () => {
    const out = await executeTool(
      "write_file",
      { path: "/tmp/a.txt", content: "hello world" },
      { dryRun: true },
    );
    expect(writeFileMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.would_write.path).toBe("/tmp/a.txt");
    expect(parsed.would_write.size_bytes).toBe(11);
    // sha256_first16 is best-effort — may be empty in the test runner env
    // but must always be present as a field.
    expect(parsed.would_write).toHaveProperty("sha256_first16");
  });

  it("run_shell: never invokes Tauri, returns would_run payload", async () => {
    const out = await executeTool(
      "run_shell",
      { command: "rm -rf /tmp/foo", cwd: "/tmp" },
      { dryRun: true },
    );
    expect(runShellMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.would_run).toBe("rm -rf /tmp/foo");
    expect(parsed.cwd).toBe("/tmp");
    // `env` is intentionally absent — run_shell has no env parameter + the
    // executor never forwarded one, so the dry-run no longer echoes it.
    expect(parsed.env).toBeUndefined();
  });

  it("applescript_run: never invokes Tauri, truncates to 2 KB", async () => {
    const longScript = "x".repeat(3000);
    const out = await executeTool(
      "applescript_run",
      { script: longScript },
      { dryRun: true },
    );
    expect(applescriptMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.would_run_applescript.startsWith("x".repeat(2048))).toBe(
      true,
    );
    expect(parsed.would_run_applescript).toContain("truncated");
  });

  it("edit_file: reads file, returns unified diff, never invokes editFile", async () => {
    const out = await executeTool(
      "edit_file",
      { path: "/tmp/a.txt", old_string: "line two", new_string: "LINE TWO" },
      { dryRun: true },
    );
    expect(editFileMock).not.toHaveBeenCalled();
    expect(readFileMock).toHaveBeenCalledWith("/tmp/a.txt");
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.would_change).toContain("-line two");
    expect(parsed.would_change).toContain("+LINE TWO");
    expect(parsed.would_change).toContain("/tmp/a.txt"); // path appears in diff header
  });

  it("multi_edit: applies all edits in-memory, returns unified diff", async () => {
    const out = await executeTool(
      "multi_edit",
      {
        path: "/tmp/a.txt",
        edits: [
          { old_string: "line one", new_string: "LINE ONE" },
          { old_string: "line three", new_string: "LINE THREE" },
        ],
      },
      { dryRun: true },
    );
    expect(multiEditMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.would_change).toContain("-line one");
    expect(parsed.would_change).toContain("+LINE ONE");
    expect(parsed.would_change).toContain("-line three");
    expect(parsed.would_change).toContain("+LINE THREE");
  });

  it("browser_navigate: passes safe public URL through, never invokes Tauri", async () => {
    const out = await executeTool(
      "browser_navigate",
      { url: "https://example.com/page" },
      { dryRun: true },
    );
    expect(browserNavigateMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.would_navigate).toBe("https://example.com/page");
  });

  it("browser_navigate: blocks loopback URL even in dry-run", async () => {
    const out = await executeTool(
      "browser_navigate",
      { url: "http://127.0.0.1/admin" },
      { dryRun: true },
    );
    expect(browserNavigateMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.blocked_by_safety).toMatch(/private|loopback|link-local/);
  });

  it("browser_navigate: blocks .local hosts in dry-run", async () => {
    const out = await executeTool(
      "browser_navigate",
      { url: "http://router.local/" },
      { dryRun: true },
    );
    expect(browserNavigateMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.blocked_by_safety).toContain("router.local");
  });

  it("browser_navigate: blocks file:// scheme", async () => {
    const out = await executeTool(
      "browser_navigate",
      { url: "file:///etc/passwd" },
      { dryRun: true },
    );
    expect(browserNavigateMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.blocked_by_safety).toMatch(/scheme/);
  });

  it("browser_click / browser_fill: return dry-run payload without Tauri", async () => {
    const click = await executeTool(
      "browser_click",
      { selector: "#submit" },
      { dryRun: true },
    );
    expect(browserClickMock).not.toHaveBeenCalled();
    expect(JSON.parse(click).would_click).toBe("#submit");

    const fill = await executeTool(
      "browser_fill",
      { selector: "input[name=q]", value: "hello" },
      { dryRun: true },
    );
    expect(browserFillMock).not.toHaveBeenCalled();
    const fillParsed = JSON.parse(fill);
    expect(fillParsed.would_fill).toEqual({
      selector: "input[name=q]",
      value: "hello",
    });
  });
});

describe("dry-run mode: read-only tools execute normally", () => {
  it("write_file: WITHOUT dry-run does invoke Tauri", async () => {
    await executeTool("write_file", { path: "/tmp/a.txt", content: "x" });
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });
});

describe("dryRunValidateUrl: SSRF preflight", () => {
  it("accepts safe public https URLs", () => {
    const r = dryRunValidateUrl("https://example.com/x");
    expect(r.ok).toBe(true);
  });

  it("rejects bad URLs", () => {
    const r = dryRunValidateUrl("not a url");
    expect(r.ok).toBe(false);
  });

  it("rejects 10.0.0.0/8", () => {
    const r = dryRunValidateUrl("http://10.1.2.3/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/private|loopback/);
  });

  it("rejects 169.254.169.254 (AWS metadata)", () => {
    const r = dryRunValidateUrl("http://169.254.169.254/latest/meta-data/");
    expect(r.ok).toBe(false);
  });

  it("accepts data:image/* URLs but rejects non-image data: URLs", () => {
    expect(dryRunValidateUrl("data:image/png;base64,iVBORw0KGgo=").ok).toBe(
      true,
    );
    expect(dryRunValidateUrl("data:text/html,<h1>hi</h1>").ok).toBe(false);
  });
});
