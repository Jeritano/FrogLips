import { marked, type Tokens } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/core";
import DOMPurify from "dompurify";

// Register a focused set — keeps bundle small.
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import csharp from "highlight.js/lib/languages/csharp";
import cpp from "highlight.js/lib/languages/cpp";
import shell from "highlight.js/lib/languages/shell";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import diff from "highlight.js/lib/languages/diff";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("zsh", bash);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("cs", csharp);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c", cpp);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("diff", diff);

marked.use(
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      try {
        return hljs.highlight(code, { language }).value;
      } catch {
        return code;
      }
    },
  }),
);

marked.setOptions({
  gfm: true,
  breaks: true,
});

// Sanitize: forbid HTML in markdown source, escape any < that survives.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Custom renderer: route raw HTML to text (no embedded HTML allowed).
// NOTE: we used to override `renderer.link` here too, but that path calls
// `this.parser.parseInline(tokens)` internally — and the renderer instance
// created via `new marked.Renderer()` never gets a `parser` attached
// because we mount it via `marked.use({ renderer })`. That blew up on every
// markdown render containing a link with `undefined is not an object
// (evaluating 'this.parser.parseInline')`. The target="_blank" + rel="…"
// behaviour is already handled by DOMPurify's afterSanitizeAttributes hook
// below, so the override was redundant.
const renderer = new marked.Renderer();
renderer.html = function ({ raw }: Tokens.HTML | Tokens.Tag) {
  return escapeHtml(raw);
};
marked.use({ renderer });

// Allow only the elements + attributes marked produces — plus hljs spans for
// syntax highlighting. Drops javascript:, data: (except in img src already
// gated by CSP), and any DOM-clobbering attributes.
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    "a", "p", "span", "br", "hr", "strong", "em", "del", "code", "pre",
    "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tr", "th", "td", "img",
  ],
  ALLOWED_ATTR: ["href", "title", "target", "rel", "class", "src", "alt"],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input", "button"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
  // Whitelist URI schemes via DOMPurify's own policy. Element-specific
  // restrictions are layered on top in the `afterSanitizeAttributes` hook
  // below — in particular `<a href>` is restricted there to https/http/
  // mailto/# only, even though `data:` clears this regex (it must, because
  // `<img src=data:image/...>` is allowed).
  ALLOWED_URI_REGEXP:
    /^(?:https?|mailto|data):|^[^a-z]|^[a-z][a-z0-9+.-]*$|^[./?#]/i,
};

// Element-specific href policy. The `ALLOWED_URI_REGEXP` above must permit
// `data:` so legitimate inline-image src attributes survive — but a `data:`
// URL on an <a href> is an HTML-smuggling vector (click-to-render attacker
// HTML inside the app's origin). This hook scrubs any <a href> whose scheme
// isn't one of: https, http, mailto, or a fragment identifier (`#…`).
//   - relative paths (no scheme) are allowed; URL parsing detects them.
//   - protocol-relative (`//example.com`) is treated as https.
//   - everything else (data:, javascript:, file:, vbscript:, custom:…) is
//     stripped and the link is downgraded to a non-clickable span-like
//     `href="#"`.
const A_HREF_ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);
// C0 + DEL + C1 + bidi/zero-width/BOM. Built via RegExp constructor +
// explicit \u code points so the source remains reviewable in diffs.
const HREF_CONTROL_BIDI_RE = new RegExp(
  "[\\u0000-\\u001F\\u007F-\\u009F" +
    "\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069" +
    "\\u2028\\u2029\\uFEFF]",
);

function isSafeAnchorHref(href: string): boolean {
  const h = href.trim();
  if (!h) return false;
  // Fragment-only is always safe (in-page anchor).
  if (h.startsWith("#")) return true;
  // Scheme-relative — treat as https.
  if (h.startsWith("//")) return true;
  // Bare path / query — relative, no scheme.
  if (h.startsWith("/") || h.startsWith("./") || h.startsWith("../") || h.startsWith("?")) {
    return true;
  }
  // Reject anything carrying an embedded NUL / control / bidi / zero-width
  // char that the URL parser might fold differently than the renderer.
  if (HREF_CONTROL_BIDI_RE.test(h)) {
    return false;
  }
  try {
    // Base URL is arbitrary — we only care about the resolved protocol.
    const u = new URL(h, "https://example.invalid/");
    return A_HREF_ALLOWED_SCHEMES.has(u.protocol);
  } catch {
    // Unparseable → treat as a relative ref (safe).
    return true;
  }
}

// Belt-and-suspenders on top of ALLOWED_URI_REGEXP: enforce target/rel and
// kill any remote/data-non-image <img> sources.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const a = node as HTMLAnchorElement;
    // <a>-specific scheme allowlist. Strips any href whose resolved
    // protocol is not http(s)/mailto/fragment, even if ALLOWED_URI_REGEXP
    // let it through (notably `data:` — needed by <img src> but never
    // safe on a clickable anchor).
    const href = a.getAttribute("href") ?? "";
    if (!isSafeAnchorHref(href)) {
      a.setAttribute("href", "#");
    }
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
  // Restrict <img src>: a model-authored remote URL is a tracking-pixel /
  // IP-exfil vector that loads on render. Allow ONLY inline data:image/*
  // sources — never remote http(s) — and drop the node entirely otherwise.
  if (node.tagName === "IMG") {
    const img = node as HTMLImageElement;
    const src = (img.getAttribute("src") ?? "").trim();
    if (!/^data:image\//i.test(src)) {
      img.removeAttribute("src");
      img.remove();
    }
  }
});

/* ── Citation chip post-processor ───────────────────────────────────────── */
//
// Runs AFTER DOMPurify. Walks text nodes that live inside <code> tags (and
// not inside <pre><code>…</code></pre> code blocks — we don't want to
// chip-ify lines inside fenced syntax-highlighted code, only the small
// inline `path/foo.rs:42` mentions). For each text node, scans for
// path-shaped substrings ending in a known code-file extension and wraps
// them in <a class="citation-chip" data-path="…" data-line="…">basename</a>.
//
// XSS hardening: chips are constructed via document.createElement +
// textContent — never innerHTML — so a path that contains characters that
// would otherwise be HTML-meaningful (e.g. `'`) can't escape the attribute
// quoting.

const CITATION_EXTS = "rs|ts|tsx|js|jsx|py|md|json|toml|yml|yaml|sh|html|css";

// Citations are WORKSPACE-RELATIVE references only. We deliberately do NOT
// match absolute (`/...`) or home-relative (`~/...`) paths: a model that
// writes `` `/Users/joseph/.ssh/id_ed25519` `` must never become a one-click
// "open arbitrary file" chip. A leading `(?<![A-Za-z0-9_./~-])` boundary
// rejects matches preceded by `/` or `~`, so an absolute path can't be
// chip-ified by matching only its relative tail. The relative form still
// requires ≥ 1 path separator so bare filenames like `index.js` (which could
// be npm package refs) aren't chip-ified.
const CITATION_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_./~-])` +
    String.raw`[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+\.(?:${CITATION_EXTS})` +
    String.raw`(?::(\d+))?`,
  "g",
);

function basenameWithLine(match: string): string {
  // Strip line suffix, take basename, then re-append line if present.
  const lineIdx = match.lastIndexOf(":");
  const hasLine = lineIdx > 0 && /^\d+$/.test(match.slice(lineIdx + 1));
  const pathPart = hasLine ? match.slice(0, lineIdx) : match;
  const linePart = hasLine ? match.slice(lineIdx) : "";
  const slash = pathPart.lastIndexOf("/");
  const base = slash >= 0 ? pathPart.slice(slash + 1) : pathPart;
  return base + linePart;
}

function splitPathAndLine(match: string): { path: string; line: string | null } {
  const lineIdx = match.lastIndexOf(":");
  if (lineIdx > 0 && /^\d+$/.test(match.slice(lineIdx + 1))) {
    return { path: match.slice(0, lineIdx), line: match.slice(lineIdx + 1) };
  }
  return { path: match, line: null };
}

/**
 * Chip-ify inline `<code>` elements that contain path-shaped text.
 *
 * Exported for unit tests — production code should use `renderMarkdown` which
 * runs this automatically.
 */
export function chipifyCitations(root: HTMLElement | DocumentFragment): void {
  // Inline <code> only — skip block <pre><code> to avoid messing with
  // syntax-highlighted source listings.
  const inlineCodes = root.querySelectorAll("code");
  for (const code of Array.from(inlineCodes)) {
    if (code.parentElement && code.parentElement.tagName === "PRE") continue;
    // A single text-node child is the common marked output for `inline`.
    // We tolerate multiple text nodes (e.g. mixed with hljs spans) by
    // iterating childNodes.
    const text = code.textContent ?? "";
    if (!text) continue;
    // Quick rejection — at least one of our extensions must appear or the
    // regex can't match.
    if (!/\.(rs|ts|tsx|js|jsx|py|md|json|toml|yml|yaml|sh|html|css)\b/.test(text)) {
      continue;
    }
    // Reset stickiness for each fresh string (CITATION_RE is /g).
    CITATION_RE.lastIndex = 0;
    if (!CITATION_RE.test(text)) continue;
    CITATION_RE.lastIndex = 0;

    // Build a fragment that interleaves chip anchors with text segments,
    // then replace the inline <code>'s contents wholesale.
    const frag = code.ownerDocument!.createDocumentFragment();
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CITATION_RE.exec(text)) !== null) {
      if (m.index > lastIndex) {
        frag.appendChild(
          code.ownerDocument!.createTextNode(text.slice(lastIndex, m.index)),
        );
      }
      const matchStr = m[0];
      const { path, line } = splitPathAndLine(matchStr);
      // Reject path-traversal segments — a relative citation must never be
      // able to escape the workspace via `..`. Emit the literal text instead
      // of a clickable chip. The click handler re-checks as defense in depth.
      if (path.split("/").some((seg) => seg === "..")) {
        frag.appendChild(code.ownerDocument!.createTextNode(matchStr));
        lastIndex = m.index + matchStr.length;
        continue;
      }
      const a = code.ownerDocument!.createElement("a");
      a.className = "citation-chip";
      a.setAttribute("data-path", path);
      if (line) a.setAttribute("data-line", line);
      a.setAttribute("title", matchStr);
      // href="#" so it looks/feels like a link; the click handler in
      // ChatWindow intercepts and prevents default.
      a.setAttribute("href", "#");
      a.textContent = basenameWithLine(matchStr);
      frag.appendChild(a);
      lastIndex = m.index + matchStr.length;
    }
    if (lastIndex < text.length) {
      frag.appendChild(code.ownerDocument!.createTextNode(text.slice(lastIndex)));
    }
    // Only commit if we actually produced at least one chip.
    if (frag.childNodes.length > 0) {
      // Replace the <code>'s children with the new fragment. The <code>
      // wrapper itself stays — the chip just lives inside it.
      while (code.firstChild) code.removeChild(code.firstChild);
      code.appendChild(frag);
    }
  }
}

export function renderMarkdown(md: string): string {
  if (!md) return "";
  const raw = marked.parse(md, { async: false }) as string;
  const sanitized = DOMPurify.sanitize(raw, PURIFY_CONFIG) as string;
  // Post-sanitize: parse the trusted HTML into a detached container, run
  // chip-ification, return the serialized output. Building DOM nodes via
  // document.createElement (not innerHTML) keeps this XSS-safe.
  if (typeof document === "undefined") return sanitized;
  const container = document.createElement("div");
  container.innerHTML = sanitized;
  chipifyCitations(container);
  return container.innerHTML;
}
