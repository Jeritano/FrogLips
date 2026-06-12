import { describe, expect, it, vi } from "vitest";
import katex from "katex";
import { renderMarkdown } from "../markdown";

describe("code-block header", () => {
  it("wraps a fenced block with header, lang label and copy button", () => {
    const out = renderMarkdown("```ts\nconst x = 1;\n```\n");
    expect(out).toContain('class="code-block"');
    expect(out).toContain('class="code-block-header"');
    expect(out).toContain('<span class="code-lang">ts</span>');
    expect(out).toContain('class="code-copy-btn"');
    expect(out).toContain(">Copy</button>");
    // The original highlighted <pre><code> survives inside the wrapper.
    expect(out).toContain("language-ts");
  });

  it('falls back to a "code" label when the fence has no language', () => {
    const out = renderMarkdown("```\nplain text\n```\n");
    expect(out).toContain('<span class="code-lang">code</span>');
  });

  it("does NOT wrap inline code", () => {
    const out = renderMarkdown("Use `foo()` here.");
    expect(out).not.toContain("code-block");
    expect(out).not.toContain("code-copy-btn");
  });

  it("model-authored <button> markup is still neutralized", () => {
    // Raw HTML is escaped by the renderer + DOMPurify FORBIDs <button>;
    // only the post-sanitize wrapCodeBlocks pass may create one.
    const out = renderMarkdown('<button class="code-copy-btn">x</button>');
    expect(out).not.toContain("<button");
  });
});

describe("KaTeX math", () => {
  it("renders $$…$$ as display math", () => {
    const out = renderMarkdown("$$x^2$$");
    expect(out).toContain("katex");
    expect(out).toContain("katex-display");
    // The TeX delimiters are gone from the output.
    expect(out).not.toContain("$$");
  });

  it("renders \\(…\\) as inline math", () => {
    const out = renderMarkdown("Euler: \\(e^{i\\pi}\\) is neat.");
    expect(out).toContain('class="katex"');
    expect(out).not.toContain("katex-display");
  });

  it("renders \\[…\\] as display math", () => {
    const out = renderMarkdown("\\[\\frac{a}{b}\\]");
    expect(out).toContain("katex-display");
  });

  it("renders conservative single-dollar inline math", () => {
    const out = renderMarkdown("the value $x_i$ converges");
    expect(out).toContain("katex");
  });

  it("does NOT treat currency dollars as math", () => {
    const out = renderMarkdown("I paid $5 and $10 for those.");
    expect(out).not.toContain("katex");
  });

  it("leaves math delimiters inside fenced code untouched", () => {
    const out = renderMarkdown("```\n$$x^2$$\n```\n");
    expect(out).not.toContain("katex");
    expect(out).toContain("$$x^2$$");
  });

  it("leaves math delimiters inside inline code untouched", () => {
    const out = renderMarkdown("see `$$x$$` for the syntax");
    expect(out).not.toContain("katex");
  });

  it("hits the per-formula cache on the second render", () => {
    const spy = vi.spyOn(katex, "renderToString");
    // Unique formula so the first render is a guaranteed cache miss.
    renderMarkdown("$$y^3 + 42y$$");
    const callsAfterFirst = spy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    renderMarkdown("$$y^3 + 42y$$");
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
    spy.mockRestore();
  });
});
