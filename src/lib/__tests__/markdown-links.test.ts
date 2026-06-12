import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../markdown";

// Regression for v0.10.5: marked v18's default Renderer.link does
// `this.parser.parseInline(tokens)`. Our old custom renderer.link used
// `marked.use({ renderer })` which never attached `parser` → every render
// containing a link crashed with:
//   "undefined is not an object (evaluating 'this.parser.parseInline')"
// The whole app webview unmounted (no ErrorBoundary), producing the
// "black window on launch" bug. These tests pin the regression.

describe("renderMarkdown — link handling regression (v0.10.5)", () => {
  it("renders a markdown link without throwing", () => {
    const out = renderMarkdown("see [the docs](https://example.com)");
    expect(out).toContain("<a");
    expect(out).toContain("example.com");
  });

  it("DOMPurify hook still sets target=_blank + rel on anchors", () => {
    const out = renderMarkdown("[click](https://example.com)");
    expect(out).toMatch(/target="_blank"/);
    expect(out).toMatch(/rel="noopener noreferrer"/);
  });

  it("strips javascript: hrefs", () => {
    const out = renderMarkdown("[bad](javascript:alert(1))");
    expect(out).not.toMatch(/javascript:/i);
  });

  it("handles multiple links + mixed content without crashing", () => {
    const md =
      "First [a](https://a.com) and second [b](https://b.com), plus `code` and **bold**.";
    expect(() => renderMarkdown(md)).not.toThrow();
    const out = renderMarkdown(md);
    expect(out).toContain("a.com");
    expect(out).toContain("b.com");
  });
});
