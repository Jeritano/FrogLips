import { describe, expect, it } from "vitest";
import { renderMarkdown, chipifyCitations } from "../markdown";

describe("markdown citation chips", () => {
  it("wraps a backticked path:line as a citation chip", () => {
    const out = renderMarkdown("See `src/foo.rs:42` for details.");
    // chip anchor with data attributes survives the post-processor
    expect(out).toContain('class="citation-chip"');
    expect(out).toContain('data-path="src/foo.rs"');
    expect(out).toContain('data-line="42"');
    // chip text should be the basename + line, not the full path
    expect(out).toContain(">foo.rs:42</a>");
  });

  it("wraps an absolute backticked path without a line", () => {
    const out = renderMarkdown("Read `/Users/me/proj/lib.ts` first.");
    expect(out).toContain('class="citation-chip"');
    expect(out).toContain('data-path="/Users/me/proj/lib.ts"');
    expect(out).not.toContain("data-line=");
    expect(out).toContain(">lib.ts</a>");
  });

  it("does NOT chip-ify URLs outside of code spans", () => {
    // The chip-ifier only walks <code> contents. URL-shaped text in
    // regular paragraph text is never chip-ified. (Marked may render
    // bare URLs as autolinks; either way, the resulting <a> isn't a
    // <code>.) Embed the URL between spaces so marked doesn't try to
    // tokenize it specially.
    const out = renderMarkdown("Visit example.com/foo.rs eventually.");
    expect(out).not.toContain("citation-chip");
  });

  it("does NOT chip-ify a bare filename without any slash", () => {
    const out = renderMarkdown("The `index.js` file is the entrypoint.");
    expect(out).not.toContain("citation-chip");
  });

  it("does NOT chip-ify text inside fenced code blocks", () => {
    const md = "```\nsrc/foo.rs:10\n```\n";
    const out = renderMarkdown(md);
    expect(out).not.toContain("citation-chip");
  });

  it("does not introduce live HTML elements via path-like content", () => {
    // chipifyCitations builds DOM via document.createElement +
    // textContent. Even if a text node CONTAINS literal characters that
    // would otherwise be HTML-meaningful, they get re-escaped on
    // serialization rather than being parsed as tags.
    const div = document.createElement("div");
    // Note: textContent here is plain text — the < > are literal chars.
    const code = document.createElement("code");
    code.textContent = "src/<img>.rs:1";
    div.appendChild(code);
    chipifyCitations(div);
    // No actual <img> element ever made it into the DOM tree.
    expect(div.querySelectorAll("img").length).toBe(0);
    // The chip's text node holds the literal characters; the serialization
    // re-escapes them so attacker-controlled text never becomes attacker-
    // controlled DOM.
    const chip = div.querySelector(".citation-chip");
    if (chip) {
      // If the regex did match (e.g. on the suffix `.rs:1`), the chip's
      // textContent contains only literal characters — no parsed elements.
      expect(chip.querySelectorAll("img").length).toBe(0);
    }
  });

  it("chip text only includes the basename, not the directory", () => {
    const out = renderMarkdown("In `src-tauri/src/agent/fs.rs:123` we…");
    expect(out).toContain('data-path="src-tauri/src/agent/fs.rs"');
    expect(out).toContain('data-line="123"');
    expect(out).toContain(">fs.rs:123</a>");
    expect(out).not.toContain(">src-tauri/src/agent/fs.rs:123<");
  });

  it("does not crash on empty or whitespace-only input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("   ")).not.toContain("citation-chip");
  });
});
