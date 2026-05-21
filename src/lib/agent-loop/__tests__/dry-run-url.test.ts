import { describe, expect, it, vi } from "vitest";

// dispatch.ts imports tauri-api + diagnostics + mcp-tools at load.
vi.mock("../../tauri-api", () => ({ api: {} }));
vi.mock("../../diagnostics", () => ({ logDiag: vi.fn() }));

import { dryRunValidateUrl } from "../dispatch";

describe("dryRunValidateUrl — SSRF host normalization", () => {
  it("allows an ordinary public host", () => {
    expect(dryRunValidateUrl("https://example.com/").ok).toBe(true);
  });

  it("blocks dotted-quad loopback", () => {
    expect(dryRunValidateUrl("http://127.0.0.1/").ok).toBe(false);
  });

  it("blocks decimal-encoded loopback (2130706433)", () => {
    const r = dryRunValidateUrl("http://2130706433/");
    expect(r.ok).toBe(false);
  });

  it("blocks hex-encoded loopback (0x7f000001)", () => {
    const r = dryRunValidateUrl("http://0x7f000001/");
    expect(r.ok).toBe(false);
  });

  it("blocks octal-encoded loopback (0177.0.0.1)", () => {
    const r = dryRunValidateUrl("http://0177.0.0.1/");
    expect(r.ok).toBe(false);
  });

  it("blocks IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
    const r = dryRunValidateUrl("http://[::ffff:127.0.0.1]/");
    expect(r.ok).toBe(false);
  });

  it("blocks decimal-encoded private 10.x address", () => {
    // 10.0.0.1 == 167772161
    expect(dryRunValidateUrl("http://167772161/").ok).toBe(false);
  });

  it("blocks bare integer 0 (unspecified address)", () => {
    expect(dryRunValidateUrl("http://0/").ok).toBe(false);
  });

  it("still allows a decimal-encoded public address", () => {
    // 8.8.8.8 == 134744072
    expect(dryRunValidateUrl("http://134744072/").ok).toBe(true);
  });
});

describe("dryRunValidateUrl — data: URL MIME gating", () => {
  it("allows data:image/* URLs", () => {
    const r = dryRunValidateUrl("data:image/png;base64,iVBORw0KGgo=");
    expect(r.ok).toBe(true);
  });

  it("rejects data:text/html", () => {
    const r = dryRunValidateUrl("data:text/html,<h1>hi</h1>");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/image/i);
  });

  it("rejects a data: URL with no MIME type", () => {
    const r = dryRunValidateUrl("data:,plaintext");
    expect(r.ok).toBe(false);
  });

  it("rejects data:application/javascript", () => {
    expect(dryRunValidateUrl("data:application/javascript,alert(1)").ok).toBe(false);
  });
});

describe("dryRunValidateUrl — scheme + host basics", () => {
  it("rejects unsupported schemes", () => {
    expect(dryRunValidateUrl("ftp://example.com/").ok).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(dryRunValidateUrl("not a url").ok).toBe(false);
  });

  it("blocks localhost and .local hosts", () => {
    expect(dryRunValidateUrl("http://localhost/").ok).toBe(false);
    expect(dryRunValidateUrl("http://printer.local/").ok).toBe(false);
  });
});
