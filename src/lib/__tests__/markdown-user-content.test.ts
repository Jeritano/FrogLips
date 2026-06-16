import { describe, expect, it } from "vitest";
import { renderUserContent, containsUserCode } from "../markdown";

// User messages render as plain prose EXCEPT for pasted code (fenced ``` blocks
// + inline `code` spans), which get the monospace + highlight + copy chrome.
// These tests pin that "code yes, markdown no" boundary.
describe("user-message code rendering", () => {
  it("detects fenced + inline code, rejects plain prose", () => {
    expect(containsUserCode("hello\n```js\nconst x=1\n```\n")).toBe(true);
    expect(containsUserCode("inline `code` here")).toBe(true);
    expect(containsUserCode("just prose, no code")).toBe(false);
    expect(containsUserCode("")).toBe(false);
  });

  it("renders a fenced block with code-block chrome, keeps prose literal", () => {
    const out = renderUserContent("look:\n```ts\nconst x = 1;\n```\ndone");
    expect(out).toContain("code-block");
    expect(out).toContain("language-ts");
    expect(out).toContain("code-copy-btn");
    expect(out).toContain("look:");
    expect(out).toContain("done");
  });

  it("does NOT turn markdown prose into HTML (no surprise formatting)", () => {
    const out = renderUserContent("# not a heading\n**not bold**\n- not a list");
    expect(out).not.toContain("<h1");
    expect(out).not.toContain("<strong");
    expect(out).not.toContain("<li");
    // The literal characters survive as typed.
    expect(out).toContain("# not a heading");
    expect(out).toContain("**not bold**");
  });

  it("renders inline code spans in prose", () => {
    const out = renderUserContent("run `npm test` now");
    expect(out).toContain("<code>npm test</code>");
    expect(out).toContain("run ");
    expect(out).toContain(" now");
  });

  it("escapes literal HTML in prose (XSS-safe)", () => {
    const out = renderUserContent("a <script>alert(1)</script> b");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("handles an unterminated trailing fence (half-pasted block)", () => {
    const out = renderUserContent("text\n```py\nprint(1)");
    expect(out).toContain("code-block");
    expect(out).toContain("language-py");
    expect(out).toContain("print(1)");
  });

  it("returns empty string for empty input", () => {
    expect(renderUserContent("")).toBe("");
  });
});
