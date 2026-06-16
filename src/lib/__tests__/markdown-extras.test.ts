import { beforeAll, describe, expect, it, vi } from "vitest";
import katex from "katex";
import { renderMarkdown } from "../markdown";

// KaTeX is now lazy-loaded (perf): the FIRST render of a message containing
// math emits a raw-TeX `.katex-pending` placeholder and kicks off a dynamic
// `import("katex")`; once it resolves, a re-render produces real typesetting.
// In the test bundle katex is already a static import, so `import("katex")`
// resolves from the module cache on the next microtask — we just need to flush
// it before asserting on real KaTeX markup. `ensureKatexLoaded` renders a
// throwaway formula to trigger the load, then polls renderMarkdown until the
// placeholder is gone, so the synchronous assertions below behave exactly as
// they did when katex was statically imported.
async function ensureKatexLoaded(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (renderMarkdown("$1$").includes('class="katex"')) return;
    // Flush microtasks (dynamic import resolution) + a macrotask for safety.
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("KaTeX lazy load did not resolve in test");
}

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
  // Ensure the lazy KaTeX chunk has landed before the synchronous-output
  // assertions below run (see ensureKatexLoaded note above).
  beforeAll(ensureKatexLoaded);

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

describe("KaTeX lazy loading (perf)", () => {
  it("a no-math reply never invokes the KaTeX typesetter (fast path)", () => {
    // The whole point of lazy-loading: a plain reply must not touch katex at
    // all. We spy on renderToString and render a rich-but-math-free message
    // (prose + a fenced code block + a `$5` currency dollar that the heuristic
    // must NOT treat as math) and assert zero calls.
    const spy = vi.spyOn(katex, "renderToString");
    const out = renderMarkdown(
      "Hello **world** — it cost $5.\n\n```ts\nconst x = 1;\n```\n",
    );
    expect(spy).not.toHaveBeenCalled();
    expect(out).not.toContain("katex");
    spy.mockRestore();
  });

  it("renders a raw-TeX placeholder first, then real KaTeX after load", async () => {
    // Force the not-yet-loaded path via a vi.resetModules-isolated import so
    // this module instance starts with KaTeX unloaded, independent of the
    // suite above (which has already triggered the lazy load).
    vi.resetModules();
    const fresh = await import("../markdown");
    // First render of a formula, before the lazy chunk lands: a readable
    // raw-TeX placeholder, NOT real katex markup, and NO leaked delimiters.
    const formula = "z^7 + 13z"; // unique so it can't be a warm cache hit
    const first = fresh.renderMarkdown(`$$${formula}$$`);
    expect(first).toContain("katex-pending");
    expect(first).toContain("z^7 + 13z");
    expect(first).not.toContain("$$");
    expect(first).not.toContain('class="katex"');
    // After the dynamic import resolves, a re-render produces real typesetting.
    let realized = "";
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 0));
      realized = fresh.renderMarkdown(`$$${formula}$$`);
      if (realized.includes('class="katex"')) break;
    }
    expect(realized).toContain('class="katex"');
    expect(realized).toContain("katex-display");
    expect(realized).not.toContain("katex-pending");
  });
});
